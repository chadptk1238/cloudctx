import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getReadonlyDb, getDb, dbExists, getDataDir, migrate } from './db.js';
import { processConversationFile } from './parser.js';
import { findJsonlForSession, readProjectCwd } from './launch.js';
import { installSlashCommand } from './install.js';

// Match either:
//   /cloudctx-save <name>     (slash-command form CC sends)
//   /cloudctx save "<name>"   (literal-text form, fallback)
const SAVE_PATTERN_SLASH = /^\/cloudctx-save\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
const SAVE_PATTERN_LITERAL = /^\/cloudctx\s+save\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
// /cloudctx-rename <args>  — captures everything after the command; routing decides 1-arg vs 2-arg
const RENAME_PATTERN_SLASH = /^\/cloudctx-rename\s+(\S[^\n]*?)\s*$/im;
const RENAME_PATTERN_LITERAL = /^\/cloudctx\s+rename\s+(\S[^\n]*?)\s*$/im;
// Used inside the routing decision to try parsing as "old new"
const TWO_ARG_PARSE = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/;
const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const SLASH_COMMAND_FILE = join(COMMANDS_DIR, 'cloudctx-save.md');
const SLASH_RENAME_FILE = join(COMMANDS_DIR, 'cloudctx-rename.md');

const CLAUDE_DIR = join(homedir(), '.claude');
const MARKER_DIR = join(getDataDir(), '.compaction-markers');
// Per-session sync state: caches the JSONL byte offset we last processed plus
// the cumulative count of compaction markers seen. Lets the hook skip a full
// re-read of the JSONL on every prompt — critical for resumed sessions whose
// JSONL can be tens of MB.
const SYNC_STATE_DIR = join(getDataDir(), '.sync-state');

const REMINDER = `CloudCtx is your memory (BM25-searchable past messages). Search BEFORE asking or guessing any unfamiliar term, tool, project, person, file, or API:

  cloudctx query "<term>"
  cloudctx sql "SELECT substr(content,1,500), timestamp FROM messages_fts f JOIN messages m ON f.rowid=m.id WHERE messages_fts MATCH '<term>' ORDER BY rank LIMIT 10"

FTS5 operators: AND / OR / NOT / "exact phrase" / prefix*

Searching memory is NEVER a silent fallback — it is the required first step. Ask the user only if memory returns nothing relevant.

Recent 4h context:
  cloudctx sql "SELECT type, substr(content,1,200), timestamp FROM messages WHERE timestamp > datetime('now','-4 hours') ORDER BY timestamp DESC LIMIT 10"

CRITICAL (task execution): If a method/API/tool/model fails mid-task, STOP and ASK. Never silently swap tools, models, or endpoints. No unrequested features or scope changes.`;

export function runHook() {
  // Read stdin JSON from Claude Code
  let input = '';
  try {
    input = readFileSync(0, 'utf-8');
  } catch {
    console.log(`Reminder: ${REMINDER}`);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    console.log(`Reminder: ${REMINDER}`);
    process.exit(0);
  }

  const sessionId = parsed.session_id || '';
  const prompt = parsed.prompt || '';
  const ccCwd = parsed.cwd || null;
  const transcriptPath = parsed.transcript_path || null;

  if (!sessionId || !dbExists()) {
    console.log(`Reminder: ${REMINDER}`);
    process.exit(0);
  }

  // Lazy-install slash commands for users upgrading from older versions
  if (!existsSync(SLASH_COMMAND_FILE) || !existsSync(SLASH_RENAME_FILE)) {
    try { installSlashCommand(); } catch {}
  }

  // Slash command intercepts
  const trimmed = prompt.trim();
  const saveMatch = trimmed.match(SAVE_PATTERN_SLASH) || trimmed.match(SAVE_PATTERN_LITERAL);
  if (saveMatch) {
    handleSaveCommand(sessionId, saveMatch[1] || saveMatch[2] || saveMatch[3], ccCwd, transcriptPath);
    process.exit(0);
  }
  const renameMatch = trimmed.match(RENAME_PATTERN_SLASH) || trimmed.match(RENAME_PATTERN_LITERAL);
  if (renameMatch) {
    handleRename(sessionId, renameMatch[1]);
    process.exit(0);
  }

  // Incrementally sync new JSONL records and get the cached cumulative
  // compaction-marker count. Single tail-read; no-op if file unchanged.
  const jsonlCompactions = syncCurrentSessionIncremental(sessionId);

  // Detect compaction: combine cached JSONL count with legacy agent-acompact files
  const compactionDetected = checkCompaction(sessionId, jsonlCompactions);

  if (compactionDetected) {
    injectPostCompactionContext(sessionId);
  } else {
    console.log(`Reminder: ${REMINDER}`);
  }

  process.exit(0);
}

