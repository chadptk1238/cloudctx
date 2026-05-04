#!/usr/bin/env bun

import { getDb, getReadonlyDb, createSchema, dbExists, getDbPath, getDataDir } from '../lib/db.js';
import { seedDatabase, incrementalSync } from '../lib/parser.js';
import { runHook } from '../lib/hook.js';
import { runStatusline } from '../lib/statusline.js';
import { installHook, uninstallHook, installClaudeMd, uninstallClaudeMd, installSlashCommand, uninstallSlashCommand, installStatusline, uninstallStatusline } from '../lib/install.js';
import { saveThread, removeThread, renameThread, listThreads, interactiveLaunch } from '../lib/launch.js';
import { ingestDoc, listDocs, searchDocs, deleteDoc } from '../lib/docs.js';
import { getConfig, getConfigValue, setConfig, unsetConfig, parseBool, isKnownKey, listKnownKeys, describeKey, getConfigPath, isBoolKey, isStringKey, STATUSLINE_COLORS } from '../lib/config.js';
import { existsSync, rmSync, statSync } from 'fs';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'init':
    await cmdInit();
    break;

  case 'import':
    cmdImport(args[1]);
    break;

  case 'hook':
    runHook();
    break;

  case 'statusline':
    runStatusline();
    break;

  case 'config':
    await cmdConfig(args.slice(1));
    break;

  case 'sync':
  case 'seed':
    cmdSync(command === 'seed');
    break;

  case 'query':
    cmdQuery(args.slice(1).join(' '));
    break;

  case 'sql':
    cmdSql(args.slice(1).join(' '));
    break;

  case 'status':
    cmdStatus();
    break;

  case 'reset':
    await cmdReset();
    break;

  case 'launch':
    await cmdLaunch(args.slice(1));
    break;

  case 'docs':
    await cmdDocs(args.slice(1));
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    showHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}

async function cmdInit() {
  console.log('');
  console.log('  CloudCtx — Persistent memory for Claude Code');
  console.log('');

  if (dbExists()) {
    console.log(`  Database already exists at ${getDbPath()}`);
    console.log('  Run "cloudctx seed" to sync new conversations.');
    console.log('  Run "cloudctx reset" to start fresh.');
    console.log('');
    return;
  }

  // Create database
  console.log('  Creating database...');
  const db = getDb();
  createSchema(db);

  // Seed from existing conversations
  console.log('  Parsing Claude Code conversations...');
  console.log('');

  const stats = seedDatabase(db, (project, total) => {
    process.stdout.write(`\r  Processed ${total} files...`);
  });

  db.close();

  console.log('');
  console.log(`  ✓ Database created: ${getDbPath()}`);
  console.log(`    ${stats.messages.toLocaleString()} messages, ${stats.tools.toLocaleString()} tool uses, ${stats.history.toLocaleString()} history entries`);

  const dbSize = statSync(getDbPath()).size / 1024 / 1024;
  console.log(`    Size: ${dbSize.toFixed(1)} MB`);
  console.log('');

  // Install hooks
  console.log('  Installing Claude Code hooks...');
  installHook();
  console.log('  ✓ Hook added to ~/.claude/settings.json');

  // Install CLAUDE.md
  installClaudeMd();
  console.log('  ✓ Instructions added to ~/.claude/CLAUDE.md');

  // Install slash commands
  installSlashCommand();
  console.log('  ✓ Slash commands /cloudctx-save and /cloudctx-rename added to ~/.claude/commands/');

  console.log('');
  console.log('  ✓ Memory is active. Open a new Claude Code session to use it.');
  console.log('');
  console.log('  Commands:');
  console.log('    cloudctx query "search terms"    Search memory');
  console.log('    cloudctx sql "SELECT ..."         Raw SQL');
  console.log('    cloudctx launch                   Resume saved threads');
  console.log('    cloudctx launch --save "name"     Save current thread');
  console.log('    cloudctx docs ingest <url> [tags] Ingest reference docs');
  console.log('    cloudctx status                   Database stats');
  console.log('    cloudctx reset                    Remove everything');
  console.log('');
}

