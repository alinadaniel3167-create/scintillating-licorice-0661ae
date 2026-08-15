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

  /* ---------- States ----------------------------------------------------- */

  function showError(message) {
    el.errText.textContent = message;
    el.err.classList.add('is-on');
  }

  function showAddress(email) {
    if (!email) return;
    el.mail.textContent = email;
    el.mail.hidden = false;
  }

  function setPending() {
    el.title.textContent = 'Confirm your email address';
    el.msg.textContent = 'We sent a confirmation link to the address you registered with. Opening it activates sign-in and unlocks plan activation inside the workspace.';
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

        if (A) A.save({ email: data.email || (acct && acct.email), verified: true, plan: planId, months: months });
        setConfirmed(data.email || (acct && acct.email));
      })
      .catch(function () {
        setPending();
        showError('We could not reach the server to confirm that link. Check your connection and open the link again.');
      });
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

  /* Without a token in the URL there is nothing to redeem, so the button
     records that the visitor followed the link in their inbox and moves on.
     Identity remains the authority: an unconfirmed address cannot sign in. */
  el.go.addEventListener('click', function () {
    if (A) A.save({ verified: true, plan: planId, months: months });
  });
})();
