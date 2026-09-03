// server.js
// Zero-dependency Node.js HTTP server: static file serving + a small JSON API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { db, FREE_PLAN_NOTE_LIMIT, UPLOADS_DIR, MAX_NOTE_VERSIONS_PER_NOTE } = require('./db');
const {
  createUser,
  getUserByEmail,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserBySession,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  SESSION_COOKIE,
  createPasswordReset,
  getValidPasswordReset,
  markPasswordResetUsed,
  updateUserPassword,
} = require('./auth');
const { DEFAULT_TEMPLATE, isTemplateAllowedForPlan, templatesForClient } = require('./templates');
const { planAtLeast, MONTHLY_AI_GENERATION_LIMITS, GENERATION_TOPUP_PRICE_USD, GENERATION_TOPUP_AMOUNT } = require('./plans');
const { FOLDER_COLORS, DEFAULT_FOLDER_COLOR, isValidFolderColor } = require('./folderColors');
const { sendPasswordResetEmail, emailSendingConfigured } = require('./email');
const {
  billingConfigured,
  proBillingConfigured,
  topupConfigured,
  createCheckoutSession,
  updateSubscriptionPrice,
  createTopupCheckoutSession,
  createBillingPortalSession,
  verifyWebhookSignature,
} = require('./stripe');
const { renderPdfToPngPages, MAX_PDF_PAGES, extractPdfText } = require('./pdfRender');
const { buildNotePdf, buildFolderPdf } = require('./notePdf');
const { generateStudySet, generateSummary, answerFromNotes, aiConfigured } = require('./ai');
const { noteToPlainText } = require('./noteText');
const {
  driveConfigured,
  encryptToken,
  buildConsentUrl,
  exchangeCodeForTokens,
  getAccessToken,
  findOrCreateAppFolder,
  syncFileToDrive,
} = require('./google');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// A single shared secret (set via the ADMIN_SECRET environment variable on
// Railway/wherever this is hosted) gates the read-only admin user list below.
// This is intentionally simple - a per-user "isAdmin" column would be
// overkill for a solo/small-team operator just wanting to see who signed up -
// but it does mean the endpoint is unusable at all until that env var is
// actually set, rather than silently open with some guessable default.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
function isValidAdminSecret(provided) {
  if (!ADMIN_SECRET || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
  // Lengths almost never match by chance, but timingSafeEqual throws if they
  // differ rather than just returning false - so pad/compare a fixed-length
  // hash of each side instead of the raw values themselves, to avoid leaking
  // the secret's length via which branch runs.
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}
// Shared gate for every /api/admin/* route below - returns an {status, error}
// pair to send back if the caller isn't allowed in, or null if they're clear.
function adminAuthError(req, url) {
  if (!ADMIN_SECRET) {
    return { status: 503, error: 'Admin access is not configured. Set the ADMIN_SECRET environment variable, then redeploy.' };
  }
  const provided = req.headers['x-admin-secret'] || url.searchParams.get('secret');
  if (!isValidAdminSecret(provided)) {
    return { status: 401, error: 'Invalid admin secret.' };
  }
  return null;
}
const VALID_PLANS = ['free', 'paid', 'pro'];
function sanitizeAdminUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    plan: row.plan,
    noteCount: row.note_count,
    createdAt: row.created_at,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Uploaded files come in as base64 inside a JSON body rather than a real
// multipart/form-data upload - keeps this consistent with the rest of the
// app's zero-npm-dependency approach instead of hand-rolling a multipart
// parser. 15MB covers a typical scanned PDF or lecture slide deck comfortably
// on the Free plan; Premium gets a higher cap (40MB) as one of its perks.
// base64 inflates the wire size by ~33%, so the actual request body limit
// passed to readBody() below is set a bit higher than the file-size cap.
const FREE_MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
const PAID_MAX_UPLOAD_FILE_BYTES = 40 * 1024 * 1024;
function maxUploadFileBytesForPlan(plan) {
  return planAtLeast(plan, 'paid') ? PAID_MAX_UPLOAD_FILE_BYTES : FREE_MAX_UPLOAD_FILE_BYTES;
}
function maxUploadBodyBytesForPlan(plan) {
  return Math.ceil(maxUploadFileBytesForPlan(plan) * 1.4);
}
function uploadSizeLimitMessage(plan, noun = 'Files') {
  const mb = Math.round(maxUploadFileBytesForPlan(plan) / (1024 * 1024));
  return `That file is too large. ${noun} are limited to ${mb}MB.`;
}

// ---- AI generation cap (Premium: 5/month taste, Pro: 40/month, plus a
// Pro-only non-expiring bonus balance from the $3.99/10-generation top-up) ----
// One "generation" is a single AI study-set generation, note summary, or
// question asked via "Ask your notes" - see consumeGeneration() below, called
// right after each of those succeeds.
function currentPeriodKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Lazily resets the monthly counter the first time it's checked in a new
// calendar month, rather than needing a cron job (this is a single-process
// app with no scheduler already running - same reasoning as the Google Drive
// auto-sync code just firing on save instead of polling). Returns a
// (possibly freshly-reloaded) user row.
function ensureCurrentGenerationPeriod(user) {
  const period = currentPeriodKey();
  if (user.ai_period_start === period) return user;
  db.prepare('UPDATE users SET ai_generations_used = 0, ai_period_start = ? WHERE id = ?').run(period, user.id);
  return { ...user, ai_generations_used: 0, ai_period_start: period };
}

function generationLimitForPlan(plan) {
  return MONTHLY_AI_GENERATION_LIMITS[plan] ?? 0;
}

// { limit, used, bonus, remaining } - `remaining` folds the monthly allowance
// and the non-expiring bonus balance together into one number, since from the
// user's point of view "how many can I still generate" is what actually
// matters; the two are only tracked separately so the bonus balance survives
// the monthly reset.
function generationStatus(user) {
  const fresh = ensureCurrentGenerationPeriod(user);
  const limit = generationLimitForPlan(fresh.plan);
  const used = fresh.ai_generations_used || 0;
  const bonus = fresh.ai_bonus_generations || 0;
  const monthlyRemaining = Math.max(0, limit - used);
  return { limit, used, bonus, remaining: monthlyRemaining + bonus };
}

// Actually spends one generation - call only after the AI call it's gating
// has already succeeded, so a failed/errored AI request never costs the user
// part of their allowance. Prefers the monthly allowance first, falling back
// to the bonus balance only once that's exhausted, so a top-up purchase never
// expires unused just because next month's free allowance reset over it.
function consumeGeneration(user) {
  const fresh = ensureCurrentGenerationPeriod(user);
  const limit = generationLimitForPlan(fresh.plan);
  const used = fresh.ai_generations_used || 0;
  if (used < limit) {
    db.prepare('UPDATE users SET ai_generations_used = ai_generations_used + 1 WHERE id = ?').run(fresh.id);
  } else {
    db.prepare('UPDATE users SET ai_bonus_generations = MAX(0, ai_bonus_generations - 1) WHERE id = ?').run(fresh.id);
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(fresh.id);
}

function generationLimitReachedMessage(plan) {
  if (plan === 'pro') {
    return `You've used all your AI generations for this month. Buy 10 more for $${GENERATION_TOPUP_PRICE_USD.toFixed(2)}, or wait until next month when your allowance resets.`;
  }
  return `You've used your ${generationLimitForPlan(plan)} free AI generations this month. Upgrade to Pro for 40 a month, plus flashcard review mode, note summaries, and more.`;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Once we know the body is over budget, stop bothering to buffer any
        // more of it - but let the request keep draining instead of calling
        // req.destroy() here. Destroying the socket mid-upload tears down the
        // connection before our friendly 413 JSON response below ever gets a
        // chance to go out, so the client just sees a raw network error (a
        // reset) instead of the actual "that file is too large" message.
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body too large'));
        return;
      }
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Like readBody(), but returns the exact raw bytes as a string instead of
// parsing JSON - needed for the Stripe webhook endpoint, whose signature is
// computed over the untouched raw request body. Re-serializing a parsed
// object back to JSON wouldn't necessarily byte-for-byte match what Stripe
// actually sent, which would make the signature check fail.
function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Image types that can become a note "page" directly, with no conversion.
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Shared by both "add a file as a page in this note" and "upload a file as a
// brand-new note": decodes+validates the uploaded bytes, and - for a PDF -
// renders each of its pages to a PNG. Returns { fileRows: [{filename,
// mimeType, buffer}], warning } where fileRows is one entry per resulting
// page (a plain image is always exactly one entry; a PDF is one per page).
// Throws an Error with a `.status` and friendly `.message` on any problem,
// so callers can just catch it and send it straight back to the client.
async function prepareUploadedPages({ filename, mimeType, dataBase64 }, maxFileBytes = FREE_MAX_UPLOAD_FILE_BYTES) {
  if (!filename || !dataBase64) {
    const err = new Error('A filename and file contents are required.');
    err.status = 400;
    throw err;
  }
  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch (e) {
    const err = new Error('Could not read that file.');
    err.status = 400;
    throw err;
  }
  if (buffer.length === 0) {
    const err = new Error('That file appears to be empty.');
    err.status = 400;
    throw err;
  }
  if (buffer.length > maxFileBytes) {
    const err = new Error(uploadSizeLimitMessage(maxFileBytes === PAID_MAX_UPLOAD_FILE_BYTES ? 'paid' : 'free'));
    err.status = 413;
    throw err;
  }

  const baseName = filename.replace(/\.[^./\\]+$/, '').slice(0, 200) || 'file';

  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      fileRows: [{ filename: filename.slice(0, 255), mimeType, buffer }],
      warning: null,
    };
  }

  if (mimeType === 'application/pdf') {
    let rendered;
    try {
      rendered = await renderPdfToPngPages(buffer);
    } catch (e) {
      const err = new Error("Couldn't read that PDF. It may be corrupted or password-protected.");
      err.status = 400;
      throw err;
    }
    if (rendered.pages.length === 0) {
      const err = new Error('That PDF has no pages.');
      err.status = 400;
      throw err;
    }
    // Text extraction (Premium) - lets a later search match words inside this
    // PDF, not just a note's own typed content (see /api/notes/search below).
    // Best-effort: extractPdfText() already swallows its own errors and
    // returns [] rather than throwing, so a PDF that renders fine but can't
    // have its text pulled out (a pure image scan, say) just gets no
    // extracted text instead of failing the whole upload.
    const pageTexts = await extractPdfText(buffer);
    const fileRows = rendered.pages.map((pngBuffer, i) => ({
      filename: `${baseName}-page-${i + 1}.png`,
      mimeType: 'image/png',
      buffer: pngBuffer,
      extractedText: pageTexts[i] || null,
    }));
    const warning = rendered.truncated
      ? `This PDF has ${rendered.totalPages} pages - only the first ${MAX_PDF_PAGES} were added.`
      : null;
    return { fileRows, warning };
  }

  const err = new Error(
    'PDF and image files are supported right now. Word, PowerPoint, and Excel aren’t yet - try saving it as a PDF first.'
  );
  err.status = 415;
  throw err;
}

