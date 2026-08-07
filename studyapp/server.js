// server.js
// Zero-dependency Node.js HTTP server: static file serving + a small JSON API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { db, FREE_PLAN_NOTE_LIMIT } = require('./db');
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

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
      // Cascade-delete everything that belongs to this account.
      db.prepare('DELETE FROM notes WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM folders WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
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
        notes: notes.map((n) => ({ ...n, content_html: undefined })),
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
        notes: notes.map((n) => ({ ...n, content_html: undefined })), // list view omits full content
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

    m = pathname.match(/^\/api\/notes\/(\d+)$/);
    if (m && method === 'GET') {
      const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(m[1]), user.id);
      if (!note) return sendJson(res, 404, { error: 'Note not found.' });
      return sendJson(res, 200, { note });
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
      db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
      return sendJson(res, 200, { ok: true });
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
  console.log(`StudyNotes MVP running at http://localhost:${PORT}`);
});
