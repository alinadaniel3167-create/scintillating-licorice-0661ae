/* ==========================================================================
   CloakShield Pro — account state

   One small store shared by the pages that come after registration. It holds
   what the browser is allowed to know about the account: the address it was
   created with, the display name, whether the confirmation link has been
   followed, and the plan the visitor was reading when they signed up.

   It is deliberately not a session. Netlify Identity owns the real session
   and the password; this only answers "has this browser finished registering
   yet", which is what gates the workspace and the checkout.
   ========================================================================== */

(function () {
  'use strict';

  var KEY = 'cs-account';

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
       unconfirmed one goes back to the verification step. */
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
     both start hidden in the HTML so neither flashes before this runs. */

  document.addEventListener('DOMContentLoaded', function () {
    var acct = read();

    Array.prototype.slice.call(document.querySelectorAll('[data-account-show]'))
      .forEach(function (node) { node.hidden = !acct; });

    Array.prototype.slice.call(document.querySelectorAll('[data-account-hide]'))
      .forEach(function (node) { node.hidden = Boolean(acct); });

    var chips = Array.prototype.slice.call(document.querySelectorAll('[data-account-chip]'));
    if (!chips.length) return;

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
      out.addEventListener('click', function () {
        CSAccount.clear();
        location.href = '/';
      });

      chip.appendChild(who);
      chip.appendChild(out);
    });
  });
})();
