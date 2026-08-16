// app.js - all client-side logic for the ScribeStack MVP.
// Plain JS, no build step, no framework - keeps this app runnable by just opening the server.

const state = {
  user: null,
  folders: [],
  folderColors: [],
  templates: [],
  view: { type: 'smart', key: 'all' }, // {type:'smart', key:'all'|'unfiled'} | {type:'folders'} | {type:'folder', id} | {type:'favorites'}
  notes: [],
  noteMeta: { totalCount: 0, limit: null },
  favoriteNotes: [],
  favoriteFolders: [],
  sidebarCollapsed: false,
  currentNote: null,
  saveTimer: null,
  rebalanceTimer: null,
  searchQuery: '',
  searchTimer: null,
  searchResults: null, // non-null while a search is active
  lastFocusedPage: null, // the .note-page-body element the toolbar should act on
  savedRange: null,      // last known selection/cursor position inside a page
  // "Pending" formatting: what happens when you click Bold/pick a font/etc
  // with nothing selected, cursor just blinking - the format should apply to
  // whatever you type NEXT, the same way it works in Word/Google Docs.
  // bold/italic/underline start at `undefined`, not `false` - that third
  // state ("never touched this round") matters: it's what tells the marker
  // builder below to leave that property alone entirely versus writing an
  // explicit "off" value to override some ancestor <b>/<i>/<u> tag left
  // over from earlier formatting.
  pendingFormat: { bold: undefined, italic: undefined, underline: undefined, fontFamily: null, fontSize: null, highlight: null },
  pendingMarkerEl: null, // the (possibly still-empty) styled <span> the cursor is currently "inside" for pending formatting
};

const PAGE_HEIGHT_PX = 820; // fixed "sheet" height - content beyond this flows to the next page

// Keep track of where the caret is within the note pages, even after focus moves
// to a toolbar button/select, so formatting commands always land in the right spot.
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const pageBody = node && node.closest ? node.closest('.note-page-body') : null;
  // Only trust this as a genuine selection made while typing/highlighting if
  // the note itself still actually has keyboard focus. The moment a toolbar
  // button or dropdown gets clicked, focus starts moving onto it, and that
  // move can itself fire a selectionchange reporting the selection as
  // suddenly collapsed - a side effect of the focus change, not a real
  // change the user made. Without this check, that spurious event would
  // silently overwrite the real selection state.savedRange needs to hold for
  // the click/change handler that's about to run right after it.
  if (pageBody && document.activeElement && pageBody.contains(document.activeElement)) {
    state.savedRange = range.cloneRange();
    state.lastFocusedPage = pageBody;
  }
  // If the cursor wandered away from an empty pending-format marker without
  // ever typing into it (clicked elsewhere, arrow-keyed away, etc), that
  // marker is now abandoned - drop it and stop forcing that format, the same
  // way Word/Docs stop applying a pre-selected style once you click away.
  if (state.pendingMarkerEl && state.pendingMarkerEl.isConnected && isPendingMarkerEmpty(state.pendingMarkerEl)) {
    const stillInside = node && node.closest && node.closest('[data-pending-marker]') === state.pendingMarkerEl;
    if (!stillInside) {
      state.pendingMarkerEl.remove();
      state.pendingMarkerEl = null;
      resetPendingFormat();
    }
  }
  updateToolbarActiveStates();
});

// Reflects which formatting commands are active at the current cursor
// position/selection (bold/italic/underline) on their toolbar buttons, so
// it's visible at a glance which tools are "on" - the same way a word
// processor's toolbar highlights the Bold button while you're typing bold text.
// When nothing is selected (just a blinking cursor), this also reflects any
// pending format queued up to apply to whatever gets typed next.
function updateToolbarActiveStates() {
  const toolbar = document.querySelector('.editor-toolbar');
  if (!toolbar) return;
  const sel = window.getSelection();
  const collapsed = !sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed;
  toolbar.querySelectorAll('[data-cmd]').forEach((btn) => {
    let active = false;
    if (collapsed && state.pendingFormat[btn.dataset.cmd]) {
      active = true;
    } else {
      try { active = document.queryCommandState(btn.dataset.cmd); } catch (e) { /* ignore - no selection yet */ }
    }
    btn.classList.toggle('active', active);
  });
}

// The authoritative answer to "does the user currently have real text
// selected" - reads the browser's own live selection. Call this AFTER
// focusLastPage(), never before: focusLastPage() itself now takes care not
// to disturb a real live selection, so by the time this runs, the live
// selection is the most trustworthy source - more so than state.savedRange,
// which is only updated by the 'selectionchange' event and can lag a beat
// behind the browser's actual, already-current selection state.
function hasRealSelection() {
  const sel = window.getSelection();
  return !!(sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed);
}

function resetPendingFormat() {
  state.pendingFormat = { bold: undefined, italic: undefined, underline: undefined, fontFamily: null, fontSize: null, highlight: null };
}

// A completely empty inline element gets silently stripped out by the
// browser the moment you start typing into a contenteditable region (it
// "cleans up" empty tags during input normalization) - which would erase our
// marker span before it ever got a chance to catch the typed characters.
// PENDING_MARKER_PLACEHOLDER is an invisible zero-width character planted
// inside the span so the browser treats it as real, non-empty content and
// leaves it alone. "Empty" from our own code's point of view still means
// "nothing the user actually typed yet" - just this invisible placeholder.
const PENDING_MARKER_PLACEHOLDER = String.fromCharCode(8203); // U+200B zero-width space
function isPendingMarkerEmpty(el) {
  return el.textContent === PENDING_MARKER_PLACEHOLDER || el.textContent === '';
}

function buildPendingStyle(pf) {
  const parts = [];
  // bold/italic/underline: once the user has explicitly touched one of
  // these this round (pf.X !== undefined), an explicit value ALWAYS gets
  // written - including the "off" value - rather than just omitting the
  // property when it's off. Omitting it would only stop NEW bold/italic/
  // underline from being added; it wouldn't cancel out an ancestor <b>/<i>/
  // <u> tag left over from earlier formatting still further up the DOM,
  // which is exactly what made "turn it back off" seem to silently fail.
  if (pf.bold !== undefined) parts.push(`font-weight:${pf.bold ? 'bold' : 'normal'}`);
  if (pf.italic !== undefined) parts.push(`font-style:${pf.italic ? 'italic' : 'normal'}`);
  if (pf.underline !== undefined) parts.push(`text-decoration:${pf.underline ? 'underline' : 'none'}`);
  // fontFamily/highlight: same idea. Once touched, pf.fontFamily/pf.highlight
  // always hold a real, concrete value (even "Default" resolves to an actual
  // font stack, and "None" highlight resolves to the literal string
  // 'transparent') rather than null/falsy, so a plain truthiness check
  // already distinguishes "explicitly set" from "never touched".
  if (pf.fontFamily) parts.push(`font-family:${pf.fontFamily}`);
  if (pf.fontSize) parts.push(`font-size:${pf.fontSize}px`);
  if (pf.highlight) parts.push(`background-color:${pf.highlight}`);
  return parts.join(';');
}

// Makes sure there's an actual cursor position inside the page to work with -
// a brand new blank page that's never been clicked into yet doesn't
// necessarily have one, which would otherwise make the very first toolbar
// click before typing anything silently fail.
function ensureCaretInPage() {
  const pageBody = state.lastFocusedPage;
  if (!pageBody) return null;
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && pageBody.contains(sel.getRangeAt(0).startContainer)) {
    return sel.getRangeAt(0);
  }
  const r = document.createRange();
  r.selectNodeContents(pageBody);
  r.collapse(false); // end of whatever's already there
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

// True if the given collapsed range is either still inside `marker`, or
// sitting exactly at the position right after it - i.e. the cursor hasn't
// moved away from the marker since it was created/last typed into.
function isRangeAtOrRightAfter(range, marker) {
  if (marker.contains(range.startContainer)) return true;
  const afterMarker = document.createRange();
  afterMarker.setStartAfter(marker);
  afterMarker.collapse(true);
  try {
    return range.compareBoundaryPoints(Range.START_TO_START, afterMarker) === 0;
  } catch (e) {
    return false;
  }
}

