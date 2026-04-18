#!/usr/bin/env node

import { getDb, getReadonlyDb, createSchema, dbExists, getDbPath, getDataDir } from '../lib/db.js';
import { seedDatabase, incrementalSync } from '../lib/parser.js';
import { runHook } from '../lib/hook.js';
import { installHook, uninstallHook, installClaudeMd, uninstallClaudeMd, installSlashCommand, uninstallSlashCommand } from '../lib/install.js';
import { saveThread, removeThread, listThreads, interactiveLaunch } from '../lib/launch.js';
import { ingestDoc, listDocs, searchDocs, deleteDoc } from '../lib/docs.js';
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

  // Install slash command
  installSlashCommand();
  console.log('  ✓ Slash command /cloudctx-save added to ~/.claude/commands/');

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
    launch --remove "name"        Remove a saved thread
    launch --list                 List saved threads

    docs ingest <url|file> [tags] Ingest reference documentation
    docs list                     List all docs
    docs search "query"           Search docs
    docs delete <id>              Delete a doc

    hook                          (internal) UserPromptSubmit handler
    help                          Show this help
`);
}
