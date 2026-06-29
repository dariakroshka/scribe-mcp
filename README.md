# Scribe MCP

Audio/video transcription, summarization, and knowledge extraction tool powered by Gemini. Works as a standalone CLI, Notion integration, MCP server tool for agent ecosystems, or a full connectome-host fleet persona.

## What it does

Given a video or audio recording, Scribe produces:

- **Summary** — executive summary with title, language, speakers, and key topics
- **Knowledge items** — structured, self-contained facts extracted from the conversation, categorized by type (fact, decision, process, explanation, requirement, issue) with timestamps
- **Full transcript** — timestamped, speaker-attributed transcript in `[MM:SS] Speaker: text` format

Long recordings are automatically split into 10-minute audio chunks via ffmpeg to avoid LLM degeneration on extended output. A domain glossary can be provided — from a local file, a MediaWiki page, or both — to improve recognition of business-specific terminology.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [ffmpeg](https://ffmpeg.org/) and ffprobe (for chunking and duration detection)
- Gemini API key (`GEMINI_API_KEY`)
- Notion integration token (`NOTION_API_KEY`) — for Notion mode only

## Setup

```bash
git clone <repo-url> && cd scribe-mcp
bun install
cp .env.example .env
# Edit .env with your API keys
```

### Notion integration setup

1. Go to https://www.notion.so/my-integrations and create an internal integration
2. Grant it **Read content**, **Insert content**, and **Upload files** permissions
3. Copy the token into `.env` as `NOTION_API_KEY`
4. On each Notion page you want to process: **...** > **Connections** > add your integration

## Usage

### Local file transcription

```bash
# Markdown output to stdout
bun src/cli.ts recording.mp4

# With glossary for domain-specific terms
bun src/cli.ts recording.mp4 --glossary glossary.txt

# Save to file
bun src/cli.ts recording.mp4 --output transcript.md

# JSON output
bun src/cli.ts recording.mp4 --json --output transcript.json
```

### Notion — single page

Scans a Notion page for video/audio attachments, transcribes each, and creates two subpages:
- **📝 Title** — summary, topics, knowledge items, plus `.md` file download
- **📜 Title — Transcript** — full timestamped transcript

```bash
bun src/cli.ts --notion "https://www.notion.so/workspace/page-name-abc123" --glossary glossary.txt
```

### Notion — batch mode

Create a text file with one Notion page URL per line (lines starting with `#` are skipped):

```
# pages.txt
https://www.notion.so/workspace/page-one-abc123
https://www.notion.so/workspace/page-two-def456
https://www.notion.so/workspace/page-three-ghi789
```

```bash
bun src/cli.ts --batch pages.txt --glossary glossary.txt
```

Processes sequentially, continues past failures, reports progress.

### Chat mode

Talk to Scribe directly — ask about glossary terms, get help interpreting transcripts, or provide context before a transcription run.

```bash
# Interactive REPL
bun src/cli.ts --chat --glossary glossary.txt

# One-shot question
bun src/cli.ts --chat "What is a Driver Server?" --glossary glossary.txt

# Transcribe a Notion page, then chat about it
bun src/cli.ts --chat --notion "https://www.notion.so/workspace/page-abc123" --glossary glossary.txt

# Transcribe a local file, then chat about it
bun src/cli.ts --chat /path/to/recording.mp4 --glossary glossary.txt
```

When combined with `--notion` or a file path, Scribe transcribes first, then enters chat with the full transcript as context.

### MCP server

```bash
bun src/index.ts
```

Exposes four tools over stdio:

| Tool | Description |
|------|-------------|
| `transcribe` | Transcribe a local audio/video file |
| `probe` | Check file format and estimate token cost |
| `scribe_notion_page` | Scan Notion page, transcribe media, post results |
| `chat` | Free-text conversation with Scribe (glossary-aware, remembers recent transcripts) |

#### MCP server config (for connectome-host or Claude Desktop)

```json
{
  "scribe": {
    "command": "bun",
    "args": ["src/index.ts"],
    "cwd": "/path/to/scribe-mcp",
    "env": {
      "GEMINI_API_KEY": "${GEMINI_API_KEY}",
      "NOTION_API_KEY": "${NOTION_API_KEY}",
      "SCRIBE_GLOSSARY_PATH": "/path/to/glossary.txt",
      "SCRIBE_GLOSSARY_URL": "http://your-wiki/wiki/index.php/Glossary_Page"
    }
  }
}
```

### CLI options

```
Commands:
  <file>           Transcribe a local audio/video file
  --notion <url>   Scan a Notion page for media, transcribe, and post back
  --batch <file>   Process multiple Notion pages (one URL per line)
  --chat [msg]     Chat with Scribe (interactive REPL, or one-shot with message)

Options:
  --audio-only         Extract audio before uploading (cheaper, needs ffmpeg)
  --model <name>       Gemini model (default: gemini-2.5-flash)
  --glossary <path>    File with domain-specific terms to improve recognition
  --glossary-url <url> MediaWiki page URL to fetch glossary from (merged with --glossary)
  --json               Output raw JSON instead of markdown
  --output <path>      Write output to file instead of stdout
  --prompt <text>      Additional instructions for the transcription
  --help               Show this help
```

## Glossary

A domain glossary improves recognition of spoken jargon, abbreviations, and cross-language terms. Scribe supports two glossary sources that can be used independently or together (merged at load time):

### Local file (`--glossary` or `SCRIBE_GLOSSARY_PATH`)

A plain text file, one term per line:

```
Locate Router / LR — middleware handling short-sale locate requests
NBBO (National Best Bid and Offer) — best bid/ask across all US exchanges
локейт = locate
венью = venue
```

See `glossary.txt` for a full example.

### MediaWiki page (`--glossary-url` or `SCRIBE_GLOSSARY_URL`)

A URL to a MediaWiki page. Scribe fetches the page content via the MediaWiki API (`action=query&prop=extracts&explaintext=1`). The page is fetched on startup and refreshed every 30 minutes when running as an MCP server.

```bash
# CLI
bun src/cli.ts recording.mp4 --glossary-url "http://wiki.example.com/wiki/index.php/Glossary"

# Or via environment variable
export SCRIBE_GLOSSARY_URL="http://wiki.example.com/wiki/index.php/Glossary"
bun src/cli.ts recording.mp4
```

When both sources are set, wiki content is prepended to the local file content.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Gemini API key for transcription |
| `NOTION_API_KEY` | For Notion modes | Notion integration token |
| `SCRIBE_GLOSSARY_PATH` | No | Path to local glossary file |
| `SCRIBE_GLOSSARY_URL` | No | MediaWiki page URL for glossary (auto-refreshes every 30min in MCP mode) |

## Connectome-host integration

Scribe integrates with [connectome-host](https://github.com/anima-research/connectome-host) in two ways — as an MCP tool on an existing agent, or as a standalone fleet persona. See [recipes/CONNECTOME.md](recipes/CONNECTOME.md) for full setup and comparison.

## Architecture

```
src/
  cli.ts      — CLI entry point (file, --notion, --batch, --chat modes)
  index.ts    — MCP server (stdio transport, 4 tools)
  gemini.ts   — Core transcription engine (3-pass: metadata -> transcript -> knowledge)
  notion.ts   — Notion API integration (download, post, file upload, dedup)
  format.ts   — Markdown formatting
  types.ts    — Zod schemas (Metadata, KnowledgeItem, Transcript)
```

### Processing pipeline

1. **Upload & metadata** — upload file (audio-only for videos >10min), extract title/summary/topics via structured JSON generation
2. **Chunked transcription** — split into 10-min audio chunks via ffmpeg, transcribe each with Gemini, offset timestamps, merge
3. **Knowledge extraction** — process transcript text through Gemini to extract structured knowledge items
4. **Post-processing** — strip prompt echoes, deduplicate repetitions, format output

### Key design decisions

- **Two-pass media processing**: metadata as small structured JSON, transcript as plain text — avoids JSON string escaping overhead and output token limits
- **10-minute audio chunks**: prevents LLM text degeneration (repetition loops) on long generation tasks; all autoregressive models exhibit this
- **Audio-only for metadata on long videos**: video tokens (~300/sec) exceed Gemini's 1M input limit on recordings >10min; audio (~32/sec) stays well within bounds
- **Two Notion subpages**: agents read the summary/knowledge page first (small, dense), drill into transcript only when needed — progressive disclosure
- **Retry with resume**: large file downloads use curl with `-C -` and up to 5 retries; Gemini API calls retry up to 3 times with backoff
- **Media deduplication**: Notion sometimes represents the same file as multiple block types (video + file); scribe deduplicates by filename before processing
- **Chat via Gemini**: the `chat` tool routes conversation through Gemini (not Claude), keeping costs low while providing glossary-aware, transcript-aware responses
