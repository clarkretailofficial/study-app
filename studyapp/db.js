// db.js
// Storage layer built on Node's built-in SQLite module (node:sqlite).
// Using only built-ins keeps this project runnable with zero "npm install" step.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Allow the data directory to be overridden by an environment variable so a
// hosting platform's persistent volume can be pointed at it regardless of
// where the app code ends up living inside the container (e.g. when deployed
// from a subdirectory of a repo). Falls back to a local "data" folder next to
// this file, which is what running the app on your own computer uses.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
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
    is_favorite INTEGER NOT NULL DEFAULT 0,
    favorited_at TEXT,
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
    is_favorite INTEGER NOT NULL DEFAULT 0,
    favorited_at TEXT,
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

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    note_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(note_id) REFERENCES notes(id)
  );

  -- AI-generated study sets (Pro tier). note_id is nullable and NOT a real
  -- foreign key constraint (SQLite here never turns on PRAGMA foreign_keys,
  -- matching every other table in this file) - once generated, a study set
  -- is meant to stand on its own in the "AI Study Sets" hub, so deleting its
  -- source note only nulls out note_id (see the notes DELETE route in
  -- server.js) rather than deleting the study set itself.
  CREATE TABLE IF NOT EXISTS study_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    note_id INTEGER,
    title TEXT NOT NULL DEFAULT 'Untitled study set',
    set_type TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium',
    length INTEGER NOT NULL DEFAULT 10,
    content_json TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    favorited_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(note_id) REFERENCES notes(id)
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

// Migrations for databases created before the Favorites feature existed.
try {
  db.exec('ALTER TABLE notes ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE notes ADD COLUMN favorited_at TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE folders ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE folders ADD COLUMN favorited_at TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migrations for databases created before Stripe subscriptions existed.
// stripe_customer_id lets us look a user up when a webhook event arrives,
// and also lets us send them to Stripe's Billing Portal to manage/cancel.
// stripe_subscription_id is kept mainly for debugging/support - the plan
// column is always the source of truth for what a user can actually do.
try {
  db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migration for databases created before the note-lock (Premium) feature
// existed. Both columns are null for an unlocked note; a locked note has
// both set (scrypt hash + its own random salt - same scheme as a user's
// account password in auth.js). Never sent to the client - see
// sanitizeNote() in server.js.
try {
  db.exec('ALTER TABLE notes ADD COLUMN lock_hash TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE notes ADD COLUMN lock_salt TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migrations for databases created before Google Drive sync (Premium/Pro)
// existed. google_refresh_token is stored encrypted (see google.js) - never
// the plaintext token Google issued - and is null for anyone who hasn't
// connected Drive, or who has disconnected it since. google_auto_sync is a
// per-user on/off toggle for syncing automatically on every save (separate
// from just "is Drive connected at all") so someone can connect their Drive
// once and still choose to only ever sync manually via the "Sync now"
// button.
try {
  db.exec('ALTER TABLE users ADD COLUMN google_refresh_token TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE users ADD COLUMN google_auto_sync INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE users ADD COLUMN google_drive_folder_id TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// google_file_id remembers which Drive file a given note was last synced to,
// so re-syncing updates that same file in place instead of creating a fresh
// duplicate in the user's Drive every time. google_synced_at is purely
// informational (shown in the UI as "Last synced ...").
try {
  db.exec('ALTER TABLE notes ADD COLUMN google_file_id TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE notes ADD COLUMN google_synced_at TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

const FREE_PLAN_NOTE_LIMIT = 10;

// Where uploaded file *contents* live on disk (separate from the SQLite
// database file, but under the same overridable persistent-volume DATA_DIR
// so both survive a redeploy). Each file's row in the `files` table stores
// enough metadata to find it back here via `storage_name`.
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

module.exports = { db, FREE_PLAN_NOTE_LIMIT, UPLOADS_DIR };
