// google.js
// Google Drive sync (Premium/Pro): OAuth2 "installed/web app" flow plus the
// handful of Drive v3 REST calls needed to keep a note's PDF export mirrored
// into a "ScribeStack" folder in the user's own Drive. Hand-rolled against
// Google's plain REST/OAuth endpoints via node's built-in fetch, rather than
// the "googleapis" npm package - same zero-extra-dependency approach as
// stripe.js and email.js.
//
// Scope: requests only 'drive.file' (the app can see/modify just the files
// it itself creates) - never the broad 'drive' scope. That's both the
// privacy-respecting choice (ScribeStack never gets to browse a user's whole
// Drive) and the one that keeps Google's OAuth verification simple and free
// (broad Drive access is a "restricted" scope that requires an annual paid
// security assessment once past ~100 users; drive.file does not).
const crypto = require('node:crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

function driveConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

// ---------------- Refresh-token encryption at rest ----------------
// A Drive refresh token is a long-lived credential - anyone holding it could
// mint access tokens for that user's synced files indefinitely, so it's
// encrypted before it ever touches the database (see the google_refresh_token
// column in db.js) rather than stored as plain text, the same way a user's
// account password is hashed rather than stored directly in auth.js.
//
// The encryption key is derived from GOOGLE_CLIENT_SECRET itself (already a
// secret you set once, alongside the client id) instead of asking you to
// mint and store yet another dedicated secret - AES-256-GCM, so tampering
// with a stored value is detected (decryption just fails) rather than
// silently returning garbage.
function encryptionKey() {
  return crypto.createHash('sha256').update(GOOGLE_CLIENT_SECRET || '').digest();
}

function encryptToken(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptToken(stored) {
  const raw = Buffer.from(stored, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------- OAuth ----------------
// `state` is a random, single-use token the caller generates and remembers
// (see the in-memory pending-state map in server.js) so the callback can
// confirm this redirect really is the continuation of a connect flow this
// server started, rather than a forged request hitting the callback URL
// directly with someone else's authorization code.
function buildConsentUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    // Forces Google to re-issue a refresh token even for a user reconnecting
    // after a previous disconnect - without this, a second consent for the
    // same Google account can come back with no refresh_token at all (only
    // handed out on a user's very first grant otherwise).
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error_description || data.error || `Google token exchange failed (${res.status})`));
  }
  return data; // { access_token, refresh_token, expires_in, scope, token_type }
}

// Refresh tokens don't expire from mere disuse, and minting a fresh access
// token is a cheap, well-quota'd call - so rather than tracking an access
// token's own expiry separately, every sync just exchanges the stored
// refresh token for a brand new access token right before it's needed.
async function getAccessToken(encryptedRefreshToken) {
  const refreshToken = decryptToken(encryptedRefreshToken);
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant here almost always means the user revoked ScribeStack's
    // access from their Google account settings, or the refresh token was
    // otherwise invalidated - the caller should treat this as "disconnected"
    // rather than a transient failure worth retrying.
    const err = new Error(data.error_description || data.error || `Could not refresh Google access token (${res.status})`);
    err.code = data.error === 'invalid_grant' ? 'GOOGLE_DISCONNECTED' : 'GOOGLE_ERROR';
    throw err;
  }
  return data.access_token;
}

// ---------------- Drive ----------------
// drive.file scope means "files this app created" is the only thing the app
// can ever see - so it's safe (and necessary) to always look for the
// ScribeStack folder among files the app itself made, never the user's
// wider Drive.
async function driveRequest(accessToken, path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${DRIVE_FILES_URL}${path}`);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Drive API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function findOrCreateAppFolder(accessToken, existingFolderId) {
  if (existingFolderId) {
    // Confirm it still exists (and isn't trashed) rather than trusting a
    // stale id forever - someone can always delete the folder from Drive
    // directly.
    try {
      const folder = await driveRequest(accessToken, `/${existingFolderId}`, { query: { fields: 'id,trashed' } });
      if (folder && !folder.trashed) return folder.id;
    } catch (e) {
      // Fall through and create a new one.
    }
  }
  const created = await driveRequest(accessToken, '', {
    method: 'POST',
    body: { name: 'ScribeStack', mimeType: 'application/vnd.google-apps.folder' },
  });
  return created.id;
}

// Builds a multipart/related body (Drive's "simple + metadata in one
// request" upload format) by hand - the whole reason this project avoids an
// npm Drive client, so this is the one bit of wire-format plumbing that
// replaces it.
function buildMultipartBody(metadata, buffer, mimeType, boundary) {
  const metadataPart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const mediaPartHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;
  return Buffer.concat([Buffer.from(metadataPart, 'utf8'), Buffer.from(mediaPartHeader, 'utf8'), buffer, Buffer.from(closing, 'utf8')]);
}

async function createFile(accessToken, { name, parentId, buffer, mimeType }) {
  const boundary = `scribestack-${crypto.randomBytes(16).toString('hex')}`;
  const body = buildMultipartBody({ name, parents: [parentId] }, buffer, mimeType, boundary);
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Drive upload failed (${res.status})`);
  return data.id;
}

async function updateFileContent(accessToken, fileId, { name, buffer, mimeType }) {
  const boundary = `scribestack-${crypto.randomBytes(16).toString('hex')}`;
  const body = buildMultipartBody({ name }, buffer, mimeType, boundary);
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=multipart&fields=id`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Drive update failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data.id;
}

// Pushes one note's PDF into the user's Drive, creating it on first sync and
// updating the same file in place on every sync after that. Returns the
// Drive file id to remember (so the caller can save it back onto the note
// row) and folder id (in case a fresh folder had to be created).
async function syncFileToDrive({ accessToken, folderId, existingFileId, fileName, buffer, mimeType }) {
  if (existingFileId) {
    try {
      const id = await updateFileContent(accessToken, existingFileId, { name: fileName, buffer, mimeType });
      return id;
    } catch (e) {
      // The previously-synced file is gone (deleted from Drive, or this is a
      // different Google account than last time) - fall back to creating a
      // fresh one rather than failing the whole sync.
      if (e.status !== 404 && e.status !== 403) throw e;
    }
  }
  return createFile(accessToken, { name: fileName, parentId: folderId, buffer, mimeType });
}

module.exports = {
  driveConfigured,
  encryptToken,
  decryptToken,
  buildConsentUrl,
  exchangeCodeForTokens,
  getAccessToken,
  findOrCreateAppFolder,
  syncFileToDrive,
};
