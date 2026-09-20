/* ==========================================================================
   CloakShield Pro — password reset

   One page, two steps:

     step 1   ask for the email   → POST /api/recover
     step 2   set the password    → POST /api/reset

   The email carries both halves of one challenge: a six-digit code and a
   single-use link. So step 2 is reached two ways, and the only difference
   between them is who supplies the proof. Open the link and the token is in
   the URL fragment, which js/site.js forwards here and this file reads once
   and then scrubs. Come back to this page with the digits instead and the
   code and the address are typed into the form. Either way the password
   rules are the same and the endpoint does the same four things with them.

   Both steps are posted to a function rather than handled here, because the
   challenge is checked against a hash in the database and the password is
   written through the Identity admin API — neither of which belongs in a
   browser, let alone one on a site with no build step.

   The success message on the first step is deliberately the same whether or
   not the address is on the account list. The endpoint answers the same way
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
    askSubmitText: $('#rsAskSubmitText'),
    askErr: $('#rsAskErr'),
    askErrText: $('#rsAskErrText'),

    set: $('#rsSetForm'),
    challenge: $('#rsChallenge'),
    code: $('#rsCode'),
    fCode: $('#fCode'),
    errCode: $('#errCode'),
    setEmail: $('#rsSetEmail'),
    fSetEmail: $('#fSetEmail'),
    errSetEmail: $('#errSetEmail'),
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
  var CODE_LENGTH = 6;

  var ASK_LABEL = 'Email me a reset code';
  var SET_LABEL = 'Set new password and sign in';

  /* ---------- The token from the email ----------------------------------
     Read once, then taken out of the address bar. It is single-use, and a
     spent token sitting in history is a confusing thing to land back on.

     Two names are recognised. `reset_token` is this site's own, minted
     alongside the six digits and redeemed by /api/reset. `recovery_token` is
     Netlify Identity's, from a link that predates this flow — nothing here
     can redeem one any more, so rather than posting it and reporting a
     mismatch that is really a version difference, that case drops straight to
     step one with a sentence that says so. */

  function hashParams() {
    var hash = location.hash.replace(/^#/, '');
    return hash ? new URLSearchParams(hash) : null;
  }

  var token = '';
  var legacyLink = false;

  (function readHash() {
    var q = hashParams();
    if (!q) return;

    token = q.get('reset_token') || '';
    if (!token && q.get('recovery_token')) legacyLink = true;

    if (token || legacyLink) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();

  /* An address can also arrive in the query string — /api/reset sends one
     there on the way to sign-in, and so does /api/login. Worth prefilling
     from: on this page it saves a customer who is already mid-reset from
     typing it twice. */
  var params = new URLSearchParams(location.search);
  var known = params.get('email') || (A && A.get() && A.get().email) || '';

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
    el.sub.textContent = 'Enter the address on the account and we will email you a six-digit code and a single-use link. Either one gets you to the next step; your current password keeps working until you choose a new one.';
    el.askSubmit.disabled = false;
    el.askSubmitText.textContent = ASK_LABEL;
    el.email.focus();
  }

  /* mode 'link' — the token is in hand and there is nothing to type.
     mode 'code' — the digits are the proof, so the challenge fields open. */
  function showSet(mode) {
    el.ask.hidden = true;
    el.set.hidden = false;
    el.eyebrow.textContent = 'Choose a new password';
    el.title.textContent = 'Set a new password';
    el.setSubmit.disabled = false;
    el.setSubmit.textContent = SET_LABEL;

    if (mode === 'link') {
      el.challenge.hidden = true;
      el.sub.textContent = 'This link checked out. Choose the password you will use from now on — it replaces the old one the moment you submit, and signs you in on this device.';
      note('Link verified. Choose a new password below.', 'ok');
      el.pass.focus();
      return;
    }

    el.challenge.hidden = false;
    if (known && !el.setEmail.value) el.setEmail.value = known;
    el.sub.textContent = 'Enter the six digits from the email along with the password you will use from now on. The code is checked when you submit, and a correct one replaces the old password straight away.';
    el.code.focus();
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
  el.setEmail.addEventListener('input', function () { clearFieldError(el.fSetEmail); });

  /* Digits only, and never more than six. Cleaned as it is typed rather than
     rejected afterwards, so a code pasted as "123 456" is accepted. */
  el.code.addEventListener('input', function () {
    var cleaned = el.code.value.replace(/\D+/g, '').slice(0, CODE_LENGTH);
    if (cleaned !== el.code.value) el.code.value = cleaned;
    clearFieldError(el.fCode);
  });

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
    el.code.value = '';
    note('Enter the address on the account and we will send another code.', 'ok');
    showAsk();
  });

  /* ---------- Step 1: ask for the email ---------------------------------- */

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
    el.askSubmitText.textContent = 'Sending…';

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
          el.askSubmitText.textContent = ASK_LABEL;
          return;
        }

        /* Remembered for the sign-in page, so someone who resets and comes
           back later does not retype it. It is their own address on their own
           browser — the same thing the store already holds after sign-in. */
        if (A) A.save({ email: address });
        known = address;

        /* Straight on to step 2 rather than a dead end, because the email
           carries digits that can be typed right here. The visitor who would
           rather click the link can still do that; it lands on this page in
           `link` mode and the typed code is never needed. */
        showSet('code');
        note('Sent. Enter the six digits from the email below — or open the link in the same email and this step fills itself in.', 'ok');
      })
      .catch(function () {
        showError(el.askErr, el.askErrText, 'We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        el.askSubmit.disabled = false;
        el.askSubmitText.textContent = ASK_LABEL;
      });
  });

  /* ---------- Step 2: set the new password ------------------------------- */

  var FIELD_FOR = {
    password: [el.fPass, el.errPass],
    confirm: [el.fPass2, el.errPass2],
    code: [el.fCode, el.errCode],
    email: [el.fSetEmail, el.errSetEmail]
  };

  function releaseSet() {
    el.setSubmit.disabled = false;
    el.setSubmit.textContent = SET_LABEL;
  }

  el.set.addEventListener('submit', function (e) {
    e.preventDefault();

    el.setErr.classList.remove('is-on');
    clearFieldError(el.fPass);
    clearFieldError(el.fPass2);
    clearFieldError(el.fCode);
    clearFieldError(el.fSetEmail);

    var password = el.pass.value;
    var confirm = el.pass2.value;
    var code = el.code.value.replace(/\D+/g, '');
    var address = el.setEmail.value.trim();
    var ok = true;

    /* Checked before the password so the first message a visitor sees is
       about the thing they most likely got wrong. */
    if (!token) {
      if (code.length !== CODE_LENGTH) {
        setFieldError(el.fCode, el.errCode, 'Enter the six digits from the email.');
        ok = false;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
        setFieldError(el.fSetEmail, el.errSetEmail, 'Enter the email address on the account.');
        ok = false;
      }
    }

    if (password.length < MIN_PASSWORD) {
      setFieldError(el.fPass, el.errPass, 'Use at least ' + MIN_PASSWORD + ' characters.');
      ok = false;
    }
    if (confirm !== password) {
      setFieldError(el.fPass2, el.errPass2, 'Both passwords need to match.');
      ok = false;
    }
    if (!ok) {
      var firstBad = el.set.querySelector('.field.is-bad .input');
      if (firstBad) firstBad.focus();
      return;
    }

    el.setSubmit.disabled = true;
    el.setSubmit.textContent = 'Setting your password…';

    var payload = token
      ? { token: token, password: password, confirm: confirm }
      : { email: address, code: code, password: password, confirm: confirm };

    fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (data) { return data || {}; });
      })
      .then(function (data) {
        if (!data.ok) {
          /* A spent, expired or locked challenge cannot be retried with a
             better password, so that case goes back to step one rather than
             leaving the visitor typing into a form that can no longer
             succeed. A code that simply does not match is the opposite: the
             challenge is still live, so they stay here with the attempts
             they have left. */
          if (data.expired) {
            token = '';
            el.code.value = '';
            showAsk();
            if (known) el.email.value = known;
            note(data.error || 'That reset code has expired. Request a new one.', 'err');
            return;
          }

          var target = FIELD_FOR[data.field];
          if (target) {
            var message = data.error;
            if (data.field === 'code' && typeof data.remaining === 'number' && data.remaining > 0) {
              message += ' ' + data.remaining + ' attempt' + (data.remaining === 1 ? '' : 's') + ' left on this code.';
            }
            setFieldError(target[0], target[1], message);
            if (data.field === 'code') el.code.select();
          } else {
            showError(el.setErr, el.setErrText, data.error || 'That did not work. Please try again.');
          }

          releaseSet();
          return;
        }

        /* A successful reset opens the session in the same call, so seed the
           store the way sign-in does: the blocking <head> guards on the
           workspace read it before any script runs and would otherwise bounce
           someone who is genuinely signed in. The address is proven by the
           challenge whichever way it was redeemed, which is why `verified` is
           a statement of fact here rather than an assumption.

           `signedIn` can still be false — the password was written and the
           login that follows it failed, which is a rare but real ordering. In
           that case the server points at sign-in instead, and the store must
           not claim a session that does not exist. */
        if (A) {
          A.save({
            email: data.email || address || known || '',
            name: data.name || '',
            verified: true,
            sessionLapsed: !data.signedIn
          });
        }

        el.setSubmit.textContent = data.signedIn ? 'Password set' : 'Password set — signing in';

        /* A full navigation, not a history push: the session cookie was set on
           the response to this fetch and has to travel with the next request
           for the guards on the far side to see it. */
        location.href = data.next || '/dashboard.html';
      })
      .catch(function () {
        showError(el.setErr, el.setErrText, 'We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
        releaseSet();
      });
  });

  /* ---------- Wire up ---------------------------------------------------- */

  if (token) {
    showSet('link');
  } else if (params.get('code') === '1' && known) {
    /* A deliberate "I have the digits" arrival — the sign-in page links here
       this way for a customer who already has the email open. */
    showSet('code');
    note('Enter the six digits from the email along with a new password.', 'ok');
  } else {
    if (known) el.email.value = known;
    showAsk();

    if (legacyLink) {
      note('That reset link was issued before we moved reset emails onto our own sender, so it can no longer be redeemed. Ask for a fresh one below — the new email carries a six-digit code as well as a link.', 'err');
    } else {
      note('Enter the address on the account.', 'ok');
    }
  }

  renderStrength();
})();
