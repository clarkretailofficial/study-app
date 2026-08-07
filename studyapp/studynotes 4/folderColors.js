// folderColors.js
// Central registry of the folder color-coding options. Ten choices, each with
// a soft fill and a slightly darker stroke so the little folder icon reads
// clearly against the white card background. `key` is what's actually stored
// on the folder in the database; `fill`/`stroke` are only used client-side to
// draw the icon, but are served from here (like templates.js) so the server
// and the client always agree on what's valid.
const FOLDER_COLORS = [
  { key: 'amber', label: 'Amber', fill: '#fbd077', stroke: '#d9a441' },
  { key: 'red', label: 'Red', fill: '#f5a3a3', stroke: '#d96b6b' },
  { key: 'orange', label: 'Orange', fill: '#f7b978', stroke: '#d98a3f' },
  { key: 'yellow', label: 'Yellow', fill: '#f5e07a', stroke: '#d9c23f' },
  { key: 'green', label: 'Green', fill: '#a8e0a0', stroke: '#6bbd63' },
  { key: 'teal', label: 'Teal', fill: '#8fd9c9', stroke: '#4fae98' },
  { key: 'blue', label: 'Blue', fill: '#a8c8f5', stroke: '#6b96d9' },
  { key: 'purple', label: 'Purple', fill: '#c9a8f5', stroke: '#9a63d9' },
  { key: 'pink', label: 'Pink', fill: '#f5a8d9', stroke: '#d963ae' },
  { key: 'gray', label: 'Gray', fill: '#c9ccd6', stroke: '#9599a8' },
];

const DEFAULT_FOLDER_COLOR = 'amber';

function isValidFolderColor(key) {
  return FOLDER_COLORS.some((c) => c.key === key);
}

module.exports = { FOLDER_COLORS, DEFAULT_FOLDER_COLOR, isValidFolderColor };
