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
  lastFocusedPage: null, // the .note-page-body (or .textbox-content) element the toolbar should act on
  savedRange: null,      // last known selection/cursor position inside a page
  textBoxPlacementActive: false, // true right after clicking the toolbar's text-box tool, until the next click on a page places one
  drawModeActive: false, // true while the draw tool is armed - pages accept pencil/marker/eraser strokes instead of clicks-to-place-cursor
  drawTool: 'pencil', // 'pencil' | 'marker' | 'eraser'
  lastPenTool: 'pencil', // 'pencil' | 'marker' - whichever the pen combo button should show/use when eraser is currently selected
  drawColor: '#1f2130', // hex, shared by pencil + marker (eraser ignores it)
  drawHue: 233, drawSat: 0.354, drawVal: 0.188, // the color wheel's own H/S/V (0-360, 0-1, 0-1) - equivalent to drawColor's #1f2130 default
  drawSettings: {
    pencil: { width: 3, opacity: 100 },
    marker: { width: 16, opacity: 45 },
    eraser: { width: 20, opacity: 100 },
  },
  lastDrawnPage: null, // the .note-page a stroke was most recently drawn on - the target for Undo/Redo
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
  // A text box's own contenteditable content area counts as an editable
  // region too, exactly like a page body - so the formatting toolbar keeps
  // working normally while typing inside one.
  const pageBody = node && node.closest ? node.closest('.note-page-body, .textbox-content') : null;
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

// Close the highlighter color popover and the Lists dropdown when clicking
// anywhere outside them. Queries the live DOM each time (rather than closing
// over a stale element) since the editor gets re-rendered every time a note
// is opened.
document.addEventListener('click', (e) => {
  const popover = document.getElementById('highlight-popover');
  if (popover && !popover.classList.contains('hidden') && !e.target.closest('.highlight-picker')) {
    popover.classList.add('hidden');
  }
  const listPopover = document.getElementById('list-popover');
  if (listPopover && !listPopover.classList.contains('hidden') && !e.target.closest('.list-picker')) {
    listPopover.classList.add('hidden');
    const listToggleBtn = document.getElementById('list-toggle');
    if (listToggleBtn) listToggleBtn.setAttribute('aria-expanded', 'false');
  }
});

// Let keyboard users dismiss the highlighter popover, the Lists dropdown, and
// the mobile sidebar drawer with Escape, same as clicking outside them with
// a mouse.
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
  const listPopover = document.getElementById('list-popover');
  if (listPopover && !listPopover.classList.contains('hidden')) {
    listPopover.classList.add('hidden');
    const listToggleBtn = document.getElementById('list-toggle');
    if (listToggleBtn) {
      listToggleBtn.setAttribute('aria-expanded', 'false');
      listToggleBtn.focus();
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

// ---------------- Icon set ----------------
// One small inline-SVG library standing in for every emoji glyph the UI used
// to lean on (★ ✕ 🗑 📄 ✏️ etc). Every icon shares the same line-art
// language - stroke="currentColor", round caps/joins, no fixed color of its
// own - so each one just inherits whatever color/hover state its button
// already had, the same way the pre-existing highlighter and Pages-panel
// icons (elsewhere in this file) always worked. viewBox is 0 0 20 20 unless
// noted; callers set the actual pixel size via width/height on the button
// or a wrapping span.
const ICONS = {
  menu: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  starOutline: '<svg width="14" height="14" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 2.6l2.24 4.54 5.01.73-3.63 3.53.86 4.99L10 13.98l-4.48 2.41.86-4.99-3.63-3.53 5.01-.73Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  starFilled: '<svg width="14" height="14" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 2.6l2.24 4.54 5.01.73-3.63 3.53.86 4.99L10 13.98l-4.48 2.41.86-4.99-3.63-3.53 5.01-.73Z" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  gear: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="10" cy="10" r="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M10 3.3v2M10 14.7v2M16.7 10h-2M5.3 10h-2M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4M14.9 14.9l-1.4-1.4M6.5 6.5 5.1 5.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 6.2h12M7.8 6.2V4.6c0-.6.5-1.1 1.1-1.1h2.2c.6 0 1.1.5 1.1 1.1v1.6M5.4 6.2l.6 9.3c.05.9.8 1.6 1.7 1.6h4.6c.9 0 1.65-.7 1.7-1.6l.6-9.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.3 9.1v5M11.7 9.1v5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  arrowLeft: '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.5 4.5 6 10l6.5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pencilEdit: '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.4 3.4 16.6 6.6 7.2 16 3.5 17l1-3.7 8.9-9.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.6 5.2l3.2 3.2" stroke="currentColor" stroke-width="1.25"/></svg>',
  close: '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  textbox: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M7 8.3h6M7 11.1h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  filePlus: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 2.5h5.3L15 6.2v11.3a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11 2.5v3.5a.7.7 0 0 0 .7.7H15" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8 12.6h4M10 10.6v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  drawToggle: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.7 3.3 16.7 6.3 7 16l-3.7 1 1-3.7 9.4-10Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.8 5.2l3 3" stroke="currentColor" stroke-width="1.25"/></svg>',
  pencilTool: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.7 3.3 16.7 6.3 7 16l-3.7 1 1-3.7 9.4-10Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.8 5.2l3 3" stroke="currentColor" stroke-width="1.25"/></svg>',
  markerTool: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8.2 16.5 4.2 15l1-3.3 6.9-7.4 3.6 3.4-6.9 7.4Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M12.1 4.3 14.3 2.4a1.5 1.5 0 0 1 2.1.1l.9.85a1.5 1.5 0 0 1 0 2.1l-1.9 2.05" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
  eraserTool: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.9 3.6 16.4 7.1a1.5 1.5 0 0 1 0 2.1l-6.5 6.5H5.7l-2.2-2.2v-2.2l7.3-7.3a1.5 1.5 0 0 1 2.1 0Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.3 6.9 14.1 11.7" stroke="currentColor" stroke-width="1.1"/><path d="M5.7 15.7H16" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  undo: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5.3 8H12a4 4 0 0 1 0 8H8.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8.3 4.5 4.8 8l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  redo: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14.7 8H8a4 4 0 0 0 0 8h3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M11.7 4.5l3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronUp: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 12.5 10 7.5 15 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronDown: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  caretDownSmall: '<svg width="9" height="9" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grip: '<svg width="9" height="15" viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.4"/><circle cx="7.5" cy="2.5" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13.5" r="1.4"/><circle cx="7.5" cy="13.5" r="1.4"/></svg>',
  eyedropper: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.75 3.15a2.25 2.25 0 0 1 3.1 3.1l-1.95 1.95-3.1-3.1 1.95-1.95Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M13.9 8.1 6.2 15.8l-3 .7.7-3L11.6 5.8" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
  plus: '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  lock: '<svg width="8" height="8" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8.5" rx="1.3" fill="currentColor"/><path d="M6.7 9V6.3a3.3 3.3 0 0 1 6.6 0V9" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 3v9M6.5 9 10 12.5 13.5 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14.5v1.8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  listBullet: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="3" cy="5" r="1.3" fill="currentColor"/><circle cx="3" cy="10" r="1.3" fill="currentColor"/><circle cx="3" cy="15" r="1.3" fill="currentColor"/><path d="M7.5 5h9M7.5 10h9M7.5 15h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  listDash: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.3 5h3.4M1.3 10h3.4M1.3 15h3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7.5 5h9M7.5 10h9M7.5 15h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  listNumber: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><text x="0" y="6.8" font-size="5.2" fill="currentColor" font-family="Helvetica, Arial, sans-serif">1.</text><text x="0" y="11.8" font-size="5.2" fill="currentColor" font-family="Helvetica, Arial, sans-serif">2.</text><text x="0" y="16.8" font-size="5.2" fill="currentColor" font-family="Helvetica, Arial, sans-serif">3.</text><path d="M7.5 5h9M7.5 10h9M7.5 15h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

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
    let { user } = await api('/api/me');
    state.user = user;
    applyDisplayPreferences(); // now reflects this account's saved preference

    // Landed back here after Stripe Checkout. The actual plan upgrade is
    // driven by the webhook (see server.js), which can lag the redirect by
    // a moment - poll briefly for it to land rather than showing "still
    // Free" for a few seconds right after someone just paid.
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      for (let i = 0; i < 5 && user.plan !== 'paid'; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        ({ user } = await api('/api/me'));
        state.user = user;
      }
      showToast(
        user.plan === 'paid'
          ? "You're on Premium now — unlimited notes, file pages, and text boxes are unlocked."
          : "Payment received - it can take a few seconds to finish activating. Refresh in a moment if Premium doesn't show up yet."
      );
    } else if (params.get('upgrade_cancelled') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
    }

    await loadApp();
  } catch (e) {
    renderAuth();
  }
}

// A brief, self-dismissing message in the corner of the screen - used for
// things like "you're on Premium now" after returning from Stripe Checkout,
// where there's no specific screen element to attach a status message to.
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('visible'), 10);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
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
      <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu" aria-expanded="false">${ICONS.menu}</button>
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
          <button id="upload-note-btn" title="Upload a PDF or image as a new note${state.user.plan !== 'paid' ? ' (Premium)' : ''}">+ File</button>
        </div>
        <input type="file" id="upload-note-file-input" accept="application/pdf,image/*" hidden />

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
  root.querySelector('#upload-note-btn').addEventListener('click', () => { closeMobileSidebar(); uploadAsNote(); });
  root.querySelector('#upload-note-file-input').addEventListener('change', handleUploadNoteFileChange);
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
    <div class="smart-item ${favoritesActive}" data-nav-favorites><span class="smart-item-inner">${ICONS.starOutline} Favorites</span></div>
    <div class="smart-item ${foldersActive}" data-nav-folders>Folders</div>
    <div class="smart-item ${smartActive('unfiled')}" data-smart="unfiled">Unfiled</div>
    <div class="sidebar-divider"></div>
    <div class="smart-item ${settingsActive}" data-nav-settings><span class="smart-item-inner">${ICONS.gear} Settings</span></div>
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
    resizeAllDrawingCanvases();
  }, 120);
});

// ---------------- Freehand drawing (pencil / marker / eraser) ----------------
// Each page gets its own <canvas> (see createPageElement/createDocumentPageElement)
// sitting between the page's own content and the text-box overlay. It's a
// plain raster layer - strokes are painted directly with the Canvas 2D API,
// not stored as editable vector shapes - which is what makes a true
// pixel-erasing eraser possible (globalCompositeOperation:'destination-out'
// below actually removes ink rather than deleting a whole shape). The
// trade-off is that once painted, a stroke can't be individually nudged or
// resized later - only undone as a whole step.
//
// Per-page undo/redo history lives here, keyed by the .note-page element
// itself (a WeakMap so it's automatically cleaned up if a page is removed).
// Each entry is a plain ImageData snapshot taken right before a stroke
// begins - putImageData() is synchronous and exact, unlike round-tripping
// through toDataURL()/Image, so undo/redo stay instant even for a fast
// series of strokes.
const drawingHistory = new WeakMap();
const DRAW_HISTORY_LIMIT = 40;

function getDrawingHistory(page) {
  let h = drawingHistory.get(page);
  if (!h) { h = { undo: [], redo: [] }; drawingHistory.set(page, h); }
  return h;
}

