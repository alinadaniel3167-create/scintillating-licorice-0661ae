/* ==========================================================================
   CloakShield Pro — registration
   Two fields, a strength meter, and a POST to the register function.

   The account email is handed to the welcome page through sessionStorage
   rather than the query string, so it never lands in browser history, a
   bookmark or a Referer header.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };

  var form = $('#regForm');
  if (!form) return;

  var P = window.CSPricing;

  var el = {
    email: $('#regEmail'),
    pass: $('#regPass'),
    fEmail: $('#fEmail'),
    fPass: $('#fPass'),
    errEmail: $('#errEmail'),
    errPass: $('#errPass'),
    submit: $('#regSubmit'),
    err: $('#regErr'),
    errText: $('#regErrText'),
    see: $('#pwSee'),
    bar: $('#pwBar'),
    word: $('#pwWord'),
    orderPlan: $('#orderPlan'),
    orderTermLabel: $('#orderTermLabel'),
    orderTotal: $('#orderTotal')
  };

  var MIN_PASSWORD = 8;
  var STORE_KEY = 'cs-signup';

  /* ---------- Plan carried in from the pricing page --------------------- */

  var params = new URLSearchParams(location.search);
  var planId = params.get('plan');
  var months = params.get('months');

  if (P) {
    if (!planId || !P.PLANS[planId]) planId = 'professional';
    if (!months || !P.TERMS[months]) months = '1';

    var q = P.quote(planId, Number(months));
    el.orderPlan.textContent = q.plan.name;
    el.orderTermLabel.textContent = P.money(q.plan.monthly) + ' × ' + q.termLabel;
    el.orderTotal.textContent = P.money(q.total);
  } else {
    planId = planId || 'professional';
    months = months || '1';
  }

  function nextStepUrl(base) {
    return base + '?plan=' + encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
  }

  /* Returning customers should not have to re-register to top up a term, so
     the escape hatch carries the same plan straight into the crypto checkout. */
  var skip = $('#regSkip');
  if (skip) skip.setAttribute('href', nextStepUrl('/checkout.html'));

  /* ---------- Password strength ----------------------------------------- */

  var WORDS = ['—', 'Weak', 'Fair', 'Good', 'Strong'];

  /* Length carries most of the weight because it actually does: a long
     lowercase passphrase beats a short one with a symbol bolted on. */
  function score(value) {
    if (!value) return 0;
    var s = 0;
    if (value.length >= MIN_PASSWORD) s++;
    if (value.length >= 12) s++;
    if (value.length >= 16) s++;
    if (/[^a-zA-Z]/.test(value) && /[a-zA-Z]/.test(value)) s++;
    return Math.min(s, 4);
  }

  function renderStrength() {
    var s = score(el.pass.value);
    el.bar.className = 'pwbar';
    el.fPass.className = el.fPass.className.replace(/\s*pw-\d/g, '');
    if (s > 0) {
      el.bar.className = 'pwbar pw-' + s;
      el.fPass.className += ' pw-' + s;
    }
    el.word.textContent = WORDS[s];
  }

  el.pass.addEventListener('input', function () {
    renderStrength();
    clearFieldError(el.fPass);
  });

  el.email.addEventListener('input', function () { clearFieldError(el.fEmail); });

  el.see.addEventListener('click', function () {
    var showing = el.pass.getAttribute('type') === 'text';
    el.pass.setAttribute('type', showing ? 'password' : 'text');
    el.see.textContent = showing ? 'Show' : 'Hide';
    el.see.setAttribute('aria-pressed', String(!showing));
    el.see.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    el.pass.focus();
  });

  /* ---------- Validation ------------------------------------------------ */

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function setFieldError(field, node, message) {
    field.classList.add('is-bad');
    if (message) node.textContent = message;
  }

  function clearFieldError(field) {
    field.classList.remove('is-bad');
  }

  function validate() {
    var ok = true;
    var email = el.email.value.trim();

    if (!email || !looksLikeEmail(email)) {
      setFieldError(el.fEmail, el.errEmail, email ? 'That email address does not look right.' : 'Enter your work email address.');
      ok = false;
    }

    if (el.pass.value.length < MIN_PASSWORD) {
      setFieldError(el.fPass, el.errPass, 'Use at least ' + MIN_PASSWORD + ' characters.');
      ok = false;
    }

    return ok;
  }

  /* ---------- Submit ----------------------------------------------------- */

  function showFormError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    el.err.classList.remove('is-on');
    clearFieldError(el.fEmail);
    clearFieldError(el.fPass);

    if (!validate()) {
      var bad = form.querySelector('.field.is-bad .input');
      if (bad) bad.focus();
      return;
    }

    var email = el.email.value.trim();

    el.submit.disabled = true;
    el.submit.textContent = 'Creating your account…';

    fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: el.pass.value })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (out) {
        var data = out.data || {};

        if (!data.ok) {
          if (data.field === 'email') setFieldError(el.fEmail, el.errEmail, data.error);
          else if (data.field === 'password') setFieldError(el.fPass, el.errPass, data.error);
          else showFormError(data.error || 'That did not work. Please try again.');

          el.submit.disabled = false;
          el.submit.textContent = 'Create account';
          return;
        }

        /* Hand the outcome to the welcome page. sessionStorage keeps the
           address out of the URL and clears itself when the tab closes. */
        try {
          sessionStorage.setItem(STORE_KEY, JSON.stringify({
            email: data.email || email,
            verified: Boolean(data.verified)
          }));
        } catch (err) {}

        el.submit.textContent = 'Account created';
        location.href = nextStepUrl('/welcome.html');
      })
      .catch(function () {
        showFormError('We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        el.submit.disabled = false;
        el.submit.textContent = 'Create account';
      });
  });

  renderStrength();
})();
