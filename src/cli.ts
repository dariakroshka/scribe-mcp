import { transcribe, createClient } from "./gemini.js";
import { formatMarkdown } from "./format.js";
import { scribePage } from "./notion.js";
import * as readline from "node:readline";

const USAGE = `scribe — transcribe audio/video files using Gemini

Usage:
  bun src/cli.ts <file> [options]
  bun src/cli.ts --notion <page-url-or-id> [options]
  bun src/cli.ts --batch <file-with-urls> [options]
  bun src/cli.ts --chat [message]

Commands:
  <file>           Transcribe a local audio/video file
  --notion <url>   Scan a Notion page for media, transcribe, and post back
  --batch <file>   Process multiple Notion pages (one URL per line)
  --chat [msg]     Chat with Scribe (interactive REPL, or one-shot with message)

Options:
  --audio-only     Extract audio before uploading (cheaper, needs ffmpeg)
  --model <name>   Gemini model (default: gemini-2.5-flash)
  --glossary <path> File with domain-specific terms to improve recognition
  --glossary-url <url> MediaWiki page URL to fetch glossary from (merged with --glossary)
  --json           Output raw JSON instead of markdown
  --output <path>  Write output to file instead of stdout
  --prompt <text>  Additional instructions for the transcription
  --help           Show this help

Environment:
  GEMINI_API_KEY        Required for transcription
  NOTION_API_KEY        Required for --notion / --batch mode
  SCRIBE_GLOSSARY_URL   MediaWiki page URL for glossary (alternative to --glossary-url)`;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function loadGlossary(path: string, log: (s: string) => void): Promise<string> {
  const gf = Bun.file(path);
  if (!await gf.exists()) {
    console.error(`Error: glossary file not found: ${path}`);
    process.exit(1);
  }
  const text = await gf.text();
  log(`Loaded glossary from ${path} (${text.split("\n").length} lines)`);
  return text;
}

