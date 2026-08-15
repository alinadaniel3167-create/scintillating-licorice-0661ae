/* ==========================================================================
   CloakShield Pro — workspace subscription panel and account state

   Two jobs on one page. The panel is the only route to the crypto checkout:
   plans are chosen here rather than on the marketing page, so a visitor
   always has an account and a confirmed address before an invoice exists.
   Prices come from the shared pricing model, never from the markup.

   The rest of the file renders the account strip and the console lock, which
   answer the question a greyed-out tool raises — signed in as whom, address
   confirmed or not, plan none, pending or active.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  var P = window.CSPricing;
  var A = window.CSAccount;
  if (!P) return;

  var acct = (A && A.get()) || null;
  var sub = (A && A.subscription()) || null;
  var status = (A && A.subStatus()) || 'none';

  /* ---------- Account strip and console lock ------------------------------
     Runs for any signed-in visitor, including one whose plan is already live
     and therefore has no subscription panel on the page at all. */

  doc.addEventListener('DOMContentLoaded', function () {
    if (!acct) return;

    var text = function (id, value) {
      var node = doc.getElementById(id);
      if (node) node.textContent = value;
    };

    var planQuote = sub ? P.quote(sub.plan, Number(sub.months)) : null;

    text('barEmail', acct.email || '—');
    text('barVerify', acct.verified ? 'Confirmed' : 'Not confirmed');
    text('barPlan', planQuote ? planQuote.plan.name + ' · ' + planQuote.termShort : 'None');
    text('barState', status === 'active' ? 'Live traffic'
      : status === 'pending' ? 'Awaiting payment'
      : 'Sample data');

    var verifyEl = doc.getElementById('barVerify');
    if (verifyEl) verifyEl.className = 'acctbar__v ' + (acct.verified ? 'is-ok' : 'is-warn');

    var stateEl = doc.getElementById('barState');
    if (stateEl) stateEl.className = 'acctbar__v ' + (status === 'active' ? 'is-ok' : 'is-warn');

    if (status === 'pending' && sub) {
      text('pendRef', sub.reference || 'pending');
      text('pendPlan', planQuote.plan.name + ' · ' + planQuote.termLabel);
      var lockD = doc.getElementById('conlockD');
      if (lockD) {
        lockD.textContent = 'Your payment has been marked as sent and is being matched against the chain. ' +
          'Tools unlock automatically once it confirms — nothing else is needed from you.';
      }
      var lockGo = doc.getElementById('conlockGo');
      if (lockGo) lockGo.textContent = 'Review the order';
    }

    if (status === 'active' && planQuote) {
      text('liveePlan', planQuote.plan.name);
      text('liveTerm', planQuote.termLabel + (planQuote.discount > 0 ? ' · −' + planQuote.offPct + '%' : ''));
      text('liveTotal', P.money(planQuote.total));
      text('liveRef', sub.reference || '—');

      /* The console header still says "sample data" in the markup, because
         that is what an unsubscribed account sees. A live plan replaces it. */
      var lede = $('.section-head[data-account-show] .lede');
      if (lede) {
        lede.textContent = 'Scoring is running against your own domains. The verdict log, integrity checks and ' +
          'integrations below reflect the campaigns your platform is routing right now.';
      }

      /* And the console chrome names the account rather than the sample one. */
      if (acct.name) {
        text('wsWho', acct.name);
        text('wsAv', initials(acct.name));
        text('wsUrl', 'app.cloakshield.io/workspace/' + slug(acct.name) + '/overview');
      }
    }
  });

  /* Two initials for the avatar chip, from however many words the name has. */
  function initials(name) {
    var parts = String(name).trim().split(/\s+/);
    var first = parts[0] ? parts[0].charAt(0) : '';
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase() || '—';
  }

  function slug(name) {
    return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  }

  /* ---------- The plan picker --------------------------------------------- */

  var panel = $('#subscribe');
  if (!panel) return;

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
  } else if (status === 'pending') {
    /* An order is already in flight. The picker stays usable — a term can
       still be changed before the transfer lands — but the button says what
       it will actually do rather than pretending nothing has happened. */
    el.badge.textContent = 'Payment pending';
    el.go.textContent = 'Return to payment';
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