// Applies the current state.pendingFormat to the cursor position by placing
// it inside a small styled <span> so that typing naturally lands inside (and
// inherits) that span's style - no selection to wrap yet, so this is the
// "type-ahead formatting" equivalent of wrapping selected text.
function applyPendingFormatMarker() {
  const sel = window.getSelection();
  const range = ensureCaretInPage();
  if (!sel || !range) return;

  const pf = state.pendingFormat;
  // "Active" here means "there's something to explicitly write into the
  // marker's style" - which includes an explicitly-touched-but-off
  // bold/italic/underline (pf.X === false, not just pf.X === true), since
  // that off value still needs to be written to override any ancestor
  // formatting tag.
  const anyActive = pf.bold !== undefined || pf.italic !== undefined || pf.underline !== undefined || !!pf.fontFamily || !!pf.fontSize || !!pf.highlight;

  // Reusing the empty marker also requires the cursor to still actually be
  // there - the 'selectionchange' listener normally cleans up an abandoned
  // empty marker the moment the cursor leaves it, but that event can lag a
  // beat, so this doesn't rely on that alone.
  const reusable = state.pendingMarkerEl && state.pendingMarkerEl.isConnected
    && isPendingMarkerEmpty(state.pendingMarkerEl)
    && isRangeAtOrRightAfter(range, state.pendingMarkerEl);

  if (reusable) {
    if (!anyActive) {
      // Turning every format off with nothing typed yet - just remove the
      // empty placeholder rather than leaving useless markup behind.
      const parent = state.pendingMarkerEl.parentNode;
      const r = document.createRange();
      r.setStartBefore(state.pendingMarkerEl);
      r.collapse(true);
      parent.removeChild(state.pendingMarkerEl);
      state.pendingMarkerEl = null;
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    // Still nothing typed into it - just restyle the same empty marker and
    // put the caret back after the placeholder character.
    state.pendingMarkerEl.setAttribute('style', buildPendingStyle(pf));
    const r = document.createRange();
    r.setStart(state.pendingMarkerEl.firstChild, state.pendingMarkerEl.firstChild.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }

  // The previous marker (if any) already has real typed text in it, so it
  // has to stay exactly as-is - we're starting a fresh run right after it.
  // But only treat it as "right after it" when the cursor is actually still
  // there (still inside it, or immediately touching its end) - e.g. right
  // after typing into it and then toggling a format off. If the cursor has
  // since moved somewhere else entirely (Enter to a new line, a click
  // elsewhere), that old marker is just history now; positioning the new
  // one relative to it would plant it in the wrong place - on the old line
  // instead of wherever the cursor actually is - which is what made a
  // toolbar click right after pressing Enter seem to jump back to the
  // previous line.
  const priorMarker = state.pendingMarkerEl && state.pendingMarkerEl.isConnected ? state.pendingMarkerEl : null;
  state.pendingMarkerEl = null;
  const priorMarkerIsWhereCursorIs = priorMarker && isRangeAtOrRightAfter(range, priorMarker);

  if (!anyActive && !priorMarkerIsWhereCursorIs) return; // never touched formatting - plain typing, nothing to do

  // Even for "no formats active" (turning everything off), an explicit new
  // span is still planted rather than just moving the caret past the old
  // one - contenteditable browsers tend to silently continue the previous
  // run's formatting for anything typed right at the edge of a styled span,
  // so "just reposition the caret" isn't reliable. An explicit boundary
  // (even one with an empty style, i.e. plain text) guarantees a clean break.
  const workingRange = priorMarkerIsWhereCursorIs
    ? (() => { const r = document.createRange(); r.setStartAfter(priorMarker); r.collapse(true); return r; })()
    : (sel.rangeCount > 0 ? sel.getRangeAt(0) : range);

  const span = document.createElement('span');
  span.setAttribute('data-pending-marker', '1');
  span.setAttribute('style', buildPendingStyle(pf));
  span.appendChild(document.createTextNode(PENDING_MARKER_PLACEHOLDER));
  workingRange.insertNode(span);
  const r = document.createRange();
  r.setStart(span.firstChild, span.firstChild.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  state.pendingMarkerEl = span;
}

// Close the highlighter color popover when clicking anywhere outside it.
// Queries the live DOM each time (rather than closing over a stale element)
// since the editor gets re-rendered every time a note is opened.
document.addEventListener('click', (e) => {
  const popover = document.getElementById('highlight-popover');
  if (!popover || popover.classList.contains('hidden')) return;
  if (!e.target.closest('.highlight-picker')) {
    popover.classList.add('hidden');
  }
});

// Let keyboard users dismiss the highlighter popover and the mobile sidebar
// drawer with Escape, same as clicking outside them with a mouse.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const popover = document.getElementById('highlight-popover');
  if (popover && !popover.classList.contains('hidden')) {
    popover.classList.add('hidden');
    const toggleBtn = document.getElementById('highlight-toggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.focus();
    }
    return;
  }
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('mobile-open')) {
    closeMobileSidebar();
    const menuBtn = document.getElementById('mobile-menu-btn');
    if (menuBtn) menuBtn.focus();
  }
});

// Note: font names use single quotes (not double) because these values get
// embedded inside double-quoted HTML attributes below.
//
// These are all real web fonts loaded in index.html (Google Fonts), not just
// names of fonts that might or might not happen to be installed on whoever's
// computer is viewing the note - that mismatch was why some font choices used
// to silently do nothing. Each still lists a sensible system-font fallback in
// case the web font ever fails to load (e.g. no internet connection).
// The note page doesn't set its own font-family - it just picks up the
// app's base font from `body` in styles.css. "Default" needs to name that
// font explicitly (rather than the CSS keyword 'inherit'), because
// 'inherit' only pulls from whatever the *immediate* parent element
// happens to be - if that parent is itself a leftover <font face="Caveat">
// wrapper from an earlier format change, 'inherit' would just inherit
// Caveat right back, making "switch back to Default" silently do nothing.
const DEFAULT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const FONT_OPTIONS = [
  { label: 'Default', value: DEFAULT_FONT_FAMILY },
  { label: 'Inter', value: "'Inter', Arial, Helvetica, sans-serif" },
  { label: 'Open Sans', value: "'Open Sans', Arial, sans-serif" },
  { label: 'Poppins', value: "'Poppins', Arial, sans-serif" },
  { label: 'Lora', value: "'Lora', Georgia, serif" },
  { label: 'Merriweather', value: "'Merriweather', Georgia, serif" },
  { label: 'Playfair Display', value: "'Playfair Display', Georgia, serif" },
  { label: 'Times New Roman', value: "'Tinos', 'Times New Roman', Times, serif" },
  { label: 'Roboto Mono', value: "'Roboto Mono', 'Courier New', monospace" },
  { label: 'Source Code Pro', value: "'Source Code Pro', 'Courier New', monospace" },
  { label: 'Quicksand', value: "'Quicksand', 'Trebuchet MS', sans-serif" },
  { label: 'Comic Neue', value: "'Comic Neue', 'Comic Sans MS', cursive" },
  { label: 'Caveat', value: "'Caveat', cursive" },
  { label: 'Patrick Hand', value: "'Patrick Hand', cursive" },
  { label: 'Kalam', value: "'Kalam', cursive" },
  { label: 'Baloo 2', value: "'Baloo 2', cursive" },
];

// Per-note text size (separate from the app-wide Settings > text size, which
// only scales menus/buttons - this scales the actual note content).
const TEXT_SIZE_OPTIONS = [
  { label: 'Small', px: 13 },
  { label: 'Normal', px: 15 },
  { label: 'Large', px: 20 },
  { label: 'X-Large', px: 28 },
];

const HIGHLIGHT_COLORS = [
  { label: 'Yellow', value: '#fff2a8' },
  { label: 'Green', value: '#c8f2c0' },
  { label: 'Blue', value: '#c6e2fb' },
  { label: 'Pink', value: '#fbd0e4' },
  { label: 'None', value: 'transparent' },
];

// ---------------- API helper ----------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// ---------------- Display preferences (theme + text size) ----------------
const TEXT_SIZE_ZOOM = { small: 0.9, medium: 1, large: 1.15 };
const PREFERS_DARK = window.matchMedia('(prefers-color-scheme: dark)');

// Applies the current user's saved theme/text-size to the whole page. Safe to
// call before login too (falls back to "system"/"medium") so the auth screen
// itself follows the visitor's OS-level light/dark preference.
function applyDisplayPreferences() {
  const theme = (state.user && state.user.theme) || 'system';
  const resolvedTheme = theme === 'system' ? (PREFERS_DARK.matches ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolvedTheme);

  const textSize = (state.user && state.user.textSize) || 'medium';
  root.style.zoom = TEXT_SIZE_ZOOM[textSize] || 1;
}

// If the preference is "system", keep following the OS setting live instead
// of requiring a reload when the visitor's system theme changes.
PREFERS_DARK.addEventListener('change', () => {
  if (!state.user || state.user.theme === 'system') applyDisplayPreferences();
});

// ---------------- Boot ----------------
const root = document.getElementById('root');

async function boot() {
  // Remember whether the sidebar was collapsed, across reloads.
  try { state.sidebarCollapsed = localStorage.getItem('sn_sidebar_collapsed') === '1'; } catch (e) { /* private browsing, etc - just default to expanded */ }

  applyDisplayPreferences(); // "system" default until we know whether someone's logged in

  // A password-reset link looks like /?reset=<token> - handle that before
  // anything else, regardless of whether the visitor happens to be logged in.
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  if (resetToken) {
    renderResetPassword(resetToken);
    return;
  }

  try {
    const { user } = await api('/api/me');
    state.user = user;
    applyDisplayPreferences(); // now reflects this account's saved preference
    await loadApp();
  } catch (e) {
    renderAuth();
  }
}

// ---------------- Auth screen ----------------
function renderAuth(message, activeTab = 'signup', messageType = 'error') {
  root.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <p class="brand-title">ScribeStack</p>
        <p class="brand-sub">Take notes in class. Turn them into study material with AI.</p>
        <div class="tab-row">
          <button class="tab-btn ${activeTab === 'signup' ? 'active' : ''}" data-tab="signup">Sign up</button>
          <button class="tab-btn ${activeTab === 'login' ? 'active' : ''}" data-tab="login">Log in</button>
        </div>
        ${message ? `<div class="${messageType === 'info' ? 'form-info' : 'form-error'}">${escapeHtml(message)}</div>` : ''}
        <form id="auth-form">
          ${activeTab === 'signup' ? `
            <div class="field">
              <label for="auth-name">Full name</label>
              <input type="text" id="auth-name" name="name" required autocomplete="name" />
            </div>` : ''}
          <div class="field">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" name="email" required autocomplete="email" />
          </div>
          <div class="field">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" name="password" required autocomplete="${activeTab === 'signup' ? 'new-password' : 'current-password'}" minlength="8" />
          </div>
          ${activeTab === 'signup' ? `
            <div class="field-checkbox">
              <label for="agree-terms-checkbox">
                <input type="checkbox" id="agree-terms-checkbox" name="agreedToTerms" required />
                I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a>
                and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.
              </label>
            </div>` : ''}
          <button type="submit" class="primary-btn">${activeTab === 'signup' ? 'Create free account' : 'Log in'}</button>
        </form>
        ${activeTab === 'login' ? '<button class="link-btn" id="forgot-password-link">Forgot your password?</button>' : ''}
        <p class="auth-legal-footer">
          <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a>
          ·
          <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
        </p>
      </div>
    </div>
  `;

  root.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderAuth(null, btn.dataset.tab));
  });

  root.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (activeTab === 'signup') {
      payload.agreedToTerms = fd.has('agreedToTerms');
      if (!payload.agreedToTerms) {
        renderAuth('Please agree to the Terms of Service and Privacy Policy to continue.', 'signup');
        return;
      }
    }
    try {
      const { user } = activeTab === 'signup'
        ? await api('/api/signup', { method: 'POST', body: payload })
        : await api('/api/login', { method: 'POST', body: { email: payload.email, password: payload.password } });
      state.user = user;
      await loadApp();
    } catch (err) {
      renderAuth(err.message, activeTab);
    }
  });

  const forgotLink = root.querySelector('#forgot-password-link');
  if (forgotLink) forgotLink.addEventListener('click', () => renderForgotPassword());
}

// ---------------- Forgot / reset password ----------------
function renderForgotPassword(message) {
  root.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <p class="brand-title">ScribeStack</p>
        <p class="brand-sub">Reset your password</p>
        ${message ? `<div class="form-info">${escapeHtml(message)}</div>` : ''}
        <form id="forgot-form">
          <div class="field">
            <label for="forgot-email">Email</label>
            <input type="email" id="forgot-email" name="email" required autocomplete="email" />
          </div>
          <button type="submit" class="primary-btn">Send reset link</button>
        </form>
        <button class="link-btn" id="back-to-login-link">Back to log in</button>
      </div>
    </div>
  `;

  root.querySelector('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { email } = Object.fromEntries(fd.entries());
    try {
      const { message } = await api('/api/forgot-password', { method: 'POST', body: { email } });
      renderForgotPassword(message);
    } catch (err) {
      renderForgotPassword(err.message);
    }
  });

  root.querySelector('#back-to-login-link').addEventListener('click', () => renderAuth(null, 'login'));
}

