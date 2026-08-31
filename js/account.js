/* ==========================================================================
   CloakShield Pro — account state

   One small store shared by the pages that come after registration. It holds
   what the browser is allowed to know about the account: the address it was
   created with, the display name, whether the confirmation link has been
   followed, and the plan the visitor was reading when they signed up.

   It is deliberately not a session. The identity store owns the real session
   and the password; this only answers "has this browser finished registering
   yet", which is what gates the workspace and the checkout.

   It also carries the subscription record — tier, term, status and reference —
   because the workspace tools are gated on a paid plan, not just on a
   confirmed address.

   That record is a CACHE, and only a cache. /api/subscription is what decides
   whether a plan is active; this store exists so the blocking <head> script
   can stamp the right state before first paint instead of flashing the wrong
   one. sync() runs on every page load and overwrites whatever is here with
   the server's answer, which is why editing the value by hand no longer
   unlocks anything for longer than it takes one fetch to return.
   ========================================================================== */

(function () {
  'use strict';

  var KEY = 'cs-account';

  /* Mirrors TERM_GRACE_MS in netlify/lib/store.mts. A cached 'active' record
     carries the term end with it now, so this store can tell an expired plan
     from a live one without waiting for the server — which matters because the
     pre-paint stamp reads from here. If the two numbers ever disagree the
     server wins; this only avoids painting an answer it is about to
     contradict. */
  var TERM_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var acct = JSON.parse(raw);
      return acct && acct.email ? acct : null;
    } catch (e) {
      return null;
    }
  }

  function write(acct) {
    try { localStorage.setItem(KEY, JSON.stringify(acct)); } catch (e) {}
    return acct;
  }

  var CSAccount = {
    KEY: KEY,

    get: read,

    /* Merges rather than replaces, so marking an account verified does not
       drop the name and plan written at registration. */
    save: function (patch) {
      var acct = read() || {};
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) acct[k] = patch[k];
      }
      return write(acct);
    },

    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
    },

    isVerified: function () {
      var acct = read();
      return Boolean(acct && acct.verified);
    },

    /* ---------- Subscription ---------------------------------------------
       Three states worth distinguishing, because each one shows the visitor
       something different:

         none     no order has been started
         pending  an order exists and the transfer has been declared, but the
                  network — and then support — has not reconciled it yet
         active   the plan is paid and the workspace runs on real traffic

       Anything that is not one of the three reads as "none", so a hand-edited
       localStorage value cannot unlock the tools. */

    subscription: function () {
      var acct = read();
      var sub = acct && acct.subscription;
      if (!sub || (sub.status !== 'pending' && sub.status !== 'active')) return null;

      /* A term that has run out is not a plan, however recently the cache was
         told otherwise. Records with no term end predate the column and are
         left alone: locking out a paying customer over a missing field is the
         worse error by a distance. */
      if (sub.status === 'active' && sub.termEndsAt &&
          Date.now() > Number(sub.termEndsAt) + TERM_GRACE_MS) {
        return null;
      }

      return sub;
    },

    subStatus: function () {
      var sub = CSAccount.subscription();
      return sub ? sub.status : 'none';
    },

    /* The one question the workspace asks before it shows a tool. */
    hasActivePlan: function () {
      return CSAccount.subStatus() === 'active';
    },

    /* Records an order the visitor has just declared paid. A local echo of
       what /api/claim has already written server-side, kept so the workspace
       reads "pending" on the very next paint rather than after a round trip.
       The next sync() replaces it with the authoritative record. */
    startSubscription: function (planId, months, reference) {
      var sub = {
        plan: planId,
        months: String(months),
        status: 'pending',
        reference: reference || '',
        placedAt: new Date().toISOString()
      };
      CSAccount.save({ subscription: sub, plan: planId, months: String(months) });
      return sub;
    },

    /* Appends the plan and term the account carries, so a redirect back to an
       earlier step still lands on the plan the visitor picked. */
    withPlan: function (path, planId, months) {
      var acct = read() || {};
      var plan = planId || acct.plan || 'professional';
      var term = months || acct.months || '1';
      return path + '?plan=' + encodeURIComponent(plan) + '&months=' + encodeURIComponent(term);
    },

    /* Where a "start this plan" call to action should go for this browser:
       the signup form when there is no account yet, the workspace panel when
       there is. Anything that rebuilds such a link — the homepage calculator
       does, on every keystroke — should ask here rather than hard-code it. */
    entry: function (planId, months) {
      var query = '?plan=' + encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
      return read() ? '/dashboard.html' + query + '#subscribe' : '/register.html' + query;
    },

    /* Page guard. Returns the account when the browser may stay, and
       redirects otherwise: no account at all goes back to registration, an
       unconfirmed one goes back to the verification step, and one without a
       paid plan goes to the subscription panel in the workspace. */
    require: function (options) {
      var opts = options || {};
      var acct = read();
      var params = new URLSearchParams(location.search);
      var planId = params.get('plan');
      var months = params.get('months');

      if (!acct) {
        location.replace(CSAccount.withPlan('/register.html', planId, months));
        return null;
      }

      if (opts.verified && !acct.verified) {
        location.replace(CSAccount.withPlan('/welcome.html', planId, months));
        return null;
      }

      if (opts.subscribed && !CSAccount.hasActivePlan()) {
        location.replace(CSAccount.withPlan('/dashboard.html', planId, months) + '#subscribe');
        return null;
      }

      return acct;
    }
  };

  window.CSAccount = CSAccount;

  /* ---------- Pricing calls to action ------------------------------------
     Someone who already has an account should not be sent back through the
     signup form by a pricing card; their plan is started from the workspace
     panel instead, with the tier they clicked carried across. This runs in
     the script body rather than on DOMContentLoaded so it lands before
     js/site.js renders the calculator — which is why account.js is loaded
     first on every page that has both. */

  if (read()) {
    Array.prototype.slice.call(document.querySelectorAll('a[href^="/register.html"]'))
      .forEach(function (link) {
        var query = link.getAttribute('href').split('?')[1] || '';
        link.setAttribute('href', '/dashboard.html' + (query ? '?' + query : '') + '#subscribe');
        if (link.textContent.trim() === 'Create account') link.textContent = 'Choose this plan';
      });
  }

  /* ---------- Signed-in chip and state-dependent blocks -----------------
     Any page can drop <span data-account-chip></span> in the nav; it fills
     in with the account address and a way out. [data-account-show] and
     [data-account-hide] swap the marketing copy for the account copy, and
     both start hidden in the HTML so neither flashes before this runs.

     [data-sub-show="none pending active"] is the same idea for the billing
     state, and <html data-sub> carries it for the CSS that dims a locked
     tool. Blocks list every status they belong to, so "none pending" reads
     as "before the plan is live".

     apply() is deliberately re-runnable: it goes once on DOMContentLoaded
     from the cached record, and again when the server's answer lands. */

  function signOut() {
    /* Identity holds a real session now, so clearing this store is no longer
       enough — the cookie has to go too, or the next page load reads the
       server and signs the visitor straight back in. Local state is cleared
       either way: someone who clicks sign out has signed out. */
    var done = function () {
      CSAccount.clear();
      location.href = '/';
    };

    fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}'
    }).then(done, done);
  }

  function apply() {
    var acct = read();
    var status = CSAccount.subStatus();

    document.documentElement.setAttribute('data-auth', acct ? 'in' : 'out');
    document.documentElement.setAttribute('data-sub', acct ? status : 'none');

    Array.prototype.slice.call(document.querySelectorAll('[data-account-show]'))
      .forEach(function (node) { node.hidden = !acct; });

    Array.prototype.slice.call(document.querySelectorAll('[data-account-hide]'))
      .forEach(function (node) { node.hidden = Boolean(acct); });

    Array.prototype.slice.call(document.querySelectorAll('[data-sub-show]'))
      .forEach(function (node) {
        var wanted = (node.getAttribute('data-sub-show') || '').split(/\s+/);
        node.hidden = !acct || wanted.indexOf(status) === -1;
      });

    var chips = Array.prototype.slice.call(document.querySelectorAll('[data-account-chip]'));

    chips.forEach(function (chip) {
      if (!acct) {
        chip.hidden = true;
        return;
      }

      chip.hidden = false;
      chip.innerHTML = '';

      var who = document.createElement('span');
      who.className = 'acct__who';
      who.textContent = acct.email;

      var out = document.createElement('button');
      out.className = 'acct__out';
      out.type = 'button';
      out.textContent = 'Sign out';
      out.addEventListener('click', signOut);

      chip.appendChild(who);
      chip.appendChild(out);
    });
  }

  CSAccount.apply = apply;

  /* ---------- Reconciliation --------------------------------------------
     The one call that makes the browser's copy honest. /api/subscription
     answers from the orders table, so it knows things this store cannot: a
     payment that landed while the tab was closed, a plan bought on another
     device, an order that was never actually paid for.

     Three outcomes, and the third is the one that matters:

       signed in, has a plan      → the record is written here as well, so
                                    the next page load paints it immediately
       signed in, has no plan     → any cached record is dropped
       not signed in at all       → the cached record is dropped too. The
                                    server cannot vouch for a browser it does
                                    not recognise, and a plan this store
                                    cannot prove is not a plan. sessionLapsed
                                    is set so a page can offer sign-in rather
                                    than silently showing a locked workspace.

     Failures are left alone on purpose: a flaky connection should not sign
     anyone out or lock a workspace someone has paid for. */

  var syncing = null;

  function sync() {
    if (syncing) return syncing;

    syncing = fetch('/api/subscription', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) return null;

        var acct = read();

        if (!data.signedIn) {
          if (acct) {
            CSAccount.save({ subscription: null, sessionLapsed: true });
            apply();
          }
          return data;
        }

        CSAccount.save({
          email: data.email || (acct && acct.email) || '',
          name: data.name || (acct && acct.name) || '',
          verified: data.verified !== false,
          subscription: data.subscription || null,
          /* A term that has run out. Not a subscription — the status it
             produces is 'none' and every gate on the site treats it that way
             — but the workspace still needs to be able to say which plan
             ended and when, rather than pretending there was never one. */
          lapsed: data.lapsed || null,
          sessionLapsed: false
        });

        apply();
        return data;
      })
      .catch(function () { return null; })
      .then(function (data) {
        syncing = null;
        return data;
      });

    return syncing;
  }

  CSAccount.sync = sync;
  CSAccount.signOut = signOut;

  /* The most recent term that ended, when the account has one and no live
     plan. Read by the workspace for the "extend it" notice. */
  CSAccount.lapsedTerm = function () {
    var acct = read();
    return (acct && acct.lapsed) || null;
  };

  /* Whether this browser has a session the server recognises. Only meaningful
     after sync() has returned. */
  CSAccount.sessionLapsed = function () {
    var acct = read();
    return Boolean(acct && acct.sessionLapsed);
  };

  document.addEventListener('DOMContentLoaded', function () {
    apply();
    sync();
  });

})();