// Sizes a page's drawing canvas's actual pixel buffer to match how big its
// sheet is currently rendered on screen (times devicePixelRatio, so strokes
// stay crisp on retina displays) while the canvas's CSS size just fills the
// sheet via 100%/100% (see styles.css). The sheet's on-screen size isn't
// fixed - it shrinks on narrow viewports and the mobile breakpoint changes
// its height too - so this also runs on every window resize
// (resizeAllDrawingCanvases below), and by default preserves whatever was
// already drawn by stretching it into the new pixel size, the same way
// resizing an <img> would.
function sizeDrawingCanvas(page, { preserve = true } = {}) {
  const canvas = page.querySelector('.note-page-drawing-canvas');
  const sheet = page.querySelector('.note-page-sheet');
  if (!canvas || !sheet) return;
  const rect = sheet.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const newW = Math.max(1, Math.round(rect.width * dpr));
  const newH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === newW && canvas.height === newH) return;
  let prev = null;
  if (preserve && canvas.width > 0 && canvas.height > 0) {
    prev = document.createElement('canvas');
    prev.width = canvas.width;
    prev.height = canvas.height;
    prev.getContext('2d').drawImage(canvas, 0, 0);
  }
  canvas.width = newW;
  canvas.height = newH;
  if (prev) {
    canvas.getContext('2d').drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, newW, newH);
  }
  // The buffer was just replaced wholesale, so any snapshots taken against
  // the old pixel dimensions are no longer compatible with putImageData().
  drawingHistory.delete(page);
}

function resizeAllDrawingCanvases() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  stack.querySelectorAll(':scope > .note-page').forEach((page) => sizeDrawingCanvas(page));
}

