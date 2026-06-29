# Scribe + Connectome-Host Integration

Two ways to bring Scribe into a connectome-host deployment: as an **MCP tool** on an existing agent, or as a **fleet persona** (standalone child process). Both are production-ready; the choice depends on how your team wants to use transcription.

## Comparison

| | MCP Tool | Fleet Persona |
|---|---|---|
| **What it is** | Tool on the miner's MCP server | Standalone fleet child with its own recipe |
| **Who calls it** | Miner (or any agent with scribe in its mcpServers) | Conductor, clerk, or user via `fleet--send` / queue |
| **Cost model** | Gemini tokens per transcription only | Claude session (Sonnet) + Gemini tokens per transcription |
| **Memory** | Remembers last 5 transcripts within MCP session | Full autobiographical context across the session |
| **Chat** | `scribe--chat` tool (Gemini-backed, stateless between calls) | Conversational via `fleet--send` or direct messages |
| **Use case** | Miner encounters a video while mining — transcribe it | Dedicated transcription service, interactive Q&A about recordings |
| **Autonomy** | Reactive — only runs when called | Proactive — watches a queue, wakes on new jobs |

**Rule of thumb**: use the tool if transcription is incidental to mining. Use the persona if transcription is a primary workflow — batch processing, follow-up questions, or the clerk routing transcription requests without involving the miner.

## Option A: MCP Tool on the Miner

The miner gets scribe tools (`scribe--transcribe`, `scribe--probe`, `scribe--scribe_notion_page`, `scribe--chat`) and uses them when it encounters media during knowledge mining.

### 1. Add scribe to knowledge-miner.json

Add this block under `mcpServers` in `recipes/knowledge-miner.json`:

```json
"scribe": {
  "command": "bun",
  "args": ["../scribe-mcp/src/index.ts"],
  "env": {
    "GEMINI_API_KEY": "${GEMINI_API_KEY}",
    "NOTION_API_KEY": "${NOTION_API_KEY}",
    "SCRIBE_GLOSSARY_PATH": "./data/miner/input/glossary.txt",
    "SCRIBE_GLOSSARY_URL": "${SCRIBE_GLOSSARY_URL}"
  },
  "source": {
    "url": "https://github.com/anima-research/scribe-mcp.git",
    "install": { "runtime": "custom", "run": "bun install" },
    "inContainer": { "path": "/scribe-mcp" }
  }
}
```

### 2. Add to the miner's system prompt

Add after the existing data source sections:

```
### 5. Scribe (audio/video transcription)
Use `scribe--*` tools to transcribe recordings found on Notion pages or local files:
- `scribe--transcribe` — transcribe a local audio/video file; returns summary, knowledge items, and full transcript
- `scribe--probe` — check file format and estimate processing cost before transcribing
- `scribe--scribe_notion_page` — scan a Notion page for video/audio attachments, transcribe each, and post results back as subpages
- `scribe--chat` — ask follow-up questions about transcribed content

When you encounter a Notion page with video or audio attachments during mining:
1. Use `scribe--scribe_notion_page` with the page URL to transcribe all media on that page
2. The tool creates two subpages per video: summary+knowledge (📝) and full transcript (📜)
3. Incorporate the knowledge items from the transcription into your mining output
4. Cite video sources as `[SRC: scribe: <video-title>]`

Use it when you encounter media files — don't proactively search for videos.

### Domain Glossary
A glossary of domain-specific terms is available at `input/glossary.txt`. Read it at the start of a session to familiarize yourself with the org's terminology. The same glossary is used by scribe for accurate transcription.
```

### 3. Add env vars to .env

```ini
GEMINI_API_KEY=your-gemini-api-key
NOTION_API_KEY=your-notion-integration-token
SCRIBE_GLOSSARY_URL=http://your-wiki/wiki/index.php/Glossary_Overview
```

(`NOTION_API_KEY` may already be present if syncntn is configured.)

### 4. Place the glossary

Copy the glossary file into the miner's input mount:

```bash
mkdir -p data/miner/input
cp /path/to/glossary.txt data/miner/input/glossary.txt
```

If `SCRIBE_GLOSSARY_URL` is set, the wiki glossary is fetched on startup and refreshed every 30 minutes. The local file serves as a fallback if the wiki is unreachable.

### 5. Restart the miner

```bash
# From the conductor TUI:
/fleet restart miner
```

The miner will now see `scribe--*` tools in its tool list.

---

## Option B: Fleet Persona

Scribe runs as a fourth fleet child alongside miner, reviewer, and clerk. It has its own personality, workspace, and job queue.

### 1. Place the recipe

Copy `scribe.json` from this repo's `recipes/` directory to `connectome-host/recipes/scribe.json`, or create it with the content below.

<details>
<summary>recipes/scribe.json (click to expand)</summary>