function cmdSync(fullReseed = false) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getDb();

  if (fullReseed) {
    console.log('Re-seeding from all Claude Code conversations...');
    const stats = seedDatabase(db, (project, total) => {
      process.stdout.write(`\r  Processed ${total} files...`);
    });
    console.log('');
    console.log(`  ✓ ${stats.messages.toLocaleString()} new messages, ${stats.tools.toLocaleString()} tool uses`);
  } else {
    const stats = incrementalSync(db);
    if (stats.messages > 0) {
      console.log(`Synced ${stats.messages} new messages, ${stats.tools} tool uses`);
    }
  }

  db.close();
}

function cmdQuery(terms) {
  if (!terms) {
    console.error('Usage: cloudctx query "search terms"');
    process.exit(1);
  }

  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getReadonlyDb();
  const rows = db.prepare(`
    SELECT m.type, substr(m.content, 1, 300) as preview, m.timestamp
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT 10
  `).all(terms);
  db.close();

  if (!rows.length) {
    console.log(`No results for: ${terms}`);
    return;
  }

  for (const r of rows) {
    const ts = r.timestamp ? r.timestamp.split('T')[0] : '';
    console.log(`[${r.type}] ${ts}`);
    console.log(`  ${r.preview}`);
    console.log('');
  }
}

