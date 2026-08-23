// notePdf.js
// Turns one note (its title + parsed content_html pages) into a downloadable
// PDF buffer - the "Download as PDF" Premium feature. Builds on pdfWriter.js
// (this project's own hand-rolled PDF writer) rather than an npm PDF library,
// same zero-extra-dependency approach as the rest of the server.
//
// Scope/fidelity notes (deliberate simplifications, not bugs):
//  - Body text always uses the "blank" template's padding/line metrics,
//    regardless of which visual template (e.g. "lined") the note actually
//    uses on screen - reproducing the ruled-paper texture isn't essential to
//    getting the actual written content into a PDF, and it's a lot of extra
//    layout work for a cosmetic detail.
//  - Bold/italic and per-run font size are preserved; underline and
//    highlighter color are not - the standard 14 PDF fonts (no embedding)
//    cover weight/slant fine, but reproducing every inline style exactly
//    would need a much heavier layout engine for very little practical
//    benefit on a text export.
//  - Word-wrap uses an approximate average character width for Helvetica
//    (there's no font-metrics table on hand), biased conservatively so lines
//    wrap a little early rather than ever overflowing the page.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PdfWriter, pdfEscapeString } = require('./pdfWriter');

const PAGE_WIDTH = 680;
const SHEET_HEIGHT = 820; // the on-screen sheet's fixed height - drawing overlays and text boxes are always anchored to this region, even on a page stretched taller below for overflowing text
const PAD_X = 56;
const PAD_TOP = 48;
const PAD_BOTTOM = 48;
const DEFAULT_FONT_SIZE = 15;
const LINE_HEIGHT_RATIO = 1.6; // matches .note-page-body's CSS line-height
const JPEG_QUALITY = 82;

// ---------------- HTML -> blocks/runs parsing ----------------
// There's no DOM available server-side (and no npm HTML parser in this
// zero-dependency project), so this is a small hand-written scanner rather
// than a real parser. It only needs to understand the shapes this app's own
// contenteditable regions actually produce (div-per-line, inline b/i/span
// with a style attribute, br, and this session's own list-item divs) - not
// arbitrary HTML from the wider web.

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Splits body HTML into top-level "line" blocks - normally one per <div>
// (this editor's paragraph separator), tracking div nesting depth so a
// pasted/nested <div> inside a line doesn't prematurely end it. A bare
// top-level <br> is its own blank-line block. Anything else at the top level
// (stray inline tags/text - the "first line typed, before Enter was ever
// pressed" case) accumulates into one leading block with no wrapper.
function splitTopLevelBlocks(html) {
  const blocks = [];
  let i = 0;
  let buf = '';
  const flushBuf = () => {
    if (buf !== '') blocks.push({ raw: buf, attrs: '' });
    buf = '';
  };
  while (i < html.length) {
    if (html[i] === '<') {
      const rest = html.slice(i);
      const openDiv = rest.match(/^<div(\s[^>]*)?>/i);
      if (openDiv) {
        flushBuf();
        let depth = 1;
        let j = i + openDiv[0].length;
        let inner = '';
        while (j < html.length && depth > 0) {
          const r2 = html.slice(j);
          const o2 = r2.match(/^<div(\s[^>]*)?>/i);
          const c2 = r2.match(/^<\/div>/i);
          if (o2) { depth++; inner += o2[0]; j += o2[0].length; }
          else if (c2) { depth--; j += c2[0].length; if (depth > 0) inner += c2[0]; }
          else { inner += html[j]; j++; }
        }
        blocks.push({ raw: inner, attrs: openDiv[1] || '' });
        i = j;
        continue;
      }
      const br = rest.match(/^<br\s*\/?>/i);
      if (br) {
        flushBuf();
        blocks.push({ raw: '', attrs: '', isBr: true });
        i += br[0].length;
        continue;
      }
      const anyTag = rest.match(/^<[a-zA-Z!][^>]*>/);
      if (anyTag) { buf += anyTag[0]; i += anyTag[0].length; continue; }
      buf += html[i]; i++;
      continue;
    }
    buf += html[i]; i++;
  }
  flushBuf();
  return blocks;
}

