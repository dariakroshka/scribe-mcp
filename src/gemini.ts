import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { unlink } from "node:fs/promises";
import { MetadataSchema, KnowledgeSchema, type KnowledgeItem, type Transcript, mimeFromPath } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 360;
const CHUNK_DURATION_SEC = 600; // 10 minutes per chunk

export interface TranscribeOptions {
  filePath: string;
  mimeType?: string;
  model?: string;
  audioOnly?: boolean;
  customPrompt?: string;
  glossary?: string;
  extractKnowledge?: boolean;
  onStatus?: (status: string) => void;
}

export async function createClient(apiKey?: string): Promise<GoogleGenAI> {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is required");
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: { timeout: 600_000 },
  });
}

async function getMediaDuration(filePath: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filePath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const info = JSON.parse(out);
  return Math.ceil(parseFloat(info.format?.duration ?? "0"));
}

async function extractAudioChunks(
  inputPath: string,
  totalDuration: number,
  onStatus?: (status: string) => void,
): Promise<string[]> {
  const chunks: string[] = [];
  const numChunks = Math.ceil(totalDuration / CHUNK_DURATION_SEC);

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_DURATION_SEC;
    const outputPath = inputPath.replace(/\.[^.]+$/, `.chunk${i}.mp3`);
    onStatus?.(`Extracting audio chunk ${i + 1}/${numChunks} (${formatTime(start)}-${formatTime(Math.min(start + CHUNK_DURATION_SEC, totalDuration))})...`);

    const proc = Bun.spawn(
      [
        "ffmpeg", "-i", inputPath,
        "-ss", String(start),
        "-t", String(CHUNK_DURATION_SEC),
        "-vn", "-acodec", "libmp3lame", "-q:a", "4",
        "-y", outputPath,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`ffmpeg chunk ${i} failed: ${stderr.slice(-300)}`);
    }
    chunks.push(outputPath);
  }

  return chunks;
}

async function extractFullAudio(inputPath: string, onStatus?: (status: string) => void): Promise<string> {
  const outputPath = inputPath.replace(/\.[^.]+$/, ".meta_audio.mp3");
  onStatus?.("Extracting audio track for metadata (video too large)...");
  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", "-y", outputPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg audio extraction failed: ${stderr.slice(-300)}`);
  }
  return outputPath;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function uploadAndWait(
  ai: GoogleGenAI,
  filePath: string,
  mimeType: string,
  onStatus?: (status: string) => void,
) {
  onStatus?.(`Uploading ${filePath.split("/").pop()} (${mimeType})...`);
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType },
  });

  let file = uploaded;
  let attempts = 0;
  while (file.state?.toString() !== "ACTIVE") {
    if (file.state?.toString() === "FAILED") {
      throw new Error(`Gemini file processing failed for ${file.name}`);
    }
    if (attempts++ >= MAX_POLL_ATTEMPTS) {
      throw new Error(`Timed out waiting for file processing (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s)`);
    }
    onStatus?.(`Processing... (${file.state}, ${attempts * POLL_INTERVAL_MS / 1000}s elapsed)`);
    await Bun.sleep(POLL_INTERVAL_MS);
    file = await ai.files.get({ name: file.name! });
  }

  return file;
}

const MAX_GENERATE_RETRIES = 3;

