/* ==========================================================================
   CloakShield Pro — sign in

   The counterpart to registration. Posts to /api/login, which opens the
   session server-side, and then navigates with a full page load so the
   browser actually sends the new cookie on the next request.

   It also seeds the account store before leaving, because the blocking
   <head> scripts on the workspace and the checkout read that store before
   any JavaScript runs — without it, someone signing in on a fresh browser
   would be bounced back to registration by a guard that had not yet heard
   they were signed in.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };

  var form = $('#siForm');
  if (!form) return;

  var A = window.CSAccount;

  var el = {
    email: $('#siEmail'),
    pass: $('#siPass'),
    fEmail: $('#fEmail'),
    fPass: $('#fPass'),
    errEmail: $('#errEmail'),
    errPass: $('#errPass'),
    submit: $('#siSubmit'),
    err: $('#siErr'),
    errText: $('#siErrText'),
    notice: $('#siNotice'),
    noticeText: $('#siNoticeText'),
    see: $('#pwSee')
  };

  /* ---------- Where to go afterwards -------------------------------------
     A name, never a URL. The endpoint resolves it to a path of its own, so
     a link to this page cannot be dressed up to bounce someone off-site
     after they have typed a password. */

  var params = new URLSearchParams(location.search);
  var next = params.get('next') === 'checkout' ? 'checkout' : 'dashboard';

  var REASONS = {
    checkout: 'Sign in to reserve your payment. The plan you picked is still selected.',
    expired: 'Your session has expired. Sign in again to pick up where you left off.',
    workspace: 'Sign in to open your workspace.'
  };

  var reason = params.get('reason');
  if (reason && REASONS[reason]) {
    el.noticeText.textContent = REASONS[reason];
    el.notice.classList.add('is-on');
  } else if (next === 'checkout') {
    el.noticeText.textContent = REASONS.checkout;
    el.notice.classList.add('is-on');
  }

  /* Carried through so the checkout still opens on the plan the visitor
     picked, exactly as every other hop in this flow does. */
  function query() {
    var plan = params.get('plan');
    var months = params.get('months');
    var parts = [];
    if (plan) parts.push('plan=' + encodeURIComponent(plan));
    if (months) parts.push('months=' + encodeURIComponent(months));
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* Prefill from whatever this browser last knew, so a lapsed session is one
     password away from being a working one. */
  var known = A && A.get();
  if (known && known.email) el.email.value = known.email;

  /* ---------- Field state ------------------------------------------------ */

  function setFieldError(field, node, message) {
    field.classList.add('is-bad');
    if (message) node.textContent = message;
  }

  function clearFieldError(field) {
    field.classList.remove('is-bad');
  }

  el.email.addEventListener('input', function () { clearFieldError(el.fEmail); });
  el.pass.addEventListener('input', function () { clearFieldError(el.fPass); });

  el.see.addEventListener('click', function () {
    var showing = el.pass.getAttribute('type') === 'text';
    el.pass.setAttribute('type', showing ? 'password' : 'text');
    el.see.textContent = showing ? 'Show' : 'Hide';
    el.see.setAttribute('aria-pressed', String(!showing));
    el.see.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  /* ---------- Submit ----------------------------------------------------- */

  var FIELD_FOR = {
    email: [el.fEmail, el.errEmail],
    password: [el.fPass, el.errPass]
  };

  function showFormError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
  }

  function done() {
    el.submit.disabled = false;
    el.submit.textContent = 'Sign in';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    el.err.classList.remove('is-on');
    clearFieldError(el.fEmail);
    clearFieldError(el.fPass);

    var email = el.email.value.trim();
    var password = el.pass.value;
    var ok = true;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setFieldError(el.fEmail, el.errEmail, 'Enter the email address on the account.');
      ok = false;
    }
    if (!password) {
      setFieldError(el.fPass, el.errPass, 'Enter your password.');
      ok = false;
    }
    if (!ok) {
      form.querySelector('.field.is-bad .input').focus();
      return;
    }

    el.submit.disabled = true;
    el.submit.textContent = 'Signing in…';

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email, password: password, next: next })
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
          done();
          return;
        }

        /* Signing in implies a confirmed address — the identity store will not
           issue a session for an unconfirmed one. */
        if (A) {
          A.save({
            email: data.email || email,
            name: data.name || (known && known.name) || '',
            verified: true,
            sessionLapsed: false
          });
        }

        el.submit.textContent = 'Signed in';

        /* A full navigation, not a history push: the session cookie was set on
           the response to this fetch and has to travel with the next request
           for the guards on the far side to see it. */
        location.href = (data.next || '/dashboard.html') + query();
      })
      .catch(function () {
        showFormError('We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        done();
      });
  });
})();