// Paints a saved drawing (a data: URL PNG, from serializePage()) onto a
// page's canvas once it's been sized to its real on-screen dimensions.
function loadDrawingIntoCanvas(page, dataUrl) {
  const canvas = page.querySelector('.note-page-drawing-canvas');
  if (!canvas) return;
  const img = new Image();
  img.onload = () => {
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    page.dataset.hasDrawing = 'true';
  };
  img.src = dataUrl;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1, g1, b1;
  if (h < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

// Builds a CSS cursor value: a hollow circle exactly as wide as the eraser
// currently is, so the cursor shows precisely what a click will erase. Drawn
// with both a black AND a white ring so the outline stays visible over both
// light and dark page content, the same trick most OS cursors use. Capped at
// 128px - very large custom cursors aren't reliably honored by every
// browser, and the ", auto" fallback means an unsupported size just quietly
// becomes the default cursor rather than an error.
function eraserCursorDataUrl(diameterCss) {
  const d = Math.max(4, diameterCss);
  const pad = 3;
  const size = Math.min(128, d + pad * 2);
  const r = (size - pad * 2) / 2;
  const c = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="rgba(255,255,255,0.2)" stroke="black" stroke-width="1.5"/><circle cx="${c}" cy="${c}" r="${Math.max(0, r - 1)}" fill="none" stroke="white" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, auto`;
}

// Keeps the eraser's live cursor in sync with its current size and with
// which tool is actually selected - re-run whenever either changes (see
// setDrawTool() and the width slider's own input handler).
function updateEraserCursor() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  stack.dataset.drawTool = state.drawTool;
  stack.style.setProperty('--eraser-cursor-url', eraserCursorDataUrl(state.drawSettings.eraser.width));
}

function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

// Jumps the wheel/marker/value-slider straight to a given hex color - used
// by favorite/recent swatches, the eyedropper, and (indirectly) by dragging
// the wheel itself once its picked point is converted back to a hex string.
function setDrawColorFromHex(hex) {
  const { h, s, v } = hexToHsv(hex);
  state.drawHue = h;
  state.drawSat = s;
  state.drawVal = v;
  updateDrawColorUi();
}

// ---------------- Draw color favorites + recents ----------------
// Persisted in localStorage (same "sn_" convention and try/catch-guarded
// pattern as the sidebar-collapsed flag elsewhere in this file) rather than
// on the server - this is a per-browser drawing preference, not note
// content, so there's no need for a backend round-trip just to remember it.
const DRAW_FAVORITES_KEY = 'sn_draw_favorite_colors';
const DRAW_RECENTS_KEY = 'sn_draw_recent_colors';
const MAX_RECENT_COLORS = 5;

function loadColorList(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((c) => typeof c === 'string') : [];
  } catch (e) {
    return [];
  }
}
function saveColorList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* private browsing, etc - just won't persist */ }
}

let drawFavoriteColors = loadColorList(DRAW_FAVORITES_KEY);
let drawRecentColors = loadColorList(DRAW_RECENTS_KEY);

// Called at the end of every completed pencil/marker stroke (not the
// eraser, which has no color of its own) - most-recent-first, deduped, kept
// to the last 5.
function addRecentColor(hex) {
  drawRecentColors = [hex, ...drawRecentColors.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_RECENT_COLORS);
  saveColorList(DRAW_RECENTS_KEY, drawRecentColors);
  renderDrawColorSwatchRows();
}
function addFavoriteColor(hex) {
  if (drawFavoriteColors.some((c) => c.toLowerCase() === hex.toLowerCase())) return; // already saved
  drawFavoriteColors = [hex, ...drawFavoriteColors];
  saveColorList(DRAW_FAVORITES_KEY, drawFavoriteColors);
  renderDrawColorSwatchRows();
}
function removeFavoriteColor(hex) {
  drawFavoriteColors = drawFavoriteColors.filter((c) => c.toLowerCase() !== hex.toLowerCase());
  saveColorList(DRAW_FAVORITES_KEY, drawFavoriteColors);
  renderDrawColorSwatchRows();
}

// (Re)draws the favorites + recents swatch rows and rewires their click
// handlers - called after every add/remove, and once when the color popover
// first opens.
function renderDrawColorSwatchRows() {
  const favSection = root.querySelector('#draw-favorites-section');
  const favRow = root.querySelector('#draw-favorite-colors');
  const recSection = root.querySelector('#draw-recents-section');
  const recRow = root.querySelector('#draw-recent-colors');
  if (favRow) {
    favRow.innerHTML = drawFavoriteColors.map((hex) => `
      <button type="button" class="draw-color-swatch" data-color="${hex}" style="background:${hex}" title="${hex}" aria-label="Use color ${hex}">
        <span class="draw-color-swatch-remove" data-remove-color="${hex}" title="Remove favorite" aria-label="Remove favorite ${hex}" role="button">${ICONS.close}</span>
      </button>
    `).join('');
  }
  if (favSection) favSection.hidden = drawFavoriteColors.length === 0;
  if (recRow) {
    recRow.innerHTML = drawRecentColors.map((hex) => `
      <button type="button" class="draw-color-swatch" data-color="${hex}" style="background:${hex}" title="${hex}" aria-label="Use color ${hex}"></button>
    `).join('');
  }
  if (recSection) recSection.hidden = drawRecentColors.length === 0;

  root.querySelectorAll('#draw-favorite-colors .draw-color-swatch, #draw-recent-colors .draw-color-swatch').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-color]')) return;
      setDrawColorFromHex(btn.dataset.color);
    });
  });
  root.querySelectorAll('#draw-favorite-colors [data-remove-color]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFavoriteColor(btn.dataset.removeColor);
    });
  });
}

// The EyeDropper API (Chrome/Edge) samples a color from anywhere on the
// user's screen, not just inside the page - it's not universally supported
// (no Firefox/Safari as of this writing), so the button is disabled with an
// explanatory title rather than hidden outright when it's missing.
const EYEDROPPER_SUPPORTED = typeof window.EyeDropper === 'function';

async function pickColorWithEyedropper() {
  if (!EYEDROPPER_SUPPORTED) return;
  try {
    const dropper = new window.EyeDropper();
    const result = await dropper.open();
    if (result && result.sRGBHex) setDrawColorFromHex(result.sRGBHex);
  } catch (e) {
    // Rejects on Escape/click-away cancel - normal, not an error worth surfacing.
  }
}

// Renders the wheel's pixel buffer exactly once (it never changes - hue by
// angle, saturation by distance from center, always at full value/brightness
// since Value is controlled separately by the slider below it) rather than
// on every open, since a 150x150 per-pixel HSV fill is the one part of this
// picker that's actually worth caching.
let colorWheelRendered = false;
function renderColorWheelBase() {
  if (colorWheelRendered) return;
  const canvas = root.querySelector('#draw-color-wheel');
  if (!canvas) return;
  const size = canvas.width; // CSS size matches (150x150), no devicePixelRatio needed for a picker
  const cx = size / 2, cy = size / 2, radius = size / 2;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist > radius) { imageData.data[idx + 3] = 0; continue; }
      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      const sat = Math.min(1, dist / radius);
      const [r, g, b] = hsvToRgb(angle, sat, 1);
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  colorWheelRendered = true;
}

// Moves the little ring marker to wherever state.drawHue/drawSat currently
// point on the wheel, and refreshes the value slider's own gradient (it
// always runs from black up to the fully-saturated picked hue, so it's an
// exact, not approximate, preview of what dragging it will produce) and the
// swatch button's background.
function updateDrawColorUi() {
  const wheelWrap = root.querySelector('.draw-color-wheel-wrap');
  const marker = root.querySelector('.draw-color-wheel-marker');
  const wheel = root.querySelector('#draw-color-wheel');
  if (wheelWrap && marker && wheel) {
    const size = wheel.width;
    const radius = size / 2;
    const rad = (state.drawHue * Math.PI) / 180;
    const dist = state.drawSat * radius;
    marker.style.left = `${radius + Math.cos(rad) * dist}px`;
    marker.style.top = `${radius + Math.sin(rad) * dist}px`;
    const [pr, pg, pb] = hsvToRgb(state.drawHue, state.drawSat, 1);
    marker.style.background = rgbToHex(pr, pg, pb);
  }
  const valueSlider = root.querySelector('#draw-value-slider');
  if (valueSlider) {
    const [fr, fg, fb] = hsvToRgb(state.drawHue, state.drawSat, 1);
    valueSlider.style.background = `linear-gradient(to right, #000, ${rgbToHex(fr, fg, fb)})`;
    valueSlider.value = String(Math.round(state.drawVal * 100));
  }
  const [r, g, b] = hsvToRgb(state.drawHue, state.drawSat, state.drawVal);
  state.drawColor = rgbToHex(r, g, b);
  const toggle = root.querySelector('#draw-color-toggle');
  if (toggle) toggle.style.background = state.drawColor;
}

function setDrawColorFromWheelEvent(e) {
  const wheel = root.querySelector('#draw-color-wheel');
  if (!wheel) return;
  const rect = wheel.getBoundingClientRect();
  const size = rect.width;
  const cx = size / 2, cy = size / 2;
  const x = e.clientX - rect.left - cx;
  const y = e.clientY - rect.top - cy;
  const dist = Math.sqrt(x * x + y * y);
  let angle = Math.atan2(y, x) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  state.drawHue = angle;
  state.drawSat = Math.min(1, dist / cx);
  updateDrawColorUi();
}

// Selects which tool is armed (pencil/marker/eraser) and swaps the width and
// opacity sliders over to that tool's own remembered settings, so switching
// tools and back doesn't lose whatever thickness you had dialed in for each.
const PEN_TOOLS = ['pencil', 'marker'];

function setDrawTool(tool) {
  state.drawTool = tool;
  if (PEN_TOOLS.includes(tool)) state.lastPenTool = tool;

  // The eraser is still a plain standalone button.
  root.querySelectorAll('.draw-tool-btn[data-tool]').forEach((btn) => {
    const isActive = btn.dataset.tool === tool;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // Pencil and Marker share one combo button - it shows/uses whichever of
  // the two was picked most recently (via the dropdown), and only reads as
  // "active" while a pen (not the eraser) is actually the current tool.
  const penMain = root.querySelector('.draw-pen-main');
  if (penMain) {
    const penIsActive = PEN_TOOLS.includes(tool);
    penMain.classList.toggle('active', penIsActive);
    penMain.setAttribute('aria-pressed', String(penIsActive));
    penMain.dataset.tool = state.lastPenTool;
    const isMarker = state.lastPenTool === 'marker';
    penMain.title = isMarker ? 'Marker' : 'Pencil';
    const iconEl = penMain.querySelector('.draw-tool-icon');
    const labelEl = penMain.querySelector('.draw-tool-label');
    if (iconEl) iconEl.innerHTML = isMarker ? ICONS.markerTool : ICONS.pencilTool;
    if (labelEl) labelEl.textContent = isMarker ? 'Marker' : 'Pencil';
  }
  root.querySelectorAll('.draw-pen-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.penTool === state.lastPenTool);
  });

  const settings = state.drawSettings[tool];
  const widthSlider = root.querySelector('#draw-width-slider');
  const opacitySlider = root.querySelector('#draw-opacity-slider');
  if (widthSlider) widthSlider.value = String(settings.width);
  if (opacitySlider) opacitySlider.value = String(settings.opacity);
  const colorToggle = root.querySelector('#draw-color-toggle');
  if (colorToggle) colorToggle.disabled = tool === 'eraser';
  updateEraserCursor();
}

function updateDrawUndoRedoButtons() {
  const page = state.lastDrawnPage;
  const h = page ? getDrawingHistory(page) : { undo: [], redo: [] };
  const undoBtn = root.querySelector('#draw-undo-btn');
  const redoBtn = root.querySelector('#draw-redo-btn');
  if (undoBtn) undoBtn.disabled = h.undo.length === 0;
  if (redoBtn) redoBtn.disabled = h.redo.length === 0;
}

function drawUndo() {
  const page = state.lastDrawnPage;
  if (!page) return;
  const h = getDrawingHistory(page);
  if (!h.undo.length) return;
  const canvas = page.querySelector('.note-page-drawing-canvas');
  const ctx = canvas.getContext('2d');
  h.redo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const prev = h.undo.pop();
  ctx.putImageData(prev, 0, 0);
  updateDrawUndoRedoButtons();
  handleDrawingChange(page);
}

function drawRedo() {
  const page = state.lastDrawnPage;
  if (!page) return;
  const h = getDrawingHistory(page);
  if (!h.redo.length) return;
  const canvas = page.querySelector('.note-page-drawing-canvas');
  const ctx = canvas.getContext('2d');
  h.undo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const next = h.redo.pop();
  ctx.putImageData(next, 0, 0);
  updateDrawUndoRedoButtons();
  handleDrawingChange(page);
}

// A drawing-only counterpart to handlePageInput() - marks the note unsaved
// and schedules the same debounced save, but skips the text-reflow
// (rebalancePages) step entirely since ink on the canvas never affects how
// text wraps across pages.
function handleDrawingChange(page) {
  page.dataset.hasDrawing = 'true';
  const status = root.querySelector('#save-status');
  if (status) status.textContent = 'Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentNote, 600);
}

// Wires up freehand pointer drawing on one page's canvas. Registered once per
// page (in createPageElement/createDocumentPageElement), same as every other
// per-page interaction in this app - the canvas itself simply ignores
// pointer events entirely unless draw mode is active (see the
// .page-stack.drawing-mode CSS rule), so nothing here needs to re-check
// state.drawModeActive on every move.
// Traces one smooth path through every point collected so far in the current
// stroke - a quadratic curve through each pair's midpoint, which is the
// standard trick for turning a series of raw pointer samples into a smooth
// line instead of a jagged polyline. Used on the scratch canvas below.
function drawSmoothPath(ctx, points) {
  if (!points.length) return;
  ctx.beginPath();
  if (points.length === 1) {
    // A single dot for a plain click-without-dragging - a perfectly
    // zero-length segment doesn't reliably render in every browser, so
    // nudging the start point by a hair guarantees the round cap still shows.
    ctx.moveTo(points[0].x - 0.01, points[0].y);
    ctx.lineTo(points[0].x, points[0].y);
    ctx.stroke();
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function wireDrawingCanvas(page) {
  const canvas = page.querySelector('.note-page-drawing-canvas');
  let drawing = false;
  let points = [];
  // Cached once per stroke (on pointerdown) rather than re-read on every
  // single pointermove - the canvas's on-screen rect can't change mid-drag
  // in practice, so there's no reason to force a fresh layout read per frame.
  let strokeRect = null;
  // The pre-stroke pixels, restored on every move before redrawing the
  // stroke's full smoothed path so far - this is what keeps a translucent
  // marker/eraser reading as ONE evenly-blended shape rather than a string of
  // separately-composited segments (which, at anything under 100% opacity,
  // visibly "beads" wherever consecutive segments' round caps overlap).
  let preImage = null;
  // Locked in at pointerdown so a stroke stays internally consistent even in
  // the (unlikely, since pointer capture holds focus) case any of these
  // change mid-drag.
  let strokeTool = 'pencil';
  let strokeColor = '#000000';
  let strokeLineWidth = 1;
  let strokeOpacity = 1;
  // The in-progress stroke is drawn fully opaque onto this offscreen buffer
  // first, then composited onto the real canvas once with the tool's actual
  // opacity/composite mode - so self-overlap within one stroke never
  // double-blends, no matter how many points it ends up with.
  const scratch = document.createElement('canvas');

  function pointToCanvas(e) {
    return {
      x: ((e.clientX - strokeRect.left) / strokeRect.width) * canvas.width,
      y: ((e.clientY - strokeRect.top) / strokeRect.height) * canvas.height,
    };
  }

  function paintCurrentStroke() {
    const ctx = canvas.getContext('2d');
    ctx.putImageData(preImage, 0, 0);
    const sctx = scratch.getContext('2d');
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.globalCompositeOperation = 'source-over';
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.strokeStyle = '#000';
    sctx.lineWidth = strokeLineWidth;
    drawSmoothPath(sctx, points);
    ctx.save();
    ctx.globalCompositeOperation = strokeTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = strokeOpacity;
    if (strokeTool === 'eraser') {
      ctx.drawImage(scratch, 0, 0);
    } else {
      // Recolor the (black) scratch mask to the current draw color, still at
      // full internal opacity - "source-in" keeps only the mask's painted
      // pixels, tinted by whatever's filled next.
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = strokeColor;
      sctx.fillRect(0, 0, scratch.width, scratch.height);
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.restore();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.drawModeActive) return;
    canvas.setPointerCapture(e.pointerId);
    strokeRect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const h = getDrawingHistory(page);
    preImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
    h.undo.push(preImage);
    if (h.undo.length > DRAW_HISTORY_LIMIT) h.undo.shift();
    h.redo = [];
    state.lastDrawnPage = page;
    updateDrawUndoRedoButtons();

    scratch.width = canvas.width;
    scratch.height = canvas.height;
    points = [pointToCanvas(e)];
    drawing = true;

    strokeTool = state.drawTool;
    const settings = state.drawSettings[strokeTool];
    const scale = canvas.width / strokeRect.width;
    strokeLineWidth = Math.max(1, settings.width * scale);
    strokeOpacity = settings.opacity / 100;
    strokeColor = state.drawColor;
    paintCurrentStroke();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    points.push(pointToCanvas(e));
    paintCurrentStroke();
  });

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    points = [];
    preImage = null;
    handleDrawingChange(page);
    if (strokeTool !== 'eraser') addRecentColor(strokeColor);
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { if (drawing) endStroke(); });
}

function toggleDrawMode(forceOn) {
  const next = typeof forceOn === 'boolean' ? forceOn : !state.drawModeActive;
  state.drawModeActive = next;
  const btn = root.querySelector('#draw-tool-btn');
  const toolbar = root.querySelector('#drawing-toolbar');
  const stack = root.querySelector('#page-stack');
  if (btn) { btn.classList.toggle('active', next); btn.setAttribute('aria-pressed', String(next)); }
  if (toolbar) toolbar.hidden = !next;
  if (stack) stack.classList.toggle('drawing-mode', next);
  if (next) {
    // Drawing and placing/editing a text box both want exclusive control of
    // clicks on the page - arming one turns the other off.
    state.textBoxPlacementActive = false;
    updateTextBoxToolbarState();
    document.querySelectorAll('.textbox.active').forEach((b) => deactivateTextBox(b));
    renderColorWheelBase();
    updateDrawColorUi();
    updateDrawUndoRedoButtons();
    updateEraserCursor();
  }
}

function wireDrawingToolbar() {
  const drawBtn = root.querySelector('#draw-tool-btn');
  if (drawBtn) drawBtn.addEventListener('click', () => {
    if (state.user.plan !== 'paid') {
      showUpgradeModal('Drawing on your notes is a Premium feature. Upgrade to Premium to sketch with pencil, marker, and eraser tools.');
      return;
    }
    toggleDrawMode();
  });

  root.querySelectorAll('.draw-tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setDrawTool(btn.dataset.tool));
  });

  // Pencil/Marker combo: the main button re-uses whichever of the two was
  // picked last, the small caret opens a dropdown to switch between them.
  const penMain = root.querySelector('.draw-pen-main');
  if (penMain) penMain.addEventListener('click', () => setDrawTool(state.lastPenTool));
  const penCaret = root.querySelector('.draw-pen-caret');
  const penDropdown = root.querySelector('#draw-pen-dropdown');
  if (penCaret && penDropdown) {
    penCaret.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = penDropdown.classList.contains('hidden');
      penDropdown.classList.toggle('hidden', !willShow);
      penCaret.setAttribute('aria-expanded', String(willShow));
    });
  }
  root.querySelectorAll('.draw-pen-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      setDrawTool(opt.dataset.penTool);
      if (penDropdown) penDropdown.classList.add('hidden');
      if (penCaret) penCaret.setAttribute('aria-expanded', 'false');
    });
  });

  const widthSlider = root.querySelector('#draw-width-slider');
  if (widthSlider) widthSlider.addEventListener('input', () => {
    state.drawSettings[state.drawTool].width = Number(widthSlider.value);
    if (state.drawTool === 'eraser') updateEraserCursor();
  });
  const opacitySlider = root.querySelector('#draw-opacity-slider');
  if (opacitySlider) opacitySlider.addEventListener('input', () => {
    state.drawSettings[state.drawTool].opacity = Number(opacitySlider.value);
  });

  const colorToggle = root.querySelector('#draw-color-toggle');
  const colorPopover = root.querySelector('#draw-color-popover');
  if (colorToggle && colorPopover) {
    colorToggle.addEventListener('click', () => {
      const willShow = colorPopover.classList.contains('hidden');
      colorPopover.classList.toggle('hidden', !willShow);
      colorToggle.setAttribute('aria-expanded', String(willShow));
      if (willShow) { renderColorWheelBase(); updateDrawColorUi(); renderDrawColorSwatchRows(); }
    });
  }
  const eyedropperBtn = root.querySelector('#draw-eyedropper-btn');
  if (eyedropperBtn) eyedropperBtn.addEventListener('click', pickColorWithEyedropper);
  const saveColorBtn = root.querySelector('#draw-save-color-btn');
  if (saveColorBtn) saveColorBtn.addEventListener('click', () => addFavoriteColor(state.drawColor));

  const wheel = root.querySelector('#draw-color-wheel');
  if (wheel) {
    let pickingColor = false;
    wheel.addEventListener('pointerdown', (e) => {
      pickingColor = true;
      wheel.setPointerCapture(e.pointerId);
      setDrawColorFromWheelEvent(e);
    });
    wheel.addEventListener('pointermove', (e) => { if (pickingColor) setDrawColorFromWheelEvent(e); });
    wheel.addEventListener('pointerup', () => { pickingColor = false; });
  }
  const valueSlider = root.querySelector('#draw-value-slider');
  if (valueSlider) valueSlider.addEventListener('input', () => {
    state.drawVal = Number(valueSlider.value) / 100;
    updateDrawColorUi();
  });

  const undoBtn = root.querySelector('#draw-undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', drawUndo);
  const redoBtn = root.querySelector('#draw-redo-btn');
  if (redoBtn) redoBtn.addEventListener('click', drawRedo);

  const doneBtn = root.querySelector('#draw-done-btn');
  if (doneBtn) doneBtn.addEventListener('click', () => toggleDrawMode(false));
}