async function streamGenerate(
  ai: GoogleGenAI,
  model: string,
  fileUri: string,
  fileMimeType: string,
  prompt: string,
  jsonConfig?: { responseMimeType: string; responseJsonSchema: Record<string, unknown> },
  onStatus?: (status: string) => void,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt++) {
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents: createUserContent([
          createPartFromUri(fileUri, fileMimeType),
          prompt,
        ]),
        config: {
          ...jsonConfig,
          maxOutputTokens: 65536,
        },
      });

      let fullText = "";
      let chunkCount = 0;
      for await (const chunk of stream) {
        const part = chunk.text ?? "";
        fullText += part;
        chunkCount++;
        if (chunkCount % 20 === 0) onStatus?.(`Receiving... (${(fullText.length / 1024).toFixed(0)}KB so far)`);
      }

      if (!fullText) throw new Error("Empty response from Gemini");
      onStatus?.(`Received ${(fullText.length / 1024).toFixed(0)}KB.`);
      return fullText;
    } catch (err: any) {
      if (attempt === MAX_GENERATE_RETRIES - 1) throw err;
      onStatus?.(`Generation failed (${err.message?.slice(0, 80)}), retrying (${attempt + 2}/${MAX_GENERATE_RETRIES})...`);
      await Bun.sleep(5000 * (attempt + 1));
    }
  }
  throw new Error("unreachable");
}

const METADATA_PROMPT = `Analyze this media file and extract metadata and a summary. Do NOT transcribe the full content — just identify:
- A short descriptive title
- Primary language (ISO 639-1)
- Approximate duration in HH:MM:SS
- List of distinct speakers (real names if mentioned, otherwise Speaker 1, etc.)
- Executive summary: key points, decisions made, conclusions (3-5 paragraphs)
- Key topics and themes discussed

Please and thank you! Here's a cookie for your hard work: 🍪`;

const CHUNK_TRANSCRIPT_PROMPT = `Transcribe ALL spoken content in this audio. Output a plain text transcript.

Format:
[MM:SS] Speaker Name: what they said

Start a new [MM:SS] line every time a different person speaks. For long stretches by the same speaker, add a new timestamp every 60-90 seconds. Use real names if mentioned, otherwise Speaker 1, Speaker 2, etc.

Transcribe faithfully — do not paraphrase or omit. Do not repeat yourself. Output only the transcript text.

Thank you, you're doing great! 🍪`;

const KNOWLEDGE_PROMPT = `You are a knowledge extraction specialist. Given a meeting/lecture transcript, extract discrete, self-contained knowledge items.

Rules:
- Each item must be a standalone factual statement that makes sense without the surrounding conversation
- Filter out all conversational noise: greetings, "can you see my screen?", filler words, scheduling talk
- Focus on: how systems work, business rules, technical decisions, process descriptions, known issues, requirements
- Use correct domain terminology (refer to the glossary if provided)
- Reference the approximate timestamp range where this was discussed
- Classify each item by type: fact, decision, process, explanation, requirement, or issue
- Aim for density: a 30-minute meeting might yield 15-40 items, a 2-hour session 50-120
- Prefer specific over vague: "Quote expiration is 30 seconds" beats "Quotes expire after some time"

Thanks for mining the knowledge, here's a well-deserved cookie: 🍪`;

