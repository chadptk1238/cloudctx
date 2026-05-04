import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = join(CLAUDE_DIR, 'history.jsonl');

export function getProjectsDir() {
  return PROJECTS_DIR;
}

function findJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findJsonlFiles(fullPath));
        } else if (entry.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      } catch {}
    }
  } catch {}
  return results;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block?.type === 'text') return block.text || '';
      if (block?.type === 'tool_use') return `[Tool: ${block.name || 'unknown'}]`;
      if (block?.type === 'tool_result') return '[Tool Result]';
      return '';
    }).join('\n');
  }
  return content ? String(content) : '';
}

function extractToolUses(content) {
  const tools = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        tools.push({
          name: block.name || 'unknown',
          input: JSON.stringify(block.input || {})
        });
      }
    }
  }
  return tools;
}

function parseJsonlFile(filepath) {
  const records = [];
  try {
    const text = readFileSync(filepath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {}
    }
  } catch (e) {
    // skip unreadable files
  }
  return records;
}

function parseTimestamp(tsStr) {
  if (!tsStr) return null;
  try {
    return new Date(tsStr.replace('Z', '+00:00')).toISOString();
  } catch {
    return null;
  }
}

// Reads file from `fromOffset` to EOF. Returns parsed records + the new EOF
// byte offset so callers can persist it for next-call incremental reads.
// JSONL is append-only line-by-line, so a stored EOF is always a clean line
// boundary on the next read.
function parseJsonlFileFromOffset(filepath, fromOffset = 0) {
  const records = [];
  let newOffset = fromOffset;
  let jsonlCompactionMarkers = 0;
  try {
    const stat = statSync(filepath);
    if (fromOffset >= stat.size) return { records, newOffset: stat.size, jsonlCompactionMarkers };
    const fd = openSync(filepath, 'r');
    try {
      const len = stat.size - fromOffset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, fromOffset);
      const text = buf.toString('utf-8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          records.push(record);
          // Count compaction markers inline so the hook doesn't need a second pass.
          if (record.type === 'user') {
            const c = record.message?.content;
            if (typeof c === 'string' && c.includes('This session is being continued from a previous conversation')) {
              jsonlCompactionMarkers++;
            } else if (Array.isArray(c)) {
              for (const block of c) {
                if (block?.type === 'text' && block.text?.includes('This session is being continued from a previous conversation')) {
                  jsonlCompactionMarkers++;
                  break;
                }
              }
            }
          }
        } catch {}
      }
      newOffset = stat.size;
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { records, newOffset, jsonlCompactionMarkers };
}

