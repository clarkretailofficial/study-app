// plans.js
// Central definition of ScribeStack's plan tiers and their ranking, so
// "does this account have at least Premium" (or Pro) can be checked
// consistently everywhere instead of ad-hoc string equality scattered across
// server.js. Pro is a strict superset of Premium - anyone on Pro keeps every
// Premium perk (unlimited notes, file uploads, drawing, templates, note
// locking, folder export, the raised upload cap) plus the AI study-set tools
// that are Pro-only.
const PLAN_RANK = { free: 0, paid: 1, pro: 2 };

function planAtLeast(plan, minPlan) {
  return (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[minPlan] ?? 0);
}

module.exports = { PLAN_RANK, planAtLeast };
