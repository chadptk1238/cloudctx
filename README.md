# CloudCtx

Persistent memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). One command, full recall.

CloudCtx gives Claude Code a long-term memory by indexing every conversation into a local SQLite database with full-text search. When context gets compacted, CloudCtx automatically re-injects recent messages so Claude doesn't lose track of what you were working on.

## What it does

- **Indexes all conversations** — parses Claude Code's JSONL session files into a searchable SQLite database
- **Full-text search** — FTS5 index over every message, instantly searchable via `cloudctx query`
- **Compaction recovery** — detects when Claude Code compresses context and re-injects recent messages automatically
- **Doc ingestion** — ingest reference docs (URLs or local files) so Claude can search them
- **Thread bookmarks** — save and resume named conversation threads with an interactive TUI picker
- **Zero config** — `cloudctx init` handles everything: database, hooks, CLAUDE.md instructions

## Install

```bash
npm install -g cloudctx
cloudctx init
```

That's it. `init` will:
1. Create a SQLite database at `~/.cloudctx/conversations.db`
2. Parse all existing Claude Code conversations into it
3. Install a `UserPromptSubmit` hook so new messages are indexed in real-time
4. Add a memory block to `~/.claude/CLAUDE.md` so Claude knows how to search

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed

## Usage

### Search your history

```bash
# Full-text search across all conversations
cloudctx query "fastapi websocket error"

# Raw SQL for complex queries
cloudctx sql "SELECT type, substr(content,1,200), timestamp FROM messages WHERE content LIKE '%migration%' ORDER BY timestamp DESC LIMIT 5"
```

### Ingest reference docs

```bash
# Ingest from URL (great for llms.txt files)
cloudctx docs ingest https://example.com/llms.txt "api,reference"

# Ingest a local file
cloudctx docs ingest ./api-reference.md "docs"

# Search ingested docs
cloudctx docs search "authentication"

# List all docs
cloudctx docs list
```

### Save and resume threads

```bash
# Save current conversation with a name
cloudctx launch --save "refactoring-auth-module"

# Interactive thread picker (arrow keys, enter to resume)
cloudctx launch

# List saved threads
cloudctx launch --list

# Remove a saved thread
cloudctx launch --remove "old-thread"
```

### Database management

```bash
# Check database stats
cloudctx status

# Incremental sync (picks up new conversations)
cloudctx sync

# Full re-import from all Claude Code sessions
cloudctx seed

# Import from another SQLite database
cloudctx import /path/to/other.db

# Remove everything (database, hooks, CLAUDE.md block)
cloudctx reset
```

## How it works

### Architecture

```
~/.claude/projects/**/*.jsonl    Claude Code's raw conversation files
         |
    cloudctx seed/sync           Parses JSONL into structured tables
         |
~/.cloudctx/conversations.db    SQLite + FTS5 full-text search
         |
    cloudctx hook                Runs on every prompt via UserPromptSubmit
         |
    Claude Code sees             Memory reminders + compaction recovery
```

### Database schema

| Table | Purpose |
|-------|---------|
| `sessions` | One row per conversation session |
| `messages` | Every user/assistant message with metadata |
| `tool_uses` | Tool calls extracted from assistant messages |
| `prompt_history` | User prompt history across sessions |
| `summaries` | Compaction summaries |
| `docs` | Ingested reference documents |
| `saved_threads` | Named thread bookmarks |
| `messages_fts` | FTS5 virtual table over messages |
| `docs_fts` | FTS5 virtual table over docs |

### Compaction detection

When Claude Code compresses context (manually via `/compact` or automatically), CloudCtx detects it on the next prompt and injects the last 40 messages from the database back into the conversation. This means Claude retains awareness of recent work even after compaction.

### Hook system

CloudCtx installs two hooks in `~/.claude/settings.json`:

- **`UserPromptSubmit`** — syncs the current session to the database on every prompt and injects memory reminders (or compaction recovery if detected)
- **`SessionEnd`** — runs an async incremental sync when a session closes

## All commands

```
cloudctx init                          Set up database, hooks, and CLAUDE.md
cloudctx import /path/to/db            Import from existing SQLite database
cloudctx query "search terms"          FTS search across all conversations
cloudctx sql "SELECT ..."              Raw read-only SQL query
cloudctx sync                          Incremental sync of new conversations
cloudctx seed                          Re-import all conversations
cloudctx status                        Database stats
cloudctx reset                         Remove everything

cloudctx launch                        Interactive thread picker
cloudctx launch --save "name" [id]     Save a thread for quick resume
cloudctx launch --remove "name"        Remove a saved thread
cloudctx launch --list                 List saved threads

cloudctx docs ingest <url|file> [tags] Ingest reference documentation
cloudctx docs list                     List all docs
cloudctx docs search "query"           Search docs
cloudctx docs delete <id>              Delete a doc

cloudctx hook                          (internal) UserPromptSubmit handler
cloudctx help                          Show help
```

## Uninstall

```bash
cloudctx reset
npm uninstall -g cloudctx
```

`reset` removes the database, hooks, and CLAUDE.md block. Your Claude Code conversations are never modified — CloudCtx only reads them.

## License

MIT