// Walks one block's inner HTML, tracking bold/italic/font-size as a small
// stack (so a closing tag restores exactly the state from before its
// matching open tag, even with mixed <b>/<span style> nesting), and returns
// a flat list of {text,bold,italic,size} runs plus {break:true} for <br>.
function parseInlineRuns(raw) {
  const runs = [];
  const stack = [];
  let bold = false, italic = false, size = null;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '<') {
      const rest = raw.slice(i);
      let m = rest.match(/^<br\s*\/?>/i);
      if (m) { runs.push({ break: true }); i += m[0].length; continue; }
      m = rest.match(/^<\/([a-zA-Z0-9]+)>/);
      if (m) {
        const tag = m[1].toLowerCase();
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].tag === tag) {
            ({ prevBold: bold, prevItalic: italic, prevSize: size } = stack[k]);
            stack.splice(k, 1);
            break;
          }
        }
        i += m[0].length;
        continue;
      }
      m = rest.match(/^<([a-zA-Z0-9]+)([^>]*)>/);
      if (m) {
        const tag = m[1].toLowerCase();
        const attrs = m[2] || '';
        const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/i);
        const style = styleMatch ? styleMatch[1] : '';
        let newBold = bold, newItalic = italic, newSize = size;
        if (tag === 'b' || tag === 'strong') newBold = true;
        if (tag === 'i' || tag === 'em') newItalic = true;
        if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) newBold = true;
        else if (/font-weight\s*:\s*(normal|[1-5]00)/i.test(style)) newBold = false;
        if (/font-style\s*:\s*italic/i.test(style)) newItalic = true;
        else if (/font-style\s*:\s*normal/i.test(style)) newItalic = false;
        const sizeMatch = style.match(/font-size\s*:\s*([\d.]+)px/i);
        if (sizeMatch) newSize = Math.max(6, Math.min(72, parseFloat(sizeMatch[1])));
        const voidEl = /^(br|img|hr|input|meta|link)$/.test(tag);
        if (!voidEl) stack.push({ tag, prevBold: bold, prevItalic: italic, prevSize: size });
        bold = newBold; italic = newItalic; size = newSize;
        i += m[0].length;
        continue;
      }
      i++; // malformed '<' - skip just this character
      continue;
    }
    const nextLt = raw.indexOf('<', i);
    const chunk = nextLt === -1 ? raw.slice(i) : raw.slice(i, nextLt);
    i = nextLt === -1 ? raw.length : nextLt;
    const decoded = decodeEntities(chunk);
    if (decoded !== '') runs.push({ text: decoded, bold, italic, size });
  }
  return runs;
}

// Returns an array of blocks: { runs, listType, listIndex } - listType is
// null for a plain paragraph, or 'bullet'/'dash'/'number' when the block's
// own <div class="note-list-item note-list-...">  markup (this session's new
// list feature) says so.
function parseBodyHtml(html) {
  if (!html) return [];
  const cleaned = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  return splitTopLevelBlocks(cleaned).map((b) => {
    if (b.isBr) return { runs: [], listType: null, listIndex: null };
    const classMatch = (b.attrs || '').match(/class\s*=\s*"([^"]*)"/i);
    const cls = classMatch ? classMatch[1] : '';
    let listType = null;
    if (/\bnote-list-bullet\b/.test(cls)) listType = 'bullet';
    else if (/\bnote-list-dash\b/.test(cls)) listType = 'dash';
    else if (/\bnote-list-number\b/.test(cls)) listType = 'number';
    const idxMatch = (b.attrs || '').match(/data-list-index\s*=\s*"(\d+)"/i);
    return { runs: parseInlineRuns(b.raw), listType, listIndex: idxMatch ? Number(idxMatch[1]) : null };
  });
}

// ---------------- Layout (word-wrap) ----------------

// Real Adobe Core-14 AFM advance widths (1/1000 em) for Helvetica and
// Helvetica-Bold, covering the printable ASCII range - this is the standard,
// unchanging metrics table shipped with every PDF-capable font renderer,
// used here instead of a flat per-character average so words don't visibly
// drift out of position (a flat average badly underestimates wide letters
// like W/M, which was previously causing the next word to overlap it).
// Helvetica-Oblique/Helvetica-BoldOblique share the same widths as their
// upright counterparts (only the glyphs are slanted, not their metrics).
const HELVETICA_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260,
  125: 334, 126: 584,
};
const HELVETICA_BOLD_WIDTHS = {
  32: 278, 33: 333, 34: 474, 35: 556, 36: 556, 37: 889, 38: 722, 39: 238,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 333, 59: 333, 60: 584, 61: 584, 62: 584, 63: 611,
  64: 975, 65: 722, 66: 722, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 556, 75: 722, 76: 611, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 333, 92: 278, 93: 333, 94: 584, 95: 556,
  96: 333, 97: 556, 98: 611, 99: 556, 100: 611, 101: 556, 102: 333, 103: 611,
  104: 611, 105: 278, 106: 278, 107: 556, 108: 278, 109: 889, 110: 611,
  111: 611, 112: 611, 113: 611, 114: 389, 115: 556, 116: 333, 117: 611,
  118: 556, 119: 778, 120: 556, 121: 556, 122: 500, 123: 389, 124: 280,
  125: 389, 126: 584,
};
// Fallback width (1/1000 em) for anything outside the mapped ASCII range -
// extended Latin characters, or the bullet/en-dash list markers - averaged
// from the tables above, close enough for the odd one-off character.
const FALLBACK_CHAR_WIDTH = 556;