// Close the color-wheel popover when clicking anywhere outside it, and let
// Escape back out of drawing mode entirely - same conventions as the
// highlighter popover and the pages panel above.
document.addEventListener('click', (e) => {
  const popover = document.getElementById('draw-color-popover');
  if (popover && !popover.classList.contains('hidden') && !e.target.closest('.draw-color-picker')) {
    popover.classList.add('hidden');
  }
  const penDropdown = document.getElementById('draw-pen-dropdown');
  if (penDropdown && !penDropdown.classList.contains('hidden') && !e.target.closest('.draw-pen-combo')) {
    penDropdown.classList.add('hidden');
    const penCaret = document.querySelector('.draw-pen-caret');
    if (penCaret) penCaret.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if (!state.drawModeActive) return;
  if (e.key === 'Escape') {
    // Close whichever popover/dropdown is open first, same as everywhere
    // else in this app - only fall through to exiting drawing mode entirely
    // once nothing's open on top of it.
    const popover = document.getElementById('draw-color-popover');
    const penDropdown = document.getElementById('draw-pen-dropdown');
    if (popover && !popover.classList.contains('hidden')) { popover.classList.add('hidden'); return; }
    if (penDropdown && !penDropdown.classList.contains('hidden')) {
      penDropdown.classList.add('hidden');
      const penCaret = document.querySelector('.draw-pen-caret');
      if (penCaret) penCaret.setAttribute('aria-expanded', 'false');
      return;
    }
    toggleDrawMode(false);
    return;
  }
  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, but only while actually in drawing mode -
  // otherwise these would fight with the browser's own undo inside a text
  // field or text box.
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) drawRedo(); else drawUndo();
  }
});

// ---------------- Pages panel: thumbnails, reorder, delete, in-note search ----------------
// All of this is transient, editor-session-only state - it's reset at the
// top of renderEditor() every time a (possibly different) note is opened,
// never persisted, and never touches content_html directly (reordering and
// deleting both just rearrange/remove real .note-page DOM nodes and then
// go through the normal saveCurrentNote() save path).
let pagesPanelOpen = false;
let panelPageRefs = []; // panelPageRefs[i] -> the real .note-page element the i-th thumbnail represents
let pagesPanelObserver = null;
let pagesPanelObserverTimer = null;
let dragSrcIndex = null;
let searchDebounceTimer = null;
let searchMatches = []; // array of live Range objects, in document order
let searchMatchIndex = -1;
// The CSS Custom Highlight API (window.Highlight / CSS.highlights) lets search
// hits be painted directly from Range objects, with zero DOM mutation of the
// note's actual contenteditable content - important since that content is
// exactly what gets read back and saved on every edit. Where it's unsupported
// (e.g. older Firefox), match count/next/previous/scroll-to-match still all
// work fine (they're plain Range math); only the yellow highlight itself is
// skipped.
const SEARCH_HIGHLIGHT_SUPPORTED = typeof window.Highlight === 'function' && !!window.CSS && !!CSS.highlights;

function togglePagesPanel(open) {
  const panel = root.querySelector('#pages-panel');
  const scrim = root.querySelector('#pages-panel-scrim');
  const btn = root.querySelector('#pages-panel-toggle-btn');
  if (!panel || !scrim) return;
  pagesPanelOpen = open;
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', String(!open));
  scrim.classList.toggle('visible', open);
  if (btn) {
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-pressed', String(open));
  }
  if (open) {
    buildPageThumbnails();
    startPagesPanelObserver();
    const input = root.querySelector('#pages-search-input');
    // Deferred a tick - the panel is still mid-slide-in, and focusing an
    // element that isn't visible/laid-out yet is unreliable in some browsers.
    if (input) setTimeout(() => input.focus(), 50);
  } else {
    stopPagesPanelObserver();
    const input = root.querySelector('#pages-search-input');
    if (input) input.value = '';
    clearSearch();
  }
}

function closePagesPanel() {
  togglePagesPanel(false);
}

function startPagesPanelObserver() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  pagesPanelObserver = new MutationObserver(() => {
    clearTimeout(pagesPanelObserverTimer);
    // Debounced - a burst of keystrokes fires many mutations in a row, and
    // rebuilding the thumbnail list / re-scanning search matches is only
    // worth doing once the DOM has settled, not on every single character.
    pagesPanelObserverTimer = setTimeout(() => {
      if (!pagesPanelOpen) return;
      buildPageThumbnails();
      refreshSearchMatches();
    }, 250);
  });
  pagesPanelObserver.observe(stack, { childList: true, subtree: true, characterData: true });
}

function stopPagesPanelObserver() {
  clearTimeout(pagesPanelObserverTimer);
  if (pagesPanelObserver) {
    pagesPanelObserver.disconnect();
    pagesPanelObserver = null;
  }
}

// Rebuilds the panel's thumbnail list from the live #page-stack DOM (the
// only source of truth for page order/content while a note is open - see
// serializePage()/saveCurrentNote()). Reuses the exact same
// data-preview-frame / data-preview-page markup and scalePreviewFrames()
// scaling technique as the note-grid cards, so a thumbnail is guaranteed to
// look like a shrunk-down copy of the real page rather than a reinvented
// approximation of one.
function buildPageThumbnails() {
  const listEl = root.querySelector('#pages-panel-list');
  const stack = root.querySelector('#page-stack');
  if (!listEl || !stack) return;
  const pages = Array.from(stack.querySelectorAll(':scope > .note-page'));
  panelPageRefs = pages;
  const template = state.currentNote ? state.currentNote.template : 'blank';
  const total = pages.length;

  listEl.innerHTML = pages.map((pageEl, i) => {
    const isDoc = pageEl.dataset.pageType === 'document';
    const previewInner = isDoc
      ? `<img class="note-card-preview-doc-img" src="/api/files/${pageEl.dataset.fileId}" alt="" />`
      : (pageEl.querySelector('.note-page-body')?.innerHTML || '');
    // The thumbnail is otherwise just a scaled-down clone of the page's real
    // markup, but freehand drawing lives on a <canvas> rather than in any
    // HTML this clone could inherit - so any drawn ink has to be baked in
    // separately, as a plain image laid on top at the same 680x820 design size.
    const drawingCanvas = pageEl.querySelector('.note-page-drawing-canvas');
    const drawingOverlay = pageEl.dataset.hasDrawing === 'true' && drawingCanvas
      ? `<img class="page-thumb-drawing-overlay" src="${drawingCanvas.toDataURL('image/png')}" alt="" />`
      : '';
    const deleteDisabled = total <= 1;
    return `
      <li class="page-thumb" draggable="true" data-index="${i}">
        <div class="page-thumb-drag-handle" title="Drag to reorder">${ICONS.grip}</div>
        <div class="note-card-preview-frame page-thumb-frame" data-preview-frame>
          <div class="note-card-preview-page ${isDoc ? 'doc-preview' : ''} template-${template}" data-preview-page>${previewInner}${drawingOverlay}</div>
        </div>
        <div class="page-thumb-footer">
          <span class="page-thumb-label">Page ${i + 1}</span>
          <button type="button" class="page-thumb-delete-btn" data-index="${i}" aria-label="Delete page ${i + 1}" title="${deleteDisabled ? "A note needs at least one page" : 'Delete this page'}" ${deleteDisabled ? 'disabled' : ''}>${ICONS.trash}</button>
        </div>
      </li>
    `;
  }).join('');

  scalePreviewFrames(listEl);
}

function wirePagesPanel() {
  const toggleBtn = root.querySelector('#pages-panel-toggle-btn');
  const closeBtn = root.querySelector('#pages-panel-close-btn');
  const scrim = root.querySelector('#pages-panel-scrim');
  const panel = root.querySelector('#pages-panel');
  const listEl = root.querySelector('#pages-panel-list');
  const searchInput = root.querySelector('#pages-search-input');
  const prevBtn = root.querySelector('#pages-search-prev-btn');
  const nextBtn = root.querySelector('#pages-search-next-btn');

  toggleBtn.addEventListener('click', () => togglePagesPanel(!pagesPanelOpen));
  closeBtn.addEventListener('click', () => closePagesPanel());
  scrim.addEventListener('click', () => closePagesPanel());
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePagesPanel(); });

  // Clicking a thumbnail (but not its delete button, and not a drag) scrolls
  // the real page into view - the panel stays open so browsing/reordering
  // can continue right after.
  listEl.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.page-thumb-delete-btn');
    if (deleteBtn) {
      const idx = Number(deleteBtn.dataset.index);
      removePageFromPanel(panelPageRefs[idx]);
      return;
    }
    const li = e.target.closest('.page-thumb');
    if (!li) return;
    const idx = Number(li.dataset.index);
    panelPageRefs[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  wirePageThumbDragEvents(listEl);

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runSearch(searchInput.value), 150);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (searchMatches.length === 0) runSearch(searchInput.value);
    else goToMatch(e.shiftKey ? -1 : 1);
  });
  prevBtn.addEventListener('click', () => goToMatch(-1));
  nextBtn.addEventListener('click', () => goToMatch(1));
}

// Native HTML5 drag-and-drop, "live reorder" style: the dragged <li> is
// actually moved in the DOM as soon as it crosses another item's midpoint,
// so the list always shows exactly what the drop will produce - no separate
// drop-indicator line to keep in sync. data-index always still refers to the
// thumbnail's ORIGINAL position (== its index into panelPageRefs) even after
// it visually moves, so finalizeReorder() can read the final DOM order of
// those original indices to know which real page goes where.
function wirePageThumbDragEvents(listEl) {
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.page-thumb');
    if (!li) return;
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox won't start a drag at all unless some data is set.
    e.dataTransfer.setData('text/plain', String(dragSrcIndex));
  });

  listEl.addEventListener('dragover', (e) => {
    if (dragSrcIndex === null) return;
    e.preventDefault();
    const dragging = listEl.querySelector('.page-thumb.dragging');
    const li = e.target.closest('.page-thumb');
    if (!dragging || !li || li === dragging) return;
    const rect = li.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    li.parentNode.insertBefore(dragging, before ? li : li.nextSibling);
  });

  listEl.addEventListener('drop', (e) => e.preventDefault());

  listEl.addEventListener('dragend', () => {
    const dragging = listEl.querySelector('.page-thumb.dragging');
    if (dragging) dragging.classList.remove('dragging');
    if (dragSrcIndex !== null) finalizeReorder();
    dragSrcIndex = null;
  });
}

async function finalizeReorder() {
  const listEl = root.querySelector('#pages-panel-list');
  const stack = root.querySelector('#page-stack');
  if (!listEl || !stack) return;
  const newOrder = Array.from(listEl.querySelectorAll('.page-thumb')).map((li) => Number(li.dataset.index));
  // No-op if nothing actually moved.
  if (newOrder.every((origIndex, i) => origIndex === i)) return;
  // appendChild on a node already in the tree *moves* it - looping through
  // the desired final order and re-appending each one is enough to put
  // #page-stack's children in exactly that order.
  newOrder.forEach((origIndex) => {
    const pageEl = panelPageRefs[origIndex];
    if (pageEl) stack.appendChild(pageEl);
  });
  renumberPages();
  await saveCurrentNote();
  buildPageThumbnails();
  refreshSearchMatches();
}

