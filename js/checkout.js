/* ==========================================================================
   CloakShield Pro — checkout
   Crypto payment selection + 30-minute rate-lock countdown.

   The countdown is stored as an absolute expiry timestamp in localStorage,
   so a refresh, a backgrounded tab or a closed laptop all resume correctly
   rather than restarting the window.
   ========================================================================== */

(function () {
  'use strict';

  var P = window.CSPricing;
  if (!P) return;

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };

  var WINDOW_MS = 30 * 60 * 1000;      // 30 minutes
  var RING_LEN = 213.6;                // 2πr for r=34
  var STORE_KEY = 'cs-pay-session';

  var assetsEl = $('#assets');
  if (!assetsEl) return;

  /* ---------- Element cache -------------------------------------------- */

  var el = {
    assets: $$('.asset'),
    clock: $('#clock'),
    timer: $('#timer'),
    ring: $('#ring'),
    hint: $('#timerHint'),
    srClock: $('#srClock'),
    alertBox: $('#alertBox'),
    alertText: $('#alertText'),
    expiredBox: $('#expiredBox'),
    regenBtn: $('#regenBtn'),
    payBlock: $('#payBlock'),
    qrImg: $('#qrImg'),
    qrBadge: $('#qrBadge'),
    addrVal: $('#addrVal'),
    copyBtn: $('#copyBtn'),
    cryptoAmount: $('#cryptoAmount'),
    fiatEquiv: $('#fiatEquiv'),
    kvNet: $('#kvNet'),
    kvConf: $('#kvConf'),
    kvEta: $('#kvEta'),
    kvRate: $('#kvRate'),
    netNotice: $('#netNotice'),
    payAssetName: $('#payAssetName'),
    invoiceRef: $('#invoiceRef'),
    sentBtn: $('#sentBtn'),
    trkWaiting: $('#trkWaiting'),
    trkWaitingD: $('#trkWaitingD'),
    trkConfD: $('#trkConfD'),
    sumPlan: $('#sumPlan'),
    sumTerm: $('#sumTerm'),
    sumRateLabel: $('#sumRateLabel'),
    sumList: $('#sumList'),
    sumDiscRow: $('#sumDiscRow'),
    sumDiscLabel: $('#sumDiscLabel'),
    sumDisc: $('#sumDisc'),
    sumTotal: $('#sumTotal'),
    chPlan: $('#chPlan'),
    chTerm: $('#chTerm'),
    toast: $('#toast'),
    toastText: $('#toastText')
  };

  /* ---------- Asset descriptors from the DOM ---------------------------- */

  function readAsset(btn) {
    return {
      id: btn.getAttribute('data-id'),
      name: btn.getAttribute('data-name'),
      net: btn.getAttribute('data-net'),
      sym: btn.getAttribute('data-sym'),
      cls: btn.getAttribute('data-cls'),
      addr: btn.getAttribute('data-addr'),
      dec: Number(btn.getAttribute('data-dec')),
      rate: Number(btn.getAttribute('data-rate')),
      conf: btn.getAttribute('data-conf'),
      eta: btn.getAttribute('data-eta')
    };
  }

  var ASSETS = el.assets.map(readAsset);

  function assetById(id) {
    for (var i = 0; i < ASSETS.length; i++) {
      if (ASSETS[i].id === id) return ASSETS[i];
    }
    return ASSETS[0];
  }

  /* ---------- Session persistence --------------------------------------- */

  function loadSession() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.expiresAt || !s.assetId) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function saveSession(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function makeRef() {
    var n = Date.now().toString(36).toUpperCase().slice(-4);
    var r = Math.floor(Math.random() * 1296).toString(36).toUpperCase();
    return 'CS-' + n + ('00' + r).slice(-2);
  }

  /* ---------- State ------------------------------------------------------ */

  var params = new URLSearchParams(location.search);
  var stored = loadSession();

  var state = {
    planId: 'professional',
    months: 1,
    assetId: ASSETS[0].id,
    ref: makeRef(),
    expiresAt: 0
  };

  var urlPlan = params.get('plan');
  var urlMonths = params.get('months');
  var hasUrlIntent = Boolean(urlPlan || urlMonths);

  if (stored) {
    state.planId = stored.planId || state.planId;
    state.months = Number(stored.months) || state.months;
    state.assetId = stored.assetId;
    state.ref = stored.ref || state.ref;
    state.expiresAt = Number(stored.expiresAt) || 0;
  }

  /* A stored asset id that no longer exists (address retired, network dropped)
     must not survive into the next persist — fall back to the first asset. */
  state.assetId = assetById(state.assetId).id;

  if (urlPlan && P.PLANS[urlPlan]) state.planId = urlPlan;
  if (urlMonths && P.TERMS[urlMonths]) state.months = Number(urlMonths);

  /* A different order than the stored one means a new rate lock. */
  var orderChanged = stored && (stored.planId !== state.planId || Number(stored.months) !== state.months);
  if (!stored || (hasUrlIntent && orderChanged)) {
    startWindow(true);
  }

  function startWindow(newRef) {
    if (newRef) state.ref = makeRef();
    state.expiresAt = Date.now() + WINDOW_MS;
    persist();
  }

  function persist() {
    saveSession({
      planId: state.planId,
      months: state.months,
      assetId: state.assetId,
      ref: state.ref,
      expiresAt: state.expiresAt
    });
  }

  /* ---------- Rendering: order summary ----------------------------------- */

  function currentQuote() {
    return P.quote(state.planId, state.months);
  }

  function renderSummary() {
    var q = currentQuote();

    el.sumPlan.textContent = q.plan.name;
    el.sumTerm.textContent = q.termLabel;
    el.sumRateLabel.textContent = P.money(q.plan.monthly) + ' × ' + q.termLabel;
    el.sumList.textContent = P.money(q.list);

    if (q.discount > 0) {
      el.sumDiscRow.hidden = false;
      el.sumDiscLabel.textContent = q.months === 12
        ? 'Annual rate (−' + q.offPct + '%)'
        : 'Term discount (−' + q.offPct + '%)';
      el.sumDisc.textContent = '−' + P.money(q.discount);
    } else {
      el.sumDiscRow.hidden = true;
    }

    el.sumTotal.textContent = P.money(q.total);
    el.chPlan.value = state.planId;
    el.chTerm.value = String(state.months);
  }

  /* ---------- Rendering: payment detail ---------------------------------- */

  function formatCrypto(amount, dec) {
    return amount.toLocaleString('en-US', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec
    });
  }

  function renderAsset() {
    var a = assetById(state.assetId);
    var q = currentQuote();
    var amount = q.total / a.rate;

    el.assets.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-id') === a.id));
    });

    el.qrImg.setAttribute('src', '/assets/qr/' + a.id + '.svg');
    el.qrImg.setAttribute('alt', 'QR code for the ' + a.sym + ' deposit address on ' + a.net);
    el.qrBadge.textContent = a.net;

    el.addrVal.textContent = a.addr;
    el.cryptoAmount.textContent = formatCrypto(amount, a.dec) + ' ' + a.sym;
    el.fiatEquiv.textContent = '≈ ' + P.money(q.total) + ' USD';

    el.kvNet.textContent = a.net;
    el.kvConf.textContent = a.conf;
    el.kvEta.textContent = a.eta;
    el.kvRate.textContent = a.rate === 1
      ? '1 ' + a.sym + ' = $1.00'
      : '1 ' + a.sym + ' = ' + P.money(a.rate);

    el.netNotice.textContent = 'Send only ' + a.sym + ' on ' + a.net +
      '. Assets sent on a different chain cannot be recovered.';

    el.payAssetName.textContent = a.sym === 'USDT'
      ? 'USDT (' + a.net.replace(/^.*\(|\)$/g, '') + ')'
      : a.name;

    el.trkConfD.textContent = 'Clears after ' + a.conf + ' (' + a.eta + ')';
    el.invoiceRef.textContent = state.ref;
  }

  /* ---------- Countdown --------------------------------------------------- */

  var expired = false;
  var lastAnnouncedMinute = -1;
  var confirmClaimed = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function setAlert(kind, html) {
    if (!kind) {
      el.alertBox.classList.remove('is-on');
      return;
    }
    el.alertBox.className = 'alert alert--' + kind + ' is-on';
    el.alertText.innerHTML = html;
  }

  function applyExpired() {
    if (expired) return;
    expired = true;

    el.clock.textContent = '00:00';
    el.timer.className = 'timer is-expired';
    el.hint.textContent = 'Payment Expired';
    el.ring.style.strokeDashoffset = RING_LEN;

    el.payBlock.classList.add('is-expired');
    el.expiredBox.classList.add('is-on');
    setAlert('danger', '<b>Payment Expired.</b> This address is no longer valid for your order. Generate a new payment address to continue.');

    el.sentBtn.disabled = true;
    el.sentBtn.textContent = 'Payment window closed';
    el.copyBtn.disabled = true;

    el.trkWaiting.classList.remove('is-active', 'is-done');
    el.trkWaiting.classList.add('is-pending');
    el.trkWaitingD.textContent = 'Window expired before a transfer arrived';
    resetTrackerTail();

    el.srClock.textContent = 'Payment window has expired.';
  }

  function clearExpired() {
    expired = false;
    confirmClaimed = false;

    el.payBlock.classList.remove('is-expired');
    el.expiredBox.classList.remove('is-on');
    setAlert(null);

    el.sentBtn.disabled = false;
    el.sentBtn.textContent = 'I have sent the payment';
    el.copyBtn.disabled = false;

    el.trkWaiting.classList.add('is-active');
    el.trkWaiting.classList.remove('is-pending', 'is-done');
    el.trkWaitingD.textContent = 'Watching the address for an incoming transaction';
    resetTrackerTail();
    el.hint.textContent = 'Send the exact amount before the timer runs out.';
    lastAnnouncedMinute = -1;
  }

  /* The "I have sent the payment" click advances the step after the waiting one.
     Anything that restarts the order has to walk that back, or the tracker keeps
     claiming a confirmation is in flight for a payment nobody made. */
  function resetTrackerTail() {
    var next = el.trkWaiting.nextElementSibling;
    if (next) {
      next.classList.remove('is-active', 'is-done');
      next.classList.add('is-pending');
    }
  }

  function tick() {
    var remaining = state.expiresAt - Date.now();

    if (remaining <= 0) {
      applyExpired();
      return;
    }

    if (expired) clearExpired();

    var secsTotal = Math.ceil(remaining / 1000);
    var mins = Math.floor(secsTotal / 60);
    var secs = secsTotal % 60;

    el.clock.textContent = pad(mins) + ':' + pad(secs);
    el.ring.style.strokeDashoffset = String(RING_LEN * (1 - remaining / WINDOW_MS));

    /* Escalating visual state */
    var cls = 'timer';
    if (secsTotal <= 60) cls += ' is-danger is-critical';
    else if (secsTotal <= 300) cls += ' is-danger';
    else if (secsTotal <= 600) cls += ' is-warn';
    if (el.timer.className !== cls) el.timer.className = cls;

    /* Threshold notices — banded, so a refresh mid-window still shows
       the right one instead of missing a crossing event. */
    if (secsTotal <= 60) {
      setAlert('danger', '<b>Payment expiring soon — complete immediately!</b> Less than a minute remains on this address.');
    } else if (secsTotal <= 300) {
      setAlert('danger', '<b>Payment will expire in 5 minutes — complete your payment now!</b> After that the quoted rate is released.');
    } else if (secsTotal <= 600) {
      setAlert('warn', '<b>Payment will expire in 10 minutes.</b> Make sure the transfer is broadcast before the timer reaches zero.');
    } else {
      setAlert(null);
    }

    /* Announce sparingly for screen readers. */
    if (mins !== lastAnnouncedMinute && (mins <= 5 || mins % 5 === 0)) {
      lastAnnouncedMinute = mins;
      el.srClock.textContent = mins === 0
        ? 'Under one minute remaining to complete payment.'
        : mins + ' minute' + (mins === 1 ? '' : 's') + ' remaining to complete payment.';
    }
  }

  /* ---------- Interactions ------------------------------------------------ */

  el.assets.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-id');
      if (id === state.assetId && !expired) return;

      state.assetId = id;
      startWindow(true);       // a new address on screen means a fresh window
      clearExpired();
      renderAsset();
      tick();
      toast('Switched to ' + assetById(id).net);
    });
  });

  el.regenBtn.addEventListener('click', function () {
    startWindow(true);
    clearExpired();
    renderAsset();
    tick();
    toast('New address issued · 30:00 on the clock');
    el.payBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  el.chPlan.addEventListener('change', function () {
    state.planId = el.chPlan.value;
    startWindow(true);
    clearExpired();
    renderSummary();
    renderAsset();
    tick();
  });

  el.chTerm.addEventListener('change', function () {
    state.months = Number(el.chTerm.value);
    startWindow(true);
    clearExpired();
    renderSummary();
    renderAsset();
    tick();
  });

  el.sentBtn.addEventListener('click', function () {
    if (expired || confirmClaimed) return;
    confirmClaimed = true;

    el.trkWaiting.classList.remove('is-active');
    el.trkWaiting.classList.add('is-done');
    el.trkWaitingD.textContent = 'Marked as sent — matching against the chain';

    var next = el.trkWaiting.nextElementSibling;
    if (next) {
      next.classList.remove('is-pending');
      next.classList.add('is-active');
    }

    el.sentBtn.disabled = true;
    el.sentBtn.textContent = 'Watching for your transaction…';
    toast('Thanks — we are watching the address for your transfer');
  });

  /* ---------- Copy to clipboard -------------------------------------------- */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.select();
      try {
        doc.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      } finally {
        doc.body.removeChild(ta);
      }
    });
  }

  el.copyBtn.addEventListener('click', function () {
    if (el.copyBtn.disabled) return;
    var label = el.copyBtn.querySelector('span');

    copyText(el.addrVal.textContent.trim()).then(function () {
      el.copyBtn.classList.add('is-done');
      label.textContent = 'Copied';
      toast('Address copied to clipboard');
      setTimeout(function () {
        el.copyBtn.classList.remove('is-done');
        label.textContent = 'Copy';
      }, 2200);
    }).catch(function () {
      toast('Could not copy — select the address manually');
    });
  });

  /* ---------- Toast --------------------------------------------------------- */

  var toastTimer;
  function toast(message) {
    el.toastText.textContent = message;
    el.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('is-on');
    }, 2800);
  }

  /* ---------- Boot ---------------------------------------------------------- */

  renderSummary();
  renderAsset();
  tick();
  setInterval(tick, 1000);

  /* Re-sync immediately when the tab regains focus, so a backgrounded
     tab does not display a stale clock for up to a second. */
  doc.addEventListener('visibilitychange', function () {
    if (!doc.hidden) tick();
  });
})();