function renderResetPassword(token, errorMsg) {
  root.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <p class="brand-title">ScribeStack</p>
        <p class="brand-sub">Set a new password</p>
        ${errorMsg ? `<div class="form-error">${escapeHtml(errorMsg)}</div>` : ''}
        <form id="reset-form">
          <div class="field">
            <label for="reset-new-password">New password</label>
            <input type="password" id="reset-new-password" name="newPassword" required minlength="8" autocomplete="new-password" />
          </div>
          <button type="submit" class="primary-btn">Set new password</button>
        </form>
      </div>
    </div>
  `;

  root.querySelector('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { newPassword } = Object.fromEntries(fd.entries());
    try {
      await api('/api/reset-password', { method: 'POST', body: { token, newPassword } });
      // Clear the ?reset=... query param so refreshing doesn't reopen this screen.
      window.history.replaceState({}, '', window.location.pathname);
      renderAuth('Your password has been reset. Log in with your new password.', 'login', 'info');
    } catch (err) {
      renderResetPassword(token, err.message);
    }
  });
}

// ---------------- App shell ----------------
async function loadApp() {
  await refreshFolders();
  await refreshTemplates();
  await refreshFolderColors();
  await selectView({ type: 'smart', key: 'all' });
}

async function refreshTemplates() {
  const { templates } = await api('/api/templates');
  state.templates = templates;
}

async function refreshFolders() {
  const { folders } = await api('/api/folders');
  state.folders = folders;
}

async function refreshFolderColors() {
  const { colors } = await api('/api/folder-colors');
  state.folderColors = colors;
}

// Renders the small folder-shaped icon used on folder cards, tinted with
// whichever color the user picked for that folder.
function folderIconSvg(colorKey, { width = 20, height = 16, className = 'folder-card-icon' } = {}) {
  const c = state.folderColors.find((fc) => fc.key === colorKey) || state.folderColors[0] || { fill: '#fbd077', stroke: '#d9a441' };
  return `
    <svg class="${className}" width="${width}" height="${height}" viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M1 3.6C1 2.71634 1.71634 2 2.6 2H7.34C7.72255 2 8.09324 2.13214 8.39 2.374L9.98 3.674C10.1258 3.79343 10.3082 3.85897 10.4967 3.85941L17.4 3.876C18.2837 3.87805 19 4.59623 19 5.48V12.4C19 13.2837 18.2837 14 17.4 14H2.6C1.71634 14 1 13.2837 1 12.4V3.6Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="0.9"/>
    </svg>
  `;
}

function renderShell() {
  const limit = state.noteMeta.limit;
  const used = state.noteMeta.totalCount;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  root.innerHTML = `
    <div class="app-shell">
      <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu" aria-expanded="false">☰</button>
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <div class="sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}" id="sidebar">
        <div class="sidebar-header">
          <p class="brand-title">ScribeStack</p>
          <span class="plan-badge">${state.user.plan === 'paid' ? 'Premium' : 'Free'}</span>
        </div>

        ${limit ? `
        <div class="note-usage">
          ${used} / ${limit} note sets used
          <div class="note-usage-bar"><div class="note-usage-fill" style="width:${pct}%"></div></div>
        </div>` : ''}

        <div class="sidebar-actions">
          <button id="new-note-btn">+ Note</button>
          <button id="new-folder-btn">+ Folder</button>
        </div>

        <div class="sidebar-search">
          <input type="search" id="note-search-input" placeholder="Search notes..." value="${escapeAttr(state.searchQuery)}" aria-label="Search notes" />
        </div>

        <div class="folder-list" id="folder-list"></div>

        <div class="sidebar-footer">
          <span class="user-name">${escapeHtml(state.user.name)}</span>
          <button class="logout-link" id="logout-btn">Log out</button>
        </div>
      </div>

      <button class="sidebar-expand-handle ${state.sidebarCollapsed && !state.currentNote ? 'visible' : ''}" id="sidebar-expand-handle" aria-label="Show sidebar" title="Show sidebar">›</button>

      <div class="main-content-viewport" id="main-content-viewport">
        <div class="main-content" id="main-content"></div>
      </div>
    </div>
  `;

  renderSidebarNav();

  root.querySelector('#new-note-btn').addEventListener('click', () => { closeMobileSidebar(); createNote(); });
  root.querySelector('#new-folder-btn').addEventListener('click', () => { closeMobileSidebar(); createFolder(); });
  root.querySelector('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    renderAuth();
  });
  root.querySelector('#sidebar-expand-handle').addEventListener('click', () => setSidebarCollapsed(false));

  const menuBtn = root.querySelector('#mobile-menu-btn');
  const sidebarEl = root.querySelector('#sidebar');
  const backdrop = root.querySelector('#sidebar-backdrop');
  menuBtn.addEventListener('click', () => {
    const isOpen = sidebarEl.classList.toggle('mobile-open');
    backdrop.classList.toggle('visible', isOpen);
    menuBtn.setAttribute('aria-expanded', String(isOpen));
  });
  backdrop.addEventListener('click', () => closeMobileSidebar());

  root.querySelector('#note-search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      const q = state.searchQuery.trim();
      if (!q) {
        exitSearch();
      } else {
        performSearch(q);
      }
    }, 250);
  });
}

// Collapsing the sidebar (desktop only - mobile already hides it by default
// behind the hamburger menu) frees up width for whatever's in the main
// panel, most usefully while writing in a note. Toggling mutates the
// existing DOM nodes in place rather than going through a full render, so
// the CSS width transition on .sidebar actually has something to animate
// between instead of just popping to its new state.
function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  try { localStorage.setItem('sn_sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) { /* private browsing, etc - fine, just won't persist */ }

  const sidebarEl = root.querySelector('#sidebar');
  const handle = root.querySelector('#sidebar-expand-handle');
  if (sidebarEl) sidebarEl.classList.toggle('collapsed', collapsed);
  // Only the standalone handle OR the in-editor toggle should ever be
  // visible at once, never both - while inside a note, the toggle below
  // already covers this, so the handle stays hidden.
  if (handle) handle.classList.toggle('visible', collapsed && !state.currentNote);

  const toggleBtn = root.querySelector('#sidebar-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = collapsed ? '›' : '‹';
    const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.title = label;
  }
}
function toggleSidebar() {
  setSidebarCollapsed(!state.sidebarCollapsed);
}

// Closes the slide-out sidebar drawer on mobile widths. Harmless no-op on
// desktop, where the sidebar is always visible and has no "mobile-open" state.
function closeMobileSidebar() {
  const sidebarEl = root.querySelector('#sidebar');
  const backdrop = root.querySelector('#sidebar-backdrop');
  const menuBtn = root.querySelector('#mobile-menu-btn');
  if (sidebarEl) sidebarEl.classList.remove('mobile-open');
  if (backdrop) backdrop.classList.remove('visible');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}

// The sidebar just holds three nav entries now - "All notes", "Folders" (which
// opens a grid of every folder in the main panel), and "Unfiled". Individual
// folders no longer live in the sidebar itself; see renderMainAsFolderGrid().
function renderSidebarNav() {
  const nav = root.querySelector('#folder-list');
  if (!nav) return;

  const smartActive = (key) => state.view.type === 'smart' && state.view.key === key ? 'active' : '';
  const foldersActive = state.view.type === 'folders' ? 'active' : '';
  const favoritesActive = state.view.type === 'favorites' ? 'active' : '';
  const settingsActive = state.view.type === 'settings' ? 'active' : '';

  nav.innerHTML = `
    <div class="smart-item ${smartActive('all')}" data-smart="all">All notes</div>
    <div class="smart-item ${favoritesActive}" data-nav-favorites>★ Favorites</div>
    <div class="smart-item ${foldersActive}" data-nav-folders>Folders</div>
    <div class="smart-item ${smartActive('unfiled')}" data-smart="unfiled">Unfiled</div>
    <div class="sidebar-divider"></div>
    <div class="smart-item ${settingsActive}" data-nav-settings>⚙ Settings</div>
  `;

  nav.querySelectorAll('[data-smart]').forEach((el) => {
    el.addEventListener('click', () => { closeMobileSidebar(); selectView({ type: 'smart', key: el.dataset.smart }); });
  });
  const foldersNavEl = nav.querySelector('[data-nav-folders]');
  if (foldersNavEl) {
    foldersNavEl.addEventListener('click', () => { closeMobileSidebar(); selectView({ type: 'folders' }); });
  }
  const favoritesNavEl = nav.querySelector('[data-nav-favorites]');
  if (favoritesNavEl) {
    favoritesNavEl.addEventListener('click', () => { closeMobileSidebar(); selectView({ type: 'favorites' }); });
  }
  const settingsNavEl = nav.querySelector('[data-nav-settings]');
  if (settingsNavEl) {
    settingsNavEl.addEventListener('click', () => { closeMobileSidebar(); selectView({ type: 'settings' }); });
  }
}

// ---------------- Views: note grid ----------------
async function selectView(view) {
  state.view = view;
  state.currentNote = null;
  if (view.type === 'folders') {
    await refreshFolders(); // note counts can change elsewhere (new/moved/deleted notes) - keep them current
    renderShell();
    renderMainAsFolderGrid();
    return;
  }
  if (view.type === 'settings') {
    renderShell();
    renderMainAsSettings();
    return;
  }
  if (view.type === 'favorites') {
    await refreshFolders(); // folder note-counts / colors can change elsewhere
    const { notes, folders } = await api('/api/favorites');
    state.favoriteNotes = notes;
    state.favoriteFolders = folders;
    renderShell();
    renderMainAsFavorites();
    return;
  }
  await refreshNotesForView();
  renderShell();
  renderMainAsGrid();
}

// Re-renders whatever the user is currently looking at - the correct list
// (All notes/Unfiled/a folder/Favorites) or the active search results -
// after a background change like a delete, rename, or favorite toggle made
// from a card's right-click menu or star button.
async function refreshCurrentView() {
  if (state.searchResults !== null && state.searchQuery.trim()) {
    await performSearch(state.searchQuery.trim());
    return;
  }
  await selectView(state.view);
}

// ---------------- Main-panel slide transitions ----------------
// Gives "opening a note/folder" and "going back" a smooth swipe animation
// instead of an instant swap, the same way a phone app pushes/pops a screen.
// Respects the OS-level "reduce motion" accessibility setting.
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Wraps a render step (anything that ends with #main-content showing new
// content - directly, or indirectly via a full renderShell() rebuild) with a
// slide animation. `direction` is 'forward' (going deeper - new content
// enters from the right, old content exits to the left) or 'back' (returning -
// new content enters from the left, old content exits to the right).
async function animateMainTransition(renderFn, direction) {
  const mainBefore = root.querySelector('#main-content');
  if (!mainBefore || prefersReducedMotion()) {
    await renderFn();
    return;
  }

  // A fixed, clipped "stage" exactly the size/position of #main-content,
  // appended to the page OUTSIDE #root so it survives renderFn() even when
  // that rebuilds the whole app shell (renderShell() does a full
  // root.innerHTML replace for several views). The outgoing snapshot lives
  // INSIDE this stage, clipped to it - and the incoming live #main-content
  // is clipped by its own permanent parent, #main-content-viewport (see
  // styles.css). Both are bounded to exactly the main panel's own region,
  // so neither can ever visually sweep across the sidebar while sliding -
  // that's what caused the half-second glitch where old content used to
  // flash over the sidebar mid-transition.
  const rect = mainBefore.getBoundingClientRect();
  const stage = document.createElement('div');
  stage.className = 'main-transition-stage';
  stage.style.top = rect.top + 'px';
  stage.style.left = rect.left + 'px';
  stage.style.width = rect.width + 'px';
  stage.style.height = rect.height + 'px';

  const snapshot = document.createElement('div');
  snapshot.className = 'main-transition-snapshot';
  snapshot.innerHTML = mainBefore.innerHTML;
  stage.appendChild(snapshot);
  document.body.appendChild(stage);

  await renderFn();

  const mainAfter = root.querySelector('#main-content');
  if (!mainAfter) { stage.remove(); return; }

  mainAfter.classList.add('main-transition-active');
  mainAfter.style.transition = 'none';
  mainAfter.style.transform = direction === 'back' ? 'translateX(-100%)' : 'translateX(100%)';
  void mainAfter.offsetWidth; // force layout so the starting position above actually takes effect before animating

  requestAnimationFrame(() => {
    mainAfter.style.transition = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)';
    mainAfter.style.transform = 'translateX(0)';
    snapshot.style.transition = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)';
    snapshot.style.transform = direction === 'back' ? 'translateX(100%)' : 'translateX(-100%)';
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    mainAfter.style.transition = '';
    mainAfter.style.transform = '';
    mainAfter.classList.remove('main-transition-active');
    stage.remove();
  };
  mainAfter.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 450); // safety net in case transitionend never fires
}

// ---------------- Note card visual thumbnails ----------------
// The card preview shows a small clipped, scaled-down peek at the note's
// actual first page (real formatting/colors/fonts included) rather than a
// generic swatch. The preview page is rendered at its real design width
// (matching .note-page-body) and then scaled down with a CSS transform to
// fit whatever width the card actually ends up at in the grid - computed
// here at runtime since the grid's column count/width is responsive.
const NOTE_PAGE_DESIGN_WIDTH = 680; // matches .note-page-body's max-width
function scalePreviewFrames(container) {
  container.querySelectorAll('[data-preview-frame]').forEach((frame) => {
    const page = frame.querySelector('[data-preview-page]');
    if (!page) return;
    const scale = frame.clientWidth / NOTE_PAGE_DESIGN_WIDTH;
    page.style.transform = `scale(${scale})`;
  });
}
let previewRescaleTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(previewRescaleTimer);
  previewRescaleTimer = setTimeout(() => {
    const main = root.querySelector('#main-content');
    if (main) scalePreviewFrames(main);
  }, 120);
});

// ---------------- Favorites ----------------
async function toggleFavoriteAndRerender(type, id, currentlyFavorite) {
  const favorite = !currentlyFavorite;
  try {
    if (type === 'note') {
      await api(`/api/notes/${id}/favorite`, { method: 'PATCH', body: { favorite } });
    } else {
      await api(`/api/folders/${id}/favorite`, { method: 'PATCH', body: { favorite } });
    }
  } catch (err) {
    alert('Could not update favorite status: ' + err.message);
    return;
  }
  await refreshCurrentView();
}

function wireFavoriteStars(main) {
  main.querySelectorAll('[data-toggle-favorite]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.favoriteType;
      const id = Number(btn.dataset.favoriteId);
      const currentlyFavorite = btn.classList.contains('active');
      toggleFavoriteAndRerender(type, id, currentlyFavorite);
    });
  });
}

// ---------------- Right-click context menus ----------------
function closeContextMenu() {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  document.removeEventListener('keydown', onContextMenuKeydown);
}

function onContextMenuKeydown(e) {
  if (e.key === 'Escape') closeContextMenu();
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((item, i) => item.divider
    ? '<div class="context-menu-divider"></div>'
    : `<button class="context-menu-item ${item.danger ? 'danger' : ''}" role="menuitem" data-idx="${i}">${escapeHtml(item.label)}</button>`
  ).join('');
  document.body.appendChild(menu);

  // Clamp inside the viewport so right-clicking near an edge doesn't render
  // the menu partly (or fully) off-screen.
  const rect = menu.getBoundingClientRect();
  const clampedX = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const clampedY = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = clampedX + 'px';
  menu.style.top = clampedY + 'px';

  menu.querySelectorAll('.context-menu-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = items[Number(btn.dataset.idx)];
      closeContextMenu();
      if (item && item.onClick) item.onClick();
    });
  });

  // Close on the next click anywhere else, on Escape, or on scroll - but not
  // on the very same click that just opened it.
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { capture: true, once: true });
    document.addEventListener('contextmenu', closeContextMenu, { capture: true, once: true });
    document.addEventListener('keydown', onContextMenuKeydown);
  }, 0);
  window.addEventListener('scroll', closeContextMenu, { capture: true, once: true });
}

function noteContextMenuItems(note) {
  return [
    { label: 'Open', onClick: () => openNote(note.id) },
    { label: 'Rename', onClick: () => renameNotePrompt(note) },
    { label: note.is_favorite ? '★ Remove from Favorites' : '☆ Add to Favorites', onClick: () => toggleFavoriteAndRerender('note', note.id, !!note.is_favorite) },
    { divider: true },
    { label: 'Delete', danger: true, onClick: () => deleteNoteFromList(note.id) },
  ];
}

function folderContextMenuItems(folder) {
  return [
    { label: 'Open', onClick: () => animateMainTransition(() => selectView({ type: 'folder', id: folder.id }), 'forward') },
    { label: 'Rename', onClick: () => openFolderEditor(folder.id) },
    { label: folder.is_favorite ? '★ Remove from Favorites' : '☆ Add to Favorites', onClick: () => toggleFavoriteAndRerender('folder', folder.id, !!folder.is_favorite) },
    { divider: true },
    { label: 'Delete', danger: true, onClick: () => deleteFolder(folder.id) },
  ];
}

function renameNotePrompt(note) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Rename note</h3>
      <div class="field">
        <label for="rename-note-input">Note title</label>
        <input type="text" id="rename-note-input" value="${escapeAttr(note.title)}" placeholder="Untitled note" />
      </div>
      <div class="modal-actions">
        <button class="modal-close-btn" id="cancel-rename-note">Cancel</button>
        <button class="primary-btn" id="save-rename-note">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#rename-note-input');
  input.focus();
  input.select();

  const save = async () => {
    const title = input.value.trim() || 'Untitled note';
    overlay.remove();
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { title } });
    await refreshCurrentView();
  };

  overlay.querySelector('#cancel-rename-note').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); overlay.remove(); }
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });
  overlay.querySelector('#save-rename-note').addEventListener('click', save);
}

async function deleteNoteFromList(id) {
  if (!confirm('Delete this note? This cannot be undone.')) return;
  await api(`/api/notes/${id}`, { method: 'DELETE' });
  await refreshCurrentView();
}

// Attaches the right-click menu to a rendered note-card/folder-card element.
function wireNoteCardContextMenu(card, note) {
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, noteContextMenuItems(note));
  });
}
function wireFolderCardContextMenu(card, folder) {
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, folderContextMenuItems(folder));
  });
}

async function refreshNotesForView() {
  let query = '';
  if (view_isFolder(state.view)) query = `?folderId=${state.view.id}`;
  else if (state.view.key === 'unfiled') query = '?folderId=unfiled';
  const { notes, totalCount, limit } = await api(`/api/notes${query}`);
  state.notes = notes;
  state.noteMeta = { totalCount, limit };
}

function view_isFolder(v) { return v.type === 'folder'; }

function currentViewTitle() {
  if (state.view.type === 'folders') return 'Folders';
  if (state.view.type === 'favorites') return 'Favorites';
  if (state.view.type === 'settings') return 'Settings';
  if (state.view.type === 'smart') return state.view.key === 'all' ? 'All notes' : 'Unfiled';
  const folder = state.folders.find((f) => f.id === state.view.id);
  return folder ? folder.name : 'Folder';
}

function renderMainAsGrid() {
  const main = root.querySelector('#main-content');
  const isFolderView = state.view.type === 'folder';
  // "Move to folder" only makes sense in the two cross-folder views (All
  // notes / Unfiled) - inside a single folder's own view, reassigning is
  // still available from the note editor's own Folder dropdown.
  const allowMove = state.view.type === 'smart';
  main.innerHTML = `
    <div class="topbar">
      <h2>${escapeHtml(currentViewTitle())}</h2>
      ${isFolderView ? `<button id="back-to-folders-btn" aria-label="Back to all folders">← Back to Folders</button>` : ''}
    </div>
    ${limitBannerHtml()}
    ${state.notes.length === 0
      ? `<div class="empty-state">No notes here yet. Click "+ Note" to create one.</div>`
      : `<div class="note-grid">${state.notes.map((n) => noteCardHtml(n, { allowMove })).join('')}</div>`
    }
  `;
  main.querySelectorAll('[data-open-note]').forEach((el) => {
    el.addEventListener('click', () => openNote(Number(el.dataset.openNote)));
    const note = state.notes.find((n) => n.id === Number(el.dataset.openNote));
    if (note) wireNoteCardContextMenu(el, note);
  });
  const backBtn = main.querySelector('#back-to-folders-btn');
  if (backBtn) backBtn.addEventListener('click', () => animateMainTransition(() => selectView({ type: 'folders' }), 'back'));

  main.querySelectorAll('[data-move-note]').forEach((sel) => {
    // Stop the click/change from bubbling up to the card's own "open this
    // note" click handler - otherwise picking a folder would also open the note.
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const noteId = Number(sel.dataset.moveNote);
      const folderId = sel.value ? Number(sel.value) : null;
      await api(`/api/notes/${noteId}`, { method: 'PATCH', body: { folderId } });
      await refreshNotesForView();
      renderMainAsGrid();
    });
  });
  const upgradeBtn = main.querySelector('#dismiss-upgrade-banner');
  wireFavoriteStars(main);
  scalePreviewFrames(main);
}

function limitBannerHtml() {
  if (!state.noteMeta.limit) return '';
  if (state.noteMeta.totalCount < state.noteMeta.limit) return '';
  return `
    <div class="upgrade-banner">
      <span>You've used all ${state.noteMeta.limit} free note sets. Upgrade to Premium for unlimited notes, folders, file uploads, and AI-generated study material.</span>
    </div>
  `;
}

// ---------------- Views: folders grid ----------------
// Shown when "Folders" is selected in the sidebar - every folder as a card in
// the main panel, each tinted with the color its owner picked for it.
function renderMainAsFolderGrid() {
  const main = root.querySelector('#main-content');
  main.innerHTML = `
    <div class="topbar">
      <h2>${escapeHtml(currentViewTitle())}</h2>
      <button id="folders-new-btn">+ Folder</button>
    </div>
    ${state.folders.length === 0
      ? `<div class="empty-state">No folders yet. Click "+ Folder" to create one.</div>`
      : `<div class="folder-grid">${state.folders.map(folderCardHtml).join('')}</div>`
    }
  `;

  main.querySelectorAll('[data-open-folder-card]').forEach((el) => {
    const folderId = Number(el.dataset.openFolderCard);
    const open = () => animateMainTransition(() => selectView({ type: 'folder', id: folderId }), 'forward');
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    const folder = state.folders.find((f) => f.id === folderId);
    if (folder) wireFolderCardContextMenu(el, folder);
  });
  main.querySelectorAll('[data-edit-folder-card]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderEditor(Number(el.dataset.editFolderCard));
    });
  });
  main.querySelectorAll('[data-delete-folder-card]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder(Number(el.dataset.deleteFolderCard));
    });
  });

  const newBtn = main.querySelector('#folders-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => openFolderEditor(null));
  wireFavoriteStars(main);
}

function folderCardHtml(f) {
  const count = f.note_count || 0;
  // Icon and name/count sit side-by-side (rather than stacked) so the card
  // reads as one compact row instead of leaving a lot of empty space between
  // the icon, the text, and the actions in the corner.
  return `
    <div class="folder-card" data-open-folder-card="${f.id}" tabindex="0" role="button" aria-label="Open folder ${escapeAttr(f.name)}">
      <div class="folder-card-actions">
        <button class="card-favorite-btn ${f.is_favorite ? 'active' : ''}" type="button" data-toggle-favorite data-favorite-type="folder" data-favorite-id="${f.id}" aria-pressed="${f.is_favorite ? 'true' : 'false'}" aria-label="${f.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}" title="${f.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">★</button>
        <button class="icon-btn" data-edit-folder-card="${f.id}" title="Edit folder" aria-label="Edit folder ${escapeAttr(f.name)}">✎</button>
        <button class="icon-btn" data-delete-folder-card="${f.id}" title="Delete folder" aria-label="Delete folder ${escapeAttr(f.name)}">✕</button>
      </div>
      <div class="folder-card-main">
        ${folderIconSvg(f.color, { width: 30, height: 24, className: 'folder-card-icon' })}
        <div class="folder-card-text">
          <div class="folder-card-name">${escapeHtml(f.name)}</div>
          <div class="folder-card-meta">${count} ${count === 1 ? 'note' : 'notes'}</div>
        </div>
      </div>
    </div>
  `;
}

// ---------------- Settings ----------------
function initialsFor(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function renderMainAsSettings() {
  const main = root.querySelector('#main-content');
  const user = state.user;
  const theme = user.theme || 'system';
  const textSize = user.textSize || 'medium';
  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;
  const noteCount = state.noteMeta.totalCount || 0;
  const folderCount = state.folders.length;

  main.innerHTML = `
    <div class="topbar">
      <h2>Settings</h2>
    </div>
    <div class="settings-view">
     <div class="settings-main">

      <section class="settings-section">
        <h3>Appearance</h3>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">Theme</span>
            <span class="settings-row-desc">Choose how ScribeStack looks on this device.</span>
          </div>
          <div class="segmented" role="group" aria-label="Theme">
            <button type="button" class="segmented-btn ${theme === 'light' ? 'active' : ''}" data-theme-option="light" aria-pressed="${theme === 'light'}">Light</button>
            <button type="button" class="segmented-btn ${theme === 'dark' ? 'active' : ''}" data-theme-option="dark" aria-pressed="${theme === 'dark'}">Dark</button>
            <button type="button" class="segmented-btn ${theme === 'system' ? 'active' : ''}" data-theme-option="system" aria-pressed="${theme === 'system'}">System</button>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">Text size</span>
            <span class="settings-row-desc">Adjust the size of menus, buttons, and sidebar text.</span>
          </div>
          <div class="segmented" role="group" aria-label="Text size">
            <button type="button" class="segmented-btn ${textSize === 'small' ? 'active' : ''}" data-textsize-option="small" aria-pressed="${textSize === 'small'}">Small</button>
            <button type="button" class="segmented-btn ${textSize === 'medium' ? 'active' : ''}" data-textsize-option="medium" aria-pressed="${textSize === 'medium'}">Medium</button>
            <button type="button" class="segmented-btn ${textSize === 'large' ? 'active' : ''}" data-textsize-option="large" aria-pressed="${textSize === 'large'}">Large</button>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3>Account</h3>
        <div class="field">
          <label for="settings-name-input">Name</label>
          <input type="text" id="settings-name-input" value="${escapeAttr(user.name)}" />
        </div>
        <button class="primary-btn settings-inline-btn" id="save-name-btn">Save name</button>
        <div class="settings-status" id="name-save-status"></div>

        <h4>Change password</h4>
        <div class="field">
          <label for="settings-current-password">Current password</label>
          <input type="password" id="settings-current-password" autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="settings-new-password">New password</label>
          <input type="password" id="settings-new-password" minlength="8" autocomplete="new-password" />
        </div>
        <button class="primary-btn settings-inline-btn" id="save-password-btn">Update password</button>
        <div class="settings-status" id="password-save-status"></div>
      </section>

      <section class="settings-section">
        <h3>Plan</h3>
        <p>You're on the <strong>${user.plan === 'paid' ? 'Premium' : 'Free'}</strong> plan.</p>
        ${user.plan !== 'paid' ? '<button class="primary-btn settings-inline-btn" id="settings-upgrade-btn">Upgrade to Premium</button>' : ''}
      </section>

      <section class="settings-section settings-danger">
        <h3>Danger zone</h3>
        <p>Deleting your account permanently removes all your notes, folders, and account data. This cannot be undone.</p>
        <button type="button" class="danger-btn" id="delete-account-btn">Delete account</button>
      </section>

      <p class="settings-legal-footer">
        <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a>
        ·
        <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
      </p>

     </div>

     <aside class="settings-side">
        <div class="account-card">
          <div class="account-avatar">${escapeHtml(initialsFor(user.name))}</div>
          <div class="account-card-name">${escapeHtml(user.name)}</div>
          <div class="account-card-email">${escapeHtml(user.email)}</div>
          <span class="plan-badge">${user.plan === 'paid' ? 'Premium' : 'Free'}</span>
          <div class="account-card-divider"></div>
          <div class="account-stat-row"><span>Notes</span><strong>${noteCount}</strong></div>
          <div class="account-stat-row"><span>Folders</span><strong>${folderCount}</strong></div>
          ${memberSince ? `<div class="account-stat-row"><span>Member since</span><strong>${escapeHtml(memberSince)}</strong></div>` : ''}
        </div>

        <div class="tips-card">
          <h4>Quick tips</h4>
          <ul>
            <li>Use the search box in the sidebar to find a note by its title or by any word inside it.</li>
            <li>Give each folder its own color from the Folders tab to spot your classes at a glance.</li>
            <li>Prefer working at night? Switch to Dark theme above — your notes stay a plain white page either way.</li>
          </ul>
        </div>
     </aside>
    </div>
  `;

  main.querySelectorAll('[data-theme-option]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newTheme = btn.dataset.themeOption;
      if (newTheme === state.user.theme) return;
      await api('/api/me', { method: 'PATCH', body: { theme: newTheme } });
      state.user.theme = newTheme;
      applyDisplayPreferences();
      renderMainAsSettings();
    });
  });

  main.querySelectorAll('[data-textsize-option]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newSize = btn.dataset.textsizeOption;
      if (newSize === state.user.textSize) return;
      await api('/api/me', { method: 'PATCH', body: { textSize: newSize } });
      state.user.textSize = newSize;
      applyDisplayPreferences();
      renderMainAsSettings();
    });
  });

  main.querySelector('#save-name-btn').addEventListener('click', async () => {
    const nameInput = main.querySelector('#settings-name-input');
    const status = main.querySelector('#name-save-status');
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = 'Name cannot be empty.';
      status.className = 'settings-status settings-status-error';
      return;
    }
    try {
      await api('/api/me', { method: 'PATCH', body: { name } });
      state.user.name = name;
      const sidebarName = root.querySelector('.user-name');
      if (sidebarName) sidebarName.textContent = name;
      status.textContent = 'Saved.';
      status.className = 'settings-status settings-status-success';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status settings-status-error';
    }
  });

  main.querySelector('#save-password-btn').addEventListener('click', async () => {
    const currentInput = main.querySelector('#settings-current-password');
    const newInput = main.querySelector('#settings-new-password');
    const status = main.querySelector('#password-save-status');
    if (!newInput.value || newInput.value.length < 8) {
      status.textContent = 'New password must be at least 8 characters.';
      status.className = 'settings-status settings-status-error';
      return;
    }
    try {
      await api('/api/me/password', {
        method: 'POST',
        body: { currentPassword: currentInput.value, newPassword: newInput.value },
      });
      currentInput.value = '';
      newInput.value = '';
      status.textContent = 'Password updated.';
      status.className = 'settings-status settings-status-success';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status settings-status-error';
    }
  });

  const upgradeBtn = main.querySelector('#settings-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', () => showUpgradeModal());
  }

  main.querySelector('#delete-account-btn').addEventListener('click', () => openDeleteAccountModal());
}

function openDeleteAccountModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card folder-editor-card">
      <h3>Delete your account?</h3>
      <p>This permanently deletes all your notes, folders, and account data. This cannot be undone.</p>
      <div class="field">
        <label for="delete-account-password">Enter your password to confirm</label>
        <input type="password" id="delete-account-password" autocomplete="current-password" />
      </div>
      <div class="form-error hidden" id="delete-account-error"></div>
      <div class="modal-actions">
        <button class="modal-close-btn" id="cancel-delete-account">Cancel</button>
        <button type="button" class="danger-btn" id="confirm-delete-account">Delete my account</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const passwordInput = overlay.querySelector('#delete-account-password');
  passwordInput.focus();

  overlay.querySelector('#cancel-delete-account').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); overlay.remove(); }
  });

  overlay.querySelector('#confirm-delete-account').addEventListener('click', async () => {
    const errorEl = overlay.querySelector('#delete-account-error');
    try {
      await api('/api/me', { method: 'DELETE', body: { password: passwordInput.value } });
      state.user = null;
      overlay.remove();
      renderAuth(null, 'signup');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}

// ---------------- Search ----------------
async function performSearch(query) {
  // Drop the active highlight in the sidebar right away - search spans every
  // folder, so no single nav item should look "selected" while it's active.
  root.querySelectorAll('.smart-item.active').forEach((el) => el.classList.remove('active'));

  const { notes } = await api(`/api/notes/search?q=${encodeURIComponent(query)}`);
  state.searchResults = notes;
  renderMainAsSearchResults(query);
}

function exitSearch() {
  state.searchResults = null;
  renderSidebarNav(); // restores the correct active highlight for the current view
  renderMainAsGrid();
}

function renderMainAsSearchResults(query) {
  const main = root.querySelector('#main-content');
  const notes = state.searchResults || [];
  main.innerHTML = `
    <div class="topbar">
      <h2>Search results for "${escapeHtml(query)}"</h2>
    </div>
    ${notes.length === 0
      ? `<div class="empty-state">No notes match "${escapeHtml(query)}".</div>`
      : `<div class="note-grid">${notes.map((n) => noteCardHtml(n, { showFolder: true })).join('')}</div>`
    }
  `;
  main.querySelectorAll('[data-open-note]').forEach((el) => {
    el.addEventListener('click', () => openNote(Number(el.dataset.openNote)));
    const note = notes.find((n) => n.id === Number(el.dataset.openNote));
    if (note) wireNoteCardContextMenu(el, note);
  });
  wireFavoriteStars(main);
  scalePreviewFrames(main);
}

// ---------------- Views: favorites ----------------
// Starred notes and folders shown together in one grid, most recently
// favorited first - the "Favorites" nav tab.
function renderMainAsFavorites() {
  const main = root.querySelector('#main-content');
  const folders = state.favoriteFolders || [];
  const notes = state.favoriteNotes || [];
  const combined = [
    ...folders.map((f) => ({ kind: 'folder', item: f, sortKey: f.favorited_at || f.created_at || '' })),
    ...notes.map((n) => ({ kind: 'note', item: n, sortKey: n.favorited_at || n.updated_at || '' })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

  main.innerHTML = `
    <div class="topbar">
      <h2>${escapeHtml(currentViewTitle())}</h2>
    </div>
    ${combined.length === 0
      ? `<div class="empty-state">No favorites yet. Right-click - or tap the star on - any note or folder to add it here.</div>`
      : `<div class="note-grid">${combined.map((c) => c.kind === 'folder' ? folderCardHtml(c.item) : noteCardHtml(c.item, { allowMove: false, showFolder: true })).join('')}</div>`
    }
  `;

  main.querySelectorAll('[data-open-note]').forEach((el) => {
    el.addEventListener('click', () => openNote(Number(el.dataset.openNote)));
    const note = notes.find((n) => n.id === Number(el.dataset.openNote));
    if (note) wireNoteCardContextMenu(el, note);
  });
  main.querySelectorAll('[data-open-folder-card]').forEach((el) => {
    const folderId = Number(el.dataset.openFolderCard);
    const open = () => animateMainTransition(() => selectView({ type: 'folder', id: folderId }), 'forward');
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    const folder = folders.find((f) => f.id === folderId);
    if (folder) wireFolderCardContextMenu(el, folder);
  });
  main.querySelectorAll('[data-edit-folder-card]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderEditor(Number(el.dataset.editFolderCard));
    });
  });
  main.querySelectorAll('[data-delete-folder-card]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder(Number(el.dataset.deleteFolderCard));
    });
  });

  wireFavoriteStars(main);
  scalePreviewFrames(main);
}

function noteCardHtml(note, opts = {}) {
  const updated = new Date(note.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const templateInfo = state.templates.find((t) => t.id === note.template);
  // Skip the plain-text folder label when the interactive move-select is
  // shown instead - the select already conveys the current folder, showing
  // both would just be redundant.
  let folderLabel = '';
  if (opts.showFolder && !opts.allowMove) {
    const folder = note.folder_id ? state.folders.find((f) => f.id === note.folder_id) : null;
    folderLabel = ' · ' + escapeHtml(folder ? folder.name : 'Unfiled');
  }
  const moveControl = opts.allowMove ? `
    <select class="note-card-move-select" data-move-note="${note.id}" aria-label="Move '${escapeAttr(note.title)}' to a folder">
      <option value="" ${!note.folder_id ? 'selected' : ''}>Unfiled</option>
      ${state.folders.map((f) => `<option value="${f.id}" ${note.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
    </select>
  ` : '';
  // A small clipped, scaled-down peek at the note's real first page (actual
  // formatting/colors/fonts, not a generic swatch) - see scalePreviewFrames().
  const previewInner = note.previewHtml || '';
  return `
    <div class="note-card" data-open-note="${note.id}">
      <button class="card-favorite-btn note-card-favorite-btn ${note.is_favorite ? 'active' : ''}" type="button" data-toggle-favorite data-favorite-type="note" data-favorite-id="${note.id}" aria-pressed="${note.is_favorite ? 'true' : 'false'}" aria-label="${note.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}" title="${note.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">★</button>
      <div class="note-card-preview-frame" data-preview-frame>
        <div class="note-card-preview-page template-${note.template || 'blank'}" data-preview-page>${previewInner}</div>
      </div>
      <div class="note-card-title">${escapeHtml(note.title)}</div>
      <div class="note-card-meta">Updated ${updated}${templateInfo ? ' · ' + escapeHtml(templateInfo.label) : ''}${folderLabel}</div>
      ${moveControl}
    </div>
  `;
}

// ---------------- Folder actions ----------------
function createFolder() {
  openFolderEditor(null);
}

// One modal handles both creating a new folder and editing an existing one
// (name + a swatch of 10 colors to pick from for organizing folders visually).
function openFolderEditor(folderId) {
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : null;
  let selectedColor = folder ? folder.color : (state.folderColors[0] ? state.folderColors[0].key : 'amber');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card folder-editor-card">
      <h3>${folder ? 'Edit folder' : 'New folder'}</h3>
      <div class="field">
        <label for="folder-name-input">Folder name</label>
        <input type="text" id="folder-name-input" value="${escapeAttr(folder ? folder.name : '')}" placeholder="e.g. Biology 101" />
      </div>
      <div class="field">
        <span class="field-label" id="folder-color-label">Color</span>
        <div class="folder-color-grid" role="group" aria-labelledby="folder-color-label">
          ${state.folderColors.map((c) => `
            <button type="button" class="folder-color-swatch ${c.key === selectedColor ? 'selected' : ''}"
              data-color="${c.key}" style="background:${c.fill}; border: 2px solid ${c.stroke};"
              aria-label="${c.label}" aria-pressed="${c.key === selectedColor}"></button>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-close-btn" id="cancel-folder-editor">Cancel</button>
        <button class="primary-btn" id="save-folder-editor">${folder ? 'Save' : 'Create'}</button>
      </div>
      ${folder ? '<button class="link-btn folder-editor-delete" id="delete-folder-in-editor">Delete this folder</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#folder-name-input');
  nameInput.focus();

  overlay.querySelectorAll('.folder-color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedColor = btn.dataset.color;
      overlay.querySelectorAll('.folder-color-swatch').forEach((b) => {
        const isSelected = b === btn;
        b.classList.toggle('selected', isSelected);
        b.setAttribute('aria-pressed', String(isSelected));
      });
    });
  });

  overlay.querySelector('#cancel-folder-editor').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  // Stop Escape here so this modal closes instead of the global handler
  // reaching past it to the highlighter popover / mobile sidebar.
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); overlay.remove(); }
  });

  if (folder) {
    overlay.querySelector('#delete-folder-in-editor').addEventListener('click', async () => {
      overlay.remove();
      await deleteFolder(folder.id);
    });
  }

  overlay.querySelector('#save-folder-editor').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (folder) {
      const { folder: updated } = await api(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name, color: selectedColor } });
      state.folders = state.folders.map((f) => (f.id === folder.id ? updated : f));
    } else {
      const { folder: created } = await api('/api/folders', { method: 'POST', body: { name, color: selectedColor } });
      state.folders.push(created);
      state.folders.sort((a, b) => a.name.localeCompare(b.name));
    }
    overlay.remove();
    if (state.view.type === 'folders') renderMainAsFolderGrid();
    if (state.view.type === 'folder' && folder && state.view.id === folder.id) renderMainAsGrid();
    // Favorites pulls folders from its own separately-fetched list
    // (state.favoriteFolders), so a synchronous re-render here would still
    // show the old name - re-fetch instead of just re-rendering.
    if (state.view.type === 'favorites') await refreshCurrentView();
  });
}

async function deleteFolder(id) {
  if (!confirm('Delete this folder? Notes inside will move to Unfiled, not be deleted.')) return;
  await api(`/api/folders/${id}`, { method: 'DELETE' });
  state.folders = state.folders.filter((f) => f.id !== id);
  if (state.view.type === 'folder' && state.view.id === id) {
    await selectView({ type: 'smart', key: 'all' });
  } else if (state.view.type === 'folders') {
    renderMainAsFolderGrid();
  } else if (state.view.type === 'favorites') {
    await refreshCurrentView();
  }
}

// ---------------- Note actions ----------------
function createNote() {
  // Check the note-limit up front so we don't make someone pick a template
  // just to be told no right after.
  if (state.noteMeta.limit && state.noteMeta.totalCount >= state.noteMeta.limit) {
    showUpgradeModal(`Free plan is limited to ${state.noteMeta.limit} note sets. Upgrade to Premium for unlimited notes.`);
    return;
  }
  showTemplatePicker();
}

function showTemplatePicker() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card template-picker-card">
      <h3>Choose a page style</h3>
      <div class="template-options">
        ${state.templates.map((t) => `
          <button class="template-option ${t.locked ? 'locked' : ''}" data-template="${t.id}" ${t.locked ? 'disabled' : ''}>
            <div class="template-preview template-preview-${t.id}"></div>
            <span class="template-option-label">${escapeHtml(t.label)}</span>
            ${t.locked ? '<span class="template-lock-badge">Premium</span>' : ''}
          </button>
        `).join('')}
      </div>
      <button class="modal-close-btn" id="cancel-template-picker">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.template-option:not(.locked)').forEach((btn) => {
    btn.addEventListener('click', async () => {
      overlay.remove();
      await createNoteWithTemplate(btn.dataset.template);
    });
  });
  overlay.querySelectorAll('.template-option.locked').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlay.remove();
      showUpgradeModal('More page styles are coming with Premium.');
    });
  });
  overlay.querySelector('#cancel-template-picker').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function createNoteWithTemplate(template) {
  const folderId = view_isFolder(state.view) ? state.view.id : null;
  try {
    const { note } = await api('/api/notes', { method: 'POST', body: { title: 'Untitled note', folderId, template } });
    await openNote(note.id);
  } catch (err) {
    if (err.code === 'NOTE_LIMIT_REACHED' || err.code === 'TEMPLATE_LOCKED') {
      showUpgradeModal(err.message);
    } else {
      alert(err.message);
    }
  }
}

async function openNote(id, opts = {}) {
  const direction = opts.direction || 'forward';
  await animateMainTransition(async () => {
    const { note } = await api(`/api/notes/${id}`);
    state.currentNote = note;
    renderEditor();
  }, direction);
}

function renderEditor() {
  const main = root.querySelector('#main-content');
  const note = state.currentNote;
  state.lastFocusedPage = null;
  state.savedRange = null;

  resetPendingFormat();
  state.pendingMarkerEl = null;

  // The editor has its own sidebar-collapse toggle (below) - hide the
  // standalone expand handle so the two controls don't both show at once.
  // renderShell() doesn't re-run just to open a note, so this has to be set
  // explicitly here rather than only in renderShell()'s own template.
  const expandHandle = root.querySelector('#sidebar-expand-handle');
  if (expandHandle) expandHandle.classList.remove('visible');

  main.innerHTML = `
    <div class="editor-view">
      <div class="topbar">
        <div class="topbar-title-group">
          <button id="sidebar-toggle-btn" class="sidebar-toggle-btn" aria-label="${state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}" title="${state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}">${state.sidebarCollapsed ? '›' : '‹'}</button>
          <h2>Editing note</h2>
          <span class="page-count" id="page-count"></span>
        </div>
        <button id="back-to-grid" aria-label="Back to notes">← Back</button>
      </div>
      <div class="editor-toolbar">
        <button data-cmd="bold" aria-label="Bold"><b>B</b></button>
        <button data-cmd="italic" aria-label="Italic"><i>I</i></button>
        <button data-cmd="underline" aria-label="Underline"><u>U</u></button>
        <div class="highlight-picker" id="highlight-picker">
          <button id="highlight-toggle" type="button" title="Highlighter" aria-label="Highlighter color" aria-haspopup="true" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.5 11.5 L12.5 3.5 L16.5 7.5 L8.5 15.5 L4.5 15.5 Z" fill="#e3e6f0" stroke="#8a8fa3" stroke-width="1"/>
              <path d="M12.5 3.5 L16.5 7.5" stroke="#6b6f80" stroke-width="1"/>
              <rect x="2" y="15.5" width="14" height="2.6" rx="1" fill="#fff2a8" stroke="#c9b95a" stroke-width="0.6"/>
            </svg>
          </button>
          <div class="highlight-popover hidden" id="highlight-popover">
            ${HIGHLIGHT_COLORS.map((c) => `
              <button class="highlight-swatch ${c.value === 'transparent' ? 'highlight-swatch-none' : ''}" data-highlight="${c.value}" title="Highlight: ${c.label}" aria-label="Highlight: ${c.label}" style="${c.value === 'transparent' ? '' : `background:${c.value}`}">${c.value === 'transparent' ? '✕' : ''}</button>
            `).join('')}
          </div>
        </div>
        <select id="font-select" aria-label="Font">
          ${FONT_OPTIONS.map((f) => `<option value="${f.value}" style="font-family:${f.value}">${f.label}</option>`).join('')}
        </select>
        <select id="size-select" aria-label="Text size">
          ${TEXT_SIZE_OPTIONS.map((s) => `<option value="${s.px}" ${s.label === 'Normal' ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
        <select id="template-select" aria-label="Page template">
          ${state.templates.map((t) => `<option value="${t.id}" ${note.template === t.id ? 'selected' : ''} ${t.locked ? 'disabled' : ''}>${escapeHtml(t.label)}${t.locked ? ' (Premium)' : ''}</option>`).join('')}
        </select>
        <div class="toolbar-spacer"></div>
        <select id="folder-select" aria-label="Folder">
          <option value="">Unfiled</option>
          ${state.folders.map((f) => `<option value="${f.id}" ${note.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
        <button id="delete-note-btn" aria-label="Delete note">Delete</button>
      </div>
      <input type="text" class="note-title-input" id="note-title" value="${escapeAttr(note.title)}" placeholder="Untitled note" aria-label="Note title" />
      <div class="page-stack" id="page-stack"></div>
      <div class="save-status" id="save-status">Saved</div>
    </div>
  `;

  document.execCommand('defaultParagraphSeparator', false, 'div');

  // Restore pages: content_html is stored as a JSON array of per-page HTML.
  // Older notes saved before pagination existed just have raw HTML - treat that as page 1.
  let pageContents;
  try {
    const parsed = JSON.parse(note.content_html);
    pageContents = Array.isArray(parsed) && parsed.length > 0 ? parsed : [''];
  } catch (e) {
    pageContents = [note.content_html || ''];
  }

  const stack = root.querySelector('#page-stack');
  pageContents.forEach((html) => {
    const page = createPageElement(note.template);
    page.querySelector('.note-page-body').innerHTML = html;
    stack.appendChild(page);
  });
  renumberPages();
  // Legacy/overlong notes may already exceed one page's worth of content - split them now.
  rebalancePages();

  root.querySelector('#sidebar-toggle-btn').addEventListener('click', () => toggleSidebar());

  root.querySelector('#back-to-grid').addEventListener('click', async () => {
    await animateMainTransition(async () => {
      // If the note was opened from a search result, go back to those results
      // (re-run the search so any edits, like a renamed title, show up correctly).
      if (state.searchResults !== null && state.searchQuery.trim()) {
        renderShell();
        await performSearch(state.searchQuery.trim());
        return;
      }
      // Otherwise return to whichever list view the note was opened from -
      // selectView() already knows how to re-fetch and render All notes,
      // Unfiled, a specific folder, or Favorites correctly.
      await selectView(state.view);
    }, 'back');
  });

  // Clicking any toolbar control naturally moves keyboard focus to that
  // control first (that's just how the browser handles clicking a <button>),
  // and doing that can disturb - or even collapse - wherever the cursor was
  // sitting in the note a moment ago, before our own click handler even
  // gets a chance to run and put it back. Blocking that default "focus me"
  // step on mousedown (not click - the click itself still needs to fire
  // normally) keeps the note's cursor position completely undisturbed the
  // whole time, which is what let the cursor visibly jump to wherever the
  // last typed text was before this fix.
  main.querySelectorAll('.editor-toolbar button').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
  });

  main.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      focusLastPage();
      const hadSelection = hasRealSelection();
      if (hadSelection) {
        // Text is already selected - format it directly, same as before.
        document.execCommand(btn.dataset.cmd, false, null);
        handlePageInput();
      } else {
        // Nothing selected, just a blinking cursor - toggle this as a
        // pending format that applies to whatever gets typed next.
        state.pendingFormat[btn.dataset.cmd] = !state.pendingFormat[btn.dataset.cmd];
        applyPendingFormatMarker();
      }
      updateToolbarActiveStates();
    });
  });

  const highlightPopover = root.querySelector('#highlight-popover');
  const highlightToggleBtn = root.querySelector('#highlight-toggle');
  highlightToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowOpen = highlightPopover.classList.toggle('hidden') === false;
    highlightToggleBtn.setAttribute('aria-expanded', String(nowOpen));
  });

  main.querySelectorAll('[data-highlight]').forEach((btn) => {
    btn.addEventListener('click', () => {
      focusLastPage();
      const hadSelection = hasRealSelection();
      if (hadSelection) {
        document.execCommand('backColor', false, btn.dataset.highlight);
        handlePageInput();
      } else {
        // Keep 'transparent' as an explicit stored value here (never
        // convert it to null) - same reasoning as bold/italic/underline
        // above: this needs to distinguish "explicitly cleared the
        // highlight" from "never touched the highlighter at all", so it
        // correctly overrides any highlighted ancestor left over from
        // earlier text instead of silently inheriting it.
        state.pendingFormat.highlight = btn.dataset.highlight;
        applyPendingFormatMarker();
        updateToolbarActiveStates();
      }
      highlightPopover.classList.add('hidden');
    });
  });

  // A <select> has to actually receive keyboard focus to open its native
  // dropdown - unlike the buttons above, that focus move can't be blocked.
  // That shift is exactly when the browser's own selection bookkeeping gets
  // least predictable (see focusLastPage()'s notes on state.savedRange
  // lagging behind). So rather than asking "was text selected?" once the
  // 'change' event finally fires - by then the answer can no longer be
  // trusted - each select captures that answer as early as possible instead:
  // on 'mousedown' for a mouse click, or 'focus' for a keyboard-driven Tab
  // into it (whichever fires first - either way, before the browser has
  // touched focus or selection at all) - and 'change' just reads back
  // whatever was captured then.
  const fontSelectEl = root.querySelector('#font-select');
  let fontSelectHadSelection = false;
  const captureFontSelection = () => { fontSelectHadSelection = hasRealSelection(); };
  fontSelectEl.addEventListener('mousedown', captureFontSelection);
  fontSelectEl.addEventListener('focus', captureFontSelection);
  fontSelectEl.addEventListener('change', (e) => {
    focusLastPage();
    const hadSelection = fontSelectHadSelection;
    if (hadSelection) {
      document.execCommand('fontName', false, e.target.value);
      handlePageInput();
    } else {
      state.pendingFormat.fontFamily = e.target.value;
      applyPendingFormatMarker();
    }
  });

  // Text size works the same way the highlighter does: select some text
  // first, then pick a size. Under the hood, execCommand's fontSize only
  // understands the old HTML "1 through 7" scale, not real pixel sizes, so
  // size 7 is used purely as a marker to wrap the selection, then swapped
  // for a precise pixel value right after. With nothing selected, the same
  // pending-format marker mechanism used by Bold/Italic/etc handles it instead.
  const sizeSelectEl = root.querySelector('#size-select');
  let sizeSelectHadSelection = false;
  const captureSizeSelection = () => { sizeSelectHadSelection = hasRealSelection(); };
  sizeSelectEl.addEventListener('mousedown', captureSizeSelection);
  sizeSelectEl.addEventListener('focus', captureSizeSelection);
  sizeSelectEl.addEventListener('change', (e) => {
    focusLastPage();
    const hadSelection = sizeSelectHadSelection;
    const px = e.target.value;
    if (hadSelection) {
      document.execCommand('fontSize', false, '7');
      const pageBody = state.lastFocusedPage;
      if (pageBody) {
        pageBody.querySelectorAll('font[size="7"]').forEach((el) => {
          el.removeAttribute('size');
          el.style.fontSize = px + 'px';
        });
      }
      handlePageInput();
    } else {
      state.pendingFormat.fontSize = px;
      applyPendingFormatMarker();
    }
  });

  root.querySelector('#folder-select').addEventListener('change', async (e) => {
    const folderId = e.target.value ? Number(e.target.value) : null;
    await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { folderId } });
    state.currentNote.folder_id = folderId;
  });

  root.querySelector('#template-select').addEventListener('change', async (e) => {
    const newTemplate = e.target.value;
    try {
      await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { template: newTemplate } });
      state.currentNote.template = newTemplate;
      root.querySelectorAll('.note-page-body').forEach((body) => {
        body.className = `note-page-body template-${newTemplate}`;
      });
    } catch (err) {
      if (err.code === 'TEMPLATE_LOCKED') {
        showUpgradeModal(err.message);
        e.target.value = note.template; // revert the dropdown
      } else {
        alert(err.message);
      }
    }
  });

  root.querySelector('#delete-note-btn').addEventListener('click', async () => {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    await api(`/api/notes/${note.id}`, { method: 'DELETE' });
    await refreshNotesForView();
    renderShell();
    renderMainAsGrid();
  });

  root.querySelector('#note-title').addEventListener('input', () => {
    const status = root.querySelector('#save-status');
    if (status) status.textContent = 'Saving…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveCurrentNote, 600);
  });
}

// Restore focus + the last known cursor position to whichever page the user was last in.
// Needed because clicking a toolbar button/select moves focus away from the page itself.
function focusLastPage() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  if (!state.lastFocusedPage || !stack.contains(state.lastFocusedPage)) {
    state.lastFocusedPage = stack.querySelector('.note-page-body');
  }
  if (!state.lastFocusedPage) return;

  // If the browser's own live selection is already sitting somewhere valid
  // inside the note (e.g. text the user just highlighted, or a cursor
  // position that's still intact), leave it completely alone rather than
  // overwriting it with state.savedRange - that saved snapshot is only
  // updated by the 'selectionchange' event, which doesn't always fire
  // immediately, so right after selecting text and clicking a toolbar
  // control, the live selection can already be correct while the saved
  // snapshot is still a beat behind. Blindly trusting the (stale) snapshot
  // here would silently replace a perfectly good real selection.
  const sel = window.getSelection();
  const liveRangeOk = sel.rangeCount > 0 && stack.contains(sel.getRangeAt(0).startContainer);

  // preventScroll: focusing an element the browser doesn't consider already
  // "in view" can otherwise trigger its own scroll-into-view behavior,
  // which - on a note with enough content to scroll - could visibly yank
  // the page back to the top of that block right as a toolbar button is
  // clicked, even though the cursor position itself is about to be restored
  // correctly right below.
  state.lastFocusedPage.focus({ preventScroll: true });

  if (liveRangeOk) return;

  if (state.savedRange && stack.contains(state.savedRange.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(state.savedRange);
  }
}

function createPageElement(template) {
  const page = document.createElement('div');
  page.className = 'note-page';
  page.innerHTML = `
    <div class="note-page-body template-${template}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note content"></div>
    <div class="note-page-number"></div>
  `;
  const body = page.querySelector('.note-page-body');
  body.addEventListener('input', handlePageInput);
  return page;
}

function renumberPages() {
  const pages = root.querySelectorAll('#page-stack .note-page');
  pages.forEach((page, i) => {
    page.querySelector('.note-page-number').textContent = `Page ${i + 1} of ${pages.length}`;
  });
  const countEl = root.querySelector('#page-count');
  if (countEl) countEl.textContent = pages.length === 1 ? '1 page' : `${pages.length} pages`;
}

// The core auto-pagination logic: push overflowing content forward onto new
// pages as they fill up, and drop empty trailing pages once content shrinks
// back down (e.g. after deleting text). Always leaves at least one page.
function rebalancePages() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  let pages = Array.from(stack.querySelectorAll('.note-page-body'));
  const template = state.currentNote.template;

  // Preserve the caret across any node moves below.
  const sel = window.getSelection();
  let anchorNode = null, anchorOffset = 0;
  if (sel && sel.rangeCount > 0 && stack.contains(sel.getRangeAt(0).startContainer)) {
    anchorNode = sel.getRangeAt(0).startContainer;
    anchorOffset = sel.getRangeAt(0).startOffset;
  }

  let guard = 0;
  const MAX_MOVES = 3000;

  for (let i = 0; i < pages.length && guard < MAX_MOVES; i++) {
    const page = pages[i];
    while (page.scrollHeight > page.clientHeight + 1 && page.childNodes.length > 0 && guard < MAX_MOVES) {
      guard++;
      let next = pages[i + 1];
      if (!next) {
        const pageEl = createPageElement(template);
        stack.appendChild(pageEl);
        next = pageEl.querySelector('.note-page-body');
        pages.push(next);
      }
      next.insertBefore(page.lastChild, next.firstChild);
    }
  }

  // Drop empty trailing pages, but never the page the user is actively in, and
  // always keep at least one page total.
  for (let i = pages.length - 1; i > 0; i--) {
    const page = pages[i];
    const isEmpty = page.childNodes.length === 0 || page.textContent.trim() === '';
    if (isEmpty && page !== state.lastFocusedPage) {
      page.closest('.note-page').remove();
      pages.pop();
    } else {
      break;
    }
  }

  renumberPages();

  if (anchorNode && document.contains(anchorNode)) {
    const maxOffset = anchorNode.nodeType === 3 ? anchorNode.textContent.length : anchorNode.childNodes.length;
    const r = document.createRange();
    r.setStart(anchorNode, Math.min(anchorOffset, maxOffset));
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

function handlePageInput() {
  // A short debounce lets fast bursts of typing (or a paste) settle into a stable
  // DOM shape before we split content across pages - reacting on every single
  // keystroke can catch the browser mid-way through normalizing a new line.
  clearTimeout(state.rebalanceTimer);
  state.rebalanceTimer = setTimeout(rebalancePages, 150);

  const status = root.querySelector('#save-status');
  if (status) status.textContent = 'Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentNote, 600);
}

async function saveCurrentNote() {
  if (!state.currentNote) return;
  const title = root.querySelector('#note-title')?.value ?? state.currentNote.title;
  const pageBodies = root.querySelectorAll('.note-page-body');
  const contentHtml = pageBodies.length
    ? JSON.stringify(Array.from(pageBodies).map((b) => b.innerHTML))
    : state.currentNote.content_html;
  try {
    await api(`/api/notes/${state.currentNote.id}`, { method: 'PATCH', body: { title, contentHtml } });
    const status = root.querySelector('#save-status');
    if (status) status.textContent = 'Saved';
  } catch (err) {
    const status = root.querySelector('#save-status');
    if (status) status.textContent = 'Could not save: ' + err.message;
  }
}

// ---------------- Upgrade modal ----------------
function showUpgradeModal(message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Upgrade to Premium</h3>
      <p>${escapeHtml(message || "You've reached the free plan limit.")}</p>
      <ul>
        <li>Unlimited notes &amp; folders</li>
        <li>Full formatting toolkit</li>
        <li>Upload &amp; download files</li>
        <li>AI-generated flashcards, quizzes &amp; tests</li>
      </ul>
      <p style="font-size:12px;color:var(--text-muted)">(Payments aren't wired up yet — this is a placeholder for the paid tier.)</p>
      <button class="modal-close-btn" id="close-modal">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#close-modal').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ---------------- Utils ----------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

boot();