async function removePageFromPanel(pageEl) {
  const stack = root.querySelector('#page-stack');
  if (!pageEl || !stack) return;
  const total = stack.querySelectorAll('.note-page').length;
  if (total <= 1) return; // the delete button is already disabled in this case
  const idx = Array.from(stack.children).indexOf(pageEl);
  if (!confirm(`Delete page ${idx + 1}? This can't be undone.`)) return;
  const fileId = pageEl.dataset.pageType === 'document' ? Number(pageEl.dataset.fileId) : null;
  pageEl.remove();
  renumberPages();
  await saveCurrentNote();
  if (fileId) {
    try {
      await api(`/api/files/${fileId}`, { method: 'DELETE' });
    } catch (e) {
      // Best-effort cleanup of the underlying stored file - same reasoning
      // as removeDocumentPage(): the page is already gone from the note
      // either way, so a failure here isn't worth surfacing to the user.
    }
  }
  buildPageThumbnails();
  refreshSearchMatches();
}

// ---------------- In-note search ----------------
// Only text pages' bodies and text-box annotations carry real, extractable
// text - uploaded PDF/image pages are stored as opaque rasters with no
// server-side text extraction (see pdfRender.js), so they're not part of
// this search. Anything typed into a text box sitting on top of a document
// page still is.
function collectSearchableContainers() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return [];
  const containers = [];
  stack.querySelectorAll('.note-page').forEach((pageEl) => {
    const body = pageEl.querySelector('.note-page-body');
    if (body) containers.push(body);
    pageEl.querySelectorAll('.textbox-content').forEach((tb) => containers.push(tb));
  });
  return containers;
}

function computeSearchMatches(query) {
  const matches = [];
  const q = query.trim().toLowerCase();
  if (!q) return matches;
  collectSearchableContainers().forEach((container) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.toLowerCase();
      let from = 0;
      let idx;
      while ((idx = text.indexOf(q, from)) !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + q.length);
        matches.push(range);
        from = idx + q.length;
      }
    }
  });
  return matches;
}

function applySearchHighlights() {
  if (!SEARCH_HIGHLIGHT_SUPPORTED) return;
  if (searchMatches.length === 0) {
    CSS.highlights.delete('pages-search-hit');
    CSS.highlights.delete('pages-search-hit-current');
    return;
  }
  CSS.highlights.set('pages-search-hit', new Highlight(...searchMatches));
  updateCurrentMatchHighlight();
}

function updateCurrentMatchHighlight() {
  if (!SEARCH_HIGHLIGHT_SUPPORTED) return;
  const current = searchMatches[searchMatchIndex];
  if (!current) {
    CSS.highlights.delete('pages-search-hit-current');
    return;
  }
  CSS.highlights.set('pages-search-hit-current', new Highlight(current));
}

function updateSearchUi() {
  const countEl = root.querySelector('#pages-search-count');
  const prevBtn = root.querySelector('#pages-search-prev-btn');
  const nextBtn = root.querySelector('#pages-search-next-btn');
  if (!countEl) return;
  const query = root.querySelector('#pages-search-input')?.value.trim() || '';
  if (!query) {
    countEl.textContent = '';
  } else if (searchMatches.length === 0) {
    countEl.textContent = 'No matches';
  } else {
    countEl.textContent = `${searchMatchIndex + 1} of ${searchMatches.length}`;
  }
  const disabled = searchMatches.length === 0;
  if (prevBtn) prevBtn.disabled = disabled;
  if (nextBtn) nextBtn.disabled = disabled;
}

// Scrolls #page-stack (not the whole window - the stack is its own scroll
// region) so the given match is centered in view. Purely Range/rect math, so
// it works identically whether or not the browser supports the Highlight API
// used to actually paint the match yellow.
function scrollToMatch(index) {
  const range = searchMatches[index];
  const stack = root.querySelector('#page-stack');
  if (!range || !stack) return;
  const rect = range.getBoundingClientRect();
  const stackRect = stack.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // A zero-size rect means the range isn't actually laid out right now
    // (e.g. collapsed whitespace) - fall back to just bringing its page into
    // view rather than computing a scroll offset from nothing.
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    node?.closest('.note-page')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const targetTop = stack.scrollTop + (rect.top - stackRect.top) - stackRect.height / 2 + rect.height / 2;
  stack.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

function goToMatch(delta) {
  if (searchMatches.length === 0) return;
  searchMatchIndex = (searchMatchIndex + delta + searchMatches.length) % searchMatches.length;
  updateCurrentMatchHighlight();
  updateSearchUi();
  scrollToMatch(searchMatchIndex);
}

function runSearch(query) {
  searchMatches = computeSearchMatches(query);
  searchMatchIndex = searchMatches.length ? 0 : -1;
  applySearchHighlights();
  updateSearchUi();
  if (searchMatchIndex >= 0) scrollToMatch(searchMatchIndex);
}

function clearSearch() {
  searchMatches = [];
  searchMatchIndex = -1;
  if (SEARCH_HIGHLIGHT_SUPPORTED) {
    CSS.highlights.delete('pages-search-hit');
    CSS.highlights.delete('pages-search-hit-current');
  }
  updateSearchUi();
}

// Called after an edit/reorder/delete while the panel is open - re-runs
// whatever query is currently typed (if any) so match count/highlights/
// current-match position stay accurate, without the user having to retype
// anything.
function refreshSearchMatches() {
  const input = root.querySelector('#pages-search-input');
  const query = input ? input.value : '';
  if (query.trim()) runSearch(query);
  else clearSearch();
}

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
    : `<button class="context-menu-item ${item.danger ? 'danger' : ''}" role="menuitem" data-idx="${i}">${item.icon ? `<span class="context-menu-item-icon">${item.icon}</span>` : ''}${escapeHtml(item.label)}</button>`
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
    { label: note.is_favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: note.is_favorite ? ICONS.starFilled : ICONS.starOutline, onClick: () => toggleFavoriteAndRerender('note', note.id, !!note.is_favorite) },
    {
      label: 'Download as PDF',
      icon: ICONS.download,
      onClick: () => {
        if (state.user.plan !== 'paid') {
          showUpgradeModal('Downloading a note as a PDF is a Premium feature. Upgrade to Premium to save your notes as PDFs.');
        } else {
          downloadNoteAsPdf(note);
        }
      },
    },
    { divider: true },
    { label: 'Delete', danger: true, onClick: () => deleteNoteFromList(note.id) },
  ];
}