function charWidthUnits(ch, bold) {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const units = table[ch.codePointAt(0)];
  return units === undefined ? FALLBACK_CHAR_WIDTH : units;
}

// Sums real per-character advance widths rather than using a flat average -
// see the AFM table comment above for why that matters here.
function measureText(text, size, bold) {
  let total = 0;
  for (const ch of text) total += charWidthUnits(ch, bold);
  return (total / 1000) * size;
}

// Kept as a cheap per-character estimate only for the single-space-token
// case (never accumulated across a whole word, so the tiny fixed-width
// imprecision here never compounds into a visible drift).
function estCharWidth(size, bold) {
  return (charWidthUnits(' ', bold) / 1000) * size;
}

function fontNameFor(bold, italic) {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

const LIST_MARKER = { bullet: '•', dash: '–' };

// Flattens one block's runs into word/space/break tokens, then greedily
// wraps them into lines that fit `availWidth`. Returns { lines, indent,
// markerText } - `lines` is an array of arrays of {text,bold,italic,size}.
function layoutBlock(block, usableWidth, defaultSize) {
  const indent = block.listType ? 22 : 0;
  const markerText = block.listType === 'number'
    ? `${block.listIndex || 1}.`
    : LIST_MARKER[block.listType] || null;

  const tokens = [];
  block.runs.forEach((run) => {
    if (run.break) { tokens.push({ brk: true }); return; }
    const size = run.size || defaultSize;
    const parts = run.text.split(/(\s+)/).filter((p) => p !== '');
    parts.forEach((p) => {
      if (/^\s+$/.test(p)) tokens.push({ space: true, size });
      else tokens.push({ text: p, bold: run.bold, italic: run.italic, size });
    });
  });

  const availWidth = Math.max(20, usableWidth - indent);
  const lines = [];
  let current = [];
  let curWidth = 0;
  const pushLine = () => { lines.push(current); current = []; curWidth = 0; };

  tokens.forEach((t) => {
    if (t.brk) { pushLine(); return; }
    if (t.space) {
      if (current.length > 0) {
        current.push({ text: ' ', bold: false, italic: false, size: t.size });
        curWidth += estCharWidth(t.size, false);
      }
      return;
    }
    const width = measureText(t.text, t.size, t.bold);
    if (curWidth + width > availWidth && current.length > 0) pushLine();
    current.push(t);
    curWidth += width;
  });
  if (current.length > 0 || lines.length === 0) pushLine();

  return { lines, indent, markerText };
}

function lineHeightFor(lineWords, fallbackSize) {
  let maxSize = fallbackSize;
  lineWords.forEach((w) => { if (w.size && w.size > maxSize) maxSize = w.size; });
  return maxSize * LINE_HEIGHT_RATIO;
}

// Lays out every block of a text region into a flat list of renderable
// lines, and reports the total vertical space they need.
function layoutBlocks(blocks, width, defaultSize) {
  const allLines = [];
  blocks.forEach((block) => {
    if (block.runs.length === 0 && !block.listType) {
      allLines.push({ words: [], indent: 0, marker: null, height: defaultSize * LINE_HEIGHT_RATIO });
      return;
    }
    const { lines, indent, markerText } = layoutBlock(block, width, defaultSize);
    lines.forEach((words, li) => {
      allLines.push({ words, indent, marker: li === 0 ? markerText : null, height: lineHeightFor(words, defaultSize) });
    });
  });
  const totalHeight = allLines.reduce((sum, l) => sum + l.height, 0);
  return { allLines, totalHeight };
}

// ---------------- Content-stream emission ----------------

const FONT_KEYS = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Helvetica-Oblique': 'F3',
  'Helvetica-BoldOblique': 'F4',
};

