import { getReadonlyDb, getDb, dbExists, migrate } from './db.js';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

export function findJsonlForSession(sessionId) {
  if (!existsSync(CLAUDE_PROJECTS)) return null;
  for (const projectName of readdirSync(CLAUDE_PROJECTS)) {
    const path = join(CLAUDE_PROJECTS, projectName, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function readProjectCwd(jsonlPath) {
  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.cwd) return record.cwd;
    }
  } catch {}
  return null;
}

export function saveThread(name, sessionId = null) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  if (!sessionId) {
    sessionId = getCurrentSessionId();
    if (!sessionId) {
      console.error('Could not detect current session. Provide a session ID.');
      process.exit(1);
    }
  }

  const jsonlPath = findJsonlForSession(sessionId);
  const projectPath = jsonlPath ? readProjectCwd(jsonlPath) : null;

  const db = getDb();
  migrate(db);
  db.prepare(`
    INSERT OR REPLACE INTO saved_threads (name, session_id, project_path, saved_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(name, sessionId, projectPath);

  db.close();
  console.log(`✓ Saved "${name}"${projectPath ? ` (${projectPath})` : ''}`);
}

export function renameThread(oldName, newName) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getDb();
  migrate(db);

  const existing = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(newName);
  if (existing) {
    db.close();
    console.error(`A saved thread named "${newName}" already exists.`);
    process.exit(1);
  }

  const result = db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(newName, oldName);
  db.close();

  if (result.changes > 0) {
    console.log(`✓ Renamed "${oldName}" → "${newName}"`);
    return true;
  }
  console.error(`No saved thread named "${oldName}"`);
  return false;
}

export function removeThread(name) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM saved_threads WHERE name = ?').run(name);
  db.close();

  if (result.changes > 0) {
    console.log(`✓ Removed "${name}"`);
  } else {
    console.error(`No saved thread named "${name}"`);
  }
}

function fetchThreadsWithActivity() {
  const db = getDb();
  migrate(db);
  const threads = db.prepare(`
    SELECT
      st.name,
      st.session_id,
      st.project_path,
      st.saved_at,
      COALESCE(
        (SELECT MAX(timestamp) FROM messages WHERE session_id = st.session_id),
        st.saved_at
      ) as last_active
    FROM saved_threads st
    ORDER BY last_active DESC
  `).all();

  // Backfill project_path for any rows missing it
  const update = db.prepare('UPDATE saved_threads SET project_path = ? WHERE name = ?');
  for (const t of threads) {
    if (!t.project_path) {
      const jsonlPath = findJsonlForSession(t.session_id);
      const cwd = jsonlPath ? readProjectCwd(jsonlPath) : null;
      if (cwd) {
        update.run(cwd, t.name);
        t.project_path = cwd;
      }
    }
  }

  db.close();
  return threads;
}

export function listThreads() {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const threads = fetchThreadsWithActivity();

  if (!threads.length) {
    console.log('No saved threads. Save one with: cloudctx launch --save "name"');
    return;
  }

  console.log('');
  console.log('  Saved threads:');
  console.log('  ' + '─'.repeat(60));

  for (const t of threads) {
    const date = t.last_active ? t.last_active.split('T')[0].split(' ')[0] : '';
    console.log(`  ${t.name.padEnd(45)} ${date}`);
  }

  console.log('  ' + '─'.repeat(60));
  console.log('');
  return threads;
}

export async function interactiveLaunch() {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  let threads = fetchThreadsWithActivity();

  if (!threads.length) {
    console.log('No saved threads. Save one with: cloudctx launch --save "name"');
    return;
  }

  const selected = await arrowKeyPicker(threads);
  if (!selected) return;

  console.log(`\n  Resuming "${selected.name}"...\n`);

  let claudeBin = 'claude';
  try {
    claudeBin = execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {}

  const spawnOpts = { stdio: 'inherit', env: process.env };
  if (selected.project_path && existsSync(selected.project_path)) {
    spawnOpts.cwd = selected.project_path;
  }

  const child = spawn(claudeBin, ['--resume', selected.session_id], spawnOpts);

  child.on('exit', (code) => process.exit(code || 0));
}

async function arrowKeyPicker(threads) {
  let cursor = 0;
  let confirmingDelete = null; // holds the thread name being deleted, if any
  let renaming = null;         // {oldName, buffer, error} when renaming
  const visibleCount = () => Math.min(threads.length, process.stdout.rows ? process.stdout.rows - 8 : 20);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('');
    console.log('  \x1b[1mCloudCtx — Select a thread to resume\x1b[0m');
    console.log('  \x1b[2m↑↓ navigate  ⏎ select  r rename  d delete  q quit\x1b[0m');
    console.log('');

    const vc = visibleCount();
    let start = 0;
    if (threads.length > vc) {
      start = Math.max(0, Math.min(cursor - Math.floor(vc / 2), threads.length - vc));
    }
    const end = Math.min(start + vc, threads.length);

    for (let i = start; i < end; i++) {
      const t = threads[i];
      const rawDate = t.last_active || t.saved_at || '';
      const date = rawDate.split('T')[0].split(' ')[0];
      const prefix = i === cursor ? '  \x1b[36m❯\x1b[0m ' : '    ';
      const nameStyle = i === cursor ? `\x1b[1m${t.name}\x1b[0m` : t.name;
      const line = `${prefix}${nameStyle}`;
      const padding = Math.max(2, 50 - t.name.length);
      console.log(`${line}${' '.repeat(padding)}\x1b[2m${date}\x1b[0m`);
    }

    if (threads.length > vc) {
      console.log(`\n  \x1b[2m${cursor + 1}/${threads.length}\x1b[0m`);
    }

    if (confirmingDelete) {
      console.log('');
      console.log(`  \x1b[31mDelete "${confirmingDelete}"? (y/n)\x1b[0m`);
    }

    if (renaming) {
      console.log('');
      console.log(`  \x1b[33mRename "${renaming.oldName}" → \x1b[1m${renaming.buffer}\x1b[22m\x1b[33m_\x1b[0m`);
      console.log('  \x1b[2m⏎ confirm  esc cancel\x1b[0m');
      if (renaming.error) {
        console.log(`  \x1b[31m${renaming.error}\x1b[0m`);
      }
    }
  };

  render();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onKey);
      process.stdin.pause();
    };

    const onKey = (key) => {
      // Handle rename mode
      if (renaming) {
        // Enter confirms
        if (key === '\r' || key === '\n') {
          const newName = renaming.buffer.trim();
          if (!newName) {
            renaming.error = 'Name cannot be empty';
            render();
            return;
          }
          if (newName === renaming.oldName) {
            renaming = null;
            render();
            return;
          }
          const db = getDb();
          const exists = db.prepare('SELECT name FROM saved_threads WHERE name = ?').get(newName);
          if (exists) {
            db.close();
            renaming.error = `"${newName}" already exists`;
            render();
            return;
          }
          db.prepare('UPDATE saved_threads SET name = ? WHERE name = ?').run(newName, renaming.oldName);
          db.close();
          threads = fetchThreadsWithActivity();
          // Keep cursor on the renamed thread
          const idx = threads.findIndex(t => t.name === newName);
          if (idx >= 0) cursor = idx;
          renaming = null;
          render();
          return;
        }
        // Esc or Ctrl+C cancels
        if (key === '\x1b' || key === '\x03') {
          renaming = null;
          render();
          return;
        }
        // Backspace
        if (key === '\x7f' || key === '\b') {
          renaming.buffer = renaming.buffer.slice(0, -1);
          renaming.error = null;
          render();
          return;
        }
        // Printable chars
        if (key.length === 1 && key >= ' ' && key <= '~') {
          renaming.buffer += key;
          renaming.error = null;
          render();
        }
        return;
      }

      // Handle delete confirmation
      if (confirmingDelete) {
        if (key === 'y' || key === 'Y') {
          // Perform delete
          const db = getDb();
          db.prepare('DELETE FROM saved_threads WHERE name = ?').run(confirmingDelete);
          db.close();

          // Refresh threads list
          threads = fetchThreadsWithActivity();
          confirmingDelete = null;

          if (!threads.length) {
            cleanup();
            console.log('  No saved threads left.');
            resolve(null);
            return;
          }

          cursor = Math.min(cursor, threads.length - 1);
          render();
          return;
        } else if (key === 'n' || key === 'N' || key === '\x1b' || key === '\x03') {
          confirmingDelete = null;
          render();
          return;
        }
        return;
      }

      // q or Ctrl+C to quit
      if (key === 'q' || key === '\x03') {
        cleanup();
        resolve(null);
        return;
      }

      // Enter to select
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(threads[cursor]);
        return;
      }

      // d to delete
      if (key === 'd') {
        confirmingDelete = threads[cursor].name;
        render();
        return;
      }

      // r to rename
      if (key === 'r') {
        renaming = { oldName: threads[cursor].name, buffer: threads[cursor].name, error: null };
        render();
        return;
      }

      // Arrow keys
      if (key === '\x1b[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        cursor = Math.min(threads.length - 1, cursor + 1);
        render();
      }
    };

    process.stdin.on('data', onKey);
  });
}

function getCurrentSessionId() {
  try {
    const result = execSync(
      'ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1',
      { encoding: 'utf-8' }
    ).trim();
    if (result) {
      const parts = result.split('/');
      const filename = parts[parts.length - 1];
      return filename.replace('.jsonl', '');
    }
  } catch {}
  return null;
}
