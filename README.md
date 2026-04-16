# CloudCtx

Persistent memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). One command, full recall.

## The problem

Claude Code forgets everything between sessions. When context gets long, it compacts — and forgets even more. You end up re-explaining your project, your preferences, and your past decisions. Every. Single. Time.

## The fix

CloudCtx gives Claude Code permanent memory. Every conversation is indexed into a local SQLite database. Your agent can search across months of history instantly, survives compaction without losing context, and you can jump back into any saved thread with a single command.

```bash
npm install -g cloudctx
cloudctx init
```

That's it. Zero config. Works immediately.

---

## Three features that matter

### 1. Persistent memory

Every message from every Claude Code session is indexed into a local SQLite database with FTS5 full-text search. Your agent can recall past errors, decisions, and solutions across all projects and sessions.

Claude searches it automatically (CloudCtx adds instructions to your `CLAUDE.md`), or you can search manually:

```bash
# Full-text search across all conversations
cloudctx query "redis connection timeout"

# Raw SQL for complex queries
cloudctx sql "SELECT type, substr(content,1,200), timestamp FROM messages WHERE content LIKE '%deploy%' ORDER BY timestamp DESC LIMIT 5"
```

The database grows with you. Months of conversations, tens of thousands of messages — SQLite handles it without breaking a sweat.

### 2. Compaction recovery

When Claude Code compresses your context (manually via `/compact` or automatically when the conversation gets long), important details disappear. CloudCtx detects compaction and automatically re-injects the last 40 messages from your database back into the conversation.

The result: your agent picks up where it left off instead of starting from scratch. No more "I don't have context about what we were doing." Compaction becomes a non-event.

### 3. Thread launcher

Long-running threads are powerful — but you need a way to get back to them. Instead of keeping terminal tabs open or hunting through session IDs, CloudCtx lets you bookmark threads by name and resume them from an interactive picker.

```bash
# Save your current conversation as a named copilot
cloudctx launch --save "meta-ads-copilot"

# Later — launch the interactive picker
cloudctx launch
```

The launcher is a full TUI: arrow keys to navigate, enter to resume, `d` to delete. It shows every saved thread sorted by last activity, and drops you straight back into the session with `claude --resume`.

```
  CloudCtx — Select a thread to resume
  ↑↓ navigate  ⏎ select  d delete  q quit

  ❯ meta-ads-copilot                   2026-04-16
    web-design-copilot                 2026-04-15
    quote-builder                      2026-04-12
    data-pipeline                      2026-04-11
```

---

## Install

```bash
npm install -g cloudctx
cloudctx init
```

`init` handles everything:
1. Creates a SQLite database at `~/.cloudctx/conversations.db`
2. Parses all existing Claude Code conversations into it
3. Installs a `UserPromptSubmit` hook for real-time indexing
4. Adds a memory block to `~/.claude/CLAUDE.md` so Claude knows how to search

### Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed

---

## Additional features

### Doc ingestion

Ingest reference docs (URLs, llms.txt files, local markdown) so Claude can search them alongside your conversation history.

```bash
cloudctx docs ingest https://example.com/llms.txt "api,reference"
cloudctx docs ingest ./api-reference.md "docs"
cloudctx docs search "authentication"
cloudctx docs list
```

### Database management

```bash
cloudctx status                   # Database stats
cloudctx sync                     # Incremental sync of new conversations
cloudctx seed                     # Full re-import from all sessions
cloudctx import /path/to/other.db # Import from another SQLite database
```

---

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

### Hook system

CloudCtx installs two hooks in `~/.claude/settings.json`:

- **`UserPromptSubmit`** — syncs the current session to the database on every prompt and injects memory reminders (or compaction recovery if detected)
- **`SessionEnd`** — runs an async incremental sync when a session closes

### Database schema

| Table | Purpose |
|-------|---------|
| `sessions` | One row per conversation session |
| `messages` | Every user/assistant message with metadata (model, tokens, timestamps, git branch, cwd) |
| `tool_uses` | Tool calls extracted from assistant messages |
| `prompt_history` | User prompt history across sessions |
| `summaries` | Compaction summaries |
| `docs` | Ingested reference documents |
| `saved_threads` | Named thread bookmarks |
| `messages_fts` | FTS5 full-text search over messages |
| `docs_fts` | FTS5 full-text search over docs |

---

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
