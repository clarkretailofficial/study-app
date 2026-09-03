// templates.js
// Central registry of note templates. Free plan currently gets "blank" and "lined".
// Later, paid-only templates can be added here with paidOnly: true and everything
// (validation + the picker UI's "locked" state) picks it up automatically.
const { planAtLeast } = require('./plans');

const TEMPLATES = [
  { id: 'blank', label: 'Blank page', description: 'A plain page with no lines.', paidOnly: false },
  { id: 'lined', label: 'Lined page', description: 'Ruled paper, like a notebook.', paidOnly: false },
  { id: 'cornell', label: 'Cornell notes', description: 'A cue column, notes column, and summary section, laid out for the Cornell note-taking method.', paidOnly: true },
  { id: 'graph', label: 'Graph paper', description: 'A grid of light squares, useful for math, diagrams, and charts.', paidOnly: true },
  { id: 'dotgrid', label: 'Dot grid', description: 'A grid of light dots - handy for bullet journaling, sketching, or diagrams that don\'t need full ruled lines.', paidOnly: true },
  { id: 'wideruled', label: 'Wide ruled', description: 'Wider-spaced ruled lines than the standard lined page - easier for handwriting.', paidOnly: true },
];

const DEFAULT_TEMPLATE = 'blank';

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id);
}

function isTemplateAllowedForPlan(id, plan) {
  const template = getTemplate(id);
  if (!template) return false;
  if (template.paidOnly && !planAtLeast(plan, 'paid')) return false;
  return true;
}

function templatesForClient(plan) {
  return TEMPLATES.map((t) => ({
    ...t,
    locked: t.paidOnly && !planAtLeast(plan, 'paid'),
  }));
}

module.exports = { TEMPLATES, DEFAULT_TEMPLATE, getTemplate, isTemplateAllowedForPlan, templatesForClient };
