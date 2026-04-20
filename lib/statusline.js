import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { getReadonlyDb, dbExists } from './db.js';
import { getConfigValue, STATUSLINE_COLORS } from './config.js';

export function runStatusline() {
  let input = '';
  let sessionId = '';
  let ourPrefix = '';

  try {
    try { input = readFileSync(0, 'utf-8'); } catch {}

    try {
      const parsed = JSON.parse(input);
      sessionId = parsed.session_id || parsed.sessionId || '';
    } catch {}

    if (sessionId && dbExists()) {
      try {
        const db = getReadonlyDb();
        const row = db.prepare(
          'SELECT name FROM saved_threads WHERE session_id = ? ORDER BY saved_at DESC LIMIT 1'
        ).get(sessionId);
        db.close();
        if (row && row.name) {
          const colorName = getConfigValue('statusline_color') || 'cyan';
          const code = STATUSLINE_COLORS[colorName] ?? '';
          const open = code ? `\x1b[1;${code}m` : `\x1b[1m`;
          ourPrefix = `${open}📌 ${row.name}\x1b[0m`;
        }
      } catch {}
    }

    const wrapped = getConfigValue('wrapped_statusline');
    let wrappedOutput = '';
    if (wrapped && wrapped.command) {
      try {
        wrappedOutput = execSync(wrapped.command, {
          input,
          timeout: 800,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
          shell: true,
        }).replace(/\r?\n+$/g, '');
      } catch {
        // wrapped command failed or timed out — fall back to just our prefix
      }
    }

    const parts = [ourPrefix, wrappedOutput].filter(s => s && s.length);
    if (parts.length) process.stdout.write(parts.join('  ·  '));
  } catch {
    // never crash Claude Code's status line
  }
  process.exit(0);
}
