/* ==========================================================================
   CloakShield Pro — email verification step

   Three ways in, one page:
     · straight from registration, with a confirmation email on its way
     · from the link in that email, with a token in the URL fragment
     · back later, from a browser that already finished confirming

   The token is redeemed by /api/confirm rather than in the browser, because
   redeeming it here would mean bundling the Identity client into a site that
   has no build step.
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
    err: $('#verifyErr'),
    errText: $('#verifyErrText'),
    go: $('#verifyGo'),
    goText: $('#verifyGoText'),
    resend: $('#verifyResend'),
    note: $('#verifyNote'),
    chkVerify: $('#chkVerify'),
    chkVerifyD: $('#chkVerifyD'),
    chkVerifyBadge: $('#chkVerifyBadge'),
    chkWorkspace: $('#chkWorkspace'),
    chkPayD: $('#chkPayD')
  };

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

  /* ---------- States -----------------------------------------------------

     Set only by a token redeemed on this page, which is the one arrival here
     that leaves a session behind it. Deliberately not set by setConfirmed(),
     which also runs off the cached record to paint the confirmed state for a
     returning visitor — that cache is a paint, not a proof, and the button
     guard at the bottom is the thing that must not trust it. */

  var confirmedHere = false;

  function showError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
  }

  function showAddress(email) {
    if (!email) return;
    el.mail.textContent = email;
    el.mail.hidden = false;
  }

  /* Whether a confirmation email actually went out. /api/register works this
     out from Identity and js/auth.js puts it in the store, because this page
     cannot tell from here — and the two cases need different copy. Only an
     explicit false changes the wording: an older record, or a visitor who
     came back to this page days later, has no opinion on the question and the
     ordinary message is the right one for them. */
  var confirmationSent = !(acct && acct.confirmationSent === false);

  function setPending() {
    el.title.textContent = 'Confirm your email address';
    el.msg.textContent = confirmationSent
      ? 'We sent a confirmation link to the address you registered with. Opening it activates sign-in and unlocks plan activation inside the workspace.'
      : 'Your account exists, but we cannot confirm that the confirmation email left our side. If nothing arrives in the next few minutes, email Cloakshield.pro@outlook.com from the address you registered with and we will confirm it by hand.';
    el.goText.textContent = 'I have confirmed my email';
  }

  function setConfirming() {
    el.title.textContent = 'Confirming your address…';
    el.msg.textContent = 'Redeeming the link from your email. This takes a second.';
    el.go.classList.add('is-busy');
    el.goText.textContent = 'Confirming…';
  }

  function setConfirmed(email) {
    el.seal.classList.add('welcome__seal--ok');
    el.seal.innerHTML = '<svg><use href="#i-check"/></svg>';
    el.title.textContent = 'Email confirmed';
    el.msg.textContent = 'Sign-in is active for this address and your workspace is ready. Plans are chosen and activated from inside it.';
    el.go.classList.remove('is-busy');
    el.goText.textContent = 'Open your workspace';
    el.err.classList.remove('is-on');
    showAddress(email);

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
    if (el.resend) el.resend.hidden = true;
  }

  /* ---------- Redeem a token from the confirmation link ------------------ */

  function tokenFromHash() {
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return '';
    var found = new URLSearchParams(hash).get('confirmation_token');
    return found || '';
  }

  function redeem(token) {
    setConfirming();

    fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    })
      .then(function (res) {
        return res.json().then(function (data) { return data || {}; });
      })
      .then(function (data) {
        /* The token is single-use, so it should not survive a refresh
           whatever the outcome. */
        history.replaceState(null, '', location.pathname + location.search);

        if (!data.ok) {
          setPending();
          showError(data.error || 'That confirmation link could not be redeemed.');
          return;
        }

        confirmedHere = true;

        if (A) A.save({ email: data.email || (acct && acct.email), verified: true, plan: planId, months: months });
        setConfirmed(data.email || (acct && acct.email));
        handOff();
      })
      .catch(function () {
        setPending();
        showError('We could not reach the server to confirm that link. Check your connection and open the link again.');
      });
  }

  /* ---------- Hand off to the workspace -----------------------------------
     A fresh redemption is the one arrival here nobody asked for — the visitor
     clicked a link in their inbox, and the account they wanted already exists.
     So the page forwards to the workspace itself rather than leaving them on
     a "done" screen to find the next step. The short delay is there so the
     confirmation is legible first, and the button underneath stays live the
     whole time for anyone who would rather not wait.

     Only after a redemption. Someone who opens /welcome.html again later is
     reading it deliberately, and moving them off it would be rude.

     location.replace, not assign: the address that brought them here carried
     a single-use token, and back should return to the inbox, not to it. */

  function handOff() {
    var target = withPlan('/dashboard.html');
    var left = 3;

    var say = function () {
      if (!el.note) return;
      el.note.textContent = 'Opening your workspace in ' + left + ' second' + (left === 1 ? '' : 's') +
        '. Nothing has been charged yet — it opens on the sample data set until a plan is activated.';
    };

    el.goText.textContent = 'Open your workspace now';
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

  if (acct) showAddress(acct.email);

  if (token) {
    redeem(token);
  } else if (acct && acct.verified) {
    setConfirmed(acct.email);
  } else if (!acct) {
    /* No account on this browser: nothing to confirm, and the workspace is
       gated on registration, so send them back to the start. */
    location.replace(withPlan('/register.html'));
    return;
  }

  /* ---------- "I have confirmed my email" -------------------------------
     Without a token in the URL there is nothing for this page to redeem, so
     the button has to find out from somewhere whether the address really was
     confirmed. It used to answer the question itself: a click wrote
     verified:true into the store and let the visitor through. Nothing had
     checked anything, and because an unconfirmed address cannot hold a
     session, /api/subscription answers "not signed in" for one and never
     contradicts the claim — so the flag stuck, and the flag was the thing the
     rest of the site read.

     So the button asks the server instead. Confirming a token opens a
     session, which makes "does this browser have one" exactly the same
     question as "was this address confirmed", and it is one the server can
     answer. No session means the link has not been opened yet, or was opened
     somewhere else; sign-in covers both, and Identity refuses an unconfirmed
     address there, so it cannot be talked past either.

     A redemption that happened on this page skips all of it: the session is
     already open and the link underneath goes straight through. */

  el.go.addEventListener('click', function (e) {
    if (confirmedHere) return;

    e.preventDefault();

    if (A) A.save({ plan: planId, months: months });

    el.go.classList.add('is-busy');
    el.goText.textContent = 'Checking…';

    var onwards = function (signedIn) {
      if (signedIn) {
        location.href = withPlan('/dashboard.html');
        return;
      }
      location.href = '/signin.html?reason=confirmed&next=dashboard&plan=' +
        encodeURIComponent(planId) + '&months=' + encodeURIComponent(months);
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
})();
