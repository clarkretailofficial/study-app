// noteText.js
// Turns a note's stored content (the same JSON page-array notePdf.js reads
// to lay out a PDF) into plain text, for handing to the AI when generating a
// study set - reuses notePdf.js's own HTML parsing rather than writing a
// second one, so list markers/formatting never drift between what the PDF
// export shows and what the AI sees.
const { parseNoteContent, parseBodyHtml } = require('./notePdf');

// Keeps a single request to the AI bounded in size (and cost) regardless of
// how long a note gets - a note this long already has more than enough
// material for any study set length we offer, so trimming the tail doesn't
// meaningfully hurt what the AI can generate from it.
const MAX_CHARS = 20000;

const LIST_MARKER_PREFIX = {
  bullet: '- ',
  dash: '- ',
  number: '', // numbering isn't tracked here the way notePdf.js does per-list -
              // the AI doesn't need literal "1. 2. 3." to understand the content.
  checklist: '- ',
};

function blockToPlainLine(block) {
  const text = (block.runs || [])
    .map((r) => (r.break ? '\n' : r.text || ''))
    .join('')
    .trim();
  if (!text) return '';
  const prefix = block.listType ? LIST_MARKER_PREFIX[block.listType] || '' : '';
  return prefix + text;
}

// Returns plain text for one note, or '' if the note has no extractable text
// (e.g. it's entirely an uploaded PDF/image page with no typed content).
function noteToPlainText(note) {
  const pages = parseNoteContent(note.content_html);
  const lines = [];
  let hadDocumentPage = false;

  for (const page of pages) {
    if (page.type === 'document') {
      hadDocumentPage = true;
      continue; // an uploaded PDF/image page - no text to extract from it here
    }
    const blocks = parseBodyHtml(page.html);
    for (const block of blocks) {
      const line = blockToPlainLine(block);
      if (line) lines.push(line);
    }
  }

  if (hadDocumentPage && lines.length === 0) {
    // Every page was an uploaded document with no typed notes at all -
    // nothing for the AI to read; let the caller decide how to message this.
    return '';
  }

  let text = lines.join('\n');
  if (hadDocumentPage) {
    text += '\n\n[Note: this note also includes uploaded PDF/image page(s) whose content could not be read as text and was left out of what follows.]';
  }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + '\n\n[...note truncated for length...]';
  }
  return text;
}

module.exports = { noteToPlainText };
