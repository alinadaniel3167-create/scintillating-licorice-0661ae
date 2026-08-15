/* ==========================================================================
   CloakShield Pro — welcome / onboarding
   Reads the signup result left by the register page and points the next
   step at the plan the visitor picked before signing up.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };

  var msg = $('#welcomeMsg');
  if (!msg) return;

  var P = window.CSPricing;
  var STORE_KEY = 'cs-signup';

  /* ---------- Carry the chosen plan into checkout ------------------------ */

  var params = new URLSearchParams(location.search);
  var planId = params.get('plan');
  var months = params.get('months');

  if (!P || !P.PLANS[planId]) planId = 'professional';
  if (!P || !P.TERMS[months]) months = '1';

  var payLink = $('#chkPay');
  if (payLink) {
    payLink.setAttribute('href', '/checkout.html?plan=' + planId + '&months=' + months);
  }

  var payDesc = $('#chkPayD');
  if (payDesc && P) {
    var q = P.quote(planId, Number(months));
    payDesc.textContent = q.plan.name + ' · ' + q.termLabel + ' · ' + P.money(q.total) +
      ' due. Crypto checkout with the rate held for 30 minutes — change plan or term before you send.';
  }

  /* ---------- Reflect the actual signup outcome -------------------------- */

  var signup = null;
  try {
    var raw = sessionStorage.getItem(STORE_KEY);
    if (raw) signup = JSON.parse(raw);
  } catch (e) {}

  if (signup && signup.email) {
    var mail = $('#welcomeMail');
    if (mail) {
      mail.textContent = signup.email;
      mail.hidden = false;
    }

    msg.textContent = signup.verified
      ? 'You are signed in and your workspace is reserved. Pick a plan below and it opens as soon as the payment confirms.'
      : 'Check your inbox for a confirmation link — it activates sign-in for this address. You can choose a plan and pay in the meantime.';
  }

  /* One-shot: a refresh should not keep replaying a signup that already
     happened, and the address should not linger in storage. */
  try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
})();
