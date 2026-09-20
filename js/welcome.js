/* ==========================================================================
   CloakShield Pro — email verification step

   Four ways in, one page:
     · straight from registration, with a six-digit code on its way
     · from the link in that email, with a token in the URL fragment
     · from sign-in, when the address on the account was never confirmed
     · back later, from a browser that already finished confirming

   The code and the link are two halves of one challenge, issued together by
   /api/recover's counterpart in /api/register and redeemed by /api/verify.
   Whichever arrives first spends the row, so typing the code and then opening
   the link reports "already used" — which is accurate, and is why that
   message offers sign-in rather than another attempt.

   /api/confirm is still called for a `confirmation_token`, which is what
   Netlify Identity's own confirmation links carry. New registrations do not
   produce those any more; the branch exists for the ones already sitting in
   inboxes.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };

  var msg = $('#welcomeMsg');
  if (!msg) return;

  var P = window.CSPricing;
  var A = window.CSAccount;

  var el = {
    seal: $('#welcomeSeal'),
    title: $('#welcomeTitle'),
    msg: msg,
    mail: $('#welcomeMail'),
    ok: $('#verifyOk'),
    okText: $('#verifyOkText'),
    err: $('#verifyErr'),
    errText: $('#verifyErrText'),
    form: $('#verifyForm'),
    fCode: $('#fCode'),
    code: $('#verifyCode'),
    errCode: $('#errCode'),
    fEmail: $('#fEmail'),
    email: $('#verifyEmail'),
    errEmail: $('#errEmail'),
    submit: $('#verifySubmit'),
    submitText: $('#verifySubmitText'),
    resend: $('#verifyResend'),
    resendText: $('#verifyResendText'),
    expiry: $('#verifyExpiry'),
    alt: $('#verifyAlt'),
    check: $('#verifyCheck'),
    go: $('#verifyGo'),
    goText: $('#verifyGoText'),
    note: $('#verifyNote'),
    chkVerify: $('#chkVerify'),
    chkVerifyD: $('#chkVerifyD'),
    chkVerifyBadge: $('#chkVerifyBadge'),
    chkWorkspace: $('#chkWorkspace'),
    chkPayD: $('#chkPayD')
  };

  var CODE_LENGTH = 6;

  /* ---------- Carry the chosen plan forward ------------------------------ */

  var params = new URLSearchParams(location.search);
  var acct = (A && A.get()) || null;
  var planId = params.get('plan') || (acct && acct.plan);
  var months = params.get('months') || (acct && acct.months);

  if (!P || !P.PLANS[planId]) planId = 'professional';
  if (!P || !P.TERMS[months]) months = '1';

  function withPlan(base) {
    return base + '?plan=' + encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
  }

  el.go.setAttribute('href', withPlan('/dashboard.html'));
  if (el.chkWorkspace) el.chkWorkspace.setAttribute('href', withPlan('/dashboard.html'));

  if (P && el.chkPayD) {
    var q = P.quote(planId, Number(months));
    el.chkPayD.textContent = q.plan.name + ' · ' + q.termLabel + ' · ' + P.money(q.total) +
      ' is pre-selected from the plan you were reading. Activation happens inside the workspace, and the crypto rate is held for 30 minutes once you start.';
  }

  /* ---------- Whose code is this? ----------------------------------------
     The address, in the order it can be trusted: the query string (put there
     by /api/login when it turned away an unconfirmed account), then the store
     this browser wrote at registration. If neither has one the email field is
     revealed and the visitor supplies it — a code typed on a different device
     from the one that registered is a real case, and it is the only case
     where this page has to ask. */

  var known = params.get('email') || (acct && acct.email) || '';

  function currentEmail() {
    if (el.fEmail.hidden) return known;
    return el.email.value.trim();
  }

  /* ---------- States -----------------------------------------------------

     Set only by a challenge redeemed on this page, which is the one arrival
     here that ends with a proven address. Deliberately not set by
     setConfirmed(), which also runs off the cached record to paint the
     confirmed state for a returning visitor — that cache is a paint, not a
     proof, and the button guard at the bottom is the thing that must not
     trust it. */

  var confirmedHere = false;

  function clearMessages() {
    el.err.classList.remove('is-on');
    el.ok.classList.remove('is-on');
  }

  function showError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
    el.ok.classList.remove('is-on');
  }

  function showNotice(message) {
    el.okText.textContent = message;
    el.ok.classList.add('is-on');
    el.err.classList.remove('is-on');
  }

  function setFieldError(field, node, message) {
    field.classList.add('is-bad');
    if (message) node.textContent = message;
  }

  function clearFieldError(field) {
    field.classList.remove('is-bad');
  }

  function showAddress(email) {
    if (!email) return;
    el.mail.textContent = email;
    el.mail.hidden = false;
  }

  /* Whether a confirmation email actually went out. /api/register works this
     out from the mailer's own answer and js/auth.js puts it in the store,
     because this page cannot tell from here — and the two cases need
     different copy. Only an explicit false changes the wording: an older
     record, or a visitor who came back to this page days later, has no
     opinion on the question and the ordinary message is the right one. */
  var confirmationSent = !(acct && acct.confirmationSent === false);

  function setPending() {
    el.title.textContent = 'Confirm your email address';
    el.msg.textContent = confirmationSent
      ? 'We emailed a six-digit code to the address you registered with. Enter it below — or open the link in the same email — to activate sign-in and unlock plan activation inside the workspace.'
      : 'Your account exists, but we cannot confirm that the confirmation email left our side. Try "Send a new code" below; if nothing arrives in the next few minutes, email Cloakshield.pro@outlook.com from the address you registered with and we will confirm it by hand.';
    el.form.hidden = false;
    el.go.hidden = true;
    el.submit.classList.remove('is-busy');
    el.submitText.textContent = 'Confirm my email';
  }

  function setConfirming(what) {
    el.title.textContent = 'Confirming your address…';
    el.msg.textContent = what === 'link'
      ? 'Redeeming the link from your email. This takes a second.'
      : 'Checking that code. This takes a second.';
    el.submit.classList.add('is-busy');
    el.submitText.textContent = 'Confirming…';
  }

  function setConfirmed(email) {
    el.seal.classList.add('welcome__seal--ok');
    el.seal.innerHTML = '<svg><use href="#i-check"/></svg>';
    el.title.textContent = 'Email confirmed';
    el.msg.textContent = 'Sign-in is active for this address and your workspace is ready. Plans are chosen and activated from inside it.';
    clearMessages();
    showAddress(email);

    el.form.hidden = true;
    el.go.hidden = false;
    el.go.classList.remove('is-busy');
    el.goText.textContent = 'Open your workspace';
    if (el.alt) el.alt.hidden = true;

    if (el.note) {
      el.note.textContent = 'Nothing has been charged yet. Your workspace opens on the sample data set until a plan is activated.';
    }

    if (el.chkVerify) {
      el.chkVerify.className = 'chk is-done';
      el.chkVerify.querySelector('.chk__pip').innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
      el.chkVerifyD.textContent = 'Confirmed. The address above can now sign in to the workspace.';
      el.chkVerifyBadge.textContent = 'Done';
    }

    if (el.chkWorkspace) el.chkWorkspace.className = 'chk is-next';
  }

  /* Landing confirmed: store what we learned, paint it, and hand off. Shared
     by the code path and both link paths so the three cannot drift. */
  function landConfirmed(email, next) {
    confirmedHere = true;

    if (A) {
      A.save({
        email: email || known,
        verified: true,
        confirmationSent: true,
        plan: planId,
        months: months
      });
    }

    setConfirmed(email || known);
    handOff(next);
  }

  /* ---------- Tokens out of the fragment ---------------------------------
     Two names, because two things mint them. `verify_token` is this site's
     own, from /api/verify; `confirmation_token` is Identity's, from a link
     that predates it. Both are single-use and neither belongs in history. */

  function tokenFromHash() {
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return null;

    var q = new URLSearchParams(hash);
    var own = q.get('verify_token');
    if (own) return { kind: 'verify', value: own };

    var legacy = q.get('confirmation_token');
    if (legacy) return { kind: 'confirm', value: legacy };

    return null;
  }

  function scrubHash() {
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------- Redeem --------------------------------------------------- */

  function post(body) {
    return fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) { return data || {}; });
    });
  }

  function redeemToken(token) {
    setConfirming('link');
    el.form.hidden = true;

    post({ token: token })
      .then(function (data) {
        /* Single-use, so it must not survive a refresh whatever happened. */
        scrubHash();

        if (!data.ok) {
          setPending();
          showError(data.error || 'That confirmation link could not be redeemed.');
          return;
        }

        landConfirmed(data.email, data.next);
      })
      .catch(function () {
        scrubHash();
        setPending();
        showError('We could not reach the server to confirm that link. Check your connection and try the code from the email instead.');
      });
  }

  /* The Identity-minted token from a link that predates this flow. Same
     shape, different endpoint. */
  function redeemLegacyToken(token) {
    setConfirming('link');
    el.form.hidden = true;

    fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: token })
    })
      .then(function (res) { return res.json().then(function (data) { return data || {}; }); })
      .then(function (data) {
        scrubHash();

        if (!data.ok) {
          setPending();
          showError(data.error || 'That confirmation link could not be redeemed.');
          return;
        }

        landConfirmed(data.email, null);
      })
      .catch(function () {
        scrubHash();
        setPending();
        showError('We could not reach the server to confirm that link. Check your connection and try the code from the email instead.');
      });
  }

  /* ---------- The code form --------------------------------------------- */

  /* Digits only, and never more than six. Typed into rather than validated
     afterwards, so a pasted "123 456" or a code copied with a stray full stop
     lands as six digits instead of as an error the visitor has to work out. */
  el.code.addEventListener('input', function () {
    var cleaned = el.code.value.replace(/\D+/g, '').slice(0, CODE_LENGTH);
    if (cleaned !== el.code.value) el.code.value = cleaned;
    clearFieldError(el.fCode);
  });

  el.email.addEventListener('input', function () { clearFieldError(el.fEmail); });

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMessages();
    clearFieldError(el.fCode);
    clearFieldError(el.fEmail);

    var code = el.code.value.replace(/\D+/g, '');
    var email = currentEmail();
    var ok = true;

    if (code.length !== CODE_LENGTH) {
      setFieldError(el.fCode, el.errCode, 'Enter the six digits from the email.');
      ok = false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      /* Only reachable with the field open — otherwise the address came from
         the store or the query string and cannot be wrong here. */
      el.fEmail.hidden = false;
      setFieldError(el.fEmail, el.errEmail, 'Enter the email address on the account.');
      ok = false;
    }
    if (!ok) {
      var firstBad = el.form.querySelector('.field.is-bad .input');
      if (firstBad) firstBad.focus();
      return;
    }

    setConfirming('code');

    post({ email: email, code: code })
      .then(function (data) {
        if (!data.ok) {
          setPending();

          /* A code that is simply wrong leaves the visitor on the field to
             try again, with however many attempts are left; anything else has
             spent the challenge, so the message points at "Send a new code"
             and the field is cleared rather than inviting a retype. */
          if (data.reason === 'mismatch' && !data.expired) {
            var note = typeof data.remaining === 'number' && data.remaining > 0
              ? data.error + ' ' + data.remaining + ' attempt' + (data.remaining === 1 ? '' : 's') + ' left on this code.'
              : data.error;
            setFieldError(el.fCode, el.errCode, note);
            el.code.select();
            return;
          }

          el.code.value = '';
          showError(data.error || 'That code could not be redeemed.');
          return;
        }

        landConfirmed(data.email || email, data.next);
      })
      .catch(function () {
        setPending();
        showError('We could not reach the server. Check your connection and try again, or email Cloakshield.pro@outlook.com.');
      });
  });

  /* ---------- Send a new code -------------------------------------------
     The server throttles this — one code a minute, six an hour — and reports
     the wait in seconds, so the button counts it down rather than letting
     somebody discover the limit by being refused. */

  var cooldown = 0;
  var cooldownTimer = null;

  function paintResend() {
    if (cooldown > 0) {
      el.resend.disabled = true;
      el.resendText.textContent = 'Send a new code in ' + cooldown + 's';
      return;
    }
    el.resend.disabled = false;
    el.resendText.textContent = 'Send a new code';
  }

  function startCooldown(seconds) {
    cooldown = Math.max(1, Math.round(seconds || 60));
    paintResend();

    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(function () {
      cooldown -= 1;
      paintResend();
      if (cooldown <= 0) clearInterval(cooldownTimer);
    }, 1000);
  }

  el.resend.addEventListener('click', function () {
    clearMessages();
    clearFieldError(el.fEmail);

    var email = currentEmail();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      el.fEmail.hidden = false;
      setFieldError(el.fEmail, el.errEmail, 'Enter the email address on the account.');
      el.email.focus();
      return;
    }

    el.resend.disabled = true;
    el.resendText.textContent = 'Sending…';

    post({ resend: 'true', email: email })
      .then(function (data) {
        if (!data.ok) {
          /* A throttle is not an error worth a red banner — the previous code
             is still live and still works. */
          if (data.retryAfter) {
            showNotice(data.error);
            startCooldown(data.retryAfter);
            return;
          }
          showError(data.error || 'That code could not be sent.');
          paintResend();
          return;
        }

        /* Deliberately worded without saying whether the address is on the
           account list — /api/verify does not say, and neither does this. */
        showNotice('If that address has an account awaiting confirmation, a new code is on its way. It replaces any earlier one.');
        if (data.minutes && el.expiry) {
          el.expiry.textContent = 'Codes expire ' + data.minutes + ' minutes after they are sent.';
        }
        el.code.value = '';
        el.code.focus();
        startCooldown(60);
      })
      .catch(function () {
        showError('We could not reach the server. Check your connection and try again.');
        paintResend();
      });
  });

  /* ---------- Hand off to the workspace -----------------------------------
     A fresh redemption is the one arrival here nobody asked for — the visitor
     typed a code or clicked a link, and the account they wanted already
     exists. So the page forwards itself rather than leaving them on a "done"
     screen to find the next step. The short delay is there so the
     confirmation is legible first, and the button underneath stays live the
     whole time for anyone who would rather not wait.

     Where it forwards *to* is the part that changed. Redeeming a code does
     not open a session: only Identity can, and it wants the password to do
     it, which this page does not have and should not be keeping. So the
     server names the destination — sign-in, with the address already filled
     in — and this follows it. The dashboard is only correct when a session
     already exists, which is why the fallback below is the one the server
     does not name.

     location.replace, not assign: the address that brought them here may have
     carried a single-use token, and back should return to the inbox. */

  function handOff(next) {
    var target = next || withPlan('/dashboard.html');

    /* The server's destination is a path with its own query string, so the
       plan rides along as extra parameters rather than replacing them. */
    if (next && planId && next.indexOf('plan=') === -1) {
      target = next + (next.indexOf('?') === -1 ? '?' : '&') +
        'plan=' + encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
    }

    var toSignIn = target.indexOf('/signin') === 0;
    var left = 4;

    el.go.setAttribute('href', target);
    el.goText.textContent = toSignIn ? 'Sign in now' : 'Open your workspace now';

    if (toSignIn) {
      el.msg.textContent = 'Your address is confirmed. Sign in once with the password you just chose and the workspace opens — it is the last step, and this browser will stay signed in afterwards.';
    }

    var say = function () {
      if (!el.note) return;
      el.note.textContent = toSignIn
        ? 'Taking you to sign-in in ' + left + ' second' + (left === 1 ? '' : 's') + '. Nothing has been charged yet.'
        : 'Opening your workspace in ' + left + ' second' + (left === 1 ? '' : 's') +
          '. Nothing has been charged yet — it opens on the sample data set until a plan is activated.';
    };

    say();

    var timer = setInterval(function () {
      left -= 1;
      if (left > 0) { say(); return; }
      clearInterval(timer);
      location.replace(target);
    }, 1000);

    /* Clicking through early stops the timer, so the two cannot race and put
       the same page onto history twice. */
    el.go.addEventListener('click', function () { clearInterval(timer); });
  }

  /* ---------- Wire up ----------------------------------------------------- */

  var token = tokenFromHash();

  if (known) showAddress(known);

  /* No address from anywhere means the visitor cannot be asked for a code
     without also being asked who they are. */
  if (!known && !token) el.fEmail.hidden = false;

  if (token) {
    if (token.kind === 'verify') redeemToken(token.value);
    else redeemLegacyToken(token.value);
  } else if (acct && acct.verified) {
    setConfirmed(acct.email);
  } else {
    setPending();
    if (!confirmationSent) showError('We could not confirm that the email left our side. Try "Send a new code" below.');
    el.code.focus();
  }

  /* An unconfirmed account that has just been turned away by sign-in arrives
     with ?reason=signin, and /api/login has already sent a fresh code. Saying
     so stops the visitor going straight for the resend button and being told
     to wait a minute. */
  if (params.get('reason') === 'signin' && !token) {
    showNotice('That address has not been confirmed yet, so we have just emailed a fresh code. Enter it below to finish setting up the account.');
    startCooldown(60);
  }

  /* ---------- "I confirmed this somewhere else" -------------------------
     The link opened on a phone, the code was typed in another tab: the
     address is confirmed and this browser simply has nothing to show for it.

     It asks the server rather than answering for itself, which is the whole
     point of the button. It used to be the primary action and it used to
     write verified:true into the store on click — nothing had checked
     anything, and because an unverified address cannot hold a session,
     /api/subscription answers "not signed in" for one and never contradicts
     the claim. So the flag stuck, and the flag was what the rest of the site
     read. A session is the only evidence this page will accept. */

  if (el.check) {
    el.check.addEventListener('click', function () {
      if (confirmedHere) {
        location.href = withPlan('/dashboard.html');
        return;
      }

      if (A) A.save({ plan: planId, months: months });

      el.check.disabled = true;
      el.check.textContent = 'Checking…';

      var onwards = function (signedIn) {
        if (signedIn) {
          location.href = withPlan('/dashboard.html');
          return;
        }
        location.href = '/signin.html?reason=confirmed&next=dashboard' +
          (known ? '&email=' + encodeURIComponent(known) : '') +
          '&plan=' + encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
      };

      if (!A || !A.sync) {
        onwards(false);
        return;
      }

      A.sync().then(function (data) {
        onwards(Boolean(data && data.signedIn));
      }, function () {
        onwards(false);
      });
    });
  }
})();
