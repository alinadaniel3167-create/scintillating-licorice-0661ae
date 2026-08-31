/* ==========================================================================
   Server-side pricing.

   IMPORTANT: this mirrors js/pricing.js, which remains the source of truth
   for what the site *displays*. The duplication is deliberate — the browser
   copy has no build step and cannot be imported here, and a price the client
   sends must never be trusted. Change one, change the other, exactly as the
   tier cards' data-monthly / data-annual attributes already require.

   Ladder: 0 / 10 / 10 / 15 / 20 percent for 1, 2, 3, 6 and 12 months. Twelve
   months is the published annual rate ($1,440 / $3,360 / $4,800).
   ========================================================================== */

export interface Plan {
  id: string
  name: string
  monthly: number
}

export interface Term {
  months: number
  off: number
  label: string
  short: string
}

export interface Quote {
  plan: Plan
  planId: string
  months: number
  termLabel: string
  termShort: string
  offPct: number
  list: number
  discount: number
  total: number
}

const PLANS: Record<string, Plan> = {
  starter: { id: 'starter', name: 'Starter', monthly: 150 },
  professional: { id: 'professional', name: 'Professional', monthly: 350 },
  enterprise: { id: 'enterprise', name: 'Enterprise', monthly: 500 }
}

const TERMS: Record<string, Term> = {
  '1': { months: 1, off: 0, label: '1 month', short: '1 mo' },
  '2': { months: 2, off: 0.1, label: '2 months', short: '2 mo' },
  '3': { months: 3, off: 0.1, label: '3 months', short: '3 mo' },
  '6': { months: 6, off: 0.15, label: '6 months', short: '6 mo' },
  '12': { months: 12, off: 0.2, label: '12 months', short: '12 mo' }
}

export function isKnownPlan(id: string) {
  return Object.prototype.hasOwnProperty.call(PLANS, id)
}

export function isKnownTerm(months: string | number) {
  return Object.prototype.hasOwnProperty.call(TERMS, String(months))
}

function cents(n: number) {
  return Math.round(n * 100) / 100
}

export function quote(planId: string, months: string | number): Quote {
  const plan = PLANS[planId] || PLANS.professional
  const term = TERMS[String(months)] || TERMS['1']
  const list = cents(plan.monthly * term.months)
  const discount = cents(list * term.off)

  return {
    plan,
    planId: plan.id,
    months: term.months,
    termLabel: term.label,
    termShort: term.short,
    offPct: Math.round(term.off * 100),
    list,
    discount,
    total: cents(list - discount)
  }
}
