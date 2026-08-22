// pdfRender.js
// Turns an uploaded PDF into a series of PNG page images, server-side, so a
// PDF can be shown as fixed, read-only "pages" inside a note - the same way
// a scanned document looks in an app like GoodNotes. Images (jpg/png/etc.)
// need no conversion at all and are handled directly in server.js; this
// module only deals with the PDF case.
//
// This is the one real npm dependency this project takes on (everything
// else is Node's own built-ins) - there is no reliable way to rasterize a
// PDF into page images without a real PDF-parsing engine. It uses:
//   - pdfjs-dist: Mozilla's own PDF engine (the same one behind Firefox's
//     built-in PDF viewer), used here in its "legacy" Node-compatible build.
//   - @napi-rs/canvas: a native <canvas> implementation for Node, which
//     pdfjs-dist renders each page into (it's an optional dependency of
//     pdfjs-dist itself, so `npm install pdfjs-dist` pulls in a prebuilt
//     binary for whatever platform it's installed on automatically).

// Loaded lazily via dynamic import() (pdfjs-dist's legacy build ships as an
// ES module) and cached after the first call.
let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLibPromise;
}

// A safety valve against someone uploading a huge document (a 400-page
// textbook scan, say) and tying up the server rendering all of it. Pages
// beyond this are simply not rendered; the caller is told how many pages
// the original document actually had so it can show a friendly note.
const MAX_PDF_PAGES = 40;

// How much to scale each PDF page up before rasterizing it - PDF points are
// roughly 72 per inch, so a plain 1x render tends to look soft/blurry once
// displayed at typical screen sizes. 1.6x keeps text crisp without making
// files unreasonably large.
const RENDER_SCALE = 1.6;

// Renders every page of `buffer` (the raw bytes of an uploaded PDF) to a PNG
// image buffer. Returns { pages: Buffer[], totalPages, truncated }.
// Throws if the PDF can't be parsed at all (corrupted file, password-
// protected, etc.) - the caller is expected to catch that and show a
// friendly error rather than a crash.
async function renderPdfToPngPages(buffer) {
  const pdfjsLib = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');

  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  const totalPages = doc.numPages;
  const pageCount = Math.min(totalPages, MAX_PDF_PAGES);
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    pages.push(await canvas.encode('png'));
    page.cleanup();
  }
  await doc.destroy();

  return { pages, totalPages, truncated: totalPages > MAX_PDF_PAGES };
}

module.exports = { renderPdfToPngPages, MAX_PDF_PAGES };
