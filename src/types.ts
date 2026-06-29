import { z } from "zod";

export const MetadataSchema = z.object({
  title: z.string().describe("Short descriptive title for this recording"),
  language: z.string().describe("Primary language detected (ISO 639-1 code)"),
  duration: z.string().describe("Approximate total duration in HH:MM:SS format"),
  speakers: z.array(z.string()).describe("List of distinct speakers identified"),
  summary: z.string().describe("Executive summary: key points, decisions, and conclusions (3-5 paragraphs)"),
  topics: z.array(z.string()).describe("Key topics and themes discussed"),
});

export const KnowledgeItemSchema = z.object({
  statement: z.string().describe("Self-contained factual statement, understandable without surrounding context"),
  topic: z.string().describe("Primary topic or system this relates to"),
  speakers: z.array(z.string()).describe("Who provided this information"),
  timestamp: z.string().describe("Approximate timestamp range, e.g. 12:30-14:00"),
  type: z.enum(["fact", "decision", "process", "explanation", "requirement", "issue"]).describe("Category of knowledge"),
});

export const KnowledgeSchema = z.object({
  items: z.array(KnowledgeItemSchema).describe("Extracted knowledge items"),
});

export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type Transcript = Metadata & { transcript: string; knowledge?: KnowledgeItem[] };

const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
};

export function mimeFromPath(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_MAP[ext];
}