function cmdSql(query) {
  if (!query) {
    console.error('Usage: cloudctx sql "SELECT ..."');
    process.exit(1);
  }

  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  // Safety: enforce read-only
  const lower = query.toLowerCase().trim();
  if (lower.startsWith('insert') || lower.startsWith('update') || lower.startsWith('delete') || lower.startsWith('drop') || lower.startsWith('alter') || lower.startsWith('create')) {
    console.error('Read-only: write operations are not allowed via cloudctx sql');
    process.exit(1);
  }

  const db = getReadonlyDb();
  try {
    const rows = db.prepare(query).all();
    if (!rows.length) {
      console.log('No results.');
      return;
    }

    // Print results
    for (const row of rows) {
      const values = Object.values(row);
      console.log(values.join(' | '));
    }
  } catch (e) {
    console.error(`SQL error: ${e.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

function cmdStatus() {
  if (!dbExists()) {
    console.log('CloudCtx is not initialized. Run: cloudctx init');
    return;
  }

  const db = getReadonlyDb();
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const tools = db.prepare('SELECT COUNT(*) as count FROM tool_uses').get().count;
  const docs = db.prepare('SELECT COUNT(*) as count FROM docs').get().count;
  const threads = db.prepare('SELECT COUNT(*) as count FROM saved_threads').get().count;
  const latest = db.prepare('SELECT MAX(timestamp) as ts FROM messages').get().ts || 'none';
  db.close();

  const dbSize = statSync(getDbPath()).size / 1024 / 1024;

  console.log('');
  console.log('  CloudCtx Status');
  console.log('  ' + '─'.repeat(40));
  console.log(`  Messages:       ${messages.toLocaleString()}`);
  console.log(`  Sessions:       ${sessions.toLocaleString()}`);
  console.log(`  Tool uses:      ${tools.toLocaleString()}`);
  console.log(`  Docs:           ${docs}`);
  console.log(`  Saved threads:  ${threads}`);
  console.log(`  Latest:         ${latest}`);
  console.log(`  DB size:        ${dbSize.toFixed(1)} MB`);
  console.log(`  DB path:        ${getDbPath()}`);
  console.log('');
}

async function cmdReset() {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('  This will:');
  console.log('    - Remove cloudctx hooks from ~/.claude/settings.json');
  console.log('    - Remove cloudctx block from ~/.claude/CLAUDE.md');
  console.log(`    - Delete ${getDataDir()} (database + config)`);
  console.log('');

  const answer = await new Promise(resolve => {
    rl.question('  Proceed? (y/N) ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    console.log('  Cancelled.');
    return;
  }

  // Remove hooks
  if (uninstallHook()) {
    console.log('  ✓ Hooks removed');
  }

  // Remove CLAUDE.md block
  if (uninstallClaudeMd()) {
    console.log('  ✓ CLAUDE.md block removed');
  }

  // Remove slash command
  if (uninstallSlashCommand()) {
    console.log('  ✓ Slash command removed');
  }

  // Remove statusline if it was installed
  if (uninstallStatusline()) {
    console.log('  ✓ Status line removed');
  }

  // Delete data dir
  if (existsSync(getDataDir())) {
    rmSync(getDataDir(), { recursive: true });
    console.log('  ✓ Database deleted');
  }

  console.log('');
  console.log('  Claude Code is back to default.');
  console.log('');
}

async function cmdLaunch(subArgs) {
  if (subArgs[0] === '--save') {
    const name = subArgs[1];
    const sessionId = subArgs[2] || null;
    if (!name) {
      console.error('Usage: cloudctx launch --save "descriptive-thread-name"');
      process.exit(1);
    }
    saveThread(name, sessionId);
  } else if (subArgs[0] === '--remove') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: cloudctx launch --remove "thread-name"');
      process.exit(1);
    }
    removeThread(name);
  } else if (subArgs[0] === '--rename') {
    const oldName = subArgs[1];
    const newName = subArgs[2];
    if (!oldName || !newName) {
      console.error('Usage: cloudctx launch --rename "old-name" "new-name"');
      process.exit(1);
    }
    renameThread(oldName, newName);
  } else if (subArgs[0] === '--list') {
    listThreads();
  } else {
    // Interactive launcher
    await interactiveLaunch();
  }
}

async function cmdDocs(subArgs) {
  const subCmd = subArgs[0];

  switch (subCmd) {
    case 'ingest': {
      const source = subArgs[1];
      const tags = subArgs[2] || '';
      if (!source) {
        console.error('Usage: cloudctx docs ingest <url_or_file> [tags]');
        process.exit(1);
      }
      await ingestDoc(source, tags);
      break;
    }
    case 'list':
      listDocs();
      break;
    case 'search': {
      const query = subArgs.slice(1).join(' ');
      if (!query) {
        console.error('Usage: cloudctx docs search "query"');
        process.exit(1);
      }
      searchDocs(query);
      break;
    }
    case 'delete': {
      const id = parseInt(subArgs[1], 10);
      if (isNaN(id)) {
        console.error('Usage: cloudctx docs delete <id>');
        process.exit(1);
      }
      deleteDoc(id);
      break;
    }
    default:
      console.error('Usage: cloudctx docs [ingest|list|search|delete]');
      process.exit(1);
  }
}

async function cmdConfig(subArgs) {
  const sub = subArgs[0] || 'list';

  if (sub === 'list') {
    const config = getConfig();
    console.log('');
    console.log('  CloudCtx Config');
    console.log('  ' + '─'.repeat(50));
    for (const key of listKnownKeys()) {
      const val = config[key];
      const desc = describeKey(key);
      console.log(`  ${key.padEnd(18)} ${String(val).padEnd(6)} ${desc}`);
    }
    console.log('');
    console.log(`  File: ${getConfigPath()}`);
    console.log('');
    console.log('  cloudctx config set <key> <true|false>');
    console.log('  cloudctx config unset <key>');
    console.log('');
    return;
  }

  if (sub === 'get') {
    const key = subArgs[1];
    if (!key) { console.error('Usage: cloudctx config get <key>'); process.exit(1); }
    if (!isKnownKey(key)) {
      console.error(`Unknown key: ${key}`);
      console.error(`Known keys: ${listKnownKeys().join(', ')}`);
      process.exit(1);
    }
    console.log(getConfigValue(key));
    return;
  }

  if (sub === 'color' || sub === 'colors') {
    if (!process.stdin.isTTY) {
      console.log('');
      console.log('  Valid statusline_color values:');
      for (const name of Object.keys(STATUSLINE_COLORS)) {
        const code = STATUSLINE_COLORS[name];
        const preview = code ? `\x1b[1;${code}m📌 ${name}\x1b[0m` : `\x1b[1m📌 ${name}\x1b[0m`;
        console.log(`    ${preview}`);
      }
      console.log('');
      console.log('  cloudctx config set statusline_color <name>');
      console.log('');
      return;
    }
    const chosen = await pickColorInteractive();
    if (chosen) {
      setConfig('statusline_color', chosen);
      const code = STATUSLINE_COLORS[chosen];
      const preview = code ? `\x1b[1;${code}m📌 ${chosen}\x1b[0m` : `\x1b[1m📌 ${chosen}\x1b[0m`;
      console.log(`  ✓ statusline_color = ${preview}`);
    } else {
      console.log('  (cancelled)');
    }
    return;
  }

  if (sub === 'set') {
    const key = subArgs[1];
    const value = subArgs[2];
    if (!key || value === undefined) {
      console.error('Usage: cloudctx config set <key> <value>');
      process.exit(1);
    }
    if (!isKnownKey(key)) {
      console.error(`Unknown key: ${key}`);
      console.error(`Known keys: ${listKnownKeys().join(', ')}`);
      process.exit(1);
    }

    let storeValue;
    if (isBoolKey(key)) {
      const bool = parseBool(value);
      if (bool === null) {
        console.error(`Value must be true/false (or on/off, yes/no) — got: ${value}`);
        process.exit(1);
      }
      storeValue = bool;
    } else if (isStringKey(key)) {
      if (key === 'statusline_color' && !(value in STATUSLINE_COLORS)) {
        console.error(`Unknown color: ${value}`);
        console.error(`Run: cloudctx config colors`);
        process.exit(1);
      }
      if (key === 'launch_sort' && !['time', 'alpha'].includes(value)) {
        console.error(`launch_sort must be 'time' or 'alpha' — got: ${value}`);
        process.exit(1);
      }
      storeValue = value;
    } else {
      storeValue = value;
    }

    setConfig(key, storeValue);
    const bool = storeValue;

    if (key === 'statusline') {
      if (bool) {
        const result = installStatusline();
        console.log(`  ✓ statusline = true — wired into ~/.claude/settings.json`);
        if (result.wrapped) {
          console.log(`    Existing statusLine detected — wrapping it (you'll see both).`);
        }
        console.log(`    Open a new Claude Code session to see it.`);
      } else {
        const result = uninstallStatusline();
        if (result.restored) {
          console.log(`  ✓ statusline = false — your original statusLine restored.`);
        } else {
          console.log(`  ✓ statusline = false — removed from ~/.claude/settings.json`);
        }
      }
    } else {
      console.log(`  ✓ ${key} = ${storeValue}`);
    }
    return;
  }

  if (sub === 'unset') {
    const key = subArgs[1];
    if (!key) { console.error('Usage: cloudctx config unset <key>'); process.exit(1); }
    unsetConfig(key);
    if (key === 'statusline') uninstallStatusline();
    console.log(`  ✓ unset ${key}`);
    return;
  }

  console.error('Usage: cloudctx config [list|get|set|unset] ...');
  process.exit(1);
}

function registerRawModeExitGuard() {
  process.once('exit', () => {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
      process.exit(130);
    });
  }
}

async function pickColorInteractive() {
  registerRawModeExitGuard();
  const colors = Object.keys(STATUSLINE_COLORS);
  const currentColor = getConfigValue('statusline_color') || 'cyan';
  let cursor = Math.max(0, colors.indexOf(currentColor));

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('');
    console.log('  \x1b[1mCloudCtx — Choose statusline color\x1b[0m');
    console.log('  \x1b[2m↑↓ navigate  ⏎ save  q cancel\x1b[0m');
    console.log('');
    for (let i = 0; i < colors.length; i++) {
      const name = colors[i];
      const code = STATUSLINE_COLORS[name];
      const preview = code ? `\x1b[1;${code}m📌 ${name}\x1b[0m` : `\x1b[1m📌 ${name}\x1b[0m`;
      const pointer = i === cursor ? '  \x1b[36m❯\x1b[0m ' : '    ';
      const mark = name === currentColor ? ' \x1b[2m(current)\x1b[0m' : '';
      console.log(`${pointer}${preview}${mark}`);
    }
    console.log('');
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  render();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onKey);
      process.stdin.pause();
    };

    const onKey = (key) => {
      if (key === '\x03' || key === 'q' || key === '\x1b') {
        cleanup();
        resolve(null);
        return;
      }
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + colors.length) % colors.length;
        render();
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % colors.length;
        render();
        return;
      }
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(colors[cursor]);
        return;
      }
    };

    process.stdin.on('data', onKey);
  });
}

