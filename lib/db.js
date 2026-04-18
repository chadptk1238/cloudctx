import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.cloudctx');
const DB_PATH = join(DATA_DIR, 'conversations.db');

export function getDataDir() {
  return DATA_DIR;
}

export function getDbPath() {
  return DB_PATH;
}

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getDb(readonly = false) {
  ensureDataDir();
  const db = new Database(DB_PATH, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  return db;
}

export function getReadonlyDb() {
  return getDb(true);
}

export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT,
      first_message_at TIMESTAMP,
      last_message_at TIMESTAMP,
      message_count INTEGER DEFAULT 0,
      is_agent_sidechain BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      session_id TEXT NOT NULL,
      parent_uuid TEXT,
      type TEXT NOT NULL,
      role TEXT,
      content TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      timestamp TIMESTAMP,
      cwd TEXT,
      git_branch TEXT,
      version TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uuid TEXT,
      session_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      timestamp TIMESTAMP,
      FOREIGN KEY (message_uuid) REFERENCES messages(uuid),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display TEXT,
      project TEXT,
      session_id TEXT,
      timestamp TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      summary TEXT,
      leaf_uuid TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      source TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS saved_threads (
      name TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      summary TEXT,
      project_path TEXT,
      saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_uses_tool ON tool_uses(tool_name);
    CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source);
    CREATE INDEX IF NOT EXISTS idx_docs_title ON docs(title);

    -- FTS for messages
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id
    );

    -- FTS for docs
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title,
      content,
      tags,
      content=docs,
      content_rowid=id
    );

    -- Triggers: messages FTS sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- Triggers: docs FTS sync
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO docs_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;
  `);
}

export function dbExists() {
  return existsSync(DB_PATH);
}

export function migrate(db) {
  try {
    db.exec('ALTER TABLE saved_threads ADD COLUMN project_path TEXT');
  } catch {
    // column already exists
  }
}
