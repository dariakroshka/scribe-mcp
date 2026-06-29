import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { transcribe, createClient } from "./gemini.js";
import { mimeFromPath, type Transcript } from "./types.js";
import { formatMarkdown } from "./format.js";
import { scribePage } from "./notion.js";

const server = new McpServer({
  name: "scribe",
  version: "0.1.0",
});

const GLOSSARY_REFRESH_MS = 30 * 60 * 1000; // 30 minutes

async function loadGlossaryFromFile(): Promise<string | undefined> {
  const path = process.env.SCRIBE_GLOSSARY_PATH;
  if (!path) return undefined;
  try {
    return await Bun.file(path).text();
  } catch {
    process.stderr.write(`[scribe] Warning: could not load glossary from ${path}\n`);
    return undefined;
  }
}

async function loadGlossaryFromWiki(): Promise<string | undefined> {
  const url = process.env.SCRIBE_GLOSSARY_URL;
  if (!url) return undefined;
  try {
    const apiUrl = url.replace(/\/index\.php\/.*$/, "/api.php");
    const pageName = url.match(/\/index\.php\/(.+?)(?:\?|#|$)/)?.[1] ?? url.split("/").pop();
    const endpoint = `${apiUrl}?action=query&titles=${encodeURIComponent(pageName!)}&prop=extracts&explaintext=1&exlimit=1&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const pages = data?.query?.pages;
    if (!pages) throw new Error("unexpected API response");
    const page = Object.values(pages)[0] as any;
    if (page.missing !== undefined) throw new Error(`page "${pageName}" not found`);
    const text = page.extract as string;
    if (!text?.trim()) throw new Error("empty page content");
    process.stderr.write(`[scribe] Loaded glossary from wiki (${text.length} chars)\n`);
    return text;
  } catch (err: any) {
    process.stderr.write(`[scribe] Warning: could not load glossary from wiki: ${err.message}\n`);
    return undefined;
  }
}

async function loadDefaultGlossary(): Promise<string | undefined> {
  const wiki = await loadGlossaryFromWiki();
  const file = await loadGlossaryFromFile();
  if (wiki && file) return `${wiki}\n\n${file}`;
  return wiki ?? file;
}

let defaultGlossary: string | undefined;
let glossaryTimer: ReturnType<typeof setInterval> | undefined;

const MAX_HISTORY = 5;
const recentTranscripts: { title: string; summary: string; transcript: string; knowledge?: any[] }[] = [];

function pushTranscript(result: Transcript) {
  recentTranscripts.unshift({
    title: result.title,
    summary: result.summary,
    transcript: result.transcript,
    knowledge: result.knowledge,
  });
  if (recentTranscripts.length > MAX_HISTORY) recentTranscripts.pop();
}

server.tool(
  "transcribe",
  "Transcribe and summarize an audio or video file using Gemini. Returns structured transcript with timestamps, speaker identification, summary, topics, and action items.",
  {
    filePath: z.string().describe("Absolute path to the audio/video file"),
    mimeType: z.string().optional().describe("MIME type override (auto-detected from extension if omitted)"),
    audioOnly: z.boolean().optional().describe("Extract audio track only before uploading (cheaper, loses visual context). Requires ffmpeg."),
    model: z.string().optional().describe("Gemini model to use (default: gemini-2.5-flash)"),
    customPrompt: z.string().optional().describe("Additional instructions appended to the transcription prompt"),
    glossary: z.string().optional().describe("Domain-specific terminology to improve recognition (one term per line)"),
  },
  async (params) => {
    try {
      const result = await transcribe({
        filePath: params.filePath,
        mimeType: params.mimeType,
        audioOnly: params.audioOnly,
        model: params.model,
        customPrompt: params.customPrompt,
        glossary: params.glossary ?? defaultGlossary,
        onStatus: (s) => process.stderr.write(`[scribe] ${s}\n`),
      });

      pushTranscript(result);
      const markdown = formatMarkdown(result);

      return {
        content: [
          { type: "text", text: markdown },
          { type: "text", text: `\n---\n<json>\n${JSON.stringify(result, null, 2)}\n</json>` },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "probe",
  "Check a media file's format and estimate transcription cost without processing it.",
  {
    filePath: z.string().describe("Absolute path to the audio/video file"),
  },
  async (params) => {
    try {
      const filePath = params.filePath;
      const file = Bun.file(filePath);
      if (!await file.exists()) {
        return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
      }
      const size = file.size;
      const mime = mimeFromPath(filePath);

      let duration = "unknown";
      let durationSec = 0;
      try {
        const proc = Bun.spawn(
          ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filePath],
          { stdout: "pipe", stderr: "pipe" }
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const info = JSON.parse(out);
        durationSec = Math.round(parseFloat(info.format?.duration ?? "0"));
        const h = Math.floor(durationSec / 3600);
        const m = Math.floor((durationSec % 3600) / 60);
        const s = durationSec % 60;
        duration = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      } catch {}

      const isVideo = mime?.startsWith("video/");
      const audioTokens = durationSec * 32;
      const videoTokens = isVideo ? durationSec * 300 : 0;
      const totalTokens = audioTokens + videoTokens;
      const audioOnlyTokens = audioTokens;

      return {
        content: [{
          type: "text",
          text: [
            `**File**: ${filePath}`,
            `**Size**: ${(size / 1024 / 1024).toFixed(1)} MB`,
            `**MIME**: ${mime ?? "unknown"}`,
            `**Duration**: ${duration}`,
            `**Estimated tokens** (full): ~${(totalTokens / 1000).toFixed(0)}k`,
            isVideo ? `**Estimated tokens** (audio-only): ~${(audioOnlyTokens / 1000).toFixed(0)}k` : null,
            size > 2 * 1024 * 1024 * 1024 ? "⚠ File exceeds 2GB Gemini limit" : null,
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "scribe_notion_page",
  "Scan a Notion page for audio/video attachments, transcribe each with Gemini, and append the results (summary, topics, action items, transcript) back to the page.",
  {
    pageIdOrUrl: z.string().describe("Notion page URL or page ID"),
    model: z.string().optional().describe("Gemini model to use (default: gemini-2.5-flash)"),
    customPrompt: z.string().optional().describe("Additional instructions for the transcription"),
    glossary: z.string().optional().describe("Domain-specific terminology to improve recognition (one term per line)"),
  },
  async (params) => {
    try {
      const results = await scribePage({
        pageIdOrUrl: params.pageIdOrUrl,
        model: params.model,
        customPrompt: params.customPrompt,
        glossary: params.glossary ?? defaultGlossary,
        onStatus: (s) => process.stderr.write(`[scribe] ${s}\n`),
      });

      const summaries = results.map((r, i) =>
        `### ${r.title}\n**Duration**: ${r.duration} | **Speakers**: ${r.speakers.join(", ")}\n\n${r.summary}`
      ).join("\n\n---\n\n");

      return {
        content: [
          { type: "text", text: `Transcribed ${results.length} file(s) and posted to Notion.\n\n${summaries}` },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

const SCRIBE_PERSONA = `You are Scribe — a specialist in audio/video transcription, knowledge extraction, and domain terminology. You work with recordings of business meetings, expert lectures, and internal knowledge-sharing sessions.

You have deep familiarity with the domain glossary and can help interpret terms, clarify ambiguities in transcripts, provide additional context about what was discussed, and answer questions about the content you've processed.

Be concise and direct. When referencing transcript content, cite timestamps and speakers. If you don't know something or it wasn't in the recording, say so.`;

server.tool(
  "chat",
  "Send a free-text message to Scribe. Use for follow-up questions about transcripts, requests for clarification, providing context before a transcription task, or any conversation. Scribe remembers recent transcripts from this session.",
  {
    message: z.string().describe("Your message to Scribe"),
    includeTranscript: z.enum(["latest", "none", "all"]).optional()
      .describe("Which recent transcript(s) to include as context (default: latest)"),
    model: z.string().optional().describe("Gemini model to use (default: gemini-2.5-flash)"),
  },
  async (params) => {
    try {
      const ai = await createClient();
      const include = params.includeTranscript ?? "latest";

      let context = "";
      if (include !== "none" && recentTranscripts.length > 0) {
        const items = include === "all" ? recentTranscripts : [recentTranscripts[0]];
        context = items.map(t =>
          `<transcript title="${t.title}">\n<summary>\n${t.summary}\n</summary>\n<knowledge>\n${JSON.stringify(t.knowledge ?? [], null, 2)}\n</knowledge>\n<text>\n${t.transcript.slice(0, 60_000)}\n</text>\n</transcript>`
        ).join("\n\n");
      }

      const glossaryBlock = defaultGlossary
        ? `\n\n<glossary>\n${defaultGlossary}\n</glossary>`
        : "";

      const prompt = [
        SCRIBE_PERSONA,
        glossaryBlock,
        context ? `\n\nRecent transcript(s) for reference:\n${context}` : "\n\nNo transcripts in current session yet.",
        `\n\nUser message:\n${params.message}`,
      ].join("");

      const response = await ai.models.generateContent({
        model: params.model ?? "gemini-2.5-flash",
        contents: prompt,
      });

      const text = response.text ?? "(no response)";

      return {
        content: [{ type: "text", text }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  defaultGlossary = await loadDefaultGlossary();
  if (defaultGlossary) {
    process.stderr.write(`[scribe] Glossary loaded (${defaultGlossary.length} chars)\n`);
  }

  if (process.env.SCRIBE_GLOSSARY_URL) {
    glossaryTimer = setInterval(async () => {
      const refreshed = await loadDefaultGlossary();
      if (refreshed) {
        defaultGlossary = refreshed;
        process.stderr.write(`[scribe] Glossary refreshed (${refreshed.length} chars)\n`);
      }
    }, GLOSSARY_REFRESH_MS);
    glossaryTimer.unref();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[scribe] MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[scribe] Fatal: ${err.message}\n`);
  process.exit(1);
});