export function processConversationFile(db, filepath, projectName, fromOffset = 0) {
  const sessionId = basename(filepath, '.jsonl');
  const isAgent = basename(filepath).startsWith('agent-');
  const { records, newOffset, jsonlCompactionMarkers } = parseJsonlFileFromOffset(filepath, fromOffset);

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
    (uuid, session_id, parent_uuid, type, role, content, model,
     input_tokens, output_tokens, timestamp, cwd, git_branch, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTool = db.prepare(`
    INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO summaries (session_id, summary, leaf_uuid)
    VALUES (?, ?, ?)
  `);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, project, first_message_at, last_message_at, message_count, is_agent_sidechain)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      message_count = message_count + excluded.message_count,
      last_message_at = MAX(last_message_at, excluded.last_message_at)
  `);

  let messagesAdded = 0;
  let toolsAdded = 0;
  let firstTs = null;
  let lastTs = null;

  for (const record of records) {
    const recordType = record.type;

    if (recordType === 'summary') {
      insertSummary.run(sessionId, record.summary, record.leafUuid);
      continue;
    }

    if (recordType === 'user' || recordType === 'assistant') {
      const msg = record.message || {};
      const content = msg.content || '';
      const textContent = extractTextContent(content);
      const ts = parseTimestamp(record.timestamp);

      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }

      const usage = msg.usage || {};
      const result = insertMsg.run(
        record.uuid,
        record.sessionId || sessionId,
        record.parentUuid,
        recordType,
        msg.role,
        textContent,
        msg.model,
        usage.input_tokens ?? null,
        usage.output_tokens ?? null,
        ts,
        record.cwd,
        record.gitBranch,
        record.version
      );

      if (result.changes > 0) {
        messagesAdded++;
        for (const tool of extractToolUses(content)) {
          insertTool.run(record.uuid, sessionId, tool.name, tool.input, ts);
          toolsAdded++;
        }
      }
    }
  }

  if (messagesAdded > 0) {
    upsertSession.run(sessionId, projectName, firstTs, lastTs, messagesAdded, isAgent ? 1 : 0);
  }

  return { messagesAdded, toolsAdded, newOffset, jsonlCompactionMarkers };
}

export function processHistoryFile(db, cutoffTs = null) {
  if (!existsSync(HISTORY_FILE)) return 0;

  const insertHistory = db.prepare(`
    INSERT INTO prompt_history (display, project, session_id, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const records = parseJsonlFile(HISTORY_FILE);
  let count = 0;

  for (const record of records) {
    const tsMs = record.timestamp;
    if (!tsMs) continue;
    const ts = new Date(tsMs).toISOString();
    if (cutoffTs && ts <= cutoffTs) continue;

    insertHistory.run(record.display, record.project, record.sessionId, ts);
    count++;
  }

  return count;
}

export function seedDatabase(db, onProgress = null) {
  if (!existsSync(PROJECTS_DIR)) {
    return { sessions: 0, messages: 0, tools: 0, history: 0 };
  }

  // Process history
  const historyCount = processHistoryFile(db);

  // Process projects
  const projectDirs = readdirSync(PROJECTS_DIR).sort();
  let totalMessages = 0;
  let totalTools = 0;
  let totalFiles = 0;

  for (const projectName of projectDirs) {
    const projectPath = join(PROJECTS_DIR, projectName);
    if (!statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = findJsonlFiles(projectPath);
    if (!jsonlFiles.length) continue;

    const batchInsert = db.transaction(() => {
      for (const filePath of jsonlFiles) {
        const { messagesAdded, toolsAdded } = processConversationFile(
          db, filePath, projectName
        );
        totalMessages += messagesAdded;
        totalTools += toolsAdded;
        totalFiles++;
      }
    });
    batchInsert();

    if (onProgress) {
      onProgress(projectName, totalFiles);
    }
  }

  return {
    sessions: projectDirs.length,
    messages: totalMessages,
    tools: totalTools,
    history: historyCount,
    files: totalFiles
  };
}

export function incrementalSync(db) {
  if (!existsSync(PROJECTS_DIR)) return { messages: 0, tools: 0 };

  // Get cutoff timestamp
  const row = db.prepare('SELECT MAX(timestamp) as last_ts FROM messages').get();
  const cutoffTs = row?.last_ts || null;

  const projectDirs = readdirSync(PROJECTS_DIR).sort();
  let totalMessages = 0;
  let totalTools = 0;

  for (const projectName of projectDirs) {
    const projectPath = join(PROJECTS_DIR, projectName);
    if (!statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = findJsonlFiles(projectPath);
    if (!jsonlFiles.length) continue;

    // Only process files modified after our cutoff
    for (const filePath of jsonlFiles) {
      const fileStat = statSync(filePath);
      if (cutoffTs && fileStat.mtime.toISOString() < cutoffTs) continue;

      const { messagesAdded, toolsAdded } = processConversationFile(db, filePath, projectName);
      totalMessages += messagesAdded;
      totalTools += toolsAdded;
    }
  }

  // Sync history too
  const histRow = db.prepare('SELECT MAX(timestamp) as last_ts FROM prompt_history').get();
  processHistoryFile(db, histRow?.last_ts || null);

  return { messages: totalMessages, tools: totalTools };
}