// Writes one already-prepared page (see prepareUploadedPages) to disk and
// inserts its `files` row, returning the new file's id.
function storeUploadedPageFile({ userId, noteId, filename, mimeType, buffer, extractedText }) {
  const safeExt = path.extname(filename).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
  const storageName = `${crypto.randomUUID()}${safeExt}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storageName), buffer);
  const info = db
    .prepare('INSERT INTO files (user_id, note_id, filename, mime_type, size_bytes, storage_name, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, noteId, filename, mimeType, buffer.length, storageName, extractedText || null);
  return Number(info.lastInsertRowid);
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getUserBySession(cookies[SESSION_COOKIE]);
}

function publicUser(user) {
  const generation = generationStatus(user);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    theme: user.theme,
    textSize: user.text_size,
    createdAt: user.created_at,
    googleDriveConnected: Boolean(user.google_refresh_token),
    googleAutoSync: Boolean(user.google_auto_sync),
    aiGenerationsLimit: generation.limit,
    aiGenerationsUsed: generation.used,
    aiGenerationsBonus: generation.bonus,
    aiGenerationsRemaining: generation.remaining,
  };
}

// ---- Google Drive sync (Premium/Pro) ----
// A short-lived, single-use CSRF token for the OAuth connect flow: created
// when a logged-in user starts "Connect Google Drive", checked when Google
// redirects back with an authorization code, then discarded either way.
// Plain in-memory Map is fine here (same reasoning as sessions living in
// SQLite rather than a separate store - this is a single-process app), and a
// 10-minute TTL comfortably covers even a slow consent screen.
const pendingGoogleStates = new Map();
function createGoogleState(userId) {
  const state = crypto.randomBytes(24).toString('hex');
  pendingGoogleStates.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}
function consumeGoogleState(state) {
  const entry = pendingGoogleStates.get(state);
  pendingGoogleStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

// Renders a note to PDF and pushes it into the user's "ScribeStack" Drive
// folder, creating the folder/file the first time and updating the same
// file every time after. Returns {fileId, folderId}. Throws with a
// `.code === 'GOOGLE_DISCONNECTED'` error if the refresh token Google gave
// us no longer works (revoked from their Google Account settings) - callers
// should clear the user's connection in that case rather than keep retrying.
async function syncNoteToDrive(user, note) {
  const accessToken = await getAccessToken(user.google_refresh_token);
  const folderId = await findOrCreateAppFolder(accessToken, user.google_drive_folder_id);
  if (folderId !== user.google_drive_folder_id) {
    db.prepare('UPDATE users SET google_drive_folder_id = ? WHERE id = ?').run(folderId, user.id);
  }
  const pdfBuffer = await buildNotePdf(note, (fileId) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, user.id);
    if (!file) return null;
    const diskPath = path.join(UPLOADS_DIR, file.storage_name);
    if (!fs.existsSync(diskPath)) return null;
    return { buffer: fs.readFileSync(diskPath), mimeType: file.mime_type };
  });
  const safeName = (note.title || 'Untitled note').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 150) || 'Untitled note';
  const fileId = await syncFileToDrive({
    accessToken,
    folderId,
    existingFileId: note.google_file_id,
    fileName: `${safeName}.pdf`,
    buffer: pdfBuffer,
    mimeType: 'application/pdf',
  });
  db.prepare("UPDATE notes SET google_file_id = ?, google_synced_at = datetime('now') WHERE id = ?").run(fileId, note.id);
  return { fileId, folderId };
}

// Fire-and-forget wrapper used right after a note save, when auto-sync is on -
// the caller doesn't await this, so a slow or failing Drive call never adds
// latency to (or breaks) the actual save. Auto-disconnects the user's Drive
// link if Google says the grant was revoked, so the UI stops claiming
// they're connected when they no longer are.
function autoSyncNoteToDrive(user, note) {
  syncNoteToDrive(user, note).catch((e) => {
    if (e.code === 'GOOGLE_DISCONNECTED') {
      db.prepare('UPDATE users SET google_refresh_token = NULL, google_auto_sync = 0 WHERE id = ?').run(user.id);
    }
    console.error(`Google Drive auto-sync failed for note ${note.id}:`, e.message);
  });
}

const VALID_THEMES = ['light', 'dark', 'system'];
const VALID_TEXT_SIZES = ['small', 'medium', 'large'];

// A lightweight snapshot of a note's first page of content, used to draw the
// small visual preview on note cards in the grid without shipping the note's
// entire (potentially multi-page) content over the wire for every single
// card. content_html is stored as a JSON array of per-page objects, e.g.
// {type:'text', html, annotations} or {type:'document', fileId, annotations}.
// Older notes predate that shape in two ways this still has to handle:
// notes saved before file-pages existed just stored a plain array of HTML
// strings, and notes saved before pagination existed at all stored raw HTML
// directly. Returns either {type:'text', html} or {type:'document', fileId}
// so the client knows whether to render markup or an <img>. Capped
// defensively at 20,000 characters - in practice a single page's worth of
// text content never gets remotely close to that, so this is a safety valve
// rather than a normal-operation limit.
function firstPageHtml(contentHtml) {
  if (!contentHtml) return { type: 'text', html: '' };
  try {
    const parsed = JSON.parse(contentHtml);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (typeof first === 'string') return { type: 'text', html: first.slice(0, 20000) };
      if (first && first.type === 'document') return { type: 'document', fileId: first.fileId };
      return { type: 'text', html: ((first && first.html) || '').slice(0, 20000) };
    }
  } catch (e) {
    // Not JSON - a legacy pre-pagination note storing raw HTML directly.
  }
  return { type: 'text', html: contentHtml.slice(0, 20000) };
}

// Strips the two lock-credential columns (lock_hash/lock_salt - see the
// note-lock routes below) from a note row before it's sent to the client.
// These are a scrypt hash + salt, same as a user's own password columns
// never leave /api/me - they exist purely to verify an unlock attempt
// server-side, and every note response needs to go through this before
// reaching sendJson, no matter which route built it. Adds a plain `locked`
// boolean the client can key off of instead.
function sanitizeNote(note) {
  if (!note) return note;
  const { lock_hash, lock_salt, ...rest } = note;
  return { ...rest, locked: !!lock_hash };
}

// A study set's card in the "AI Study Sets" hub only ever needs the metadata
// below, not the (potentially large) generated content itself - mirrors how
// the note grid gets a lightweight previewHtml instead of full content_html.
function sanitizeStudySetSummary(row) {
  const sourceNote = row.note_id ? db.prepare('SELECT id, title FROM notes WHERE id = ?').get(row.note_id) : null;
  return {
    id: row.id,
    title: row.title,
    setType: row.set_type,
    difficulty: row.difficulty,
    length: row.length,
    isFavorite: !!row.is_favorite,
    sourceNote: sourceNote ? { id: sourceNote.id, title: sourceNote.title } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The full study set, including its generated items - only sent when
// actually opening one to study from (GET /api/study-sets/:id).
function sanitizeStudySet(row) {
  let items = [];
  try {
    items = JSON.parse(row.content_json);
  } catch (e) {
    items = [];
  }
  return { ...sanitizeStudySetSummary(row), items };
}

// ---- Static file serving ----
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Fall back to index.html for client-side style navigation (single page app).
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(fullPath);
    // Without this, browsers are free to keep serving an old cached copy of
    // app.js/styles.css/index.html indefinitely, even after a fresh deploy -
    // that's what let a stale toolbar script (mismatched with newer HTML)
    // silently keep running in someone's browser after an update went live.
    // "no-cache" doesn't mean "never cache" - it means the browser must
    // check back with the server on every load, so updates always take
    // effect on the next page refresh instead of possibly hours/days later.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- API handlers ----
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  try {
    // --- Auth ---
    if (pathname === '/api/signup' && method === 'POST') {
      const { email, name, password, agreedToTerms } = await readBody(req);
      if (!email || !name || !password) {
        return sendJson(res, 400, { error: 'Email, name, and password are required.' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      }
      if (!agreedToTerms) {
        return sendJson(res, 400, { error: 'You must agree to the Terms of Service and Privacy Policy to create an account.' });
      }
      if (getUserByEmail(email)) {
        return sendJson(res, 409, { error: 'An account with that email already exists.' });
      }
      const user = createUser(email, name, password);
      const session = createSession(user.id);
      return sendJson(res, 201, { user: publicUser(user) }, {
        'Set-Cookie': sessionCookieHeader(session.id, session.expiresAt),
      });
    }

    if (pathname === '/api/login' && method === 'POST') {
      const { email, password } = await readBody(req);
      const user = email ? getUserByEmail(email) : null;
      if (!user || !verifyPassword(password || '', user.password_salt, user.password_hash)) {
        return sendJson(res, 401, { error: 'Incorrect email or password.' });
      }
      const session = createSession(user.id);
      return sendJson(res, 200, { user: publicUser(user) }, {
        'Set-Cookie': sessionCookieHeader(session.id, session.expiresAt),
      });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[SESSION_COOKIE]) destroySession(cookies[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
    }

    if (pathname === '/api/me' && method === 'GET') {
      const user = getCurrentUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not logged in.' });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/forgot-password' && method === 'POST') {
      const { email } = await readBody(req);
      const account = email ? getUserByEmail(email) : null;
      if (account) {
        const { token } = createPasswordReset(account.id);
        if (emailSendingConfigured()) {
          const resetUrl = `https://${req.headers.host}/?reset=${token}`;
          try {
            await sendPasswordResetEmail(account.email, resetUrl);
          } catch (err) {
            // Email delivery failing shouldn't break the request or leak the
            // token back to the caller (same reasoning as the note below) -
            // just log it server-side, same as the no-email-configured path,
            // so the site owner can still help out manually if needed.
            console.error('Failed to send password reset email:', err.message);
            console.log(`[password reset - email failed, here's the link] ${account.email} -> ${resetUrl}`);
          }
        } else {
          // NOTE: no email service is configured yet (e.g. running locally
          // on your own computer). Rather than handing the reset link back
          // in the API response (which would let anyone reset ANY account
          // just by knowing its email address - a real account takeover
          // risk once this is running on a public URL), it's only logged
          // server-side for now, where only the site owner can see it.
          console.log(`[password reset] ${account.email} -> /?reset=${token}`);
        }
      }
      // Always return the same generic message regardless of whether the
      // email exists, so this endpoint can't be used to find out who has an account.
      return sendJson(res, 200, {
        message: emailSendingConfigured()
          ? 'If an account exists for that email, a reset link has been emailed to it.'
          : "If an account exists for that email, a reset link has been created. Email sending isn't set up yet, so for now ask the site owner to look it up for you.",
      });
    }

    if (pathname === '/api/reset-password' && method === 'POST') {
      const { token, newPassword } = await readBody(req);
      const reset = token ? getValidPasswordReset(token) : null;
      if (!reset) {
        return sendJson(res, 400, { error: 'This reset link is invalid or has expired. Request a new one.' });
      }
      if (!newPassword || newPassword.length < 8) {
        return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      }
      updateUserPassword(reset.user_id, newPassword);
      markPasswordResetUsed(token);
      return sendJson(res, 200, { ok: true });
    }

    // --- Stripe webhook (Stripe's servers call this directly - no session
    // cookie, so it has to live above the "everything below requires auth"
    // line. Authenticity is instead verified via the signed request body.) ---
    if (pathname === '/api/webhooks/stripe' && method === 'POST') {
      let rawBody;
      try {
        rawBody = await readRawBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'Could not read webhook body.' });
      }
      let event;
      try {
        event = verifyWebhookSignature(rawBody, req.headers['stripe-signature']);
      } catch (e) {
        console.error('Stripe webhook signature check failed:', e.message);
        return sendJson(res, 400, { error: 'Invalid signature.' });
      }

      try {
        const obj = (event.data && event.data.object) || {};
        if (event.type === 'checkout.session.completed' && obj.metadata && obj.metadata.type === 'ai_topup') {
          // The one-time "buy 10 more generations" purchase (mode 'payment',
          // not 'subscription') - see createTopupCheckoutSession() in
          // stripe.js. Handled as its own branch, ahead of the subscription
          // logic below, since both a subscription and a top-up fire the same
          // checkout.session.completed event and only metadata.type tells
          // them apart.
          const userId = Number(obj.client_reference_id || obj.metadata.userId);
          if (userId) {
            db.prepare('UPDATE users SET ai_bonus_generations = ai_bonus_generations + ? WHERE id = ?')
              .run(GENERATION_TOPUP_AMOUNT, userId);
          }
        } else if (event.type === 'checkout.session.completed') {
          // The moment someone finishes paying - flip them to whichever tier
          // they actually checked out for right away. client_reference_id/
          // metadata.userId were stamped on the session when we created it
          // in createCheckoutSession(); metadata.tier says Premium vs Pro
          // (defaulting to Premium for any older session that predates Pro).
          const userId = Number(obj.client_reference_id || (obj.metadata && obj.metadata.userId));
          const tier = (obj.metadata && obj.metadata.tier === 'pro') ? 'pro' : 'paid';
          if (userId) {
            db.prepare(
              'UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?'
            ).run(tier, obj.customer || null, obj.subscription || null, userId);
          }
        } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
          // Covers renewals, cancellations, payment failures that lapse a
          // subscription, and an in-place Premium<->Pro tier swap - keeps a
          // user's plan in sync with what they're actually still paying for,
          // not just what happened at checkout.
          const stillActive = event.type !== 'customer.subscription.deleted' && ['active', 'trialing'].includes(obj.status);
          const tier = (obj.metadata && obj.metadata.tier === 'pro') ? 'pro' : 'paid';
          const userId = Number(obj.metadata && obj.metadata.userId);
          if (userId) {
            db.prepare("UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE id = ?")
              .run(stillActive ? tier : 'free', stillActive ? obj.id : null, userId);
          } else if (obj.customer) {
            // Fallback for events that don't carry our metadata - match by
            // the Stripe customer id we saved back at checkout time.
            db.prepare("UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?")
              .run(stillActive ? tier : 'free', stillActive ? obj.id : null, obj.customer);
          }
        }
      } catch (e) {
        // A bug here shouldn't make Stripe hammer this endpoint with
        // retries forever - log it for us to investigate and move on.
        console.error('Error handling Stripe webhook event:', event.type, e);
      }

      return sendJson(res, 200, { received: true });
    }

    // --- Admin (owner-only user list, gated by ADMIN_SECRET, not a user
    // session - see the ADMIN_SECRET comment near the top of this file. Has
    // to live above the "everything below requires auth" line, same reason
    // as the Stripe webhook: this isn't called with a logged-in user's
    // session cookie at all.) ---
    if (pathname === '/api/admin/users' && method === 'GET') {
      const adminErr = adminAuthError(req, url);
      if (adminErr) return sendJson(res, adminErr.status, { error: adminErr.error });
      const rows = db.prepare(`
        SELECT
          u.id, u.name, u.email, u.plan, u.created_at,
          (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS note_count
        FROM users u
        ORDER BY u.created_at DESC
      `).all();
      return sendJson(res, 200, { users: rows.map(sanitizeAdminUser), total: rows.length });
    }

    // Admin: edit a user's display name, force-set a new password for them
    // (e.g. they emailed you locked out), and/or change their plan directly
    // (comps, support fixes, testing) - all in one PATCH so the admin page
    // can send just whichever field(s) it's changing. Never accepts or
    // returns password_hash/password_salt - there's no "view the password"
    // path, by design (see the ADMIN_SECRET comment up top).
    const mAdminUser = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (mAdminUser && method === 'PATCH') {
      const adminErr = adminAuthError(req, url);
      if (adminErr) return sendJson(res, adminErr.status, { error: adminErr.error });
      const targetId = Number(mAdminUser[1]);
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
      if (!target) return sendJson(res, 404, { error: 'No account with that id.' });

      const { name, plan, newPassword } = await readBody(req);

      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return sendJson(res, 400, { error: 'Name cannot be empty.' });
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trimmed, targetId);
      }

      if (plan !== undefined) {
        if (!VALID_PLANS.includes(plan)) {
          return sendJson(res, 400, { error: `Plan must be one of: ${VALID_PLANS.join(', ')}.` });
        }
        // This only flips the plan column locally - it does not touch Stripe
        // at all. That's deliberate (comping someone or fixing a stuck
        // account shouldn't require a real subscription), but it does mean
        // it can drift from Stripe's own idea of what they're paying for -
        // if they later cancel or their card fails, Stripe's webhook will
        // still downgrade them back to whatever it thinks is correct.
        db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, targetId);
      }

      if (newPassword !== undefined) {
        if (!newPassword || newPassword.length < 8) {
          return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
        }
        updateUserPassword(targetId, newPassword);
      }

      const updated = db.prepare(`
        SELECT u.id, u.name, u.email, u.plan, u.created_at,
          (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS note_count
        FROM users u WHERE u.id = ?
      `).get(targetId);
      return sendJson(res, 200, { user: sanitizeAdminUser(updated) });
    }

    // Everything below requires auth
    const user = getCurrentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not logged in.' });

    // --- Templates ---
    if (pathname === '/api/templates' && method === 'GET') {
      return sendJson(res, 200, { templates: templatesForClient(user.plan) });
    }

    // --- Account / settings ---
    if (pathname === '/api/me' && method === 'PATCH') {
      const body = await readBody(req);
      const setClauses = [];
      const params = [];

      if (body.name !== undefined) {
        if (!body.name || !body.name.trim()) return sendJson(res, 400, { error: 'Name is required.' });
        setClauses.push('name = ?');
        params.push(body.name.trim());
      }
      if (body.theme !== undefined) {
        if (!VALID_THEMES.includes(body.theme)) return sendJson(res, 400, { error: 'Invalid theme.' });
        setClauses.push('theme = ?');
        params.push(body.theme);
      }
      if (body.textSize !== undefined) {
        if (!VALID_TEXT_SIZES.includes(body.textSize)) return sendJson(res, 400, { error: 'Invalid text size.' });
        setClauses.push('text_size = ?');
        params.push(body.textSize);
      }

      if (setClauses.length) {
        params.push(user.id);
        db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
      }
      const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return sendJson(res, 200, { user: publicUser(updated) });
    }

    if (pathname === '/api/me/password' && method === 'POST') {
      const { currentPassword, newPassword } = await readBody(req);
      if (!verifyPassword(currentPassword || '', user.password_salt, user.password_hash)) {
        return sendJson(res, 401, { error: 'Current password is incorrect.' });
      }
      if (!newPassword || newPassword.length < 8) {
        return sendJson(res, 400, { error: 'New password must be at least 8 characters.' });
      }
      updateUserPassword(user.id, newPassword);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && method === 'DELETE') {
      const { password } = await readBody(req);
      if (!verifyPassword(password || '', user.password_salt, user.password_hash)) {
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }
      // Cascade-delete everything that belongs to this account. Files first
      // (both their disk storage and DB rows) - the notes/files DELETE below
      // would otherwise leave orphaned file content sitting on the
      // persistent volume forever with nothing left pointing to it.
      const ownedFiles = db.prepare('SELECT * FROM files WHERE user_id = ?').all(user.id);
      for (const f of ownedFiles) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storage_name)); } catch (e) { /* already gone - fine */ }
      }
      db.prepare('DELETE FROM files WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM study_sets WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM notes WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM folders WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
    }

    // --- Billing (Stripe Managed Payments) ---
    if (pathname === '/api/billing/checkout' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const tier = body.tier === 'pro' ? 'pro' : 'paid';
      if (!billingConfigured()) {
        return sendJson(res, 503, { error: 'Billing is not set up yet - check back soon.' });
      }
      if (tier === 'pro' && !proBillingConfigured()) {
        return sendJson(res, 503, { error: 'Pro billing is not set up yet - check back soon.' });
      }
      const origin = `https://${req.headers.host}`;
      try {
        // Already has an active paid subscription and is switching tiers in
        // place (Premium <-> Pro) - modify that one subscription rather than
        // starting a second, separately-billed one alongside it.
        if (user.stripe_subscription_id && planAtLeast(user.plan, 'paid') && user.plan !== tier) {
          await updateSubscriptionPrice({ subscriptionId: user.stripe_subscription_id, tier, userId: user.id });
          db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(tier, user.id);
          return sendJson(res, 200, { upgraded: true, plan: tier });
        }
        const url = await createCheckoutSession({
          userId: user.id,
          email: user.email,
          tier,
          successUrl: `${origin}/?upgraded=${tier}`,
          cancelUrl: `${origin}/?upgrade_cancelled=1`,
        });
        return sendJson(res, 200, { url });
      } catch (e) {
        console.error('Failed to start checkout/upgrade:', e.message);
        return sendJson(res, 502, { error: 'Could not start checkout right now. Please try again in a moment.' });
      }
    }

    // One-time "buy 10 more generations" top-up (Pro only) - a separate,
    // non-recurring Stripe Checkout session (mode 'payment', not
    // 'subscription') from the plan upgrade flow above. The purchase itself
    // is credited by the webhook handler once payment actually completes,
    // not here (same reasoning as a subscription upgrade only taking effect
    // once Stripe confirms it, not the moment checkout starts).
    if (pathname === '/api/billing/topup' && method === 'POST') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Buying extra generations is available on Pro.',
          code: 'PRO_REQUIRED',
        });
      }
      if (!topupConfigured()) {
        return sendJson(res, 503, { error: 'Buying extra generations is not set up yet - check back soon.' });
      }
      const origin = `https://${req.headers.host}`;
      try {
        const url = await createTopupCheckoutSession({
          userId: user.id,
          email: user.email,
          successUrl: `${origin}/?topup=success`,
          cancelUrl: `${origin}/?topup=cancelled`,
        });
        return sendJson(res, 200, { url });
      } catch (e) {
        console.error('Failed to start generation top-up checkout:', e.message);
        return sendJson(res, 502, { error: 'Could not start checkout right now. Please try again in a moment.' });
      }
    }

    if (pathname === '/api/billing/portal' && method === 'POST') {
      if (!billingConfigured()) {
        return sendJson(res, 503, { error: 'Billing is not set up yet - check back soon.' });
      }
      if (!user.stripe_customer_id) {
        return sendJson(res, 400, { error: 'No billing account found for your account yet.' });
      }
      const origin = `https://${req.headers.host}`;
      try {
        const url = await createBillingPortalSession({
          customerId: user.stripe_customer_id,
          returnUrl: `${origin}/`,
        });
        return sendJson(res, 200, { url });
      } catch (e) {
        console.error('Failed to create Stripe billing portal session:', e.message);
        return sendJson(res, 502, { error: 'Could not open billing settings right now. Please try again in a moment.' });
      }
    }

    // --- Google Drive sync (Premium/Pro) ---
    if (pathname === '/api/google/connect' && method === 'GET') {
      if (!driveConfigured()) {
        return sendJson(res, 503, { error: 'Google Drive sync is not set up yet - check back soon.' });
      }
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Syncing to Google Drive is a Premium feature. Upgrade to Premium to turn it on.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const state = createGoogleState(user.id);
      return sendJson(res, 200, { url: buildConsentUrl(state) });
    }

    // Google redirects the browser here directly (not an API call from our
    // own frontend) after the user approves or cancels on Google's consent
    // screen - so this always responds with a redirect back into the app
    // rather than JSON, the same pattern billing/checkout's successUrl uses
    // for landing back from Stripe. Reachable with a normal session cookie
    // because it's a top-level GET navigation on our own domain, which
    // SameSite=Lax cookies are sent on.
    if (pathname === '/api/google/callback' && method === 'GET') {
      const origin = `https://${req.headers.host}`;
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const expectedUserId = returnedState ? consumeGoogleState(returnedState) : null;
      if (!expectedUserId || expectedUserId !== user.id) {
        res.writeHead(302, { Location: `${origin}/?google=error&message=${encodeURIComponent('That connection request expired or was invalid - please try again.')}` });
        return res.end();
      }
      if (!code) {
        // User clicked "Cancel" on Google's consent screen.
        res.writeHead(302, { Location: `${origin}/?google=cancelled` });
        return res.end();
      }
      try {
        const tokens = await exchangeCodeForTokens(code);
        if (!tokens.refresh_token) {
          // Shouldn't normally happen (prompt=consent forces one), but if
          // Google ever omits it, connecting would silently be unable to
          // sync anything after the access token expires - better to say so.
          throw new Error('Google did not grant offline access - please try connecting again.');
        }
        db.prepare('UPDATE users SET google_refresh_token = ?, google_drive_folder_id = NULL WHERE id = ?')
          .run(encryptToken(tokens.refresh_token), user.id);
        res.writeHead(302, { Location: `${origin}/?google=connected` });
        return res.end();
      } catch (e) {
        console.error('Google Drive connect failed:', e.message);
        res.writeHead(302, { Location: `${origin}/?google=error&message=${encodeURIComponent(e.message)}` });
        return res.end();
      }
    }

    if (pathname === '/api/google/disconnect' && method === 'POST') {
      db.prepare('UPDATE users SET google_refresh_token = NULL, google_auto_sync = 0, google_drive_folder_id = NULL WHERE id = ?').run(user.id);
      return sendJson(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    }

    if (pathname === '/api/google/auto-sync' && method === 'PATCH') {
      if (!user.google_refresh_token) {
        return sendJson(res, 400, { error: 'Connect Google Drive before turning on auto-sync.' });
      }
      const { enabled } = await readBody(req);
      db.prepare('UPDATE users SET google_auto_sync = ? WHERE id = ?').run(enabled ? 1 : 0, user.id);
      return sendJson(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    }

    // Manual "Sync now" - pushes every one of the user's notes (skipping any
    // that are currently locked, same as PDF download) to Drive right away,
    // regardless of whether auto-sync is on. Runs sequentially rather than
    // in parallel so a large note library doesn't fire off dozens of
    // simultaneous Drive uploads at once.
    if (pathname === '/api/google/sync' && method === 'POST') {
      if (!driveConfigured()) {
        return sendJson(res, 503, { error: 'Google Drive sync is not set up yet - check back soon.' });
      }
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Syncing to Google Drive is a Premium feature. Upgrade to Premium to turn it on.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      if (!user.google_refresh_token) {
        return sendJson(res, 400, { error: 'Connect Google Drive first.' });
      }
      const notes = db.prepare("SELECT * FROM notes WHERE user_id = ? AND lock_hash IS NULL").all(user.id);
      let synced = 0;
      const failures = [];
      for (const note of notes) {
        try {
          await syncNoteToDrive(user, note);
          synced++;
        } catch (e) {
          if (e.code === 'GOOGLE_DISCONNECTED') {
            db.prepare('UPDATE users SET google_refresh_token = NULL, google_auto_sync = 0 WHERE id = ?').run(user.id);
            return sendJson(res, 401, { error: 'Your Google Drive connection was revoked. Please reconnect it.', code: 'GOOGLE_DISCONNECTED' });
          }
          failures.push({ noteId: note.id, title: note.title, error: e.message });
        }
      }
      return sendJson(res, 200, { synced, total: notes.length, failures });
    }

    // --- Folders ---
    if (pathname === '/api/folder-colors' && method === 'GET') {
      return sendJson(res, 200, { colors: FOLDER_COLORS, defaultColor: DEFAULT_FOLDER_COLOR });
    }

    if (pathname === '/api/folders' && method === 'GET') {
      const folders = db
        .prepare(`
          SELECT folders.*, (SELECT COUNT(*) FROM notes WHERE notes.folder_id = folders.id) AS note_count
          FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE
        `)
        .all(user.id);
      return sendJson(res, 200, { folders });
    }

    if (pathname === '/api/folders' && method === 'POST') {
      const { name, color } = await readBody(req);
      if (!name || !name.trim()) return sendJson(res, 400, { error: 'Folder name is required.' });
      const folderColor = color && isValidFolderColor(color) ? color : DEFAULT_FOLDER_COLOR;
      const info = db
        .prepare('INSERT INTO folders (user_id, name, color) VALUES (?, ?, ?)')
        .run(user.id, name.trim(), folderColor);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(Number(info.lastInsertRowid));
      return sendJson(res, 201, { folder: { ...folder, note_count: 0 } });
    }

    let m = pathname.match(/^\/api\/folders\/(\d+)$/);
    if (m && method === 'PATCH') {
      const folderId = Number(m[1]);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, user.id);
      if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
      const body = await readBody(req);

      let newName = folder.name;
      let newColor = folder.color;
      const setClauses = [];
      const params = [];

      if (body.name !== undefined) {
        if (!body.name || !body.name.trim()) return sendJson(res, 400, { error: 'Folder name is required.' });
        newName = body.name.trim();
        setClauses.push('name = ?');
        params.push(newName);
      }
      if (body.color !== undefined) {
        if (!isValidFolderColor(body.color)) return sendJson(res, 400, { error: 'Invalid folder color.' });
        newColor = body.color;
        setClauses.push('color = ?');
        params.push(newColor);
      }

      if (setClauses.length) {
        params.push(folderId);
        db.prepare(`UPDATE folders SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
      }

      const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE folder_id = ?').get(folderId).c;
      return sendJson(res, 200, { folder: { ...folder, name: newName, color: newColor, note_count: noteCount } });
    }

    if (m && method === 'DELETE') {
      const folderId = Number(m[1]);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, user.id);
      if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
      // Notes in this folder become unfiled rather than being deleted.
      db.prepare('UPDATE notes SET folder_id = NULL WHERE folder_id = ?').run(folderId);
      db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
      return sendJson(res, 200, { ok: true });
    }

    let mFolderFav = pathname.match(/^\/api\/folders\/(\d+)\/favorite$/);
    if (mFolderFav && method === 'PATCH') {
      const folderId = Number(mFolderFav[1]);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, user.id);
      if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
      const { favorite } = await readBody(req);
      // A dedicated endpoint (rather than folding this into the general
      // folder PATCH above) so favoriting never disturbs anything else about
      // the folder - it only ever touches these two columns.
      if (favorite) {
        db.prepare("UPDATE folders SET is_favorite = 1, favorited_at = datetime('now') WHERE id = ?").run(folderId);
      } else {
        db.prepare('UPDATE folders SET is_favorite = 0, favorited_at = NULL WHERE id = ?').run(folderId);
      }
      const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE folder_id = ?').get(folderId).c;
      const updated = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
      return sendJson(res, 200, { folder: { ...updated, note_count: noteCount } });
    }

    // Export every note in a folder as one combined PDF (Premium) - uses its
    // own match variable (mFolderPdf) rather than reassigning `m` above, same
    // reason as every other route added between existing ones in this file:
    // routes further down still rely on `m` holding its own match.
    const mFolderPdf = pathname.match(/^\/api\/folders\/(\d+)\/pdf$/);
    if (mFolderPdf && method === 'GET') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Exporting a folder as one PDF is a Premium feature. Upgrade to Premium to export whole folders.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const folderId = Number(mFolderPdf[1]);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, user.id);
      if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
      const allNotes = db
        .prepare('SELECT * FROM notes WHERE user_id = ? AND folder_id = ? ORDER BY updated_at DESC')
        .all(user.id, folderId);
      // Locked notes are simply left out of a whole-folder export rather
      // than prompting for each one's password mid-export (or bypassing the
      // lock, which reading content_html straight from the DB here would
      // otherwise do) - same reasoning as the single-note PDF and duplicate
      // routes above.
      const lockedCount = allNotes.filter((n) => n.lock_hash).length;
      const notes = allNotes.filter((n) => !n.lock_hash);
      if (notes.length === 0) {
        return sendJson(res, 400, {
          error: lockedCount > 0
            ? 'Every note in this folder is locked - unlock them first to include them in the export.'
            : 'This folder has no notes to export.',
        });
      }
      let pdfBuffer;
      try {
        pdfBuffer = await buildFolderPdf(notes, (fileId) => {
          const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, user.id);
          if (!file) return null;
          const diskPath = path.join(UPLOADS_DIR, file.storage_name);
          if (!fs.existsSync(diskPath)) return null;
          return { buffer: fs.readFileSync(diskPath), mimeType: file.mime_type };
        });
      } catch (e) {
        console.error('Error building folder PDF:', e);
        return sendJson(res, 500, { error: 'Could not generate that PDF. Please try again.' });
      }
      const safeName = (folder.name || 'Folder').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 150) || 'Folder';
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdfBuffer.length,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.pdf"`,
      });
      return res.end(pdfBuffer);
    }

    // --- Favorites (notes + folders the user starred, most recent first) ---
    if (pathname === '/api/favorites' && method === 'GET') {
      const favNotes = db
        .prepare('SELECT * FROM notes WHERE user_id = ? AND is_favorite = 1 ORDER BY favorited_at DESC')
        .all(user.id);
      const favFolders = db
        .prepare(`
          SELECT folders.*, (SELECT COUNT(*) FROM notes WHERE notes.folder_id = folders.id) AS note_count
          FROM folders WHERE user_id = ? AND is_favorite = 1 ORDER BY favorited_at DESC
        `)
        .all(user.id);
      return sendJson(res, 200, {
        notes: favNotes.map((n) => sanitizeNote({ ...n, previewHtml: n.lock_hash ? null : firstPageHtml(n.content_html), content_html: undefined })),
        folders: favFolders,
      });
    }

    // --- Notes ---
    if (pathname === '/api/notes/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { notes: [] });
      const like = `%${q}%`;
      // content_html holds the note's stored HTML/JSON, so a plain-text search
      // term still matches as a substring even though it's wrapped in markup.
      // A locked note's own content never participates in the text match -
      // matching by title is still fine (titles are always visible on
      // cards), but searching note bodies for a locked note would leak its
      // content word-by-word through a side channel search was never meant
      // to be. The EXISTS clause (Premium) additionally matches text
      // extracted from an uploaded PDF's pages (see extracted_text in
      // prepareUploadedPages) - an uploaded document page has no content_html
      // of its own to match against otherwise.
      const notes = db
        .prepare(`
          SELECT * FROM notes WHERE user_id = ? AND (
            title LIKE ?
            OR (lock_hash IS NULL AND content_html LIKE ?)
            OR (lock_hash IS NULL AND EXISTS (
              SELECT 1 FROM files f WHERE f.note_id = notes.id AND f.extracted_text LIKE ?
            ))
          ) ORDER BY updated_at DESC
        `)
        .all(user.id, like, like, like);
      return sendJson(res, 200, {
        notes: notes.map((n) => sanitizeNote({ ...n, previewHtml: n.lock_hash ? null : firstPageHtml(n.content_html), content_html: undefined })),
      });
    }

    if (pathname === '/api/notes' && method === 'GET') {
      const folderId = url.searchParams.get('folderId');
      let notes;
      if (folderId === 'unfiled') {
        notes = db
          .prepare('SELECT * FROM notes WHERE user_id = ? AND folder_id IS NULL ORDER BY updated_at DESC')
          .all(user.id);
      } else if (folderId) {
        notes = db
          .prepare('SELECT * FROM notes WHERE user_id = ? AND folder_id = ? ORDER BY updated_at DESC')
          .all(user.id, Number(folderId));
      } else {
        notes = db
          .prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC')
          .all(user.id);
      }
      const totalCount = db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(user.id).c;
      return sendJson(res, 200, {
        // List view omits the full (possibly multi-page) content, but does
        // include a lightweight snapshot of just page 1 so cards can render
        // a small visual preview of the note - except for a locked note,
        // whose preview would otherwise show its content right on the grid
        // card without ever asking for the password.
        notes: notes.map((n) => sanitizeNote({ ...n, previewHtml: n.lock_hash ? null : firstPageHtml(n.content_html), content_html: undefined })),
        totalCount,
        limit: user.plan === 'free' ? FREE_PLAN_NOTE_LIMIT : null,
      });
    }

    if (pathname === '/api/notes' && method === 'POST') {
      const totalCount = db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(user.id).c;
      if (user.plan === 'free' && totalCount >= FREE_PLAN_NOTE_LIMIT) {
        return sendJson(res, 403, {
          error: `Free plan is limited to ${FREE_PLAN_NOTE_LIMIT} note sets. Upgrade to Premium for unlimited notes.`,
          code: 'NOTE_LIMIT_REACHED',
        });
      }
      const { title, folderId, template } = await readBody(req);
      const chosenTemplate = template || DEFAULT_TEMPLATE;
      if (!isTemplateAllowedForPlan(chosenTemplate, user.plan)) {
        return sendJson(res, 403, {
          error: 'That template is only available on Premium.',
          code: 'TEMPLATE_LOCKED',
        });
      }
      const info = db
        .prepare('INSERT INTO notes (user_id, folder_id, title, template) VALUES (?, ?, ?, ?)')
        .run(user.id, folderId || null, (title && title.trim()) || 'Untitled note', chosenTemplate);
      const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(info.lastInsertRowid));
      return sendJson(res, 201, { note: sanitizeNote(note) });
    }

    // Upload a PDF or image straight in as a brand-new note (Premium only) -
    // its rendered page(s) become the note's content immediately, read-only,
    // exactly like a document dropped into a paper notebook. Uses the same
    // note-count limit as creating a note normally.
    if (pathname === '/api/notes/upload' && method === 'POST') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Uploading a file as a note is a Premium feature. Upgrade to Premium to turn PDFs and images into notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      // No note-count check needed here - this whole endpoint already
      // requires an active Premium plan above, and Premium has no note limit.
      let body;
      try {
        body = await readBody(req, maxUploadBodyBytesForPlan(user.plan));
      } catch (e) {
        return sendJson(res, 413, { error: uploadSizeLimitMessage(user.plan) });
      }
      let fileRows, warning;
      try {
        ({ fileRows, warning } = await prepareUploadedPages(body, maxUploadFileBytesForPlan(user.plan)));
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
      const rawTitle = (body.filename || 'Untitled note').replace(/\.[^./\\]+$/, '').trim();
      const info = db
        .prepare('INSERT INTO notes (user_id, folder_id, title, template) VALUES (?, ?, ?, ?)')
        .run(user.id, body.folderId || null, rawTitle || 'Untitled note', DEFAULT_TEMPLATE);
      const noteId = Number(info.lastInsertRowid);
      const pages = fileRows.map((row) => {
        const fileId = storeUploadedPageFile({ userId: user.id, noteId, ...row });
        return { type: 'document', fileId, annotations: [] };
      });
      db.prepare("UPDATE notes SET content_html = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(pages), noteId);
      const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      return sendJson(res, 201, { note: sanitizeNote(note), warning });
    }

    m = pathname.match(/^\/api\/notes\/(\d+)$/);
    if (m && method === 'GET') {
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(m[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      // A locked note's content never goes out over this route - the client
      // sees `locked: true` (from sanitizeNote) and no content_html at all,
      // and has to go through POST /api/notes/:id/unlock with the right
      // password first (below) to actually read it.
      if (note.lock_hash) return sendJson(res, 200, { note: sanitizeNote({ ...note, content_html: undefined }) });
      return sendJson(res, 200, { note: sanitizeNote(note) });
    }

    // Lock a note behind a password (Premium) - or verify/remove an existing
    // lock. Three sub-routes under the same note, each with its own match
    // variable per the standing rule about routes inserted between existing
    // ones:
    //   POST   /api/notes/:id/lock    - set/replace the lock (Premium only)
    //   POST   /api/notes/:id/unlock  - verify the password, return full content
    //   DELETE /api/notes/:id/lock    - verify the password, remove the lock
    // This is a lightweight "privacy screen" (keep a note's content off the
    // grid and out of GET until the password is entered), not a security
    // boundary against the account's own owner - someone who already has a
    // valid session for this account and calls the API directly still could,
    // same as any client-side lock. See sanitizeNote() above for the one
    // guarantee this module actually holds itself to: the hash/salt columns
    // themselves never reach the client.
    const mLock = pathname.match(/^\/api\/notes\/(\d+)\/lock$/);
    if (mLock && method === 'POST') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Locking a note is a Premium feature. Upgrade to Premium to password-protect a note.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(mLock[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      const { password } = await readBody(req);
      if (!password || password.length < 4) {
        return sendJson(res, 400, { error: 'Choose a password at least 4 characters long.' });
      }
      const { hash, salt } = hashPassword(password);
      db.prepare('UPDATE notes SET lock_hash = ?, lock_salt = ? WHERE id = ?').run(hash, salt, note.id);
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
      return sendJson(res, 200, { note: sanitizeNote({ ...updated, content_html: undefined }) });
    }

    if (mLock && method === 'DELETE') {
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(mLock[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (!note.lock_hash) return sendJson(res, 200, { note: sanitizeNote(note) });
      const { password } = await readBody(req);
      if (!password || !verifyPassword(password, note.lock_salt, note.lock_hash)) {
        return sendJson(res, 403, { error: 'Incorrect password.', code: 'WRONG_PASSWORD' });
      }
      db.prepare('UPDATE notes SET lock_hash = NULL, lock_salt = NULL WHERE id = ?').run(note.id);
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
      return sendJson(res, 200, { note: sanitizeNote(updated) });
    }

    const mUnlock = pathname.match(/^\/api\/notes\/(\d+)\/unlock$/);
    if (mUnlock && method === 'POST') {
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(mUnlock[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (!note.lock_hash) return sendJson(res, 200, { note: sanitizeNote(note) });
      const { password } = await readBody(req);
      if (!password || !verifyPassword(password, note.lock_salt, note.lock_hash)) {
        return sendJson(res, 403, { error: 'Incorrect password.', code: 'WRONG_PASSWORD' });
      }
      return sendJson(res, 200, { note: sanitizeNote(note) });
    }

    // ---------- AI study sets (Pro) ----------
    // Generates a new study set from a note's content. Uses its own match
    // variable (mGenStudySet) rather than reassigning the shared `m` above -
    // see the standing rule at the top of this file about routes inserted
    // between existing ones.
    const mGenStudySet = pathname.match(/^\/api\/notes\/(\d+)\/study-sets$/);
    if (mGenStudySet && method === 'POST') {
      // Premium gets a small taste (5/month) of the AI tools Pro has in full
      // (40/month) - see MONTHLY_AI_GENERATION_LIMITS in plans.js - so this
      // gate is "at least Premium", with the actual monthly cap enforced
      // just below rather than here.
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Turning a note into a study set is a Premium feature. Upgrade to Premium to generate flashcards, true/false sets, and practice tests from your notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const genStatusBefore = generationStatus(user);
      if (genStatusBefore.remaining <= 0) {
        return sendJson(res, 403, {
          error: generationLimitReachedMessage(user.plan),
          code: 'GENERATION_LIMIT_REACHED',
        });
      }
      const noteId = Number(mGenStudySet[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      // Same reasoning as the PDF export routes above - the AI would
      // otherwise be handed a locked note's content without ever checking
      // its password, defeating the lock.
      if (note.lock_hash) {
        return sendJson(res, 403, { error: 'Unlock this note before generating a study set from it.', code: 'NOTE_LOCKED' });
      }

      const body = await readBody(req).catch(() => ({}));
      const setType = ['flashcards', 'true_false', 'multiple_choice'].includes(body.setType) ? body.setType : null;
      if (!setType) return sendJson(res, 400, { error: 'Choose a study set type.' });
      const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium';
      const length = Math.max(5, Math.min(50, Number(body.length) || 10));

      const noteText = noteToPlainText(note);
      if (!noteText.trim()) {
        return sendJson(res, 400, {
          error: "This note doesn't have enough written content yet to generate a study set from.",
          code: 'NOTE_EMPTY',
        });
      }

      let generated;
      try {
        generated = await generateStudySet({ noteTitle: note.title, noteText, setType, difficulty, length });
      } catch (e) {
        return sendJson(res, e.status || 502, { error: e.message, code: e.code });
      }

      const info = db.prepare(
        'INSERT INTO study_sets (user_id, note_id, title, set_type, difficulty, length, content_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(user.id, noteId, generated.title, setType, difficulty, generated.items.length, JSON.stringify(generated.items));
      const studySet = db.prepare('SELECT * FROM study_sets WHERE id = ?').get(Number(info.lastInsertRowid));
      // Only actually spent now that generation succeeded - a failed AI call
      // above never costs the user part of their monthly allowance.
      const userAfterGen = consumeGeneration(user);
      return sendJson(res, 201, { studySet: sanitizeStudySet(studySet), aiGenerations: generationStatus(userAfterGen) });
    }

    if (pathname === '/api/study-sets' && method === 'GET') {
      const rows = db.prepare(
        // Favorited sets surface first within the hub, newest first within
        // each group - the same "pin favorites, else most-recent" ordering
        // the rest of the app already uses for notes/folders.
        'SELECT * FROM study_sets WHERE user_id = ? ORDER BY is_favorite DESC, created_at DESC'
      ).all(user.id);
      return sendJson(res, 200, { studySets: rows.map(sanitizeStudySetSummary) });
    }

    const mStudySet = pathname.match(/^\/api\/study-sets\/(\d+)$/);
    if (mStudySet && method === 'GET') {
      const row = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(Number(mStudySet[1]), user.id);
      if (!row) return sendJson(res, 404, { error: 'Study set not found.' });
      return sendJson(res, 200, { studySet: sanitizeStudySet(row) });
    }

    if (mStudySet && method === 'PATCH') {
      const row = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(Number(mStudySet[1]), user.id);
      if (!row) return sendJson(res, 404, { error: 'Study set not found.' });
      const body = await readBody(req);
      if (body.title === undefined || !body.title.trim()) {
        return sendJson(res, 400, { error: 'Title is required.' });
      }
      db.prepare("UPDATE study_sets SET title = ?, updated_at = datetime('now') WHERE id = ?").run(body.title.trim(), row.id);
      const updated = db.prepare('SELECT * FROM study_sets WHERE id = ?').get(row.id);
      return sendJson(res, 200, { studySet: sanitizeStudySetSummary(updated) });
    }

    if (mStudySet && method === 'DELETE') {
      const row = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(Number(mStudySet[1]), user.id);
      if (!row) return sendJson(res, 404, { error: 'Study set not found.' });
      db.prepare('DELETE FROM study_sets WHERE id = ?').run(row.id);
      return sendJson(res, 200, { ok: true });
    }

    const mStudySetFav = pathname.match(/^\/api\/study-sets\/(\d+)\/favorite$/);
    if (mStudySetFav && method === 'PATCH') {
      const row = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(Number(mStudySetFav[1]), user.id);
      if (!row) return sendJson(res, 404, { error: 'Study set not found.' });
      const { favorite } = await readBody(req);
      if (favorite) {
        db.prepare("UPDATE study_sets SET is_favorite = 1, favorited_at = datetime('now') WHERE id = ?").run(row.id);
      } else {
        db.prepare('UPDATE study_sets SET is_favorite = 0, favorited_at = NULL WHERE id = ?').run(row.id);
      }
      const updated = db.prepare('SELECT * FROM study_sets WHERE id = ?').get(row.id);
      return sendJson(res, 200, { studySet: sanitizeStudySetSummary(updated) });
    }

    // ---------- Flashcard spaced-repetition review mode (Pro) ----------
    // A simplified SM-2 (the same algorithm behind Anki/SuperMemo, minus its
    // 0-5 quality scale in favor of three plain buttons - "Again"/"Good"/
    // "Easy" map to 2/4/5) - schedules each flashcard's next review date
    // individually based on how well it's been remembered, rather than
    // reviewing every card every time. Pure scheduling logic against data
    // that's already been generated, so it doesn't touch the AI generation
    // cap at all - it's gated Pro-only because it's a real Pro-tier study
    // workflow, not something worth tasting at 5/month like the generation
    // features above.
    function computeNextReview(prev, quality) {
      let { ease_factor: ease, interval_days: interval, repetitions } = prev;
      if (quality < 3) {
        repetitions = 0;
        interval = 0; // due again right away (today) - a card you missed
      } else {
        if (repetitions === 0) interval = 1;
        else if (repetitions === 1) interval = 6;
        else interval = Math.round(interval * ease);
        repetitions += 1;
      }
      ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
      const dueAt = new Date(Date.now() + interval * 24 * 60 * 60 * 1000).toISOString();
      return { ease_factor: ease, interval_days: interval, repetitions, due_at: dueAt };
    }
    const RATING_QUALITY = { again: 2, good: 4, easy: 5 };

    const mReview = pathname.match(/^\/api\/study-sets\/(\d+)\/review$/);
    if (mReview && method === 'GET') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Spaced-repetition review is a Pro feature. Upgrade to Pro to review your flashcards on a smart schedule.',
          code: 'PRO_REQUIRED',
        });
      }
      const setId = Number(mReview[1]);
      const set = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(setId, user.id);
      if (!set) return sendJson(res, 404, { error: 'Study set not found.' });
      if (set.set_type !== 'flashcards') {
        return sendJson(res, 400, { error: 'Review mode is only available for flashcard sets.' });
      }
      let items = [];
      try { items = JSON.parse(set.content_json); } catch (e) { items = []; }
      const reviewRows = db.prepare('SELECT * FROM flashcard_reviews WHERE study_set_id = ? AND user_id = ?').all(setId, user.id);
      const reviewByIndex = new Map(reviewRows.map((r) => [r.item_index, r]));
      const now = Date.now();
      const due = [];
      items.forEach((item, i) => {
        const r = reviewByIndex.get(i);
        const isDue = !r || new Date(r.due_at).getTime() <= now;
        if (isDue) due.push({ itemIndex: i, front: item.front, back: item.back, isNew: !r });
      });
      return sendJson(res, 200, {
        due,
        totalItems: items.length,
        dueCount: due.length,
        reviewedCount: reviewRows.filter((r) => r.repetitions > 0).length,
      });
    }

    if (mReview && method === 'POST') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Spaced-repetition review is a Pro feature. Upgrade to Pro to review your flashcards on a smart schedule.',
          code: 'PRO_REQUIRED',
        });
      }
      const setId = Number(mReview[1]);
      const set = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(setId, user.id);
      if (!set) return sendJson(res, 404, { error: 'Study set not found.' });
      const { itemIndex, rating } = await readBody(req);
      if (!RATING_QUALITY[rating]) return sendJson(res, 400, { error: 'Rating must be again, good, or easy.' });
      const existing = db.prepare('SELECT * FROM flashcard_reviews WHERE study_set_id = ? AND user_id = ? AND item_index = ?').get(setId, user.id, Number(itemIndex));
      const prev = existing || { ease_factor: 2.5, interval_days: 0, repetitions: 0 };
      const next = computeNextReview(prev, RATING_QUALITY[rating]);
      if (existing) {
        db.prepare(
          "UPDATE flashcard_reviews SET ease_factor = ?, interval_days = ?, repetitions = ?, due_at = ?, last_reviewed_at = datetime('now') WHERE id = ?"
        ).run(next.ease_factor, next.interval_days, next.repetitions, next.due_at, existing.id);
      } else {
        db.prepare(
          "INSERT INTO flashcard_reviews (study_set_id, user_id, item_index, ease_factor, interval_days, repetitions, due_at, last_reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).run(setId, user.id, Number(itemIndex), next.ease_factor, next.interval_days, next.repetitions, next.due_at);
      }
      return sendJson(res, 200, { ok: true, nextDueAt: next.due_at });
    }

    // ---------- Practice-test / true-false performance tracker (Pro) ----------
    // Records each completed attempt (from either the true/false drill or the
    // multiple-choice practice test player) so progress shows up over time
    // instead of the score disappearing the moment you leave the player.
    const mAttempts = pathname.match(/^\/api\/study-sets\/(\d+)\/attempts$/);
    if (mAttempts && method === 'POST') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Tracking your practice-test performance over time is a Pro feature. Upgrade to Pro to see your progress.',
          code: 'PRO_REQUIRED',
        });
      }
      const setId = Number(mAttempts[1]);
      const set = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(setId, user.id);
      if (!set) return sendJson(res, 404, { error: 'Study set not found.' });
      const { results } = await readBody(req);
      if (!Array.isArray(results) || results.length === 0) {
        return sendJson(res, 400, { error: 'Results are required.' });
      }
      const correctCount = results.filter(Boolean).length;
      db.prepare(
        'INSERT INTO practice_attempts (study_set_id, user_id, correct_count, total_count, results_json) VALUES (?, ?, ?, ?, ?)'
      ).run(setId, user.id, correctCount, results.length, JSON.stringify(results));
      return sendJson(res, 201, { ok: true, correctCount, totalCount: results.length });
    }

    const mPerformance = pathname.match(/^\/api\/study-sets\/(\d+)\/performance$/);
    if (mPerformance && method === 'GET') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Tracking your practice-test performance over time is a Pro feature. Upgrade to Pro to see your progress.',
          code: 'PRO_REQUIRED',
        });
      }
      const setId = Number(mPerformance[1]);
      const set = db.prepare('SELECT * FROM study_sets WHERE id = ? AND user_id = ?').get(setId, user.id);
      if (!set) return sendJson(res, 404, { error: 'Study set not found.' });
      const attempts = db
        .prepare('SELECT * FROM practice_attempts WHERE study_set_id = ? AND user_id = ? ORDER BY created_at ASC')
        .all(setId, user.id);
      let items = [];
      try { items = JSON.parse(set.content_json); } catch (e) { items = []; }
      // Per-item miss counts, so "which questions do I keep missing" doesn't
      // require re-scanning every attempt's results client-side.
      const missCounts = new Array(items.length).fill(0);
      const seenCounts = new Array(items.length).fill(0);
      for (const attempt of attempts) {
        let results = [];
        try { results = JSON.parse(attempt.results_json); } catch (e) { results = []; }
        results.forEach((correct, i) => {
          if (i >= items.length) return;
          seenCounts[i] += 1;
          if (!correct) missCounts[i] += 1;
        });
      }
      const mostMissed = items
        .map((item, i) => ({
          index: i,
          text: item.question || item.statement || item.front || `Item ${i + 1}`,
          missCount: missCounts[i],
          seenCount: seenCounts[i],
        }))
        .filter((m) => m.missCount > 0)
        .sort((a, b) => b.missCount - a.missCount)
        .slice(0, 10);
      return sendJson(res, 200, {
        attempts: attempts.map((a) => ({
          id: a.id,
          correctCount: a.correct_count,
          totalCount: a.total_count,
          createdAt: a.created_at,
        })),
        mostMissed,
      });
    }

    // A lightweight overview across every study set with at least one
    // attempt, for a top-level "your progress" glance rather than having to
    // open each set individually.
    if (pathname === '/api/performance' && method === 'GET') {
      if (!planAtLeast(user.plan, 'pro')) {
        return sendJson(res, 403, {
          error: 'Tracking your practice-test performance over time is a Pro feature. Upgrade to Pro to see your progress.',
          code: 'PRO_REQUIRED',
        });
      }
      const rows = db.prepare(`
        SELECT s.id AS study_set_id, s.title,
          COUNT(a.id) AS attempt_count,
          SUM(a.correct_count) AS total_correct,
          SUM(a.total_count) AS total_questions,
          MAX(a.created_at) AS last_attempt_at
        FROM practice_attempts a
        JOIN study_sets s ON s.id = a.study_set_id
        WHERE a.user_id = ?
        GROUP BY a.study_set_id
        ORDER BY last_attempt_at DESC
      `).all(user.id);
      return sendJson(res, 200, {
        studySets: rows.map((r) => ({
          studySetId: r.study_set_id,
          title: r.title,
          attemptCount: r.attempt_count,
          accuracy: r.total_questions ? Math.round((r.total_correct / r.total_questions) * 100) : 0,
          lastAttemptAt: r.last_attempt_at,
        })),
      });
    }

    // One-click note summarization (Premium taste / Pro) - same generation
    // cap as study-set generation above, since both count as one "AI
    // generation" against the same monthly allowance.
    const mSummary = pathname.match(/^\/api\/notes\/(\d+)\/summary$/);
    if (mSummary && method === 'POST') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Summarizing a note is a Premium feature. Upgrade to Premium to generate quick summaries of your notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const genStatus = generationStatus(user);
      if (genStatus.remaining <= 0) {
        return sendJson(res, 403, { error: generationLimitReachedMessage(user.plan), code: 'GENERATION_LIMIT_REACHED' });
      }
      const noteId = Number(mSummary[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (note.lock_hash) {
        return sendJson(res, 403, { error: 'Unlock this note before summarizing it.', code: 'NOTE_LOCKED' });
      }
      const noteText = noteToPlainText(note);
      let summary;
      try {
        summary = await generateSummary({ noteTitle: note.title, noteText });
      } catch (e) {
        return sendJson(res, e.status || 502, { error: e.message, code: e.code });
      }
      const userAfterGen = consumeGeneration(user);
      return sendJson(res, 200, { summary, aiGenerations: generationStatus(userAfterGen) });
    }

    // "Ask your notes" (Premium taste / Pro) - answers a question grounded in
    // the plain text of every one of the user's own notes (most recently
    // updated first), rather than one note at a time. There's no
    // embeddings/vector-search here (this project deliberately has no npm
    // dependency for it) - just a bounded amount of the user's actual note
    // text handed to the model directly, which is plenty workable at the
    // note volume a personal study app actually sees. Counts as one
    // generation against the same monthly allowance as everything else here.
    const MAX_ASK_CONTEXT_CHARS = 40000;
    if (pathname === '/api/ask' && method === 'POST') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Asking questions about your notes is a Premium feature. Upgrade to Premium to try it.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const genStatus = generationStatus(user);
      if (genStatus.remaining <= 0) {
        return sendJson(res, 403, { error: generationLimitReachedMessage(user.plan), code: 'GENERATION_LIMIT_REACHED' });
      }
      const { question } = await readBody(req);
      const notes = db
        .prepare('SELECT * FROM notes WHERE user_id = ? AND lock_hash IS NULL ORDER BY updated_at DESC')
        .all(user.id);
      let notesContext = '';
      for (const note of notes) {
        const text = noteToPlainText(note);
        if (!text.trim()) continue;
        const chunk = `### ${note.title || 'Untitled note'}\n${text}\n\n`;
        if (notesContext.length + chunk.length > MAX_ASK_CONTEXT_CHARS) break;
        notesContext += chunk;
      }
      let answer;
      try {
        answer = await answerFromNotes({ question, notesContext });
      } catch (e) {
        return sendJson(res, e.status || 502, { error: e.message, code: e.code });
      }
      const userAfterGen = consumeGeneration(user);
      return sendJson(res, 200, { answer, aiGenerations: generationStatus(userAfterGen) });
    }

    // Duplicate a note (Free feature) - clones its pages, text-box/image
    // annotations, and drawings into a brand-new note. Uses its own match
    // variable (mDup) rather than reassigning the shared `m` above - see the
    // standing rule at the top of this file about routes inserted between
    // existing ones. Counts against the free-plan note limit just like
    // creating a note normally, since it IS creating a new note set.
    const mDup = pathname.match(/^\/api\/notes\/(\d+)\/duplicate$/);
    if (mDup && method === 'POST') {
      const sourceId = Number(mDup[1]);
      const source = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(sourceId, user.id);
      if (!source) return sendJson(res, 404, { error: 'Note not found.' });

      // A locked note's content_html gets read directly out of the DB below
      // (not through the GET route's lock check above), so this route would
      // otherwise be a one-click way to clone a locked note's full content
      // into a brand-new, unlocked note - completely defeating the lock
      // without ever entering its password. Require it here too, and carry
      // the same lock over onto the copy so a duplicate of a locked note
      // stays just as locked (rather than silently exposing what the lock
      // was hiding).
      const dupBody = await readBody(req).catch(() => ({}));
      if (source.lock_hash) {
        if (!dupBody.password || !verifyPassword(dupBody.password, source.lock_salt, source.lock_hash)) {
          return sendJson(res, 403, { error: 'Incorrect password.', code: 'WRONG_PASSWORD' });
        }
      }

      const totalCount = db.prepare('SELECT COUNT(*) as c FROM notes WHERE user_id = ?').get(user.id).c;
      if (user.plan === 'free' && totalCount >= FREE_PLAN_NOTE_LIMIT) {
        return sendJson(res, 403, {
          error: `Free plan is limited to ${FREE_PLAN_NOTE_LIMIT} note sets. Upgrade to Premium for unlimited notes.`,
          code: 'NOTE_LIMIT_REACHED',
        });
      }

      const info = db
        .prepare('INSERT INTO notes (user_id, folder_id, title, template, lock_hash, lock_salt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, source.folder_id, `${source.title} (Copy)`, source.template, source.lock_hash || null, source.lock_salt || null);
      const newNoteId = Number(info.lastInsertRowid);

      // Same page-shape normalization used everywhere else this note's
      // content is read (see the GET /api/notes/:id note-open handling on
      // the client, and the PDF-export route below) - two older shapes
      // still have to be handled: a plain array of HTML strings, or raw
      // HTML with no pagination at all.
      let pageEntries;
      try {
        const parsed = JSON.parse(source.content_html);
        pageEntries = Array.isArray(parsed) && parsed.length > 0
          ? parsed.map((p) => (typeof p === 'string' ? { type: 'text', html: p, annotations: [], drawing: null } : { annotations: [], drawing: null, ...p }))
          : [{ type: 'text', html: '', annotations: [], drawing: null }];
      } catch (e) {
        pageEntries = [{ type: 'text', html: source.content_html || '', annotations: [], drawing: null }];
      }

      // Uploaded document pages and inline images point at rows in the
      // `files` table that are deleted (disk blob included - see the
      // DELETE /api/notes/:id handler below) whenever their owning note is.
      // Just pointing the copy at the same fileId would leave it with a
      // dangling reference the moment the original note is deleted, so each
      // referenced file gets its own physical copy owned by the new note.
      const fileIdMap = new Map();
      const copyFile = (oldFileId) => {
        if (fileIdMap.has(oldFileId)) return fileIdMap.get(oldFileId);
        const original = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(oldFileId, user.id);
        if (!original) return null;
        let buffer;
        try {
          buffer = fs.readFileSync(path.join(UPLOADS_DIR, original.storage_name));
        } catch (e) {
          return null; // source file missing on disk - skip rather than fail the whole duplicate
        }
        const newFileId = storeUploadedPageFile({
          userId: user.id,
          noteId: newNoteId,
          filename: original.filename,
          mimeType: original.mime_type,
          buffer,
        });
        fileIdMap.set(oldFileId, newFileId);
        return newFileId;
      };

      const newPages = pageEntries.map((entry) => {
        const copy = { ...entry };
        if (copy.type === 'document' && copy.fileId) {
          const newId = copyFile(copy.fileId);
          if (newId) copy.fileId = newId;
        }
        if (Array.isArray(copy.annotations)) {
          copy.annotations = copy.annotations.map((ann) => {
            if (ann.type === 'image' && ann.fileId) {
              const newId = copyFile(ann.fileId);
              return newId ? { ...ann, fileId: newId } : ann;
            }
            return ann;
          });
        }
        return copy;
      });

      db.prepare('UPDATE notes SET content_html = ? WHERE id = ?').run(JSON.stringify(newPages), newNoteId);
      const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(newNoteId);
      return sendJson(res, 201, { note: sanitizeNote(note) });
    }

    // Download a note as a PDF (Premium) - reproduces its text (including
    // this session's new bulleted/dashed/numbered lists, bold/italic, and
    // per-run font size), any freehand drawing and text boxes on top of it,
    // and any uploaded document pages, as an actual multi-page PDF file.
    // Uses its own match variable (mPdf) rather than reassigning the shared
    // `m` above - the PATCH/DELETE handlers just below still rely on `m`
    // holding the plain /api/notes/:id match, and clobbering it here made
    // every note edit/delete silently 404 as "Unknown endpoint" once a
    // /pdf-suffixed path had been checked.
    const mPdf = pathname.match(/^\/api\/notes\/(\d+)\/pdf$/);
    if (mPdf && method === 'GET') {
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Downloading a note as a PDF is a Premium feature. Upgrade to Premium to save your notes as PDFs.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(mPdf[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      // Same reasoning as the duplicate route above - reading content_html
      // straight from the DB here would bypass the lock entirely. Open (and
      // unlock) the note first, then download from there.
      if (note.lock_hash) {
        return sendJson(res, 403, { error: 'Unlock this note before downloading it as a PDF.', code: 'NOTE_LOCKED' });
      }
      let pdfBuffer;
      try {
        pdfBuffer = await buildNotePdf(note, (fileId) => {
          const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, user.id);
          if (!file) return null;
          const diskPath = path.join(UPLOADS_DIR, file.storage_name);
          if (!fs.existsSync(diskPath)) return null;
          return { buffer: fs.readFileSync(diskPath), mimeType: file.mime_type };
        });
      } catch (e) {
        console.error('Error building note PDF:', e);
        return sendJson(res, 500, { error: 'Could not generate that PDF. Please try again.' });
      }
      const safeName = (note.title || 'Untitled note').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 150) || 'Untitled note';
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdfBuffer.length,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.pdf"`,
      });
      return res.end(pdfBuffer);
    }

    if (m && method === 'PATCH') {
      const noteId = Number(m[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      const { title, folderId, contentHtml, template } = await readBody(req);
      if (template !== undefined && !isTemplateAllowedForPlan(template, user.plan)) {
        return sendJson(res, 403, {
          error: 'That template is only available on Premium.',
          code: 'TEMPLATE_LOCKED',
        });
      }
      const newTitle = title !== undefined ? title.trim() || 'Untitled note' : note.title;
      const newFolderId = folderId !== undefined ? folderId : note.folder_id;
      const newContent = contentHtml !== undefined ? contentHtml : note.content_html;
      const newTemplate = template !== undefined ? template : note.template;

      // Note version history (Premium) - snapshot the PRE-edit state before
      // overwriting it, so the versions list reads as "what this note looked
      // like at each past save" rather than including the save that's
      // happening right now. Only worth snapshotting when the content is
      // actually changing (a plain rename/move alone would otherwise create
      // a version identical to the one before it).
      if (contentHtml !== undefined && contentHtml !== note.content_html && planAtLeast(user.plan, 'paid')) {
        db.prepare(
          'INSERT INTO note_versions (note_id, user_id, title, content_html, template) VALUES (?, ?, ?, ?, ?)'
        ).run(noteId, user.id, note.title, note.content_html, note.template);
        // Prune anything beyond the most recent MAX_NOTE_VERSIONS_PER_NOTE -
        // an unbounded-editing note (autosave fires often) would otherwise
        // grow this table forever.
        db.prepare(`
          DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
            SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
          )
        `).run(noteId, noteId, MAX_NOTE_VERSIONS_PER_NOTE);
      }

      db.prepare(
        "UPDATE notes SET title = ?, folder_id = ?, content_html = ?, template = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newTitle, newFolderId, newContent, newTemplate, noteId);
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      // Auto-sync to Drive, if the user has both Drive connected and the
      // auto-sync toggle on - deliberately not awaited (see
      // autoSyncNoteToDrive's own comment) so a slow/failing Drive call can
      // never slow down or break the save the user is actually waiting on.
      // Skipped for a locked note for the same reason the PDF-download route
      // refuses one - content_html on a locked note is meant to stay opaque
      // until explicitly unlocked, not get quietly exported.
      if (contentHtml !== undefined && user.google_auto_sync && user.google_refresh_token
        && !updated.lock_hash && planAtLeast(user.plan, 'paid')) {
        autoSyncNoteToDrive(user, updated);
      }
      return sendJson(res, 200, { note: sanitizeNote(updated) });
    }

    if (m && method === 'DELETE') {
      const noteId = Number(m[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      // Clean up any files attached to this note - both their disk storage
      // and their database rows - so deleting a note doesn't leave orphaned
      // files sitting on the persistent volume forever.
      const attachedFiles = db.prepare('SELECT * FROM files WHERE note_id = ?').all(noteId);
      for (const f of attachedFiles) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storage_name)); } catch (e) { /* already gone - fine */ }
      }
      db.prepare('DELETE FROM files WHERE note_id = ?').run(noteId);
      // A study set generated from this note is meant to stand on its own in
      // the AI Study Sets hub - deleting the source note just detaches it
      // (note_id -> NULL) rather than deleting the study set too.
      db.prepare('UPDATE study_sets SET note_id = NULL WHERE note_id = ?').run(noteId);
      db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- Note version history (Premium) ----------
    // List is lightweight (id/title/createdAt only - see sanitizeStudySetSummary
    // above for the same pattern) since the point of the list is just picking
    // which past save to look at; the full content_html for one specific
    // version is only ever fetched when actually opening/restoring it.
    const mNoteVersions = pathname.match(/^\/api\/notes\/(\d+)\/versions$/);
    if (mNoteVersions && method === 'GET') {
      const noteId = Number(mNoteVersions[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Version history is a Premium feature. Upgrade to Premium to see and restore past versions of your notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const versions = db
        .prepare('SELECT id, title, created_at FROM note_versions WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC')
        .all(noteId, user.id);
      return sendJson(res, 200, {
        versions: versions.map((v) => ({ id: v.id, title: v.title, createdAt: v.created_at })),
      });
    }

    const mNoteVersionRestore = pathname.match(/^\/api\/notes\/(\d+)\/versions\/(\d+)\/restore$/);
    if (mNoteVersionRestore && method === 'POST') {
      const noteId = Number(mNoteVersionRestore[1]);
      const versionId = Number(mNoteVersionRestore[2]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Version history is a Premium feature. Upgrade to Premium to see and restore past versions of your notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const version = db.prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ? AND user_id = ?').get(versionId, noteId, user.id);
      if (!version) return sendJson(res, 404, { error: 'That version no longer exists.' });
      // Snapshot the note's CURRENT state before overwriting it with the old
      // version - so restoring is itself just another change you can undo by
      // restoring again, rather than a one-way trip.
      db.prepare(
        'INSERT INTO note_versions (note_id, user_id, title, content_html, template) VALUES (?, ?, ?, ?, ?)'
      ).run(noteId, user.id, note.title, note.content_html, note.template);
      db.prepare(`
        DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
          SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
        )
      `).run(noteId, noteId, MAX_NOTE_VERSIONS_PER_NOTE);
      db.prepare("UPDATE notes SET title = ?, content_html = ?, template = ?, updated_at = datetime('now') WHERE id = ?")
        .run(version.title, version.content_html, version.template, noteId);
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      return sendJson(res, 200, { note: sanitizeNote(updated) });
    }

    // ---------- Pages from an uploaded file (Premium only for uploading;
    // anyone who already has pages - e.g. after a subscription lapses - can
    // still view, and delete, their own existing ones). A PDF or image gets
    // turned into one or more fixed, read-only "pages" appended to this
    // note's page-stack, exactly like adding another page to a paper
    // notebook - see prepareUploadedPages() above for the actual PDF/image
    // handling. ----------
    m = pathname.match(/^\/api\/notes\/(\d+)\/pages$/);
    if (m && method === 'POST') {
      const noteId = Number(m[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      if (!planAtLeast(user.plan, 'paid')) {
        return sendJson(res, 403, {
          error: 'Adding files to your notes is a Premium feature. Upgrade to Premium to add PDF or image pages.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      let body;
      try {
        body = await readBody(req, maxUploadBodyBytesForPlan(user.plan));
      } catch (e) {
        return sendJson(res, 413, { error: uploadSizeLimitMessage(user.plan) });
      }
      let fileRows, warning;
      try {
        ({ fileRows, warning } = await prepareUploadedPages(body, maxUploadFileBytesForPlan(user.plan)));
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
      const fileIds = fileRows.map((row) => storeUploadedPageFile({ userId: user.id, noteId, ...row }));
      return sendJson(res, 201, { fileIds, warning });
    }

    // ---------- Image annotations (Free) - a picture dropped on top of an
    // existing page, positioned/resized like a text box (see
    // addImageAnnotation() in app.js), as opposed to the Premium /pages route
    // above, which adds a whole new fixed page from an uploaded PDF/image.
    // Deliberately narrower than that route: images only (no PDF-to-page
    // rendering), and no plan check. Uses its own match variable (mImage)
    // rather than reassigning the shared `m` - see the /pdf route's comment
    // above for why that matters. ----------
    const mImage = pathname.match(/^\/api\/notes\/(\d+)\/images$/);
    if (mImage && method === 'POST') {
      const noteId = Number(mImage[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      let body;
      try {
        body = await readBody(req, maxUploadBodyBytesForPlan(user.plan));
      } catch (e) {
        return sendJson(res, 413, { error: uploadSizeLimitMessage(user.plan, 'Images') });
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(body.mimeType)) {
        return sendJson(res, 415, { error: 'Only PNG, JPEG, GIF, or WebP images are supported.' });
      }
      let fileRows;
      try {
        ({ fileRows } = await prepareUploadedPages(body, maxUploadFileBytesForPlan(user.plan)));
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
      const fileId = storeUploadedPageFile({ userId: user.id, noteId, ...fileRows[0] });
      return sendJson(res, 201, { fileId });
    }

    m = pathname.match(/^\/api\/files\/(\d+)$/);
    if (m && method === 'GET') {
      const fileId = Number(m[1]);
      const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, user.id);
      if (!file) return sendJson(res, 404, { error: 'File not found.' });
      const diskPath = path.join(UPLOADS_DIR, file.storage_name);
      if (!fs.existsSync(diskPath)) return sendJson(res, 404, { error: 'File not found.' });
      const mimeType = file.mime_type || 'application/octet-stream';
      // Rendered/uploaded page images are meant to display inline as part of
      // the note (an <img> tag pointing straight at this endpoint) - only
      // non-image files (a leftover from before this feature existed, if
      // any) fall back to forcing a download.
      const disposition = mimeType.startsWith('image/')
        ? `inline; filename="${encodeURIComponent(file.filename)}"`
        : `attachment; filename="${encodeURIComponent(file.filename)}"`;
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': file.size_bytes,
        'Content-Disposition': disposition,
      });
      fs.createReadStream(diskPath).pipe(res);
      return;
    }

    if (m && method === 'DELETE') {
      const fileId = Number(m[1]);
      const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, user.id);
      if (!file) return sendJson(res, 404, { error: 'File not found.' });
      try { fs.unlinkSync(path.join(UPLOADS_DIR, file.storage_name)); } catch (e) { /* already gone - fine */ }
      db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
      return sendJson(res, 200, { ok: true });
    }

    let mNoteFav = pathname.match(/^\/api\/notes\/(\d+)\/favorite$/);
    if (mNoteFav && method === 'PATCH') {
      const noteId = Number(mNoteFav[1]);
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(noteId, user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      const { favorite } = await readBody(req);
      // A dedicated endpoint (rather than folding this into the general note
      // PATCH above) so starring a note never bumps its "Updated" timestamp -
      // the general PATCH always touches updated_at, which would make
      // favoriting a note look like editing it and reorder it in All Notes.
      if (favorite) {
        db.prepare("UPDATE notes SET is_favorite = 1, favorited_at = datetime('now') WHERE id = ?").run(noteId);
      } else {
        db.prepare('UPDATE notes SET is_favorite = 0, favorited_at = NULL WHERE id = ?').run(noteId);
      }
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      return sendJson(res, 200, { note: sanitizeNote({ ...updated, content_html: undefined }) });
    }

    return sendJson(res, 404, { error: 'Unknown endpoint.' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Server error: ' + err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`ScribeStack MVP running at http://localhost:${PORT}`);
});
