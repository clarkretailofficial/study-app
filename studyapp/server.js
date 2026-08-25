// server.js
// Zero-dependency Node.js HTTP server: static file serving + a small JSON API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { db, FREE_PLAN_NOTE_LIMIT, UPLOADS_DIR } = require('./db');
const {
  createUser,
  getUserByEmail,
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
const { FOLDER_COLORS, DEFAULT_FOLDER_COLOR, isValidFolderColor } = require('./folderColors');
const { sendPasswordResetEmail, emailSendingConfigured } = require('./email');
const {
  billingConfigured,
  createCheckoutSession,
  createBillingPortalSession,
  verifyWebhookSignature,
} = require('./stripe');
const { renderPdfToPngPages, MAX_PDF_PAGES } = require('./pdfRender');
const { buildNotePdf } = require('./notePdf');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Uploaded files (Premium only) come in as base64 inside a JSON body rather
// than a real multipart/form-data upload - keeps this consistent with the
// rest of the app's zero-npm-dependency approach instead of hand-rolling a
// multipart parser. 15MB covers a typical scanned PDF or lecture slide deck
// comfortably; base64 inflates the wire size by ~33%, so the actual request
// body limit passed to readBody() below is set a bit higher than this.
const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_FILE_BYTES * 1.4);

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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
async function prepareUploadedPages({ filename, mimeType, dataBase64 }) {
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
  if (buffer.length > MAX_UPLOAD_FILE_BYTES) {
    const err = new Error('That file is too large. Files are limited to 15MB.');
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
    const fileRows = rendered.pages.map((pngBuffer, i) => ({
      filename: `${baseName}-page-${i + 1}.png`,
      mimeType: 'image/png',
      buffer: pngBuffer,
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
function storeUploadedPageFile({ userId, noteId, filename, mimeType, buffer }) {
  const safeExt = path.extname(filename).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
  const storageName = `${crypto.randomUUID()}${safeExt}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storageName), buffer);
  const info = db
    .prepare('INSERT INTO files (user_id, note_id, filename, mime_type, size_bytes, storage_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, noteId, filename, mimeType, buffer.length, storageName);
  return Number(info.lastInsertRowid);
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getUserBySession(cookies[SESSION_COOKIE]);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    theme: user.theme,
    textSize: user.text_size,
    createdAt: user.created_at,
  };
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
        if (event.type === 'checkout.session.completed') {
          // The moment someone finishes paying - flip them to Premium right
          // away. client_reference_id/metadata.userId were stamped on the
          // session when we created it in createCheckoutSession().
          const userId = Number(obj.client_reference_id || (obj.metadata && obj.metadata.userId));
          if (userId) {
            db.prepare(
              "UPDATE users SET plan = 'paid', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?"
            ).run(obj.customer || null, obj.subscription || null, userId);
          }
        } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
          // Covers renewals, cancellations, and payment failures that lapse
          // a subscription - keeps a user's plan in sync with what they're
          // actually still paying for, not just what happened at checkout.
          const stillActive = event.type !== 'customer.subscription.deleted' && ['active', 'trialing'].includes(obj.status);
          const userId = Number(obj.metadata && obj.metadata.userId);
          if (userId) {
            db.prepare("UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE id = ?")
              .run(stillActive ? 'paid' : 'free', stillActive ? obj.id : null, userId);
          } else if (obj.customer) {
            // Fallback for events that don't carry our metadata - match by
            // the Stripe customer id we saved back at checkout time.
            db.prepare("UPDATE users SET plan = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?")
              .run(stillActive ? 'paid' : 'free', stillActive ? obj.id : null, obj.customer);
          }
        }
      } catch (e) {
        // A bug here shouldn't make Stripe hammer this endpoint with
        // retries forever - log it for us to investigate and move on.
        console.error('Error handling Stripe webhook event:', event.type, e);
      }

      return sendJson(res, 200, { received: true });
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
      db.prepare('DELETE FROM notes WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM folders WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
    }

    // --- Billing (Stripe Managed Payments) ---
    if (pathname === '/api/billing/checkout' && method === 'POST') {
      if (!billingConfigured()) {
        return sendJson(res, 503, { error: 'Billing is not set up yet - check back soon.' });
      }
      const origin = `https://${req.headers.host}`;
      try {
        const url = await createCheckoutSession({
          userId: user.id,
          email: user.email,
          successUrl: `${origin}/?upgraded=1`,
          cancelUrl: `${origin}/?upgrade_cancelled=1`,
        });
        return sendJson(res, 200, { url });
      } catch (e) {
        console.error('Failed to create Stripe checkout session:', e.message);
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
        notes: favNotes.map((n) => ({ ...n, previewHtml: firstPageHtml(n.content_html), content_html: undefined })),
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
      const notes = db
        .prepare(
          'SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? OR content_html LIKE ?) ORDER BY updated_at DESC'
        )
        .all(user.id, like, like);
      return sendJson(res, 200, {
        notes: notes.map((n) => ({ ...n, previewHtml: firstPageHtml(n.content_html), content_html: undefined })),
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
        // a small visual preview of the note.
        notes: notes.map((n) => ({ ...n, previewHtml: firstPageHtml(n.content_html), content_html: undefined })),
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
      return sendJson(res, 201, { note });
    }

    // Upload a PDF or image straight in as a brand-new note (Premium only) -
    // its rendered page(s) become the note's content immediately, read-only,
    // exactly like a document dropped into a paper notebook. Uses the same
    // note-count limit as creating a note normally.
    if (pathname === '/api/notes/upload' && method === 'POST') {
      if (user.plan !== 'paid') {
        return sendJson(res, 403, {
          error: 'Uploading a file as a note is a Premium feature. Upgrade to Premium to turn PDFs and images into notes.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      // No note-count check needed here - this whole endpoint already
      // requires an active Premium plan above, and Premium has no note limit.
      let body;
      try {
        body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      } catch (e) {
        return sendJson(res, 413, { error: 'That file is too large. Files are limited to 15MB.' });
      }
      let fileRows, warning;
      try {
        ({ fileRows, warning } = await prepareUploadedPages(body));
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
      return sendJson(res, 201, { note, warning });
    }

    m = pathname.match(/^\/api\/notes\/(\d+)$/);
    if (m && method === 'GET') {
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(m[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      return sendJson(res, 200, { note });
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
      if (user.plan !== 'paid') {
        return sendJson(res, 403, {
          error: 'Downloading a note as a PDF is a Premium feature. Upgrade to Premium to save your notes as PDFs.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(mPdf[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
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
      db.prepare(
        "UPDATE notes SET title = ?, folder_id = ?, content_html = ?, template = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newTitle, newFolderId, newContent, newTemplate, noteId);
      const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      return sendJson(res, 200, { note: updated });
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
      db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
      return sendJson(res, 200, { ok: true });
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
      if (user.plan !== 'paid') {
        return sendJson(res, 403, {
          error: 'Adding files to your notes is a Premium feature. Upgrade to Premium to add PDF or image pages.',
          code: 'PREMIUM_REQUIRED',
        });
      }
      let body;
      try {
        body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      } catch (e) {
        return sendJson(res, 413, { error: 'That file is too large. Files are limited to 15MB.' });
      }
      let fileRows, warning;
      try {
        ({ fileRows, warning } = await prepareUploadedPages(body));
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
        body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      } catch (e) {
        return sendJson(res, 413, { error: 'That image is too large. Images are limited to 15MB.' });
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(body.mimeType)) {
        return sendJson(res, 415, { error: 'Only PNG, JPEG, GIF, or WebP images are supported.' });
      }
      let fileRows;
      try {
        ({ fileRows } = await prepareUploadedPages(body));
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
      return sendJson(res, 200, { note: { ...updated, content_html: undefined } });
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
