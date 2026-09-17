/* ==========================================================================
   CloakShield Pro — password reset

   One page, two steps, chosen by whether the URL carries a token:

     no token   ask for a link   → POST /api/recover
     token      set the password → POST /api/reset

   Identity mails the link back to the site root with the token in the
   fragment, and js/site.js forwards anything carrying one here. Both steps
   are posted to a function rather than handled in the browser, because
   redeeming a token here would mean bundling the Identity client into a site
   that has no build step.

   The success message on the first step is deliberately the same whether or
   not the address is on the account list — the endpoint answers the same way
   for both, and this page is careful not to add a distinction the server took
   trouble to remove.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };

  var askForm = $('#rsAskForm');
  if (!askForm) return;

  var A = window.CSAccount;

  var el = {
    eyebrow: $('#rsEyebrow'),
    title: $('#rsTitle'),
    sub: $('#rsSub'),
    notice: $('#rsNotice'),
    noticeText: $('#rsNoticeText'),

    ask: askForm,
    email: $('#rsEmail'),
    fEmail: $('#fEmail'),
    errEmail: $('#errEmail'),
    askSubmit: $('#rsAskSubmit'),
    askErr: $('#rsAskErr'),
    askErrText: $('#rsAskErrText'),

    set: $('#rsSetForm'),
    pass: $('#rsPass'),
    pass2: $('#rsPass2'),
    fPass: $('#fPass'),
    fPass2: $('#fPass2'),
    errPass: $('#errPass'),
    errPass2: $('#errPass2'),
    setSubmit: $('#rsSetSubmit'),
    setErr: $('#rsSetErr'),
    setErrText: $('#rsSetErrText'),
    see: $('#pwSee'),
    bar: $('#pwBar'),
    word: $('#pwWord'),
    askAgain: $('#rsAskAgain')
  };

  var MIN_PASSWORD = 8;

  /* ---------- The token from the email ----------------------------------
     Read once, then taken out of the address bar. It is single-use, and a
     spent token sitting in history is a confusing thing to land back on. */

  function tokenFromHash() {
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return '';
    return new URLSearchParams(hash).get('recovery_token') || '';
  }

  var token = tokenFromHash();

  if (token) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------- Field state ------------------------------------------------ */

  function setFieldError(field, node, message) {
    field.classList.add('is-bad');
    if (message) node.textContent = message;
  }

  function clearFieldError(field) {
    field.classList.remove('is-bad');
  }

  function showError(box, node, message) {
    node.textContent = message;
    box.classList.add('is-on');
  }

  function note(message, kind) {
    el.noticeText.textContent = message;
    el.notice.className = 'form__status form__status--' + (kind || 'ok') + ' is-on';
  }

  /* ---------- Which step is on screen ------------------------------------ */

  function showAsk() {
    el.set.hidden = true;
    el.ask.hidden = false;
    el.eyebrow.textContent = 'Password reset';
    el.title.textContent = 'Reset your password';
    el.sub.textContent = 'Enter the address on the account and we will email you a single-use link. Your current password keeps working until you follow it and choose a new one.';
    el.email.focus();
  }

  function showSet() {
    el.ask.hidden = true;
    el.set.hidden = false;
    el.eyebrow.textContent = 'Choose a new password';
    el.title.textContent = 'Set a new password';
    el.sub.textContent = 'This link checked out. Choose the password you will use from now on — it replaces the old one the moment you submit, and signs you in on this device.';
    note('Link verified. Choose a new password below.', 'ok');
    el.pass.focus();
  }

  /* Nothing left to do on this page, so the panel stops being a form. */
  function showSent(address) {
    el.ask.hidden = true;
    el.set.hidden = true;
    el.eyebrow.textContent = 'Check your inbox';
    el.title.textContent = 'Reset link sent';
    el.sub.textContent = 'If ' + address + ' is on the account list, a single-use link is on its way to it. It expires on its own, and nothing about the account has changed until you follow it.';
    note('Sent. Check spam too — transactional mail sometimes lands there the first time.', 'ok');
  }

  /* ---------- Password strength -----------------------------------------
     The same scoring as the registration form, deliberately: a meter that
     rates the same password differently on two pages of one site reads as a
     bug in whichever one the visitor saw second. */

  var WORDS = ['—', 'Weak', 'Fair', 'Good', 'Strong'];

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

  el.pass2.addEventListener('input', function () { clearFieldError(el.fPass2); });
  el.email.addEventListener('input', function () { clearFieldError(el.fEmail); });

  el.see.addEventListener('click', function () {
    var showing = el.pass.getAttribute('type') === 'text';
    el.pass.setAttribute('type', showing ? 'password' : 'text');
    el.see.textContent = showing ? 'Show' : 'Hide';
    el.see.setAttribute('aria-pressed', String(!showing));
    el.see.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    el.pass.focus();
  });

  el.askAgain.addEventListener('click', function (e) {
    e.preventDefault();
    token = '';
    el.setErr.classList.remove('is-on');
    note('Enter the address on the account and we will send another link.', 'ok');
    showAsk();
  });

  /* ---------- Step 1: ask for a link ------------------------------------- */

  el.ask.addEventListener('submit', function (e) {
    e.preventDefault();

    el.askErr.classList.remove('is-on');
    clearFieldError(el.fEmail);

    var address = el.email.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
      setFieldError(el.fEmail, el.errEmail, 'Enter the email address on the account.');
      el.email.focus();
      return;
    }

    el.askSubmit.disabled = true;
    el.askSubmit.textContent = 'Sending…';

    fetch('/api/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: address })
    })
      .then(function (res) {
        return res.json().then(function (data) { return data || {}; });
      })
      .then(function (data) {
        if (!data.ok) {
          if (data.field === 'email') setFieldError(el.fEmail, el.errEmail, data.error);
          else showError(el.askErr, el.askErrText, data.error || 'That did not work. Please try again.');
          el.askSubmit.disabled = false;
          el.askSubmit.textContent = 'Email me a reset link';
          return;
        }

        /* Remembered for the sign-in page, so someone who resets and comes
           back later does not retype it. It is their own address on their own
           browser — the same thing the store already holds after sign-in. */
        if (A) A.save({ email: address });

        showSent(address);
      })
      .catch(function () {
        showError(el.askErr, el.askErrText, 'We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        el.askSubmit.disabled = false;
        el.askSubmit.textContent = 'Email me a reset link';
      });
  });

  /* ---------- Step 2: set the new password ------------------------------- */

  var FIELD_FOR = {
    password: [el.fPass, el.errPass],
    confirm: [el.fPass2, el.errPass2]
  };

  el.set.addEventListener('submit', function (e) {
    e.preventDefault();

    el.setErr.classList.remove('is-on');
    clearFieldError(el.fPass);
    clearFieldError(el.fPass2);

    var password = el.pass.value;
    var confirm = el.pass2.value;
    var ok = true;

    if (password.length < MIN_PASSWORD) {
      setFieldError(el.fPass, el.errPass, 'Use at least ' + MIN_PASSWORD + ' characters.');
      ok = false;
    }
    if (confirm !== password) {
      setFieldError(el.fPass2, el.errPass2, 'Both passwords need to match.');
      ok = false;
    }
    if (!ok) {
      el.set.querySelector('.field.is-bad .input').focus();
      return;
    }

    el.setSubmit.disabled = true;
    el.setSubmit.textContent = 'Setting your password…';

    fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: token, password: password, confirm: confirm })
    })
      .then(function (res) {
        return res.json().then(function (data) { return data || {}; });
      })
      .then(function (data) {
        if (!data.ok) {
          /* A spent or expired token cannot be retried with a better
             password, so that case goes back to step one rather than leaving
             the visitor typing into a form that can no longer succeed. */
          if (data.expired) {
            token = '';
            showAsk();
            note(data.error || 'That reset link has expired. Request a new one.', 'err');
            el.setSubmit.disabled = false;
            el.setSubmit.textContent = 'Set new password and sign in';
            return;
          }

          var target = FIELD_FOR[data.field];
          if (target) setFieldError(target[0], target[1], data.error);
          else showError(el.setErr, el.setErrText, data.error || 'That did not work. Please try again.');

          el.setSubmit.disabled = false;
          el.setSubmit.textContent = 'Set new password and sign in';
          return;
        }

        /* Redeeming the token opened a session, so seed the store the same way
           sign-in does: the blocking <head> guards on the workspace read it
           before any script runs, and would otherwise bounce someone who is
           genuinely signed in. A reset only succeeds on a confirmed address,
           so verified is a statement of fact here rather than an assumption. */
        if (A) {
          A.save({
            email: data.email || '',
            name: data.name || '',
            verified: true,
            sessionLapsed: false
          });
        }

        el.setSubmit.textContent = 'Password set';

        /* A full navigation, not a history push: the session cookie was set on
           the response to this fetch and has to travel with the next request
           for the guards on the far side to see it. */
        location.href = data.next || '/dashboard.html';
      })
      .catch(function () {
        showError(el.setErr, el.setErrText, 'We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        el.setSubmit.disabled = false;
        el.setSubmit.textContent = 'Set new password and sign in';
      });
  });

  /* ---------- Wire up ---------------------------------------------------- */

  if (token) {
    showSet();
  } else {
    var known = A && A.get();
    if (known && known.email) el.email.value = known.email;
    showAsk();
    note('Enter the address on the account.', 'ok');
  }

  renderStrength();
})();
