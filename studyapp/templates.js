// templates.js
// Central registry of note templates. Free plan currently gets "blank" and "lined".
// Later, paid-only templates can be added here with paidOnly: true and everything
// (validation + the picker UI's "locked" state) picks it up automatically.
const TEMPLATES = [
  { id: 'blank', label: 'Blank page', description: 'A plain page with no lines.', paidOnly: false },
  { id: 'lined', label: 'Lined page', description: 'Ruled paper, like a notebook.', paidOnly: false },
];

const DEFAULT_TEMPLATE = 'blank';

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id);
}

function isTemplateAllowedForPlan(id, plan) {
  const template = getTemplate(id);
  if (!template) return false;
  if (template.paidOnly && plan !== 'paid') return false;
  return true;
}

function templatesForClient(plan) {
  return TEMPLATES.map((t) => ({
    ...t,
    locked: t.paidOnly && plan !== 'paid',
  }));
}

module.exports = { TEMPLATES, DEFAULT_TEMPLATE, getTemplate, isTemplateAllowedForPlan, templatesForClient };
