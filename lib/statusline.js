import { readFileSync } from 'fs';
import { getReadonlyDb, dbExists } from './db.js';
import { getConfigValue, STATUSLINE_COLORS } from './config.js';

export function runStatusline() {
  try {
    if (!dbExists()) {
      process.exit(0);
    }

    let input = '';
    try {
      input = readFileSync('/dev/stdin', 'utf-8');
    } catch {}

    let sessionId = '';
    try {
      const parsed = JSON.parse(input);
      sessionId = parsed.session_id || parsed.sessionId || '';
    } catch {}

    if (!sessionId) process.exit(0);

    const db = getReadonlyDb();
    const row = db.prepare(
      'SELECT name FROM saved_threads WHERE session_id = ? ORDER BY saved_at DESC LIMIT 1'
    ).get(sessionId);
    db.close();

    if (row && row.name) {
      const colorName = getConfigValue('statusline_color') || 'cyan';
      const code = STATUSLINE_COLORS[colorName] ?? '';
      const prefix = code ? `\x1b[1;${code}m` : `\x1b[1m`;
      process.stdout.write(`${prefix}📌 ${row.name}\x1b[0m`);
    }
  } catch {
    // silent — statusline should never crash CC
  }
  process.exit(0);
}