// Fetches /api/notes/:id/pdf as a blob and triggers a normal browser download
// - not a plain <a href> navigation, since that would show the server's raw
// JSON error page if generation ever failed instead of a friendly alert.
async function downloadNoteAsPdf(note) {
  let res;
  try {
    res = await fetch(`/api/notes/${note.id}/pdf`, { credentials: 'same-origin' });
  } catch (e) {
    alert('Could not download that PDF - check your connection and try again.');
    return;
  }
  if (!res.ok) {
    let message = `Could not generate that PDF (${res.status}).`;
    try { const data = await res.json(); if (data.error) message = data.error; } catch (e) { /* no JSON body */ }
    if (res.status === 403) showUpgradeModal(message); else alert(message);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(note.title || 'Untitled note').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function folderContextMenuItems(folder) {
  return [
    { label: 'Open', onClick: () => animateMainTransition(() => selectView({ type: 'folder', id: folder.id }), 'forward') },
    { label: 'Rename', onClick: () => openFolderEditor(folder.id) },
    { label: folder.is_favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: folder.is_favorite ? ICONS.starFilled : ICONS.starOutline, onClick: () => toggleFavoriteAndRerender('folder', folder.id, !!folder.is_favorite) },
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
      ${isFolderView ? `<button id="back-to-folders-btn" class="btn-with-icon" aria-label="Back to all folders">${ICONS.arrowLeft} Back to Folders</button>` : ''}
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
        <button class="card-favorite-btn ${f.is_favorite ? 'active' : ''}" type="button" data-toggle-favorite data-favorite-type="folder" data-favorite-id="${f.id}" aria-pressed="${f.is_favorite ? 'true' : 'false'}" aria-label="${f.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}" title="${f.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${f.is_favorite ? ICONS.starFilled : ICONS.starOutline}</button>
        <button class="icon-btn" data-edit-folder-card="${f.id}" title="Edit folder" aria-label="Edit folder ${escapeAttr(f.name)}">${ICONS.pencilEdit}</button>
        <button class="icon-btn" data-delete-folder-card="${f.id}" title="Delete folder" aria-label="Delete folder ${escapeAttr(f.name)}">${ICONS.close}</button>
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
        ${user.plan !== 'paid'
          ? '<button class="primary-btn settings-inline-btn" id="settings-upgrade-btn">Upgrade to Premium</button>'
          : '<button class="primary-btn settings-inline-btn" id="manage-subscription-btn">Manage subscription</button>'}
        <p class="form-error hidden" id="plan-section-error"></p>
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

  const manageSubBtn = main.querySelector('#manage-subscription-btn');
  if (manageSubBtn) {
    manageSubBtn.addEventListener('click', async () => {
      const errorEl = main.querySelector('#plan-section-error');
      manageSubBtn.disabled = true;
      manageSubBtn.textContent = 'Opening…';
      try {
        const { url } = await api('/api/billing/portal', { method: 'POST' });
        window.location.href = url;
      } catch (err) {
        errorEl.textContent = err.message || 'Could not open billing settings. Please try again.';
        errorEl.classList.remove('hidden');
        manageSubBtn.disabled = false;
        manageSubBtn.textContent = 'Manage subscription';
      }
    });
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
  // A note whose first page is an uploaded PDF/image shows a thumbnail of
  // that image instead of any HTML.
  const preview = note.previewHtml;
  const isDocPreview = !!(preview && preview.type === 'document');
  const previewInner = isDocPreview
    ? `<img class="note-card-preview-doc-img" src="/api/files/${preview.fileId}" alt="" />`
    : (preview && preview.html) || '';
  return `
    <div class="note-card" data-open-note="${note.id}">
      <button class="card-favorite-btn note-card-favorite-btn ${note.is_favorite ? 'active' : ''}" type="button" data-toggle-favorite data-favorite-type="note" data-favorite-id="${note.id}" aria-pressed="${note.is_favorite ? 'true' : 'false'}" aria-label="${note.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}" title="${note.is_favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${note.is_favorite ? ICONS.starFilled : ICONS.starOutline}</button>
      <div class="note-card-preview-frame" data-preview-frame>
        <div class="note-card-preview-page ${isDocPreview ? 'doc-preview' : ''} template-${note.template || 'blank'}" data-preview-page>${previewInner}</div>
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

// "Upload a file as a note" - lets a PDF or image become a brand-new note
// on its own (from All notes/Unfiled/a folder), rather than needing to
// create a blank note first and then add the file as a page inside it.
function uploadAsNote() {
  if (state.user.plan !== 'paid') {
    showUpgradeModal('Uploading a file as a note is a Premium feature. Upgrade to Premium to turn PDFs and images into notes.');
    return;
  }
  if (state.noteMeta.limit && state.noteMeta.totalCount >= state.noteMeta.limit) {
    showUpgradeModal(`Free plan is limited to ${state.noteMeta.limit} note sets. Upgrade to Premium for unlimited notes.`);
    return;
  }
  root.querySelector('#upload-note-file-input').click();
}

async function handleUploadNoteFileChange(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    alert('That file is too large. Files are limited to 15MB.');
    return;
  }
  try {
    const dataBase64 = await fileToBase64(file);
    const folderId = view_isFolder(state.view) ? state.view.id : null;
    const { note, warning } = await api('/api/notes/upload', {
      method: 'POST',
      body: { filename: file.name, mimeType: file.type, dataBase64, folderId },
    });
    await refreshNotesForView();
    if (warning) alert(warning);
    await openNote(note.id);
  } catch (err) {
    if (err.code === 'NOTE_LIMIT_REACHED' || err.code === 'PREMIUM_REQUIRED') {
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

  // renderEditor() fully rebuilds the DOM every time a note opens, so any
  // pages-panel state (which page thumbnails map to, an active search) or
  // CSS Custom Highlight registrations left over from a previously open
  // note must be reset here rather than silently carried onto this note's
  // (entirely different) pages.
  stopPagesPanelObserver();
  pagesPanelOpen = false;
  panelPageRefs = [];
  searchMatches = [];
  searchMatchIndex = -1;
  if (SEARCH_HIGHLIGHT_SUPPORTED) {
    CSS.highlights.delete('pages-search-hit');
    CSS.highlights.delete('pages-search-hit-current');
  }
  // Same deal for drawing mode - the toolbar/canvases from whichever note was
  // open before are about to be torn down, and the color wheel's cached
  // pixel render belongs to a <canvas> element that's about to be replaced.
  state.drawModeActive = false;
  state.lastDrawnPage = null;
  colorWheelRendered = false;

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
        <div class="topbar-right-group">
          <button type="button" id="pages-panel-toggle-btn" class="pages-panel-toggle-btn" aria-label="Show page thumbnails and search" aria-pressed="false" title="Pages &amp; search">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="6.5" y="2.5" width="11" height="13" rx="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="1.3"/>
              <rect x="2.5" y="4.5" width="11" height="13" rx="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="1.3"/>
            </svg>
            <span>Pages</span>
          </button>
          <button id="back-to-grid" class="btn-with-icon" aria-label="Back to notes">${ICONS.arrowLeft} Back</button>
        </div>
      </div>
      <div class="editor-toolbar">
        <button data-cmd="bold" aria-label="Bold"><b>B</b></button>
        <button data-cmd="italic" aria-label="Italic"><i>I</i></button>
        <button data-cmd="underline" aria-label="Underline"><u>U</u></button>
        <div class="list-picker" id="list-picker">
          <button id="list-toggle" type="button" title="Bullet &amp; numbered lists" aria-label="Lists" aria-haspopup="true" aria-expanded="false">${ICONS.listBullet}</button>
          <div class="list-popover hidden" id="list-popover">
            <button type="button" class="list-option" data-list-type="bullet">${ICONS.listBullet} Bulleted list</button>
            <button type="button" class="list-option" data-list-type="dash">${ICONS.listDash} Dashed list</button>
            <button type="button" class="list-option" data-list-type="number">${ICONS.listNumber} Numbered list</button>
          </div>
        </div>
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
              <button class="highlight-swatch ${c.value === 'transparent' ? 'highlight-swatch-none' : ''}" data-highlight="${c.value}" title="Highlight: ${c.label}" aria-label="Highlight: ${c.label}" style="${c.value === 'transparent' ? '' : `background:${c.value}`}">${c.value === 'transparent' ? ICONS.close : ''}</button>
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
        <button type="button" id="textbox-tool-btn" class="premium-tool-btn" aria-label="Insert text box" aria-pressed="false" title="Text box${state.user.plan !== 'paid' ? ' (Premium)' : ''}">${ICONS.textbox}${state.user.plan !== 'paid' ? `<span class="tool-lock-badge">${ICONS.lock}</span>` : ''}</button>
        <button type="button" id="add-file-page-btn" class="premium-tool-btn" aria-label="Add a PDF or image as a page" title="Add a PDF or image as a page${state.user.plan !== 'paid' ? ' (Premium)' : ''}">${ICONS.filePlus}${state.user.plan !== 'paid' ? `<span class="tool-lock-badge">${ICONS.lock}</span>` : ''}</button>
        <input type="file" id="page-file-input" accept="application/pdf,image/*" hidden />
        <button type="button" id="draw-tool-btn" class="premium-tool-btn" aria-label="Draw on the page" aria-pressed="false" title="Draw${state.user.plan !== 'paid' ? ' (Premium)' : ''}">${ICONS.drawToggle}${state.user.plan !== 'paid' ? `<span class="tool-lock-badge">${ICONS.lock}</span>` : ''}</button>
        <div class="toolbar-spacer"></div>
        <select id="folder-select" aria-label="Folder">
          <option value="">Unfiled</option>
          ${state.folders.map((f) => `<option value="${f.id}" ${note.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
        <button id="delete-note-btn" aria-label="Delete note">Delete</button>
      </div>
      <div class="drawing-toolbar" id="drawing-toolbar" hidden>
        <div class="draw-tool-group" role="group" aria-label="Drawing tool">
          <div class="draw-pen-combo">
            <button type="button" class="draw-pen-main active" data-tool="pencil" aria-pressed="true" title="Pencil">
              <span class="draw-tool-icon">${ICONS.pencilTool}</span><span class="draw-tool-label">Pencil</span>
            </button>
            <button type="button" class="draw-pen-caret" aria-haspopup="true" aria-expanded="false" aria-label="Choose pen type" title="Choose pen type">${ICONS.caretDownSmall}</button>
            <div class="draw-pen-dropdown hidden" id="draw-pen-dropdown">
              <button type="button" class="draw-pen-option active" data-pen-tool="pencil">${ICONS.pencilTool} Pencil</button>
              <button type="button" class="draw-pen-option" data-pen-tool="marker">${ICONS.markerTool} Marker</button>
            </div>
          </div>
          <button type="button" class="draw-tool-btn" data-tool="eraser" aria-pressed="false" title="Eraser">${ICONS.eraserTool} Eraser</button>
        </div>
        <div class="draw-toolbar-divider"></div>
        <div class="draw-color-picker">
          <button type="button" id="draw-color-toggle" aria-haspopup="true" aria-expanded="false" title="Color" style="background:${state.drawColor}"></button>
          <div class="draw-color-popover hidden" id="draw-color-popover">
            <div class="draw-color-wheel-wrap">
              <canvas id="draw-color-wheel" width="150" height="150"></canvas>
              <div class="draw-color-wheel-marker"></div>
            </div>
            <div class="draw-value-slider-wrap">
              <input type="range" id="draw-value-slider" min="0" max="100" value="19" aria-label="Brightness" />
            </div>
            <div class="draw-color-actions">
              <button type="button" id="draw-eyedropper-btn" title="${EYEDROPPER_SUPPORTED ? 'Pick a color from anywhere' : 'Eyedropper not supported in this browser'}" aria-label="Eyedropper" ${EYEDROPPER_SUPPORTED ? '' : 'disabled'}>${ICONS.eyedropper}</button>
              <button type="button" id="draw-save-color-btn" title="Save this color to favorites" aria-label="Save color to favorites">${ICONS.plus}</button>
            </div>
            <div class="draw-color-section" id="draw-favorites-section" hidden>
              <div class="draw-color-section-label">Favorites</div>
              <div class="draw-color-row" id="draw-favorite-colors"></div>
            </div>
            <div class="draw-color-section" id="draw-recents-section" hidden>
              <div class="draw-color-section-label">Recent</div>
              <div class="draw-color-row" id="draw-recent-colors"></div>
            </div>
          </div>
        </div>
        <label class="draw-slider-label">Size
          <input type="range" id="draw-width-slider" min="1" max="40" value="3" aria-label="Stroke width" />
        </label>
        <label class="draw-slider-label">Opacity
          <input type="range" id="draw-opacity-slider" min="10" max="100" value="100" aria-label="Opacity" />
        </label>
        <button type="button" id="draw-undo-btn" class="btn-icon-only" title="Undo" aria-label="Undo" disabled>${ICONS.undo}</button>
        <button type="button" id="draw-redo-btn" class="btn-icon-only" title="Redo" aria-label="Redo" disabled>${ICONS.redo}</button>
        <div class="drawing-toolbar-spacer"></div>
        <button type="button" id="draw-done-btn">Done</button>
      </div>
      <div class="editor-body-wrap" id="editor-body-wrap">
        <input type="text" class="note-title-input" id="note-title" value="${escapeAttr(note.title)}" placeholder="Untitled note" aria-label="Note title" />
        <div class="page-stack" id="page-stack"></div>
        <div class="save-status" id="save-status">Saved</div>

        <div class="pages-panel-scrim" id="pages-panel-scrim"></div>
        <div class="pages-panel" id="pages-panel" aria-hidden="true">
          <div class="pages-panel-header">
            <h3>Pages</h3>
            <button type="button" class="pages-panel-close-btn" id="pages-panel-close-btn" aria-label="Close pages panel">${ICONS.close}</button>
          </div>
          <div class="pages-panel-search">
            <div class="pages-panel-search-row">
              <input type="text" id="pages-search-input" placeholder="Find in note…" aria-label="Find in note" autocomplete="off" />
              <button type="button" id="pages-search-prev-btn" class="pages-search-nav-btn" aria-label="Previous match" disabled title="Previous match">${ICONS.chevronUp}</button>
              <button type="button" id="pages-search-next-btn" class="pages-search-nav-btn" aria-label="Next match" disabled title="Next match">${ICONS.chevronDown}</button>
            </div>
            <div class="pages-search-count" id="pages-search-count"></div>
          </div>
          <ul class="pages-panel-list" id="pages-panel-list"></ul>
        </div>
      </div>
    </div>
  `;

  document.execCommand('defaultParagraphSeparator', false, 'div');

  // Restore pages: content_html is stored as a JSON array of per-page
  // objects - {type:'text', html, annotations, drawing} for ordinary flowing
  // text, or {type:'document', fileId, annotations, drawing} for a fixed,
  // read-only page rendered from an uploaded PDF/image. `annotations` is a
  // list of text boxes placed anywhere on that page, and `drawing` (added
  // alongside them) is a PNG data: URL of whatever was drawn freehand on top
  // of it, or null if nothing's been drawn there. Two older shapes still have
  // to be handled here: notes saved before file-pages existed stored a plain
  // array of HTML strings, and notes saved before pagination existed at all
  // stored raw HTML directly - both are treated as a text page (or pages)
  // with no annotations and no drawing.
  let pageEntries;
  try {
    const parsed = JSON.parse(note.content_html);
    if (Array.isArray(parsed) && parsed.length > 0) {
      pageEntries = parsed.map((p) =>
        typeof p === 'string' ? { type: 'text', html: p, annotations: [], drawing: null } : { annotations: [], drawing: null, ...p }
      );
    } else {
      pageEntries = [{ type: 'text', html: '', annotations: [], drawing: null }];
    }
  } catch (e) {
    pageEntries = [{ type: 'text', html: note.content_html || '', annotations: [], drawing: null }];
  }

  const stack = root.querySelector('#page-stack');
  pageEntries.forEach((entry) => {
    const page = entry.type === 'document'
      ? createDocumentPageElement(entry.fileId)
      : createPageElement(note.template);
    if (entry.type !== 'document') {
      const body = page.querySelector('.note-page-body');
      body.innerHTML = entry.html || '';
      renumberLists(body);
    }
    (entry.annotations || []).forEach((ann) => addTextBox(page, ann));
    stack.appendChild(page);
    sizeDrawingCanvas(page, { preserve: false });
    if (entry.drawing) loadDrawingIntoCanvas(page, entry.drawing);
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

  const listPopover = root.querySelector('#list-popover');
  const listToggleBtn = root.querySelector('#list-toggle');
  listToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowOpen = listPopover.classList.toggle('hidden') === false;
    listToggleBtn.setAttribute('aria-expanded', String(nowOpen));
  });
  main.querySelectorAll('[data-list-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setListType(btn.dataset.listType);
      listPopover.classList.add('hidden');
      listToggleBtn.setAttribute('aria-expanded', 'false');
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

  // ---------------- Text box tool (Premium) ----------------
  // Clicking the toolbar button "arms" the tool; the very next click on any
  // page (not on an existing text box) drops a new one right there, then the
  // tool automatically turns back off - the same one-shot pattern most
  // drawing apps use for an "insert shape" tool.
  root.querySelector('#textbox-tool-btn').addEventListener('click', () => {
    if (state.user.plan !== 'paid') {
      showUpgradeModal('Text boxes are a Premium feature. Upgrade to Premium to add them anywhere on your notes.');
      return;
    }
    toggleDrawMode(false);
    state.textBoxPlacementActive = !state.textBoxPlacementActive;
    updateTextBoxToolbarState();
  });

  // ---------------- Add a file as a page (Premium) ----------------
  root.querySelector('#add-file-page-btn').addEventListener('click', () => {
    if (state.user.plan !== 'paid') {
      showUpgradeModal('Adding files to your notes is a Premium feature. Upgrade to Premium to add PDF or image pages.');
      return;
    }
    toggleDrawMode(false);
    root.querySelector('#page-file-input').click();
  });

  root.querySelector('#page-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      alert('That file is too large. Files are limited to 15MB.');
      return;
    }
    const status = root.querySelector('#save-status');
    if (status) status.textContent = 'Adding page…';
    try {
      const dataBase64 = await fileToBase64(file);
      const { fileIds, warning } = await api(`/api/notes/${note.id}/pages`, {
        method: 'POST',
        body: { filename: file.name, mimeType: file.type, dataBase64 },
      });
      const stack = root.querySelector('#page-stack');
      fileIds.forEach((fileId) => stack.appendChild(createDocumentPageElement(fileId)));
      renumberPages();
      await saveCurrentNote();
      if (warning) alert(warning);
      const lastPage = stack.lastElementChild;
      if (lastPage) lastPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err.code === 'PREMIUM_REQUIRED') {
        showUpgradeModal(err.message);
      } else {
        alert(err.message);
      }
      if (status) status.textContent = 'Saved';
    }
  });

  wirePagesPanel();
  wireDrawingToolbar();
}

// Reads a File object into the base64 string (no data: URL prefix) the
// upload endpoints expect - shared by "add a file as a page" and "upload a
// file as a whole new note".
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function updateTextBoxToolbarState() {
  const btn = root.querySelector('#textbox-tool-btn');
  if (btn) btn.setAttribute('aria-pressed', String(state.textBoxPlacementActive));
  if (btn) btn.classList.toggle('active', state.textBoxPlacementActive);
  const stack = root.querySelector('#page-stack');
  if (stack) stack.classList.toggle('placing-textbox', state.textBoxPlacementActive);
}

// Restore focus + the last known cursor position to whichever page the user was last in.
// Needed because clicking a toolbar button/select moves focus away from the page itself.
function focusLastPage() {
  const stack = root.querySelector('#page-stack');
  if (!stack) return;
  if (!state.lastFocusedPage || !stack.contains(state.lastFocusedPage)) {
    state.lastFocusedPage = stack.querySelector('.note-page-body, .textbox-content');
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

// ---------------- Bulleted / dashed / numbered lists ----------------
// Deliberately NOT built on execCommand('insertUnorderedList'/'insertOrderedList')
// or real <ul>/<li> markup - neither browsers' native list commands nor their
// resulting DOM give the 3 distinct marker styles this needs, or predictable
// enough structure to safely hook the custom "- " autoformat and
// Backspace-exits-the-list behavior below. Instead each "line" (already a
// plain top-level <div> child of .note-page-body, since
// defaultParagraphSeparator is 'div') just gets a class - note-list-item
// plus note-list-bullet/note-list-dash/note-list-number - and a matching
// ::before marker in CSS. That means list state round-trips through
// content_html/serializePage() completely for free, as ordinary HTML.
const LIST_TYPES = ['bullet', 'dash', 'number'];
const LIST_CLASSES = ['note-list-item', 'note-list-bullet', 'note-list-dash', 'note-list-number'];

// Finds the top-level child of `body` that contains the caret (a "line"),
// creating one first if the caret is sitting bare inside body - which
// happens on a brand-new empty page, or one whose very first line has never
// had Enter pressed in it yet (defaultParagraphSeparator only wraps content
// in a <div> starting from the first Enter). Returns null if there's no
// selection inside body at all.
function ensureBlockWrapper(body) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!body.contains(range.startContainer) && range.startContainer !== body) return null;
  let node = range.startContainer;
  if (node !== body) {
    while (node.parentNode !== body) node = node.parentNode;
  }
  // `node` is now either body itself (caret sitting bare between child
  // nodes, or body currently empty), or one of body's direct children - but
  // that direct child can be a bare Text node rather than a real block
  // Element (typing on the very first line, before Enter has ever wrapped
  // anything in a <div>). Only a real Element can carry the list classes/
  // data-attributes this feature needs, so both of those "no real block
  // yet" cases get the same fix: wrap everything currently in body into one
  // new div.
  if (node.nodeType === 1 && node !== body) return node;

  const div = document.createElement('div');
  while (body.firstChild) div.appendChild(body.firstChild);
  body.appendChild(div);
  placeCaretAtStart(div);
  return div;
}

// Same idea, but read-only - never creates or mutates anything. Used by the
// keydown handlers, which only want to know "is there already a real block
// here" without wrapping bare content on every single keystroke. Returns
// block: null for the same "no real block yet" cases ensureBlockWrapper
// would otherwise have to fix up - callers already treat a null block as
// "this line isn't a list item" (correctly, since it can't be yet).
function currentLineInfo(body) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!body.contains(range.startContainer) && range.startContainer !== body) return null;
  let node = range.startContainer;
  if (node !== body) {
    while (node.parentNode !== body) node = node.parentNode;
  }
  const block = (node !== body && node.nodeType === 1) ? node : null;
  return { range, block };
}

// Chromium won't actually accept a typed character into a *completely*
// empty block element positioned at (el, 0) - it inserts the text as a new
// sibling BEFORE el instead of as el's own child (verified directly: typing
// right after this landed the character outside the div every time). Every
// native empty paragraph a browser creates on Enter has the same problem
// and works around it by always leaving a lone <br> inside as an anchor -
// this does the same thing here before placing the caret.
function placeCaretAtStart(el) {
  if (el.childNodes.length === 0) el.appendChild(document.createElement('br'));
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// True if there's no content between the start of `block` and the caret -
// i.e. the caret sits at the very beginning of that line.
function isCaretAtStartOfBlock(block, range) {
  const pre = document.createRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length === 0;
}

function clearListFormatting(block) {
  block.classList.remove(...LIST_CLASSES);
  delete block.dataset.listType;
  delete block.dataset.listIndex;
}

// Renumbers every run of consecutive note-list-number items so their
// data-list-index (what the ::before marker actually displays) always
// reads 1, 2, 3... within that run, resetting whenever a non-numbered line
// breaks the sequence. Cheap enough to just call after any edit that could
// possibly affect numbering (adding/removing/retyping a numbered item).
function renumberLists(body) {
  if (!body) return;
  let n = 0;
  Array.from(body.children).forEach((child) => {
    if (child.classList && child.classList.contains('note-list-number')) {
      n += 1;
      child.dataset.listIndex = String(n);
    } else {
      n = 0;
    }
  });
}

// Applies (or, clicking the same type again, removes) list formatting on
// whichever line the toolbar's Lists dropdown was invoked on.
function setListType(type) {
  focusLastPage();
  const body = state.lastFocusedPage;
  if (!body || !body.classList || !body.classList.contains('note-page-body')) return;
  const info = currentLineInfo(body);
  const block = (info && info.block) || ensureBlockWrapper(body);
  if (!block) return;
  const already = block.dataset.listType === type;
  clearListFormatting(block);
  if (!already) {
    block.classList.add('note-list-item', `note-list-${type}`);
    block.dataset.listType = type;
  }
  renumberLists(body);
  handlePageInput();
}

// Handles the two keyboard shortcuts this feature adds, delegated onto each
// page body: typing "- " at the very start of an otherwise-empty line turns
// it into a bulleted list item (the same shorthand Google Docs/Notion/Word
// all use), Enter continues the current list item's type onto a new line (or
// exits the list if the current item is empty, mirroring Enter's behavior
// in those same apps), and Backspace at the very start of a list item strips
// its list formatting instead of merging into the previous line - "press
// delete/backspace on the bullet and it goes back to regular text".
function handleListKeydown(e) {
  const body = e.currentTarget;

  if (e.key === ' ' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const info = currentLineInfo(body);
    if (info && info.range.collapsed) {
      const lineEl = info.block || body;
      const isAlreadyList = lineEl.classList && lineEl.classList.contains('note-list-item');
      const atLineStart = info.range.startContainer.nodeType === 3
        && info.range.startContainer.textContent === '-'
        && info.range.startOffset === 1
        && lineEl.textContent === '-';
      if (!isAlreadyList && atLineStart) {
        e.preventDefault();
        const block = ensureBlockWrapper(body);
        block.textContent = '';
        block.classList.add('note-list-item', 'note-list-bullet');
        block.dataset.listType = 'bullet';
        placeCaretAtStart(block);
        renumberLists(body);
        handlePageInput();
        return;
      }
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    const info = currentLineInfo(body);
    const block = info && info.block;
    if (block && block.classList.contains('note-list-item')) {
      e.preventDefault();
      if (block.textContent.trim() === '') {
        clearListFormatting(block);
        renumberLists(body);
        handlePageInput();
        return;
      }
      const range = info.range;
      const afterRange = range.cloneRange();
      afterRange.selectNodeContents(block);
      afterRange.setStart(range.endContainer, range.endOffset);
      const afterFragment = afterRange.extractContents();
      const newItem = document.createElement('div');
      newItem.className = block.className;
      newItem.dataset.listType = block.dataset.listType;
      newItem.appendChild(afterFragment);
      if (!newItem.textContent) newItem.appendChild(document.createElement('br'));
      block.after(newItem);
      placeCaretAtStart(newItem);
      renumberLists(body);
      handlePageInput();
      return;
    }
  }

  if (e.key === 'Backspace') {
    const info = currentLineInfo(body);
    if (info && info.block && info.block.classList.contains('note-list-item') && isCaretAtStartOfBlock(info.block, info.range)) {
      e.preventDefault();
      clearListFormatting(info.block);
      renumberLists(body);
      handlePageInput();
    }
  }
}

function createPageElement(template) {
  const page = document.createElement('div');
  page.className = 'note-page';
  page.dataset.pageType = 'text';
  page.innerHTML = `
    <div class="note-page-sheet">
      <div class="note-page-body template-${template}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note content"></div>
      <canvas class="note-page-drawing-canvas"></canvas>
      <div class="note-page-overlay"></div>
    </div>
    <div class="note-page-number"></div>
  `;
  const body = page.querySelector('.note-page-body');
  body.addEventListener('input', handlePageInput);
  body.addEventListener('keydown', handleListKeydown);
  wirePageForTextBoxPlacement(page);
  wireDrawingCanvas(page);
  return page;
}

// A fixed, read-only page rendered from an uploaded PDF/image - it never
// takes part in auto-pagination (there's no flowing text to overflow), but
// it can still carry text-box annotations on top of it, and it can be
// removed on its own via the "Remove page" control.
function createDocumentPageElement(fileId) {
  const page = document.createElement('div');
  page.className = 'note-page';
  page.dataset.pageType = 'document';
  page.dataset.fileId = String(fileId);
  page.innerHTML = `
    <div class="note-page-sheet">
      <img class="note-page-doc-img" src="/api/files/${fileId}" alt="Uploaded document page" draggable="false" />
      <canvas class="note-page-drawing-canvas"></canvas>
      <div class="note-page-overlay"></div>
    </div>
    <div class="note-page-controls">
      <button type="button" class="remove-page-btn" aria-label="Remove this page">${ICONS.close} Remove page</button>
    </div>
    <div class="note-page-number"></div>
  `;
  page.querySelector('.remove-page-btn').addEventListener('click', () => removeDocumentPage(page));
  wirePageForTextBoxPlacement(page);
  wireDrawingCanvas(page);
  return page;
}

async function removeDocumentPage(page) {
  if (!confirm('Remove this page? This cannot be undone.')) return;
  const fileId = Number(page.dataset.fileId);
  const stack = root.querySelector('#page-stack');
  page.remove();
  if (stack.children.length === 0) {
    stack.appendChild(createPageElement(state.currentNote.template));
  }
  renumberPages();
  await saveCurrentNote();
  try {
    await api(`/api/files/${fileId}`, { method: 'DELETE' });
  } catch (e) {
    // Best-effort cleanup of the underlying stored image - the page is
    // already gone from the note either way, so a failure here isn't
    // worth surfacing to the user.
  }
}

// Lets the toolbar's text-box tool drop a new box wherever the next click on
// this page lands (as long as that click isn't on an existing text box,
// which needs its own click to just... be a text box).
function wirePageForTextBoxPlacement(page) {
  page.addEventListener('click', (e) => {
    if (!state.textBoxPlacementActive) return;
    if (e.target.closest('.textbox')) return;
    const sheet = page.querySelector('.note-page-sheet');
    const rect = sheet.getBoundingClientRect();
    const defaultW = 220, defaultH = 110;
    const x = Math.max(0, Math.min(rect.width - defaultW, e.clientX - rect.left - defaultW / 2));
    const y = Math.max(0, Math.min(rect.height - defaultH, e.clientY - rect.top - 20));
    const box = addTextBox(page, { x, y, w: defaultW, h: defaultH, html: '' });
    state.textBoxPlacementActive = false;
    updateTextBoxToolbarState();
    handlePageInput();
    // A freshly placed box should be ready to type into immediately, rather
    // than making the user click it a second time first.
    activateTextBox(box);
    box.querySelector('.textbox-content').focus();
  });
}

// Adds one text-box annotation to `page` - used both when restoring a note
// (with a saved id/position/size/html) and when the text-box tool places a
// brand new one (opts.id/html omitted).
function addTextBox(page, opts) {
  const overlay = page.querySelector('.note-page-overlay');
  const id = opts.id || (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `tb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const box = document.createElement('div');
  box.className = 'textbox';
  box.dataset.textboxId = id;
  box.style.left = `${opts.x || 0}px`;
  box.style.top = `${opts.y || 0}px`;
  box.style.width = `${opts.w || 220}px`;
  box.style.height = `${opts.h || 110}px`;
  box.innerHTML = `
    <button type="button" class="textbox-delete-btn" aria-label="Delete text box" title="Delete text box">${ICONS.close}</button>
    <div class="textbox-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Text box"></div>
    ${TEXTBOX_RESIZE_DIRS.map((dir) => `<div class="textbox-resize-handle" data-dir="${dir}"></div>`).join('')}
  `;
  box.querySelector('.textbox-content').innerHTML = opts.html || '';
  overlay.appendChild(box);
  wireTextBox(box, page);
  return box;
}

function wireTextBox(box, page) {
  const content = box.querySelector('.textbox-content');
  content.addEventListener('input', handlePageInput);
  box.querySelector('.textbox-delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    box.remove();
    handlePageInput();
  });

  wireTextBoxSelectionAndDrag(box, page);
  wireTextBoxResizeHandles(box, page);
}

// A text box has two states once it exists: unselected (plain bordered box,
// nothing else interactive) and selected/".active" (delete "x" + 8 resize
// dots visible, and the box can be dragged from anywhere on it). There's no
// separate "now editing" class - :focus-within in the CSS already tells
// "selected, ready to drag" apart from "selected and the caret is actually
// inside the text" for free.
function activateTextBox(box) {
  if (box.classList.contains('active')) return;
  document.querySelectorAll('.textbox.active').forEach((b) => { if (b !== box) deactivateTextBox(b); });
  box.classList.add('active');
}

function deactivateTextBox(box) {
  box.classList.remove('active');
  const content = box.querySelector('.textbox-content');
  if (content && document.activeElement === content) content.blur();
}

// Clicking anywhere that isn't inside a text box deselects whichever one was
// selected - registered once, globally, rather than per text box, since it
// has nothing to do with any single box.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.textbox')) return;
  document.querySelectorAll('.textbox.active').forEach((b) => deactivateTextBox(b));
});

// Manually drops a caret at an exact screen point inside a contenteditable -
// needed because wireTextBoxSelectionAndDrag() below suppresses the
// browser's own default mousedown behavior (so it can decide "drag the box"
// vs. "start editing" itself instead of the browser doing it automatically),
// so starting to edit has to place the caret by hand.
function placeCaretAtPoint(el, x, y) {
  el.focus();
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  if (range && el.contains(range.startContainer)) {
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Click-to-select / click-again-to-edit / drag-anywhere-once-selected, all
// from a single mousedown handler on the box itself:
//  - not yet selected -> this click only selects it (no caret, no drag)
//  - already selected, no real movement before mouseup -> a plain second
//    click, so start editing (place the caret where it landed)
//  - already selected, mouse actually moves past a small threshold -> drag
//    the whole box instead, and make sure no text caret/selection is left
//    fighting it once the drag is underway
function wireTextBoxSelectionAndDrag(box, page) {
  const content = box.querySelector('.textbox-content');

  box.addEventListener('mousedown', (e) => {
    if (e.target.closest('.textbox-delete-btn') || e.target.closest('.textbox-resize-handle')) return;

    const wasActive = box.classList.contains('active');
    activateTextBox(box);
    e.preventDefault();

    const sheet = page.querySelector('.note-page-sheet');
    const sheetRect = sheet.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = box.offsetLeft, startTop = box.offsetTop;
    let moved = false;

    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
        window.getSelection()?.removeAllRanges();
      }
      if (!moved) return;
      const newLeft = Math.max(0, Math.min(sheetRect.width - box.offsetWidth, startLeft + dx));
      const newTop = Math.max(0, Math.min(sheetRect.height - box.offsetHeight, startTop + dy));
      box.style.left = `${newLeft}px`;
      box.style.top = `${newTop}px`;
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) {
        handlePageInput();
      } else if (wasActive) {
        placeCaretAtPoint(content, ev.clientX, ev.clientY);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

const TEXTBOX_RESIZE_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
const TEXTBOX_MIN_W = 80, TEXTBOX_MIN_H = 40;

function wireTextBoxResizeHandles(box, page) {
  box.querySelectorAll('.textbox-resize-handle').forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateTextBox(box);

      const dir = handle.dataset.dir;
      const growLeft = dir.includes('w'), growRight = dir.includes('e');
      const growTop = dir.includes('n'), growBottom = dir.includes('s');
      const sheet = page.querySelector('.note-page-sheet');
      const sheetRect = sheet.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = box.offsetLeft, startTop = box.offsetTop;
      const startW = box.offsetWidth, startH = box.offsetHeight;

      function onMove(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        let left = startLeft, top = startTop, w = startW, h = startH;
        if (growRight) {
          w = Math.max(TEXTBOX_MIN_W, Math.min(startW + dx, sheetRect.width - startLeft));
        } else if (growLeft) {
          const newLeft = Math.max(0, Math.min(startLeft + dx, startLeft + startW - TEXTBOX_MIN_W));
          w = startW + (startLeft - newLeft);
          left = newLeft;
        }
        if (growBottom) {
          h = Math.max(TEXTBOX_MIN_H, Math.min(startH + dy, sheetRect.height - startTop));
        } else if (growTop) {
          const newTop = Math.max(0, Math.min(startTop + dy, startTop + startH - TEXTBOX_MIN_H));
          h = startH + (startTop - newTop);
          top = newTop;
        }
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handlePageInput();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
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
        // Insert right after the page that's overflowing - not just appended
        // to the very end of the stack - so this stays correct even when a
        // fixed document page (uploaded PDF/image) happens to sit later in
        // the stack than the text page that's currently overflowing.
        page.closest('.note-page').after(pageEl);
        next = pageEl.querySelector('.note-page-body');
        pages.push(next);
      }
      next.insertBefore(page.lastChild, next.firstChild);
    }
  }

  // Drop empty trailing pages, but never the page the user is actively in,
  // never a page that still has a text box sitting on it (it isn't really
  // "empty" - deleting it would silently delete that text box's content
  // too), and always keep at least one page total.
  for (let i = pages.length - 1; i > 0; i--) {
    const page = pages[i];
    const isEmpty = page.childNodes.length === 0 || page.textContent.trim() === '';
    const hasTextBoxes = page.closest('.note-page').querySelector('.textbox');
    if (isEmpty && !hasTextBoxes && page !== state.lastFocusedPage) {
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

// Turns one .note-page DOM element back into the plain-object shape that
// gets stored in content_html - {type:'text', html, annotations, drawing}
// for a flowing text page, or {type:'document', fileId, annotations,
// drawing} for a fixed page rendered from an uploaded file. Annotations
// (text boxes) are read straight from their current on-screen
// position/size, so a drag or resize that just happened is captured the
// same way a text edit would be. `drawing` is only ever populated once
// page.dataset.hasDrawing has actually been set true (by a completed stroke,
// or by loading a previously-saved drawing back in) - an untouched page's
// canvas is fully transparent, and there's no reason to inflate content_html
// with a PNG of nothing every single autosave.
function serializePage(page) {
  const annotations = Array.from(page.querySelectorAll('.textbox')).map((box) => ({
    id: box.dataset.textboxId,
    x: box.offsetLeft,
    y: box.offsetTop,
    w: box.offsetWidth,
    h: box.offsetHeight,
    html: box.querySelector('.textbox-content').innerHTML,
  }));
  const canvas = page.querySelector('.note-page-drawing-canvas');
  const drawing = page.dataset.hasDrawing === 'true' && canvas ? canvas.toDataURL('image/png') : null;
  if (page.dataset.pageType === 'document') {
    return { type: 'document', fileId: Number(page.dataset.fileId), annotations, drawing };
  }
  const body = page.querySelector('.note-page-body');
  return { type: 'text', html: body ? body.innerHTML : '', annotations, drawing };
}

async function saveCurrentNote() {
  if (!state.currentNote) return;
  const title = root.querySelector('#note-title')?.value ?? state.currentNote.title;
  const pageEls = root.querySelectorAll('#page-stack .note-page');
  const contentHtml = pageEls.length
    ? JSON.stringify(Array.from(pageEls).map(serializePage))
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
        <li>Turn PDFs &amp; images into note pages (or whole new notes)</li>
        <li>Add text boxes anywhere on a page</li>
        <li>Draw freehand with pencil, marker, and eraser tools</li>
      </ul>
      <p class="upgrade-price">$8.99/month</p>
      <p class="form-error hidden" id="upgrade-modal-error"></p>
      <button class="primary-btn" id="start-checkout-btn">Upgrade to Premium</button>
      <button class="modal-close-btn" id="close-modal">Not now</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#close-modal').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#start-checkout-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    const errorEl = overlay.querySelector('#upgrade-modal-error');
    btn.disabled = true;
    btn.textContent = 'Redirecting to checkout…';
    try {
      const { url } = await api('/api/billing/checkout', { method: 'POST' });
      window.location.href = url;
    } catch (err) {
      errorEl.textContent = err.message || 'Could not start checkout. Please try again.';
      errorEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Upgrade to Premium';
    }
  });
}

// ---------------- Utils ----------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

boot();