// Appends the operators to draw `allLines` (from layoutBlocks) starting at
// (x, topOffset) measured in "distance down from the page's own top edge" -
// a coordinate system that stays valid however tall the final PDF page ends
// up being, since extra page height is always appended below, never above.
function emitTextLines(ops, allLines, x, topOffset, pageHeight) {
  let yFromTop = topOffset;
  allLines.forEach((line) => {
    const baselineFromTop = yFromTop + line.height * 0.78;
    const pdfY = pageHeight - baselineFromTop;
    if (line.marker) {
      const sz = line.height / LINE_HEIGHT_RATIO;
      ops.push(`BT /${FONT_KEYS.Helvetica} ${sz.toFixed(2)} Tf ${(x + 4).toFixed(2)} ${pdfY.toFixed(2)} Td (${pdfEscapeString(line.marker)}) Tj ET`);
    }
    let curX = x + line.indent;
    line.words.forEach((w) => {
      const size = w.size || DEFAULT_FONT_SIZE;
      if (w.text !== '') {
        const fn = FONT_KEYS[fontNameFor(w.bold, w.italic)];
        ops.push(`BT /${fn} ${size.toFixed(2)} Tf ${curX.toFixed(2)} ${pdfY.toFixed(2)} Td (${pdfEscapeString(w.text)}) Tj ET`);
      }
      curX += measureText(w.text, size, w.bold);
    });
    yFromTop += line.height;
  });
}

// ---------------- Image helpers ----------------

// Decodes a data: URL (the drawing canvas's own toDataURL('image/png')
// output) at the target pixel size and splits it into two layers: an opaque
// JPEG of its colors (composited over white, since JPEG has no alpha
// channel of its own) plus a raw grayscale alpha buffer for use as a PDF
// soft mask. The drawing sits on top of a page's actual text, so this can't
// just be flattened onto white and drawn full-bleed the way a document
// page's background image is - every pixel the user never actually drew on
// needs to stay genuinely transparent, or it would blank out everything
// underneath it. Returns null if the data URL can't be parsed.
async function drawingDataUrlToLayers(dataUrl, targetW, targetH) {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const img = await loadImage(buf);

  const alphaSrc = createCanvas(targetW, targetH);
  const alphaSrcCtx = alphaSrc.getContext('2d');
  alphaSrcCtx.drawImage(img, 0, 0, targetW, targetH);
  const { data } = alphaSrcCtx.getImageData(0, 0, targetW, targetH); // RGBA
  const alphaRaw = Buffer.alloc(targetW * targetH);
  for (let p = 0; p < targetW * targetH; p++) alphaRaw[p] = data[p * 4 + 3];
  const alphaFlate = zlib.deflateSync(alphaRaw);

  const colorCanvas = createCanvas(targetW, targetH);
  const colorCtx = colorCanvas.getContext('2d');
  colorCtx.fillStyle = '#ffffff';
  colorCtx.fillRect(0, 0, targetW, targetH);
  colorCtx.drawImage(img, 0, 0, targetW, targetH);
  const colorJpeg = await colorCanvas.encode('jpeg', JPEG_QUALITY);

  return { colorJpeg, alphaFlate };
}

// Loads an arbitrary image buffer (an uploaded document page's file) and
// fits it into boxW x boxH the same way CSS object-fit:contain does -
// scaled to fit without cropping, centered, on a white background.
async function containFitToJpeg(buffer, boxW, boxH) {
  const img = await loadImage(buffer);
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale, h = img.height * scale;
  const x = (boxW - w) / 2, y = (boxH - h) / 2;
  const canvas = createCanvas(boxW, boxH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, boxW, boxH);
  ctx.drawImage(img, x, y, w, h);
  return canvas.encode('jpeg', JPEG_QUALITY);
}

// ---------------- Note content parsing (mirrors the client's own tolerant
// parsing of content_html in app.js's openNote(), so old notes predating
// pagination/file-pages still export sensibly) ----------------

function parseNoteContent(contentHtml) {
  if (!contentHtml) return [{ type: 'text', html: '', annotations: [], drawing: null }];
  try {
    const parsed = JSON.parse(contentHtml);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((p) =>
        typeof p === 'string' ? { type: 'text', html: p, annotations: [], drawing: null } : { annotations: [], drawing: null, ...p }
      );
    }
  } catch (e) {
    // Not JSON - a legacy pre-pagination note storing raw HTML directly.
  }
  return [{ type: 'text', html: String(contentHtml), annotations: [], drawing: null }];
}

// ---------------- Per-page builders ----------------

