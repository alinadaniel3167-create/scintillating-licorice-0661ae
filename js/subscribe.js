/* ==========================================================================
   CloakShield Pro — workspace subscription panel

   The only route to the crypto checkout. Plans are chosen here rather than
   on the marketing page, so a visitor always has an account and a confirmed
   address before an invoice exists. Prices come from the shared pricing
   model, never from the markup.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  var panel = $('#subscribe');
  if (!panel) return;

  var P = window.CSPricing;
  var A = window.CSAccount;
  if (!P) return;

  var el = {
    plans: $$('[data-plan]', panel),
    terms: $$('[data-months]', panel),
    line: $('#subLine'),
    total: $('#subTotal'),
    per: $('#subPer'),
    go: $('#subGo'),
    badge: $('#subBadge'),
    lock: $('#subLock'),
    lockLink: $('#subLockLink')
  };

  var acct = (A && A.get()) || null;

  /* The plan the visitor was reading before they registered is carried all
     the way here, so the panel opens pre-selected on it. */
  var params = new URLSearchParams(location.search);
  var state = {
    plan: params.get('plan') || (acct && acct.plan) || 'professional',
    months: Number(params.get('months') || (acct && acct.months) || 1)
  };

  if (!P.PLANS[state.plan]) state.plan = 'professional';
  if (!P.TERMS[state.months]) state.months = 1;

  var verified = Boolean(acct && acct.verified);

  /* ---------- Render ----------------------------------------------------- */

  function render() {
    var q = P.quote(state.plan, state.months);

    el.plans.forEach(function (btn) {
      btn.setAttribute('aria-checked', String(btn.getAttribute('data-plan') === state.plan));
    });

    el.terms.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(Number(btn.getAttribute('data-months')) === state.months));
    });

    el.line.textContent = q.plan.name + ' · ' + q.termLabel +
      (q.discount > 0 ? ' · −' + q.offPct + '%' : '');
    el.total.textContent = P.money(q.total);
    el.per.textContent = P.money(q.perMonth) + ' per month';

    el.go.setAttribute('href', '/checkout.html?plan=' + q.planId + '&months=' + q.months);

    /* Remember the selection, so a reload — or the checkout guard sending
       the visitor back here — reopens on the same choice. Only for a real
       account: an anonymous visitor reading the preview has nothing to
       remember it against. */
    if (A && acct) A.save({ plan: q.planId, months: String(q.months) });
  }

  /* ---------- Unconfirmed accounts --------------------------------------- */

  if (!verified) {
    el.lock.hidden = false;
    el.badge.textContent = 'Email not confirmed';
    el.go.classList.add('is-off');
    el.go.setAttribute('aria-disabled', 'true');

    el.go.addEventListener('click', function (e) {
      e.preventDefault();
      location.href = '/welcome.html?plan=' + state.plan + '&months=' + state.months;
    });

    if (el.lockLink) {
      el.lockLink.setAttribute('href', '/welcome.html?plan=' + state.plan + '&months=' + state.months);
    }
  }

  /* ---------- Controls ---------------------------------------------------- */

  el.plans.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.plan = btn.getAttribute('data-plan');
      render();
    });
  });

  el.terms.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.months = Number(btn.getAttribute('data-months'));
      render();
    });
  });

  render();
})();
