import { Client } from "@notionhq/client";
import { transcribe } from "./gemini.js";
import { formatMarkdown } from "./format.js";
import type { Transcript } from "./types.js";
import { mimeFromPath } from "./types.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createNotionClient(token?: string): Client {
  const auth = token ?? process.env.NOTION_API_KEY;
  if (!auth) throw new Error("NOTION_API_KEY is required");
  return new Client({ auth });
}

interface FileAttachment {
  name: string;
  url: string;
  blockId: string;
}

function extractPageId(input: string): string {
  const match = input.match(/([a-f0-9]{32}|[a-f0-9-]{36})/);
  if (!match) throw new Error(`Cannot extract page ID from: ${input}`);
  return match[1].replace(/-/g, "");
}

export async function findMediaAttachments(
  notion: Client,
  pageIdOrUrl: string,
): Promise<FileAttachment[]> {
  const pageId = extractPageId(pageIdOrUrl);
  const blocks = await getAllBlocks(notion, pageId);
  const files: FileAttachment[] = [];

  for (const block of blocks) {
    const b = block as any;
    let fileInfo: { name: string; url: string } | null = null;

    if (b.type === "video" && b.video) {
      const v = b.video;
      const url = v.type === "file" ? v.file?.url : v.external?.url;
      if (url) fileInfo = { name: nameFromUrl(url), url };
    } else if (b.type === "audio" && b.audio) {
      const a = b.audio;
      const url = a.type === "file" ? a.file?.url : a.external?.url;
      if (url) fileInfo = { name: nameFromUrl(url), url };
    } else if (b.type === "file" && b.file) {
      const f = b.file;
      const url = f.type === "file" ? f.file?.url : f.external?.url;
      if (url && isMediaFile(url)) fileInfo = { name: nameFromUrl(url), url };
    } else if (b.type === "embed" && b.embed?.url && isMediaFile(b.embed.url)) {
      fileInfo = { name: nameFromUrl(b.embed.url), url: b.embed.url };
    }

    if (fileInfo) {
      files.push({ ...fileInfo, blockId: b.id });
    }
  }

  const seen = new Set<string>();
  return files.filter(f => {
    const key = f.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getAllBlocks(notion: Client, blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  do {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
  } while (cursor);
  return blocks;
}

const MEDIA_EXTS = /\.(mp4|mov|avi|mkv|webm|wmv|flv|mpg|mpeg|3gp|mp3|wav|aac|ogg|flac|m4a|wma|aiff)(\?|$)/i;

function isMediaFile(url: string): boolean {
  return MEDIA_EXTS.test(url);
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const decoded = decodeURIComponent(path.split("/").pop() ?? "file");
    return decoded.replace(/\?.*$/, "");
  } catch {
    return "file";
  }
}

async function downloadFile(
  url: string,
  name: string,
  onStatus?: (s: string) => void,
): Promise<string> {
  const dest = join(tmpdir(), `scribe_${Date.now()}_${name}`);
  onStatus?.(`Downloading ${name}...`);

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const args = [
      "curl", "-fSL",
      "--max-time", "1800",
      "--connect-timeout", "30",
      "-C", "-",
      "-o", dest,
      url,
    ];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode === 0) break;

    const stderr = await new Response(proc.stderr).text();
    if (attempt === maxRetries - 1) {
      throw new Error(`Download failed after ${maxRetries} attempts (curl exit ${exitCode}): ${stderr.slice(-300)}`);
    }
    onStatus?.(`Download interrupted, retrying (${attempt + 2}/${maxRetries})...`);
    await Bun.sleep(3000);
  }

  const size = Bun.file(dest).size;
  onStatus?.(`Downloaded ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return dest;
}

const MAX_BLOCK_TEXT = 2000;

function splitLongLine(line: string): string[] {
  if (line.length <= MAX_BLOCK_TEXT) return [line];
  const parts: string[] = [];
  while (line.length > MAX_BLOCK_TEXT) {
    let cut = line.lastIndexOf(" ", MAX_BLOCK_TEXT);
    if (cut <= 0) cut = MAX_BLOCK_TEXT;
    parts.push(line.slice(0, cut));
    line = line.slice(cut).trimStart();
  }
  if (line) parts.push(line);
  return parts;
}

function splitForNotion(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawLine of text.split("\n")) {
    for (const line of splitLongLine(rawLine)) {
      if (current.length + line.length + 1 > MAX_BLOCK_TEXT && current) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function summaryBlocks(result: Transcript): any[] {
  const blocks: any[] = [];

  blocks.push({
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: "Summary" } }] },
  });

  for (const chunk of splitForNotion(result.summary)) {
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
    });
  }

  if (result.topics.length > 0) {
    blocks.push({
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Topics" } }] },
    });
    for (const topic of result.topics) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: topic } }] },
      });
    }
  }

  if (result.knowledge && result.knowledge.length > 0) {
    blocks.push({
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Knowledge Items" } }] },
    });

    const byType = new Map<string, typeof result.knowledge>();
    for (const item of result.knowledge) {
      const list = byType.get(item.type) ?? [];
      list.push(item);
      byType.set(item.type, list);
    }

    for (const [type, items] of byType) {
      blocks.push({
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: type.charAt(0).toUpperCase() + type.slice(1) + "s" } }] },
      });
      for (const item of items) {
        const text = `[${item.timestamp}] ${item.statement} (${item.topic}; ${item.speakers.join(", ")})`;
        for (const chunk of splitLongLine(text)) {
          blocks.push({
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ type: "text", text: { content: chunk } }] },
          });
        }
      }
    }
  }

  return blocks;
}

function transcriptBlocks(result: Transcript): any[] {
  const blocks: any[] = [];
  for (const chunk of splitForNotion(result.transcript)) {
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
    });
  }
  return blocks;
}

async function uploadFileToPage(
  notion: Client,
  pageId: string,
  filePath: string,
  fileName: string,
) {
  const created = await (notion as any).fileUploads.create({
    filename: fileName,
    content_type: "text/markdown",
  });
  const uploadId = created.id;

  const fileData = await Bun.file(filePath).arrayBuffer();
  await (notion as any).fileUploads.send({
    file_upload_id: uploadId,
    file: { data: new Blob([fileData], { type: "text/markdown" }), filename: fileName },
  });

  await notion.blocks.children.append({
    block_id: pageId,
    children: [{
      type: "file" as any,
      file: { type: "file_upload" as any, file_upload: { id: uploadId } } as any,
    }],
  });
}

async function appendBlocks(notion: Client, pageId: string, blocks: any[]) {
  // Notion API allows max 100 blocks per request
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + 100),
    });
  }
}

export interface ScribePageOptions {
  pageIdOrUrl: string;
  notionToken?: string;
  model?: string;
  customPrompt?: string;
  glossary?: string;
  onStatus?: (s: string) => void;
}

export async function scribePage(opts: ScribePageOptions): Promise<Transcript[]> {
  const notion = createNotionClient(opts.notionToken);
  const pageId = extractPageId(opts.pageIdOrUrl);

  opts.onStatus?.(`Scanning page ${pageId} for media...`);
  const attachments = await findMediaAttachments(notion, pageId);

  if (attachments.length === 0) {
    throw new Error("No audio/video attachments found on this page");
  }

  opts.onStatus?.(`Found ${attachments.length} media file(s): ${attachments.map(a => a.name).join(", ")}`);

  const results: Transcript[] = [];

  for (const att of attachments) {
    const localPath = await downloadFile(att.url, att.name, opts.onStatus);

    try {
      opts.onStatus?.(`Transcribing ${att.name}...`);
      const result = await transcribe({
        filePath: localPath,
        model: opts.model,
        customPrompt: opts.customPrompt,
        glossary: opts.glossary,
        onStatus: opts.onStatus,
      });

      const subpageTitle = result.title || att.name.replace(/\.[^.]+$/, "");

      opts.onStatus?.(`Creating summary page "${subpageTitle}"...`);
      const summaryPage = await notion.pages.create({
        parent: { page_id: pageId },
        properties: {
          title: [{ type: "text", text: { content: `📝 ${subpageTitle}` } }],
        },
      });
      await appendBlocks(notion, summaryPage.id, summaryBlocks(result));

      opts.onStatus?.(`Creating transcript page...`);
      const transcriptPage = await notion.pages.create({
        parent: { page_id: pageId },
        properties: {
          title: [{ type: "text", text: { content: `📜 ${subpageTitle} — Transcript` } }],
        },
      });
      await appendBlocks(notion, transcriptPage.id, transcriptBlocks(result));

      const mdFileName = att.name.replace(/\.[^.]+$/, "_transcript.md");
      const mdPath = join(tmpdir(), `scribe_${Date.now()}_${mdFileName}`);
      await Bun.write(mdPath, formatMarkdown(result));

      opts.onStatus?.(`Uploading ${mdFileName}...`);
      try {
        await uploadFileToPage(notion, summaryPage.id, mdPath, mdFileName);
      } catch (e: any) {
        opts.onStatus?.(`Warning: file upload failed (${e.message}), text was still posted.`);
      }

      results.push(result);
      try { await unlink(mdPath); } catch {}
      opts.onStatus?.(`Done: ${att.name}`);
    } finally {
      try { await unlink(localPath); } catch {}
    }
  }

  return results;
}
