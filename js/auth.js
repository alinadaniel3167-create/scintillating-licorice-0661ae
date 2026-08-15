/* ==========================================================================
   CloakShield Pro — registration

   Collects the account profile, validates it in the browser, and POSTs it to
   the register function, which is the only part of the site that talks to
   Netlify Identity.

   The account email is handed to the next step through the account store
   rather than the query string, so it never lands in browser history, a
   bookmark or a Referer header.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };

  var form = $('#regForm');
  if (!form) return;

  var P = window.CSPricing;
  var A = window.CSAccount;

  var el = {
    type: $$('input[name="account_type"]'),
    name: $('#regName'),
    country: $('#regCountry'),
    use: $('#regUse'),
    useOther: $('#regUseOther'),
    email: $('#regEmail'),
    pass: $('#regPass'),
    pass2: $('#regPass2'),

    fType: $('#fType'),
    fName: $('#fName'),
    fCountry: $('#fCountry'),
    fUse: $('#fUse'),
    fUseOther: $('#fUseOther'),
    fEmail: $('#fEmail'),
    fPass: $('#fPass'),
    fPass2: $('#fPass2'),

    errType: $('#errType'),
    errName: $('#errName'),
    errCountry: $('#errCountry'),
    errUse: $('#errUse'),
    errUseOther: $('#errUseOther'),
    errEmail: $('#errEmail'),
    errPass: $('#errPass'),
    errPass2: $('#errPass2'),

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

  /* ---------- "Something else" reveal ----------------------------------- */

  function syncUseOther() {
    var other = el.use.value === 'other';
    el.fUseOther.hidden = !other;
    if (other) el.useOther.setAttribute('required', 'required');
    else el.useOther.removeAttribute('required');
  }

  el.use.addEventListener('change', function () {
    syncUseOther();
    clearFieldError(el.fUse);
    if (el.use.value === 'other') el.useOther.focus();
  });

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

  el.see.addEventListener('click', function () {
    var showing = el.pass.getAttribute('type') === 'text';
    el.pass.setAttribute('type', showing ? 'password' : 'text');
    el.see.textContent = showing ? 'Show' : 'Hide';
    el.see.setAttribute('aria-pressed', String(!showing));
    el.see.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    el.pass.focus();
  });

  /* Clear a field's error the moment the visitor starts fixing it. */
  [
    [el.name, el.fName, 'input'],
    [el.country, el.fCountry, 'change'],
    [el.useOther, el.fUseOther, 'input'],
    [el.email, el.fEmail, 'input'],
    [el.pass2, el.fPass2, 'input']
  ].forEach(function (pair) {
    pair[0].addEventListener(pair[2], function () { clearFieldError(pair[1]); });
  });

  el.type.forEach(function (radio) {
    radio.addEventListener('change', function () { clearFieldError(el.fType); });
  });

  /* ---------- Validation ------------------------------------------------ */

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function chosenType() {
    for (var i = 0; i < el.type.length; i++) {
      if (el.type[i].checked) return el.type[i].value;
    }
    return '';
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

    if (!chosenType()) {
      setFieldError(el.fType, el.errType, 'Choose how you are registering.');
      ok = false;
    }

    if (el.name.value.trim().length < 2) {
      setFieldError(el.fName, el.errName, 'Enter the name this account belongs to.');
      ok = false;
    }

    if (!el.country.value) {
      setFieldError(el.fCountry, el.errCountry, 'Select a country.');
      ok = false;
    }

    if (!el.use.value) {
      setFieldError(el.fUse, el.errUse, 'Tell us roughly what you need it for.');
      ok = false;
    } else if (el.use.value === 'other' && el.useOther.value.trim().length < 3) {
      setFieldError(el.fUseOther, el.errUseOther, 'A short line is enough.');
      ok = false;
    }

    var email = el.email.value.trim();
    if (!email || !looksLikeEmail(email)) {
      setFieldError(el.fEmail, el.errEmail, email ? 'That email address does not look right.' : 'Enter your work email address.');
      ok = false;
    }

    if (el.pass.value.length < MIN_PASSWORD) {
      setFieldError(el.fPass, el.errPass, 'Use at least ' + MIN_PASSWORD + ' characters.');
      ok = false;
    } else if (el.pass2.value !== el.pass.value) {
      setFieldError(el.fPass2, el.errPass2, 'The two passwords do not match.');
      ok = false;
    }

    return ok;
  }

  /* ---------- Submit ----------------------------------------------------- */

  function showFormError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
  }

  var FIELD_FOR = {
    email: [el.fEmail, el.errEmail],
    password: [el.fPass, el.errPass],
    full_name: [el.fName, el.errName],
    country: [el.fCountry, el.errCountry],
    use_case: [el.fUse, el.errUse],
    account_type: [el.fType, el.errType]
  };

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    el.err.classList.remove('is-on');
    [el.fType, el.fName, el.fCountry, el.fUse, el.fUseOther, el.fEmail, el.fPass, el.fPass2]
      .forEach(clearFieldError);

    if (!validate()) {
      var bad = form.querySelector('.field.is-bad .input, .field.is-bad .select, .field.is-bad input');
      if (bad) bad.focus();
      return;
    }

    var profile = {
      account_type: chosenType(),
      full_name: el.name.value.trim(),
      country: el.country.value,
      use_case: el.use.value === 'other' ? el.useOther.value.trim() : el.use.value,
      email: el.email.value.trim()
    };

    el.submit.disabled = true;
    el.submit.textContent = 'Creating your account…';

    fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_type: profile.account_type,
        full_name: profile.full_name,
        country: profile.country,
        use_case: profile.use_case,
        email: profile.email,
        password: el.pass.value,
        plan: planId,
        months: months
      })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (out) {
        var data = out.data || {};

        if (!data.ok) {
          var target = FIELD_FOR[data.field];
          if (target) setFieldError(target[0], target[1], data.error);
          else showFormError(data.error || 'That did not work. Please try again.');

          el.submit.disabled = false;
          el.submit.textContent = 'Create account';
          return;
        }

        /* Hand the outcome to the verification step. The store keeps the
           address out of the URL, and "verified" decides whether the
           workspace opens now or after the confirmation link is followed. */
        if (A) {
          A.save({
            email: data.email || profile.email,
            name: profile.full_name,
            type: profile.account_type,
            country: profile.country,
            verified: Boolean(data.verified),
            plan: planId,
            months: months
          });
        }

        el.submit.textContent = 'Account created';
        location.href = nextStepUrl('/welcome.html');
      })
      .catch(function () {
        showFormError('We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        el.submit.disabled = false;
        el.submit.textContent = 'Create account';
      });
  });

  syncUseOther();
  renderStrength();
})();
