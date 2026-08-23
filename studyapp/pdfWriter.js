// pdfWriter.js
// A minimal, dependency-free PDF 1.4 writer - just enough of the spec to
// emit a multi-page document containing JPEG images and word-wrapped text
// in the standard 14 fonts (Helvetica and friends, built into every PDF
// reader - no font embedding needed). Written by hand, in the same spirit
// as this project's other zero-npm-dependency modules (see server.js's own
// top-of-file comment and pdfRender.js's notes on why pdfjs-dist is the one
// exception) - "Download as PDF" doesn't need a full PDF-generation library
// when the actual surface area needed (a handful of image + text pages) is
// this small.
const zlib = require('node:zlib');

// WinAnsiEncoding (the encoding every font in this file uses) matches
// Unicode/Latin-1 code points exactly for 0x00-0x7F and 0xA0-0xFF, but its
// 0x80-0x9F range is remapped to Windows-1252's punctuation block instead of
// Latin-1's control characters - that's where the bullet (•), en dash (–)
// and friends actually live. Without this table those characters have no
// representable Latin-1 byte at all and would silently fall back to '?'.
const WINANSI_HIGH_MAP = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Maps one character to its WinAnsiEncoding byte value, or null if it has
// none (falls back to '?' at the call site).
function winAnsiByte(codePoint) {
  if (codePoint <= 0x7f) return codePoint;
  if (WINANSI_HIGH_MAP[codePoint] !== undefined) return WINANSI_HIGH_MAP[codePoint];
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return null;
}

// PDF's literal-string syntax (the "(...)" form used for Tj) only needs '(',
// ')' and '\' backslash-escaped. Anything with no WinAnsiEncoding byte at
// all can't be represented without embedding a Unicode font, which is well
// beyond what this needs - those characters fall back to '?' rather than
// corrupting the file or silently vanishing.
function pdfEscapeString(str) {
  let out = '';
  for (const ch of String(str)) {
    const byte = winAnsiByte(ch.codePointAt(0));
    if (byte === null) { out += '?'; continue; }
    const mapped = String.fromCharCode(byte);
    if (mapped === '(' || mapped === ')' || mapped === '\\') out += '\\' + mapped;
    else out += mapped;
  }
  return out;
}

class PdfWriter {
  constructor() {
    // 1-indexed PDF object numbers map to (index+1) in this array. Objects 1
    // (Catalog) and 2 (Pages) are reserved up front and filled in by build()
    // once every page has been added, so page/font/image objects can start
    // at 3 without needing a second numbering pass.
    this._objects = [null, null];
    this._pageRefs = [];
    this._fontRefs = {}; // BaseFont name -> object number, memoized
  }

  _alloc() {
    this._objects.push(null);
    return this._objects.length;
  }

  // Returns the object number for one of the standard 14 fonts, allocating
  // it the first time it's requested and reusing the same object (and PDF
  // object number) for every page that references it afterwards.
  fontRef(baseFont) {
    if (this._fontRefs[baseFont]) return this._fontRefs[baseFont];
    const n = this._alloc();
    this._objects[n - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`;
    this._fontRefs[baseFont] = n;
    return n;
  }

  // Registers a raw JPEG buffer as an Image XObject (via /DCTDecode - the
  // bytes are embedded exactly as-is, no re-encoding) and returns its object
  // number.
  imageRef(jpegBuffer, width, height) {
    const n = this._alloc();
    this._objects[n - 1] = {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuffer.length} >>`,
      stream: jpegBuffer,
    };
    return n;
  }

  // Same as imageRef(), but with an accompanying alpha channel (a soft mask)
  // so transparent areas of the image let whatever's underneath it on the
  // page show through - needed for the freehand drawing overlay, which sits
  // on top of a page's own text and must stay transparent everywhere the
  // user didn't actually draw. `maskFlateBuffer` is a zlib-deflated buffer
  // of raw 8-bit grayscale alpha values, one byte per pixel, row-major.
  imageRefWithMask(jpegBuffer, width, height, maskFlateBuffer) {
    const maskObjNum = this._alloc();
    this._objects[maskObjNum - 1] = {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${maskFlateBuffer.length} >>`,
      stream: maskFlateBuffer,
    };
    const n = this._alloc();
    this._objects[n - 1] = {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask ${maskObjNum} 0 R /Length ${jpegBuffer.length} >>`,
      stream: jpegBuffer,
    };
    return n;
  }

  // Adds one page. `ops` is an array of already-formed content-stream
  // operator strings; `resources` is { fonts: {LocalName: objNum}, images:
  // {LocalName: objNum} }.
  addPage(width, height, ops, resources) {
    const compressed = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
    const contentObjNum = this._alloc();
    this._objects[contentObjNum - 1] = {
      dict: `<< /Length ${compressed.length} /Filter /FlateDecode >>`,
      stream: compressed,
    };

    const fontEntries = Object.entries((resources && resources.fonts) || {})
      .map(([name, objNum]) => `/${name} ${objNum} 0 R`).join(' ');
    const imgEntries = Object.entries((resources && resources.images) || {})
      .map(([name, objNum]) => `/${name} ${objNum} 0 R`).join(' ');
    const resParts = [];
    if (fontEntries) resParts.push(`/Font << ${fontEntries} >>`);
    if (imgEntries) resParts.push(`/XObject << ${imgEntries} >>`);

    const pageObjNum = this._alloc();
    this._objects[pageObjNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << ${resParts.join(' ')} >> /Contents ${contentObjNum} 0 R >>`;
    this._pageRefs.push(pageObjNum);
    return pageObjNum;
  }

  // Serializes everything into a complete PDF file buffer.
  build() {
    this._objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
    const kids = this._pageRefs.map((n) => `${n} 0 R`).join(' ');
    this._objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${this._pageRefs.length} >>`;

    const chunks = [];
    let offset = 0;
    const push = (val) => {
      const buf = Buffer.isBuffer(val) ? val : Buffer.from(val, 'latin1');
      chunks.push(buf);
      offset += buf.length;
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const xrefOffsets = new Array(this._objects.length + 1).fill(0);
    for (let i = 0; i < this._objects.length; i++) {
      const objNum = i + 1;
      xrefOffsets[objNum] = offset;
      const obj = this._objects[i];
      if (obj == null) {
        push(`${objNum} 0 obj\n<< >>\nendobj\n`);
      } else if (typeof obj === 'string') {
        push(`${objNum} 0 obj\n${obj}\nendobj\n`);
      } else {
        push(`${objNum} 0 obj\n${obj.dict}\nstream\n`);
        push(obj.stream);
        push('\nendstream\nendobj\n');
      }
    }

    const xrefStart = offset;
    const total = this._objects.length + 1;
    push(`xref\n0 ${total}\n`);
    push('0000000000 65535 f \n');
    for (let objNum = 1; objNum < total; objNum++) {
      push(String(xrefOffsets[objNum]).padStart(10, '0') + ' 00000 n \n');
    }
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    return Buffer.concat(chunks);
  }
}

module.exports = { PdfWriter, pdfEscapeString, winAnsiByte };
