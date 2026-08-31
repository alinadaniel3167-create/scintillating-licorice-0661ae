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

  /* A term end, written the way a date is read rather than the way it is
     stored. Returns null for an order the server could not date, which the
     callers show as an em dash rather than as "Invalid Date". */
  function termDay(ms) {
    if (!ms) return null;
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ---------- Account strip and console lock ------------------------------
     Runs for any signed-in visitor, including one whose plan is already live
     and therefore has no subscription panel on the page at all.

     Re-runnable, and run twice on purpose: once from the cached record so the
     panel is populated on the first paint, and again when /api/subscription
     answers. The second pass is what a customer whose payment confirmed in
     another tab depends on — without it the panel would show whatever the
     cache last knew, which on the load right after a payment is the state
     before it. */

  function renderAccount() {
    if (!acct) return;

    sub = (A && A.subscription()) || null;
    status = (A && A.subStatus()) || 'none';

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

    /* A term that ended. The status is 'none' from here on, so the picker is
       already back on screen — this only names what ran out and when, because
       "choose a plan" is a strange thing to read three days after paying for
       one. */
    var lapsed = A && A.lapsedTerm ? A.lapsedTerm() : null;
    var lapseNote = doc.getElementById('lapseNote');

    if (lapseNote) {
      var showLapse = Boolean(lapsed && status === 'none');
      lapseNote.hidden = !showLapse;

      if (showLapse) {
        var lapseQuote = P.PLANS[lapsed.plan] ? P.quote(lapsed.plan, Number(lapsed.months)) : null;
        text('lapsePlan', lapseQuote ? lapseQuote.plan.name + ' · ' + lapseQuote.termLabel : 'Your plan');
        text('lapseEnds', termDay(lapsed.termEndsAt) || 'its end date');
      }
    }

    if (status === 'active' && planQuote) {
      text('liveePlan', planQuote.plan.name);
      text('liveTerm', planQuote.termLabel + (planQuote.discount > 0 ? ' · −' + planQuote.offPct + '%' : ''));
      text('liveTotal', P.money(planQuote.total));
      text('liveEnds', termDay(sub.termEndsAt) || '—');
      text('liveRef', sub.reference || '—');

      /* The renewal route. Crypto cannot auto-charge, so an active plan with
         no way to extend it is a plan that ends without warning — this was the
         one subscription state the site offered no way out of. Extending is a
         new order for the same tier and term; the server chains its term end
         onto this one rather than starting from today, so paying early costs
         nothing. */
      var renew = doc.getElementById('liveRenew');
      if (renew) {
        renew.setAttribute('href',
          '/checkout.html?plan=' + encodeURIComponent(planQuote.planId) +
          '&months=' + encodeURIComponent(planQuote.months));
      }

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
  }

  doc.addEventListener('DOMContentLoaded', function () {
    acct = (A && A.get()) || null;
    renderAccount();

    /* The authoritative pass. account.js has already started this fetch, and
       sync() hands back the same in-flight promise rather than issuing a
       second request. */
    if (A && A.sync) {
      A.sync().then(function () {
        acct = (A && A.get()) || null;
        renderAccount();
      });
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

  /* ---------- Changing a live plan ---------------------------------------
     The picker belongs to data-sub-show="none pending": an active plan gets
     the billing summary in its place, which is right, because the common case
     for a paid customer is not shopping. "Change plan" opens it anyway — the
     only route to a different tier or a different term that does not involve
     waiting for the current one to run out.

     The attribute is removed rather than the panel just unhidden, because
     js/account.js re-applies data-sub-show whenever the server answers and
     would close it again mid-click. */

  var change = $('#liveChange');

  if (change) {
    change.addEventListener('click', function (e) {
      e.preventDefault();

      panel.removeAttribute('data-sub-show');
      panel.hidden = false;

      var head = doc.getElementById('subHead');
      if (head) {
        head.textContent = 'Change or extend your plan';
        head.setAttribute('tabindex', '-1');
      }

      var lede = panel.querySelector('.subpanel__head p');
      if (lede) {
        lede.textContent = 'A new payment adds to the term you already have rather than replacing it — ' +
          'the tier changes from the moment it confirms, and the time you have paid for is not lost.';
      }

      if (el.badge) el.badge.textContent = 'Plan active';

      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (head) head.focus();
    });
  }

  render();
})();