```json
{
  "name": "Scribe",
  "description": "Audio/video transcription specialist — transcribes recordings, extracts knowledge, and answers questions about content it has processed.",
  "version": "1.0.0",
  "agent": {
    "name": "scribe",
    "model": "claude-sonnet-4-6",
    "maxTokens": 16384,
    "systemPrompt": "<see recipes/scribe.json for full prompt>",
    "strategy": {
      "type": "autobiographical",
      "headWindowTokens": 4000,
      "recentWindowTokens": 30000,
      "maxMessageTokens": 10000
    }
  },
  "mcpServers": {
    "scribe": {
      "command": "bun",
      "args": ["../scribe-mcp/src/index.ts"],
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}",
        "NOTION_API_KEY": "${NOTION_API_KEY}",
        "SCRIBE_GLOSSARY_PATH": "./data/scribe/input/glossary.txt",
        "SCRIBE_GLOSSARY_URL": "${SCRIBE_GLOSSARY_URL}"
      },
      "source": {
        "url": "https://github.com/anima-research/scribe-mcp.git",
        "install": { "runtime": "custom", "run": "bun install" },
        "inContainer": { "path": "/scribe-mcp" }
      }
    }
  },
  "modules": {
    "subagents": true,
    "lessons": true,
    "retrieval": false,
    "wake": {
      "policies": [
        { "name": "user-input", "match": { "scope": ["external-message"] }, "behavior": "always" },
        { "name": "subagent-completions", "match": { "scope": ["inference-request"] }, "behavior": "always" },
        { "name": "new-jobs", "match": { "scope": ["workspace:created"], "mount": "queue", "pathGlob": "queue/*" }, "behavior": "always" }
      ],
      "default": "skip"
    },
    "workspace": {
      "configMount": true,
      "mounts": [
        { "name": "input", "path": "./input", "mode": "read-only" },
        { "name": "library-mined", "path": "./library-mined", "mode": "read-only" },
        { "name": "products", "path": "./output", "mode": "read-write", "autoMaterialize": true },
        { "name": "queue", "path": "./scribe-queue", "mode": "read-write", "watch": "always", "wakeOnChange": ["created"], "autoMaterialize": true }
      ]
    }
  }
}
```

</details>

### 2. Add scribe as a fleet child in triumvirate.json

Add to the `children` array in `recipes/triumvirate.json`:

```json
{
  "name": "scribe",
  "recipe": "scribe.json",
  "dataDir": "./data/scribe",
  "autoStart": true,
  "subscription": ["lifecycle", "inference:completed", "inference:speech", "tool:completed", "tool:failed", "inference:failed"]
}
```

### 3. Update the conductor's system prompt

Add scribe to the conductor's child list in `recipes/triumvirate.json`:

```
- **scribe** (recipes/scribe.json) — Transcription Department. Processes audio/video recordings,
  extracts knowledge, posts results to Notion. Wakes on new files in `scribe-queue/`.
  Can be messaged directly for follow-up questions about transcribed content.
```

And add to the coordinator's "allowedRecipes" if applicable.

### 4. Set up the workspace

```bash
mkdir -p data/scribe/input
cp /path/to/glossary.txt data/scribe/input/glossary.txt
mkdir -p scribe-queue
```

### 5. Add env vars to .env

Same as Option A:

```ini
GEMINI_API_KEY=your-gemini-api-key
NOTION_API_KEY=your-notion-integration-token
SCRIBE_GLOSSARY_URL=http://your-wiki/wiki/index.php/Glossary_Overview
```

### 6. Launch

```bash
bun src/index.ts recipes/triumvirate.json
```

Scribe auto-starts as a fourth child. Verify with `/fleet list`.

### How other agents interact with Scribe

**Clerk routing a user request:**
The clerk can ask the conductor to relay a transcription request: "Ask scribe to transcribe this page: <url>". The conductor uses `fleet--send scribe "Transcribe this page: <url>"`.

**Queue-based (autonomous):**
Drop a file into `scribe-queue/` with a Notion URL and optional instructions. Scribe wakes and processes it.

```markdown
# scribe-queue/2026-05-18-rass-demo.md
https://www.notion.so/workspace/page-abc123

Focus on the RASS configuration changes discussed after the 15-minute mark.
```

**Direct message:**
From the conductor TUI: `@scribe What did Max say about clearance workflows in the last video?`

---

## Using both options together

The two options are not mutually exclusive. You can run scribe as a fleet persona AND have the miner reference scribe tools. The fleet persona is the "person" — the miner's tool is the "ability." In practice:

- The **miner** uses `scribe--*` tools when it stumbles on video during mining (incidental)
- The **scribe persona** handles dedicated transcription requests routed through the clerk or queue (intentional)
- Both share the same underlying MCP server code and glossary

The persona's Claude session provides memory and reasoning across transcriptions; the miner's tool call is fire-and-forget.

---

## Glossary sources

Both options support the same glossary configuration:

| Source | Env var | Behavior |
|--------|---------|----------|
| Local file | `SCRIBE_GLOSSARY_PATH` | Read once at startup |
| MediaWiki page | `SCRIBE_GLOSSARY_URL` | Fetched at startup, refreshed every 30 minutes |

When both are set, the wiki content is prepended to the local file content. If the wiki is unreachable, the local file is used as fallback.

The wiki URL should point to a MediaWiki `index.php` page. The MCP server extracts the page name and queries the MediaWiki API for plain-text content.