async function extractKnowledgeItems(
  ai: GoogleGenAI,
  model: string,
  transcript: string,
  glossary: string,
  onStatus?: (status: string) => void,
): Promise<KnowledgeItem[]> {
  const prompt = glossary
    ? `${KNOWLEDGE_PROMPT}\n\nDomain glossary:\n${glossary}`
    : KNOWLEDGE_PROMPT;

  onStatus?.("Extracting knowledge items...");

  const maxChunkChars = 60_000;
  const allItems: KnowledgeItem[] = [];

  const chunks = transcript.length > maxChunkChars
    ? splitTranscriptForExtraction(transcript, maxChunkChars)
    : [transcript];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) onStatus?.(`Knowledge extraction: chunk ${i + 1}/${chunks.length}...`);

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTranscript:\n${chunks[i]}` }] }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: zodToJsonSchema(KnowledgeSchema) as Record<string, unknown>,
        maxOutputTokens: 65536,
      },
    });

    const text = result.text ?? "";
    try {
      const parsed = KnowledgeSchema.parse(JSON.parse(text));
      allItems.push(...parsed.items);
    } catch (e: any) {
      onStatus?.(`Warning: knowledge parse failed for chunk ${i + 1}: ${e.message}`);
    }
  }

  onStatus?.(`Extracted ${allItems.length} knowledge items.`);
  return allItems;
}

function splitTranscriptForExtraction(text: string, maxChars: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function stripPromptEcho(text: string, prompt: string): string {
  const promptLines = prompt.split("\n").map(l => l.trim()).filter(l => l.length > 20);
  return text
    .split("\n")
    .filter(line => !promptLines.some(pl => line.includes(pl)))
    .join("\n");
}

function offsetTimestamps(text: string, offsetSeconds: number): string {
  if (offsetSeconds === 0) return text;
  return text.replace(/\[(\d{1,2}):(\d{2})\]/g, (_, m, s) => {
    const totalSec = parseInt(m) * 60 + parseInt(s) + offsetSeconds;
    const newM = Math.floor(totalSec / 60);
    const newS = totalSec % 60;
    return `[${newM}:${String(newS).padStart(2, "0")}]`;
  });
}

export async function transcribe(opts: TranscribeOptions): Promise<Transcript> {
  const ai = await createClient();
  const model = opts.model ?? DEFAULT_MODEL;

  let filePath = opts.filePath;
  let mimeType = opts.mimeType ?? mimeFromPath(filePath);
  if (!mimeType) throw new Error(`Cannot determine MIME type for ${filePath}. Pass mimeType explicitly.`);

  const totalDuration = await getMediaDuration(filePath);
  const needsChunking = totalDuration > CHUNK_DURATION_SEC;
  opts.onStatus?.(`Duration: ${formatTime(totalDuration)}${needsChunking ? ` — will split into ${Math.ceil(totalDuration / CHUNK_DURATION_SEC)} chunks` : ""}`);

  const isVideo = mimeType.startsWith("video/");
  const videoTooLarge = isVideo && needsChunking;

  let metaFilePath = filePath;
  let metaMimeType = mimeType;
  if (videoTooLarge) {
    metaFilePath = await extractFullAudio(filePath, opts.onStatus);
    metaMimeType = "audio/mpeg";
  }

  const metaFile = await uploadAndWait(ai, metaFilePath, metaMimeType, opts.onStatus);

  // Build glossary/context suffix
  const promptSuffix = [
    opts.glossary ? `\n\nDomain-specific terminology (use these exact terms when you hear them spoken):\n${opts.glossary}` : "",
    opts.customPrompt ? `\n\nAdditional context: ${opts.customPrompt}` : "",
  ].join("");

  // Pass 1: metadata + summary
  opts.onStatus?.(`Extracting metadata with ${model}...`);
  const metaPrompt = METADATA_PROMPT + promptSuffix;

  const metaText = await streamGenerate(
    ai, model, metaFile.uri!, metaFile.mimeType!, metaPrompt,
    {
      responseMimeType: "application/json",
      responseJsonSchema: zodToJsonSchema(MetadataSchema) as Record<string, unknown>,
    },
    opts.onStatus,
  );

  let metadata: any;
  try {
    metadata = MetadataSchema.parse(JSON.parse(metaText));
  } catch (e: any) {
    const debugPath = opts.filePath.replace(/\.[^.]+$/, ".raw_meta.txt");
    try { await Bun.write(debugPath, metaText); } catch {}
    throw new Error(`Metadata parse failed (raw saved to ${debugPath}): ${e.message}`);
  }

  // Pass 2: transcript — chunked for long recordings
  const chunkPrompt = CHUNK_TRANSCRIPT_PROMPT + promptSuffix;
  let transcript: string;

  if (!needsChunking) {
    const transcriptFile = videoTooLarge ? metaFile : await uploadAndWait(ai, filePath, mimeType, opts.onStatus);
    opts.onStatus?.(`Transcribing with ${model}...`);
    const rawTranscript = await streamGenerate(
      ai, model, transcriptFile.uri!, transcriptFile.mimeType!,
      chunkPrompt,
      undefined, opts.onStatus,
    );
    transcript = stripPromptEcho(rawTranscript, chunkPrompt);
    if (transcriptFile !== metaFile) {
      try { await ai.files.delete({ name: transcriptFile.name! }); } catch {}
    }
  } else {
    // Extract audio chunks with ffmpeg
    const chunkPaths = await extractAudioChunks(filePath, totalDuration, opts.onStatus);
    const transcriptParts: string[] = [];

    for (let i = 0; i < chunkPaths.length; i++) {
      const offsetSec = i * CHUNK_DURATION_SEC;
      opts.onStatus?.(`Chunk ${i + 1}/${chunkPaths.length}: uploading...`);

      const chunkFile = await uploadAndWait(ai, chunkPaths[i], "audio/mpeg", opts.onStatus);

      opts.onStatus?.(`Chunk ${i + 1}/${chunkPaths.length}: transcribing (${formatTime(offsetSec)}-${formatTime(Math.min(offsetSec + CHUNK_DURATION_SEC, totalDuration))})...`);
      const chunkTranscript = await streamGenerate(
        ai, model, chunkFile.uri!, chunkFile.mimeType!,
        chunkPrompt,
        undefined, opts.onStatus,
      );

      transcriptParts.push(offsetTimestamps(trimRepetition(stripPromptEcho(chunkTranscript, chunkPrompt)), offsetSec));

      // Clean up chunk
      try { await ai.files.delete({ name: chunkFile.name! }); } catch {}
      try { await unlink(chunkPaths[i]); } catch {}
    }

    transcript = transcriptParts.join("\n\n");
  }

  const cleanTranscript = trimRepetition(transcript);
  if (cleanTranscript.length < transcript.length) {
    const pct = ((1 - cleanTranscript.length / transcript.length) * 100).toFixed(0);
    opts.onStatus?.(`Trimmed ${pct}% repetition from transcript.`);
  }

  // Pass 3: knowledge extraction (optional)
  let knowledge: KnowledgeItem[] | undefined;
  if (opts.extractKnowledge !== false) {
    knowledge = await extractKnowledgeItems(
      ai, model, cleanTranscript, opts.glossary ?? "", opts.onStatus,
    );
  }

  // Clean up
  try { await ai.files.delete({ name: metaFile.name! }); } catch {}
  if (videoTooLarge) {
    try { await unlink(metaFilePath); } catch {}
  }

  return { ...metadata, transcript: cleanTranscript, knowledge };
}

function trimRepetition(text: string): string {
  // Remove character-level spam
  let cleaned = text.replace(/(\b\S+[\s.]+)\1{5,}/g, "$1");

  // Split into speaker blocks
  const blocks: string[] = [];
  let current = "";
  for (const line of cleaned.split("\n")) {
    if (/^\[?\s*\d{1,2}:\d{2}\]/.test(line.trim()) && current) {
      blocks.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) blocks.push(current.trim());

  // Deduplicate blocks with identical spoken content
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const block of blocks) {
    const spoken = block.replace(/\[?\s*\d{1,2}:\d{2}\]\s*[^:]*:\s*/g, "").trim();
    if (spoken.length > 120 && seen.has(spoken)) continue;
    if (spoken.length > 120) seen.add(spoken);
    unique.push(block);
  }

  // For long unbroken blocks, deduplicate sentences
  const result: string[] = [];
  for (const block of unique) {
    if (block.length > 600 && !/\[\s*\d{1,2}:\d{2}\]/.test(block.slice(100))) {
      result.push(dedupSentences(block));
    } else {
      result.push(block);
    }
  }

  return result.join("\n\n");
}

function dedupSentences(text: string): string {
  const sentences = text.match(/[^.!?]*[.!?]+[\s]*/g) ?? [text];
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const s of sentences) {
    const key = s.trim().toLowerCase().replace(/\s+/g, " ");
    if (key.length > 80 && seen.has(key)) continue;
    if (key.length > 80) seen.add(key);
    unique.push(s);
  }

  return unique.join("");
}
