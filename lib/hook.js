import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
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
// /cloudctx-rename "old" "new"  or  /cloudctx rename "old" "new"  (two-arg form)
const RENAME_PATTERN_SLASH = /^\/cloudctx-rename\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
const RENAME_PATTERN_LITERAL = /^\/cloudctx\s+rename\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
// /cloudctx-rename "new"  or  /cloudctx rename "new"  (single-arg form: renames CURRENT session's thread)
const RENAME_PATTERN_SINGLE_SLASH = /^\/cloudctx-rename\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
const RENAME_PATTERN_SINGLE_LITERAL = /^\/cloudctx\s+rename\s+(?:"([^"]+)"|'([^']+)'|(\S[^\n]*?))\s*$/im;
const COMMANDS_DIR = join(homedir(), '.claude', 'commands');
const SLASH_COMMAND_FILE = join(COMMANDS_DIR, 'cloudctx-save.md');
const SLASH_RENAME_FILE = join(COMMANDS_DIR, 'cloudctx-rename.md');

const CLAUDE_DIR = join(homedir(), '.claude');
const MARKER_DIR = join(getDataDir(), '.compaction-markers');

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
  // Two-arg form first (old + new): /cloudctx-rename oldname newname
  const renameMatch = trimmed.match(RENAME_PATTERN_SLASH) || trimmed.match(RENAME_PATTERN_LITERAL);
  if (renameMatch) {
    const oldName = renameMatch[1] || renameMatch[2] || renameMatch[3];
    const newName = renameMatch[4] || renameMatch[5] || renameMatch[6];
    handleRenameCommand(oldName, newName);
    process.exit(0);
  }
  // Single-arg form: /cloudctx-rename newname  (renames CURRENT session's saved thread)
  const renameSingleMatch = trimmed.match(RENAME_PATTERN_SINGLE_SLASH) || trimmed.match(RENAME_PATTERN_SINGLE_LITERAL);
  if (renameSingleMatch) {
    const newName = renameSingleMatch[1] || renameSingleMatch[2] || renameSingleMatch[3];
    handleRenameCurrentSession(sessionId, newName);
    process.exit(0);
  }

  // Quick sync current session so we have latest messages in DB
  syncCurrentSession(sessionId);

  // Detect compaction: check if the JSONL has a compaction summary message
  // OR check for legacy agent-acompact files
  const compactionDetected = checkCompaction(sessionId, prompt);

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

function handleRenameCurrentSession(sessionId, rawNew) {
  const newName = (rawNew || '').trim();
  try {
    if (!newName) throw new Error('New name is required');

    const db = getDb();
    migrate(db);

    // Find the current session's saved thread (most recent if multiple)
    const current = db.prepare(
      'SELECT name FROM saved_threads WHERE session_id = ? ORDER BY saved_at DESC LIMIT 1'
    ).get(sessionId);

    if (!current) {
      db.close();
      const out = {
        decision: 'block',
        reason: `[CloudCtx] This session has no saved thread. Save it first with /cloudctx-save <name>`
      };
      console.log(JSON.stringify(out));
      return;
    }

    if (current.name === newName) {
      db.close();
      const out = {
        decision: 'block',
        reason: `[CloudCtx] Already named "${newName}" — no change.`
      };
      console.log(JSON.stringify(out));
      return;
    }

    const exists = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(newName);
    if (exists) {
      db.close();
      const out = { decision: 'block', reason: `[CloudCtx] Cannot rename: "${newName}" already exists` };
      console.log(JSON.stringify(out));
      return;
    }

    db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(newName, current.name);
    db.close();

    const out = {
      decision: 'block',
      reason: `[CloudCtx] ✓ Renamed "${current.name}" → "${newName}"`
    };
    console.log(JSON.stringify(out));
  } catch (e) {
    const out = { decision: 'block', reason: `[CloudCtx] Rename failed: ${e.message}` };
    console.log(JSON.stringify(out));
  }
}