async function fetchGlossaryFromWiki(url: string, log: (s: string) => void): Promise<string | undefined> {
  try {
    const apiUrl = url.replace(/\/index\.php\/.*$/, "/api.php");
    const pageName = url.match(/\/index\.php\/(.+?)(?:\?|#|$)/)?.[1] ?? url.split("/").pop();
    const endpoint = `${apiUrl}?action=query&titles=${encodeURIComponent(pageName!)}&prop=extracts&explaintext=1&exlimit=1&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const page = Object.values(data?.query?.pages ?? {})[0] as any;
    if (page?.missing !== undefined) throw new Error(`page "${pageName}" not found`);
    const text = page?.extract as string;
    if (!text?.trim()) throw new Error("empty page content");
    log(`Loaded glossary from wiki (${text.length} chars)`);
    return text;
  } catch (err: any) {
    log(`Warning: could not fetch glossary from wiki: ${err.message}`);
    return undefined;
  }
}

async function processNotionPage(
  url: string,
  opts: { model?: string; customPrompt?: string; glossary?: string; jsonOutput: boolean; outputPath?: string },
  log: (s: string) => void,
) {
  log(`Notion mode: ${url}`);
  const results = await scribePage({
    pageIdOrUrl: url,
    model: opts.model,
    customPrompt: opts.customPrompt,
    glossary: opts.glossary,
    onStatus: log,
  });
  log(`Processed ${results.length} file(s)`);

  if (opts.outputPath) {
    const output = results.map(r => opts.jsonOutput ? JSON.stringify(r, null, 2) : formatMarkdown(r)).join("\n\n---\n\n");
    await Bun.write(opts.outputPath, output);
    log(`Written to ${opts.outputPath}`);
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  const model = getArg(args, "--model");
  const customPrompt = getArg(args, "--prompt");
  const glossaryPath = getArg(args, "--glossary");
  const jsonOutput = args.includes("--json");
  const outputPath = getArg(args, "--output");
  const log = (s: string) => console.error(`[scribe] ${s}`);

  const glossaryUrl = getArg(args, "--glossary-url") ?? process.env.SCRIBE_GLOSSARY_URL;
  const fileGlossary = glossaryPath ? await loadGlossary(glossaryPath, log) : undefined;
  const wikiGlossary = glossaryUrl ? await fetchGlossaryFromWiki(glossaryUrl, log) : undefined;
  const glossary = wikiGlossary && fileGlossary ? `${wikiGlossary}\n\n${fileGlossary}`
    : wikiGlossary ?? fileGlossary;

  // Chat mode
  const chatIdx = args.indexOf("--chat");
  if (chatIdx >= 0) {
    const ai = await createClient();
    const glossaryBlock = glossary ? `\n\n<glossary>\n${glossary}\n</glossary>` : "";

    let transcriptContext = "";
    const contextUrl = getArg(args, "--notion");
    const contextFile = args.find(a => !a.startsWith("--") && a !== args[chatIdx + 1] && a !== getArg(args, "--model") && a !== getArg(args, "--glossary") && a !== getArg(args, "--glossary-url") && a !== getArg(args, "--output") && a !== getArg(args, "--prompt") && a !== contextUrl);

    if (contextUrl) {
      log("Transcribing Notion page for context...");
      const results = await scribePage({
        pageIdOrUrl: contextUrl,
        model,
        customPrompt,
        glossary,
        onStatus: log,
      });
      transcriptContext = results.map(r =>
        `<transcript title="${r.title}">\n<summary>\n${r.summary}\n</summary>\n<text>\n${r.transcript}\n</text>\n</transcript>`
      ).join("\n\n");
      log(`Context loaded: ${results.length} transcript(s)`);
    } else if (contextFile && !contextFile.startsWith("--")) {
      const cf = Bun.file(contextFile);
      if (await cf.exists()) {
        log(`Transcribing ${contextFile} for context...`);
        const result = await transcribe({
          filePath: contextFile,
          audioOnly: args.includes("--audio-only"),
          model,
          customPrompt,
          glossary,
          onStatus: log,
        });
        transcriptContext = `<transcript title="${result.title}">\n<summary>\n${result.summary}\n</summary>\n<text>\n${result.transcript}\n</text>\n</transcript>`;
        log("Context loaded from transcription");
      }
    }

    const persona = [
      "You are Scribe — a specialist in audio/video transcription, knowledge extraction, and domain terminology. You work with recordings of business meetings, expert lectures, and internal knowledge-sharing sessions. Be concise and direct. When referencing transcript content, cite timestamps and speakers.",
      glossaryBlock,
      transcriptContext ? `\n\nTranscript context:\n${transcriptContext}` : "",
    ].join("");

    const oneShot = args[chatIdx + 1] && !args[chatIdx + 1].startsWith("--") ? args[chatIdx + 1] : undefined;

    const ask = async (msg: string) => {
      const res = await ai.models.generateContent({
        model: model ?? "gemini-2.5-flash",
        contents: `${persona}\n\nUser: ${msg}`,
      });
      console.log(`\n${res.text ?? "(no response)"}\n`);
    };

    if (oneShot) {
      await ask(oneShot);
      return;
    }

    console.error("[scribe] Chat mode — type your message, or 'exit' to quit");
    if (glossary) console.error(`[scribe] Glossary loaded (${glossary.length} chars)`);
    if (transcriptContext) console.error("[scribe] Transcript loaded as context");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => rl.question("you> ", async (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        rl.close();
        return;
      }
      try {
        await ask(trimmed);
      } catch (err: any) {
        console.error(`[scribe] Error: ${err.message}`);
      }
      prompt();
    });
    prompt();
    await new Promise((resolve) => rl.on("close", resolve));
    return;
  }

  // Batch mode
  const batchFile = getArg(args, "--batch");
  if (batchFile) {
    const bf = Bun.file(batchFile);
    if (!await bf.exists()) {
      console.error(`Error: batch file not found: ${batchFile}`);
      process.exit(1);
    }
    const urls = (await bf.text())
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));

    log(`Batch mode: ${urls.length} page(s) to process`);
    let done = 0;
    let failed = 0;

    for (const url of urls) {
      try {
        await processNotionPage(url, { model, customPrompt, glossary, jsonOutput }, log);
        done++;
        log(`Progress: ${done}/${urls.length} done, ${failed} failed`);
      } catch (err: any) {
        failed++;
        log(`FAILED: ${url} — ${err.message}`);
        log(`Progress: ${done}/${urls.length} done, ${failed} failed`);
      }
    }

    log(`Batch complete: ${done} succeeded, ${failed} failed out of ${urls.length}`);
    return;
  }

  // Single Notion page mode
  const notionPage = getArg(args, "--notion");
  if (notionPage) {
    await processNotionPage(notionPage, { model, customPrompt, glossary, jsonOutput, outputPath }, log);
    return;
  }

  // Local file mode
  const filePath = args[0];
  if (!filePath || filePath.startsWith("--")) {
    console.error("Error: first argument must be a file path, --notion <url>, or --batch <file>");
    process.exit(1);
  }

  const file = Bun.file(filePath);
  if (!await file.exists()) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const audioOnly = args.includes("--audio-only");

  log(`Processing: ${filePath}`);

  const result = await transcribe({
    filePath,
    audioOnly,
    model,
    customPrompt,
    glossary,
    onStatus: log,
  });

  let output: string;
  if (jsonOutput) {
    output = JSON.stringify(result, null, 2);
  } else {
    output = formatMarkdown(result);
  }

  if (outputPath) {
    await Bun.write(outputPath, output);
    log(`Written to ${outputPath}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(`[scribe] Error: ${err.message}`);
  process.exit(1);
});