function handleSaveCommand(sessionId, rawName, ccCwd = null, transcriptPath = null) {
  const name = rawName.trim();
  try {
    // Read line 1 of the jsonl for the SESSION's launch cwd.
    // parsed.cwd from CC reflects the user's CURRENT cwd, which may differ
    // from where claude was originally launched (the project cwd).
    // claude --resume only finds sessions whose project matches the spawn cwd.
    const jsonlPath = transcriptPath || findJsonlForSession(sessionId);
    let projectPath = jsonlPath ? readProjectCwd(jsonlPath) : null;
    if (!projectPath) projectPath = ccCwd; // last-resort fallback

    const db = getDb();
    migrate(db);
    db.prepare(`
      INSERT OR REPLACE INTO saved_threads (name, session_id, project_path, saved_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(name, sessionId, projectPath);
    db.close();

    const out = {
      decision: 'block',
      reason: `[CloudCtx] ✓ Saved "${name}"${projectPath ? `\nProject: ${projectPath}` : ''}\n\nResume from any directory: cloudctx launch`
    };
    console.log(JSON.stringify(out));
  } catch (e) {
    const out = {
      decision: 'block',
      reason: `[CloudCtx] Failed to save "${name}": ${e.message}`
    };
    console.log(JSON.stringify(out));
  }
}

function stripOuterQuotes(s) {
  const q = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/);
  return q ? q[1] : s;
}

function reply(reason) {
  console.log(JSON.stringify({ decision: 'block', reason: `[CloudCtx] ${reason}` }));
}

function handleRename(sessionId, argsStr) {
  try {
    const args = (argsStr || '').trim();
    if (!args) return reply('Usage: /cloudctx-rename <new-name>   (or)   /cloudctx-rename <old> <new>');

    const db = getDb();
    migrate(db);

    // Try to parse as two-arg form
    const two = args.match(TWO_ARG_PARSE);
    if (two) {
      const maybeOld = two[1] || two[2] || two[3];
      const maybeNew = two[4] || two[5] || two[6];
      const oldExists = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(maybeOld);
      if (oldExists) {
        if (maybeOld === maybeNew) {
          db.close();
          return reply(`Already named "${maybeNew}" — no change.`);
        }
        const collides = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(maybeNew);
        if (collides) {
          db.close();
          return reply(`Cannot rename: "${maybeNew}" already exists`);
        }
        db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(maybeNew, maybeOld);
        db.close();
        return reply(`✓ Renamed "${maybeOld}" → "${maybeNew}"`);
      }
      // First token wasn't a real thread — fall through to single-arg mode using the full args string
    }

    // Single-arg mode: rename THIS session's saved thread to the whole args string
    const newName = stripOuterQuotes(args).trim();
    if (!newName) {
      db.close();
      return reply('New name cannot be empty');
    }

    const current = db.prepare(
      'SELECT name FROM saved_threads WHERE session_id = ? ORDER BY saved_at DESC LIMIT 1'
    ).get(sessionId);

    if (!current) {
      db.close();
      return reply(`This session has no saved thread. Save it first with /cloudctx-save <name>`);
    }
    if (current.name === newName) {
      db.close();
      return reply(`Already named "${newName}" — no change.`);
    }
    const collides = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(newName);
    if (collides) {
      db.close();
      return reply(`Cannot rename: "${newName}" already exists`);
    }

    db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(newName, current.name);
    db.close();
    return reply(`✓ Renamed "${current.name}" → "${newName}"`);
  } catch (e) {
    return reply(`Rename failed: ${e.message}`);
  }
}

function readSyncState(sessionId) {
  const file = join(SYNC_STATE_DIR, sessionId);
  if (!existsSync(file)) return null;
  try {
    const [sizeStr, compStr] = readFileSync(file, 'utf-8').trim().split(',');
    const size = parseInt(sizeStr, 10);
    const compactions = parseInt(compStr, 10);
    if (Number.isNaN(size) || Number.isNaN(compactions)) return null;
    return { size, compactions };
  } catch {
    return null;
  }
}

function writeSyncState(sessionId, size, compactions) {
  try {
    mkdirSync(SYNC_STATE_DIR, { recursive: true });
    writeFileSync(join(SYNC_STATE_DIR, sessionId), `${size},${compactions}`);
  } catch {}
}

// Incrementally process only the JSONL bytes appended since last hook fire.
// Returns cumulative JSONL compaction-marker count (cached + newly seen).
// On a no-op fire (file unchanged) this opens no DB connection at all.
function syncCurrentSessionIncremental(sessionId) {
  try {
    const projectsDir = join(CLAUDE_DIR, 'projects');
    if (!existsSync(projectsDir)) return 0;

    for (const projectName of readdirSync(projectsDir)) {
      const jsonlPath = join(projectsDir, projectName, `${sessionId}.jsonl`);
      if (!existsSync(jsonlPath)) continue;

      const stat = statSync(jsonlPath);
      const state = readSyncState(sessionId);

      // Recover from anomaly (file shrank, e.g. corruption or manual edit) by
      // re-processing from byte 0. INSERT OR IGNORE keeps the DB consistent.
      const fromOffset = (state && stat.size >= state.size) ? state.size : 0;
      const baseCompactions = (state && stat.size >= state.size) ? state.compactions : 0;

      // No new bytes — skip DB open entirely.
      if (fromOffset === stat.size && state) {
        return state.compactions;
      }

      const db = getDb();
      const result = processConversationFile(db, jsonlPath, projectName, fromOffset);
      db.close();

      const totalCompactions = baseCompactions + (result.jsonlCompactionMarkers || 0);
      writeSyncState(sessionId, result.newOffset ?? stat.size, totalCompactions);
      return totalCompactions;
    }
  } catch {}
  return 0;
}

function checkCompaction(sessionId, jsonlCompactions) {
  mkdirSync(MARKER_DIR, { recursive: true });
  const markerFile = join(MARKER_DIR, sessionId);

  // Combine cached JSONL count (from incremental sync) with legacy
  // agent-acompact files count (cheap directory listing).
  const totalCompactions = (jsonlCompactions || 0) + checkCompactionFiles(sessionId);

  if (totalCompactions === 0) return false;

  // Marker tracks last-injected count to avoid re-firing on the same compaction.
  let seenCount = 0;
  if (existsSync(markerFile)) {
    try {
      seenCount = parseInt(readFileSync(markerFile, 'utf-8').trim(), 10) || 0;
    } catch {}
  }

  if (totalCompactions > seenCount) {
    writeFileSync(markerFile, String(totalCompactions));
    return true;
  }

  return false;
}

function checkCompactionFiles(sessionId) {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return 0;

  try {
    for (const projectName of readdirSync(projectsDir)) {
      const candidateDir = join(projectsDir, projectName, sessionId, 'subagents');
      if (existsSync(candidateDir)) {
        return readdirSync(candidateDir).filter(f => f.startsWith('agent-acompact-') && f.endsWith('.jsonl')).length;
      }
    }
  } catch {}
  return 0;
}

// CC's hook stdout limit is ~10KB. We target 8KB to leave headroom for the
// framing lines and any safety margin. Tiered cap gives the most-recent
// messages real detail and progressively less to older ones; running total
// against TOTAL_BUDGET means short recent messages naturally free up room
// for older ones.
const COMPACTION_TOTAL_BUDGET = 8000;
const COMPACTION_TIERS = [
  { count: 5,  cap: 1500 }, // most recent 5: rich detail
  { count: 10, cap: 600 },  // next 10: medium
  { count: 25, cap: 200 },  // older 25: just gist
];

function injectPostCompactionContext(sessionId) {
  try {
    const db = getReadonlyDb();
    const rows = db.prepare(`
      SELECT type, content FROM messages
      WHERE session_id = ?
      ORDER BY id DESC LIMIT 40
    `).all(sessionId);
    db.close();

    const filtered = rows.filter(r => {
      if (!r.content) return false;
      // Skip tool results, tool calls, interrupts, and system/command messages
      if (r.content === '[Tool Result]') return false;
      if (r.content === '[Request interrupted by user]') return false;
      if (r.content.startsWith('[Tool:')) return false;
      if (r.content.startsWith('<local-command')) return false;
      if (r.content.startsWith('<command-name>')) return false;
      if (r.content.trim() === '') return false;
      return true;
    });

    if (!filtered.length) {
      console.log('COMPACTION DETECTED: Context was compressed but no recent messages found. Ask the user what they were working on.');
      return;
    }

    // filtered is newest-first (ORDER BY id DESC). Walk it applying the
    // current tier's per-message cap, stopping when total budget is exhausted.
    const picked = []; // newest-first
    let used = 0;
    let tierIdx = 0;
    let inTier = 0;

    for (const row of filtered) {
      while (tierIdx < COMPACTION_TIERS.length && inTier >= COMPACTION_TIERS[tierIdx].count) {
        tierIdx++;
        inTier = 0;
      }
      if (tierIdx >= COMPACTION_TIERS.length) break;

      const cap = COMPACTION_TIERS[tierIdx].cap;
      const truncated = row.content.length > cap
        ? row.content.slice(0, cap) + '...'
        : row.content;
      // Approximate per-line cost: "[role] content\n" → role + 3 + content + 1
      const cost = truncated.length + row.type.length + 4;

      if (used + cost > COMPACTION_TOTAL_BUDGET) break;

      picked.push({ role: row.type, content: truncated });
      used += cost;
      inTier++;
    }

    if (!picked.length) {
      console.log('COMPACTION DETECTED: Context was compressed but recent messages did not fit in the budget. Ask the user what they were working on.');
      return;
    }

    const lines = [
      'COMPACTION DETECTED — Message Injection (most recent messages):',
      ''
    ];

    // Reverse to chronological order for output
    for (const m of picked.reverse()) {
      lines.push(`[${m.role}] ${m.content}`);
    }

    lines.push('');
    lines.push('For full messages or older context: cloudctx query "terms"');
    console.log(lines.join('\n'));
  } catch (e) {
    console.log(`COMPACTION DETECTED: Context was compressed. Could not read memory DB: ${e.message}`);
  }
}
