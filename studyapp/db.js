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

// Migrations for the monthly AI-generation cap (Premium gets a small taste,
// Pro gets the real allowance - see MONTHLY_AI_GENERATION_LIMITS in plans.js)
// plus a non-expiring "bonus" balance from one-time top-up purchases (Pro
// only - see /api/billing/topup in server.js). ai_period_start is the
// first-of-month date (YYYY-MM-01) the counter was last reset for - checked
// lazily on each use rather than via a cron job, since this is a
// single-process app with no scheduler already running.
try {
  db.exec('ALTER TABLE users ADD COLUMN ai_generations_used INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec("ALTER TABLE users ADD COLUMN ai_period_start TEXT NOT NULL DEFAULT ''");
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}
try {
  db.exec('ALTER TABLE users ADD COLUMN ai_bonus_generations INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Migration for PDF text extraction (Premium) - lets a search match text
// inside an uploaded PDF's pages, not just a note's own typed content. Only
// ever populated for a PDF's rendered page files (see prepareUploadedPages in
// server.js); null for a plain image upload or on any database that predates
// this feature.
try {
  db.exec('ALTER TABLE files ADD COLUMN extracted_text TEXT');
} catch (e) {
  // Column already exists - fine, this only runs once per database.
}

// Note version history (Premium). A snapshot is written just before an edit
// overwrites a note's content (see the note PATCH route in server.js) - so
// this holds the note's content as it was *before* each save, not after.
// Capped to the most recent 20 snapshots per note (pruned on write) so a
// heavily-edited note can't grow this table without bound.
db.exec(`
  CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content_html TEXT NOT NULL,
    template TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(note_id) REFERENCES notes(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);
const MAX_NOTE_VERSIONS_PER_NOTE = 20;

// Spaced-repetition scheduling state for flashcard study sets (Pro). One row
// per (study_set_id, item_index) - item_index indexes into that set's own
// content_json array, since generated items don't otherwise have a stable id
// of their own. Uses a simplified SM-2 algorithm (see reviewFlashcards() in
// server.js): ease_factor/interval_days/repetitions are SM-2's own state,
// due_at is just ease_factor+interval_days resolved to an actual date so
// "what's due today" is a plain comparison.
db.exec(`
  CREATE TABLE IF NOT EXISTS flashcard_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_set_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    item_index INTEGER NOT NULL,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_reviewed_at TEXT,
    FOREIGN KEY(study_set_id) REFERENCES study_sets(id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(study_set_id, item_index)
  );
`);

// One row per completed true/false drill or practice-test submission (Pro),
// so performance can be tracked over time instead of the score just
// disappearing the moment you leave the player. results_json is a plain
// array of booleans, one per item, in item order - kept alongside
// correct_count/total_count (which are cheap to query on their own) so the
// "which questions do I keep missing" breakdown can be computed without
// re-parsing every row's JSON on every request... actually it still has to
// parse them; this just keeps the common "score over time" queries simple.
db.exec(`
  CREATE TABLE IF NOT EXISTS practice_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_set_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    total_count INTEGER NOT NULL,
    results_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(study_set_id) REFERENCES study_sets(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

const FREE_PLAN_NOTE_LIMIT = 10;

// Where uploaded file *contents* live on disk (separate from the SQLite
// database file, but under the same overridable persistent-volume DATA_DIR
// so both survive a redeploy). Each file's row in the `files` table stores
// enough metadata to find it back here via `storage_name`.
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

module.exports = { db, FREE_PLAN_NOTE_LIMIT, UPLOADS_DIR, MAX_NOTE_VERSIONS_PER_NOTE };