// Builds one PDF page (image resources + content-stream ops) for a single
// note page entry, and adds it to `doc`. `pageHeight` is decided by the
// caller (fixed 820 for document pages; dynamic for text pages so nothing
// ever gets clipped).
async function buildPage(doc, entry, pageHeight, filesLookup) {
  const ops = [];
  const images = {};
  let imgCounter = 0;
  const registerImage = (jpegBuf, w, h) => {
    imgCounter += 1;
    const key = `Im${imgCounter}`;
    images[key] = doc.imageRef(jpegBuf, w, h);
    return key;
  };
  const registerMaskedImage = (jpegBuf, alphaFlate, w, h) => {
    imgCounter += 1;
    const key = `Im${imgCounter}`;
    images[key] = doc.imageRefWithMask(jpegBuf, w, h, alphaFlate);
    return key;
  };

  if (entry.type === 'document') {
    const file = filesLookup(entry.fileId);
    if (file) {
      try {
        const jpeg = await containFitToJpeg(file.buffer, PAGE_WIDTH, SHEET_HEIGHT);
        const key = registerImage(jpeg, PAGE_WIDTH, SHEET_HEIGHT);
        const y = pageHeight - SHEET_HEIGHT; // top-anchored, see SHEET_HEIGHT note
        ops.push(`q ${PAGE_WIDTH} 0 0 ${SHEET_HEIGHT} 0 ${y} cm /${key} Do Q`);
      } catch (e) {
        // Corrupt/missing file on disk - fall back to a blank sheet rather
        // than failing the whole export.
      }
    }
  } else {
    const blocks = parseBodyHtml(entry.html || '');
    const { allLines } = layoutBlocks(blocks, PAGE_WIDTH - PAD_X * 2, DEFAULT_FONT_SIZE);
    emitTextLines(ops, allLines, PAD_X, PAD_TOP, pageHeight);
  }

  if (entry.drawing) {
    try {
      const layers = await drawingDataUrlToLayers(entry.drawing, PAGE_WIDTH, SHEET_HEIGHT);
      if (layers) {
        const key = registerMaskedImage(layers.colorJpeg, layers.alphaFlate, PAGE_WIDTH, SHEET_HEIGHT);
        const y = pageHeight - SHEET_HEIGHT;
        ops.push(`q ${PAGE_WIDTH} 0 0 ${SHEET_HEIGHT} 0 ${y} cm /${key} Do Q`);
      }
    } catch (e) {
      // Malformed drawing data URL - skip it rather than failing the export.
    }
  }

  for (const ann of entry.annotations || []) {
    const blocks = parseBodyHtml(ann.html || '');
    const boxTopFromPageTop = (pageHeight - SHEET_HEIGHT) + ann.y;
    const { allLines } = layoutBlocks(blocks, Math.max(10, ann.w - 8), DEFAULT_FONT_SIZE * 0.75);
    // Clip to the text box's own bounds so overflowing annotation text
    // doesn't spill across the rest of the page, matching the on-screen box.
    const clipX = 0, clipW = PAGE_WIDTH; // horizontal clip skipped (annotations are already wrapped to their width); only clip vertically
    const clipYBottom = pageHeight - (boxTopFromPageTop + ann.h);
    ops.push(`q ${clipX} ${clipYBottom.toFixed(2)} ${clipW} ${ann.h.toFixed(2)} re W n`);
    emitTextLines(ops, allLines, ann.x + 4, boxTopFromPageTop + 4, pageHeight);
    ops.push('Q');
  }

  const fonts = {
    [FONT_KEYS.Helvetica]: doc.fontRef('Helvetica'),
    [FONT_KEYS['Helvetica-Bold']]: doc.fontRef('Helvetica-Bold'),
    [FONT_KEYS['Helvetica-Oblique']]: doc.fontRef('Helvetica-Oblique'),
    [FONT_KEYS['Helvetica-BoldOblique']]: doc.fontRef('Helvetica-BoldOblique'),
  };
  doc.addPage(PAGE_WIDTH, pageHeight, ops, { fonts, images });
}

// Builds the complete PDF buffer for a note. `getFileForId(fileId)` should
// return { buffer, mimeType } for an uploaded document-page file, or null if
// it's missing - kept as an injected function rather than reaching into the
// database/filesystem directly, so this module stays a pure "content in,
// PDF bytes out" transform.
async function buildNotePdf(note, getFileForId) {
  const entries = parseNoteContent(note.content_html);
  const doc = new PdfWriter();

  for (const entry of entries) {
    let pageHeight = SHEET_HEIGHT;
    if (entry.type !== 'document') {
      const blocks = parseBodyHtml(entry.html || '');
      const { totalHeight } = layoutBlocks(blocks, PAGE_WIDTH - PAD_X * 2, DEFAULT_FONT_SIZE);
      pageHeight = Math.max(SHEET_HEIGHT, Math.ceil(totalHeight) + PAD_TOP + PAD_BOTTOM);
    }
    await buildPage(doc, entry, pageHeight, getFileForId);
  }

  return doc.build();
}

module.exports = { buildNotePdf, parseNoteContent, parseBodyHtml };