function handleRenameCommand(rawOld, rawNew) {
  const oldName = (rawOld || '').trim();
  const newName = (rawNew || '').trim();
  try {
    if (!oldName || !newName) throw new Error('Both old and new names are required');

    const db = getDb();
    migrate(db);
    const exists = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(newName);
    if (exists) {
      db.close();
      const out = { decision: 'block', reason: `[CloudCtx] Cannot rename: "${newName}" already exists` };
      console.log(JSON.stringify(out));
      return;
    }
    const result = db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(newName, oldName);
    db.close();

    if (result.changes === 0) {
      const out = { decision: 'block', reason: `[CloudCtx] No saved thread named "${oldName}"` };
      console.log(JSON.stringify(out));
      return;
    }
    const out = { decision: 'block', reason: `[CloudCtx] ✓ Renamed "${oldName}" → "${newName}"` };
    console.log(JSON.stringify(out));
  } catch (e) {
    const out = { decision: 'block', reason: `[CloudCtx] Rename failed: ${e.message}` };
    console.log(JSON.stringify(out));
  }
}

function syncCurrentSession(sessionId) {
  try {
    const projectsDir = join(CLAUDE_DIR, 'projects');
    if (!existsSync(projectsDir)) return;

    for (const projectName of readdirSync(projectsDir)) {
      const jsonlPath = join(projectsDir, projectName, `${sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        const db = getDb();
        processConversationFile(db, jsonlPath, projectName);
        db.close();
        return;
      }
    }
  } catch {}
}

function checkCompaction(sessionId, prompt) {
  mkdirSync(MARKER_DIR, { recursive: true });
  const markerFile = join(MARKER_DIR, sessionId);

  // Method 1: Detect compaction from the prompt content
  // After compaction, the next user message often contains "continued from a previous conversation"
  // or the user's first message after /compact
  // We detect this by checking if the JSONL has a compaction summary record
  const compactedViaJsonl = checkJsonlForCompaction(sessionId);

  // Method 2: Legacy detection via agent-acompact files
  const compactedViaFiles = checkCompactionFiles(sessionId);

  const totalCompactions = compactedViaJsonl + compactedViaFiles;

  if (totalCompactions === 0) return false;

  // Check marker to avoid re-injecting
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

function checkJsonlForCompaction(sessionId) {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return 0;

  try {
    for (const projectName of readdirSync(projectsDir)) {
      const jsonlPath = join(projectsDir, projectName, `${sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        // Count compaction summaries in the JSONL
        const content = readFileSync(jsonlPath, 'utf-8');
        let count = 0;
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            // Compaction summary appears as a user message with this specific text
            if (record.type === 'user') {
              const msgContent = record.message?.content;
              if (typeof msgContent === 'string' && msgContent.includes('This session is being continued from a previous conversation')) {
                count++;
              } else if (Array.isArray(msgContent)) {
                for (const block of msgContent) {
                  if (block?.type === 'text' && block.text?.includes('This session is being continued from a previous conversation')) {
                    count++;
                    break;
                  }
                }
              }
            }
          } catch {}
        }
        return count;
      }
    }
  } catch {}
  return 0;
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

    const lines = [
      'COMPACTION DETECTED — Message Injection (most recent messages):',
      ''
    ];

    // Truncate each message to keep total output under 10KB limit
    const maxPerMessage = 500;
    for (const row of filtered.reverse()) {
      const content = row.content.length > maxPerMessage
        ? row.content.slice(0, maxPerMessage) + '...'
        : row.content;
      lines.push(`[${row.type}] ${content}`);
    }

    lines.push('');
    lines.push('For full messages or older context: cloudctx query "terms"');
    console.log(lines.join('\n'));
  } catch (e) {
    console.log(`COMPACTION DETECTED: Context was compressed. Could not read memory DB: ${e.message}`);
  }
}
