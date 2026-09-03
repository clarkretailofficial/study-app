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

// How many AI generations (a study set, a note summary, or one question asked
// via "Ask your notes" all count as one each) a plan gets per calendar month.
// Premium's 5 is a free taste of the Pro AI tools, not a real workload - it's
// there so someone can see what Pro is like before paying for the higher
// limit. Free gets none; the AI routes in server.js refuse it outright rather
// than reading 0 from here, but it's listed for completeness.
const MONTHLY_AI_GENERATION_LIMITS = { free: 0, paid: 5, pro: 40 };

// A Pro-only one-time purchase for when the monthly allowance runs out
// mid-month (see POST /api/billing/topup in server.js) - bonus generations
// never expire/reset, unlike the monthly counter above, since the user paid
// for them specifically.
const GENERATION_TOPUP_PRICE_USD = 3.99;
const GENERATION_TOPUP_AMOUNT = 10;

module.exports = {
  PLAN_RANK,
  planAtLeast,
  MONTHLY_AI_GENERATION_LIMITS,
  GENERATION_TOPUP_PRICE_USD,
  GENERATION_TOPUP_AMOUNT,
};
