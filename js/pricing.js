/* ==========================================================================
   Shared pricing model — used by the homepage calculator and the checkout.
   One source of truth so the two can never disagree.
   ========================================================================== */

window.CSPricing = (function () {
  'use strict';

  var PLANS = {
    starter:      { id: 'starter',      name: 'Starter',      monthly: 150 },
    professional: { id: 'professional', name: 'Professional', monthly: 350 },
    enterprise:   { id: 'enterprise',   name: 'Enterprise',   monthly: 500 }
  };

  /* Term discounts. 12 months is the published annual rate (20% off),
     which is why the tiers show $1,440 / $3,360 / $4,800 per year. */
  var TERMS = {
    1:  { months: 1,  off: 0,    label: '1 month',   short: '1 mo'  },
    2:  { months: 2,  off: 0.10, label: '2 months',  short: '2 mo'  },
    3:  { months: 3,  off: 0.10, label: '3 months',  short: '3 mo'  },
    6:  { months: 6,  off: 0.15, label: '6 months',  short: '6 mo'  },
    12: { months: 12, off: 0.20, label: '12 months', short: '12 mo' }
  };

  function plan(id) {
    return PLANS[id] || PLANS.professional;
  }

  function term(months) {
    return TERMS[String(months)] || TERMS[1];
  }

  /* Round to cents to keep display and arithmetic in agreement. */
  function cents(n) {
    return Math.round(n * 100) / 100;
  }

  function quote(planId, months) {
    var p = plan(planId);
    var t = term(months);
    var list = cents(p.monthly * t.months);
    var discount = cents(list * t.off);
    var total = cents(list - discount);

    return {
      plan: p,
      planId: p.id,
      months: t.months,
      termLabel: t.label,
      termShort: t.short,
      off: t.off,
      offPct: Math.round(t.off * 100),
      list: list,
      discount: discount,
      total: total,
      perMonth: cents(total / t.months)
    };
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  return {
    PLANS: PLANS,
    TERMS: TERMS,
    plan: plan,
    term: term,
    quote: quote,
    money: money
  };
})();
