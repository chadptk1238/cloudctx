import { getReadonlyDb, getDb, dbExists } from './db.js';
import { execSync, spawn } from 'child_process';

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

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO saved_threads (name, session_id, saved_at)
    VALUES (?, ?, datetime('now'))
  `).run(name, sessionId);

  db.close();
  console.log(`✓ Saved "${name}"`);
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
  const db = getReadonlyDb();
  const threads = db.prepare(`
    SELECT
      st.name,
      st.session_id,
      st.saved_at,
      COALESCE(
        (SELECT MAX(timestamp) FROM messages WHERE session_id = st.session_id),
        st.saved_at
      ) as last_active
    FROM saved_threads st
    ORDER BY last_active DESC
  `).all();
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

  const child = spawn(claudeBin, ['--resume', selected.session_id], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => process.exit(code || 0));
}

async function arrowKeyPicker(threads) {
  let cursor = 0;
  let confirmingDelete = null; // holds the thread name being deleted, if any
  const visibleCount = () => Math.min(threads.length, process.stdout.rows ? process.stdout.rows - 7 : 20);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('');
    console.log('  \x1b[1mCloudCtx — Select a thread to resume\x1b[0m');
    console.log('  \x1b[2m↑↓ navigate  ⏎ select  d delete  q quit\x1b[0m');
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
