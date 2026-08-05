// db.js
// Storage layer built on Node's built-in SQLite module (node:sqlite).
// Using only built-ins keeps this project runnable with zero "npm install" step.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'studynotes.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    theme TEXT NOT NULL DEFAULT 'system',
    text_size TEXT NOT NULL DEFAULT 'medium',
    agreed_to_terms_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'amber',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    folder_id INTEGER,
    title TEXT NOT NULL DEFAULT 'Untitled note',
    content_html TEXT NOT NULL DEFAULT '',
    template TEXT NOT NULL DEFAULT 'blank',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(folder_id) REFERENCES folders(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Migration for databases created before the `template` column existed.
try {
  db.exec("ALTER TABLE notes ADD COLUMN template TEXT NOT NULL DEFAULT 'blank'");
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migration for databases created before folders had a `color` column.
try {
  db.exec("ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT 'amber'");
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migrations for databases created before users had display-preference columns.
try {
  db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'");
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec("ALTER TABLE users ADD COLUMN text_size TEXT NOT NULL DEFAULT 'medium'");
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migration for databases created before signup required agreeing to the
// Terms of Service / Privacy Policy.
try {
  db.exec('ALTER TABLE users ADD COLUMN agreed_to_terms_at TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

const FREE_PLAN_NOTE_LIMIT = 10;

module.exports = { db, FREE_PLAN_NOTE_LIMIT };