function cmdImport(dbPath) {
  if (!dbPath) {
    console.error('Usage: cloudctx import /path/to/existing.db');
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = getDb();
  createSchema(db);

  console.log(`  Importing from ${dbPath}...`);

  // Attach the source database
  db.exec(`ATTACH DATABASE '${dbPath}' AS source`);

  // Import each table, skipping duplicates
  const tables = [
    { name: 'sessions', key: 'session_id' },
    { name: 'messages', key: 'uuid' },
    { name: 'tool_uses', key: null },
    { name: 'summaries', key: null },
    { name: 'prompt_history', key: null },
    { name: 'docs', key: 'source' },
  ];

  for (const { name, key } of tables) {
    try {
      // Check if table exists in source
      const exists = db.prepare(`SELECT name FROM source.sqlite_master WHERE type='table' AND name=?`).get(name);
      if (!exists) continue;

      const conflict = key ? `OR IGNORE` : '';
      const result = db.exec(`INSERT ${conflict} INTO main.${name} SELECT * FROM source.${name}`);
      const count = db.prepare(`SELECT COUNT(*) as c FROM main.${name}`).get().c;
      console.log(`    ${name}: ${count.toLocaleString()} rows`);
    } catch (e) {
      console.log(`    ${name}: skipped (${e.message})`);
    }
  }

  // Rebuild FTS indexes
  console.log('  Rebuilding search indexes...');
  try {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    db.exec(`INSERT INTO docs_fts(docs_fts) VALUES('rebuild')`);
  } catch (e) {
    console.log(`    FTS rebuild: ${e.message}`);
  }

  db.exec('DETACH DATABASE source');
  db.close();

  const dbSize = statSync(getDbPath()).size / 1024 / 1024;
  console.log(`  ✓ Import complete. DB size: ${dbSize.toFixed(1)} MB`);
}

function showHelp() {
  console.log(`
  CloudCtx — Persistent memory for Claude Code

  Usage: cloudctx <command> [options]

  Commands:
    init                          Set up database, hooks, and CLAUDE.md
    import /path/to/db            Import from existing SQLite database
    query "search terms"          FTS search across all conversations
    sql "SELECT ..."              Raw read-only SQL query
    sync                          Incremental sync of new conversations
    seed                          Re-import all conversations
    status                        Database stats
    reset                         Remove everything (database, hooks, CLAUDE.md)

    launch                        Interactive thread picker
    launch --save "name" [id]     Save a thread for quick resume
    launch --rename "old" "new"   Rename a saved thread
    launch --remove "name"        Remove a saved thread
    launch --list                 List saved threads

    docs ingest <url|file> [tags] Ingest reference documentation
    docs list                     List all docs
    docs search "query"           Search docs
    docs delete <id>              Delete a doc

    config                        List all config values
    config color                  Interactive color picker for statusline
    config get <key>              Get one value
    config set <key> <value>      Set a value (known keys: statusline, statusline_color)
    config unset <key>            Remove a value

    hook                          (internal) UserPromptSubmit handler
    statusline                    (internal) Claude Code statusLine handler
    help                          Show this help
`);
}
