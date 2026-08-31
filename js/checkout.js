/* ==========================================================================
   CloakShield Pro — checkout
   Crypto payment selection + 30-minute rate-locked window.

   The amount, the address, the rate and the reference all come from
   /api/order. None of them is computed here, and that is the point: the
   figure on screen has to be the same figure the deposit poller is waiting
   for, to the last digit. A number this file worked out for itself could not
   be matched to a payment by anything on the server.

   That last digit is load-bearing. MEXC issues one deposit address per coin
   and network, shared across every customer, so the address cannot say who
   paid — the amount does, by carrying a tail that is unique among open
   orders. Which is why nothing here rounds, reformats or "tidies" the value
   it was given.

   The countdown is still driven by an absolute expiry timestamp rather than a
   decrementing counter, so a refresh, a backgrounded tab or a closed laptop
   resume correctly. It now comes from the order rather than from
   localStorage, which means the clock on screen is the same rate lock the
   server is honouring.
   ========================================================================== */

(function () {
  'use strict';

  var P = window.CSPricing;
  if (!P) return;

  var A = window.CSAccount;

  var doc = document;
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };

  var WINDOW_MS = 30 * 60 * 1000;      // 30 minutes, matching RATE_WINDOW_MS
  var RING_LEN = 213.6;                // 2πr for r=34
  var STORE_KEY = 'cs-pay-session';
  var WATCH_MS = 8000;                 // how often to ask whether the plan is live

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
    exactAmount: $('#exactAmount'),
    fiatEquiv: $('#fiatEquiv'),
    kvNet: $('#kvNet'),
    kvConf: $('#kvConf'),
    kvEta: $('#kvEta'),
    kvRate: $('#kvRate'),
    netNotice: $('#netNotice'),
    payAssetName: $('#payAssetName'),
    invoiceRef: $('#invoiceRef'),
    txHash: $('#txHash'),
    txField: $('#txHash') && $('#txHash').closest('.field'),
    txHint: $('#txHint'),
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

  /* ---------- Asset descriptors from the DOM ----------------------------
     Labels only. The address, the rate and the decimals that matter live in
     netlify/lib/assets.mts, and reach this page inside the order. */

  function readAsset(btn) {
    return {
      id: btn.getAttribute('data-id'),
      name: btn.getAttribute('data-name'),
      net: btn.getAttribute('data-net'),
      sym: btn.getAttribute('data-sym'),
      cls: btn.getAttribute('data-cls'),
      dec: Number(btn.getAttribute('data-dec')),
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

  /* ---------- Remembered preferences -------------------------------------
     Which network the visitor last chose, and nothing more. The order itself
     is server-side, so there is no longer anything here worth forging. */

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        planId: state.planId,
        months: state.months,
        assetId: state.assetId
      }));
    } catch (e) {}
  }

  /* ---------- State ------------------------------------------------------ */

  var params = new URLSearchParams(location.search);
  var stored = loadPrefs();

  var state = {
    planId: 'professional',
    months: 1,
    assetId: ASSETS[0].id,
    order: null,
    expiresAt: 0
  };

  if (stored) {
    state.planId = stored.planId || state.planId;
    state.months = Number(stored.months) || state.months;
    state.assetId = stored.assetId || state.assetId;
  }

  /* A stored asset id that no longer exists (address retired, network dropped)
     must not survive into the next persist — fall back to the first asset. */
  state.assetId = assetById(state.assetId).id;

  var urlPlan = params.get('plan');
  var urlMonths = params.get('months');
  if (urlPlan && P.PLANS[urlPlan]) state.planId = urlPlan;
  if (urlMonths && P.TERMS[urlMonths]) state.months = Number(urlMonths);

  function planQuery() {
    return '?plan=' + encodeURIComponent(state.planId) +
           '&months=' + encodeURIComponent(state.months);
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

  /* ---------- Rendering: payment detail ----------------------------------
     Split in two. The chrome — which button is pressed, which QR, which
     network label — can be drawn from the markup the moment someone clicks.
     The money cannot, and waits for the order. */

  function renderChrome() {
    var a = assetById(state.assetId);

    el.assets.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-id') === a.id));
    });

    el.qrImg.setAttribute('src', '/assets/qr/' + a.id + '.svg');
    el.qrImg.setAttribute('alt', 'QR code for the ' + a.sym + ' deposit address on ' + a.net);
    el.qrBadge.textContent = a.net;

    el.kvNet.textContent = a.net;
    el.kvConf.textContent = a.conf;
    el.kvEta.textContent = a.eta;

    el.netNotice.textContent = 'Send only ' + a.sym + ' on ' + a.net +
      '. Assets sent on a different chain cannot be recovered.';

    el.payAssetName.textContent = a.sym === 'USDT'
      ? 'USDT (' + a.net.replace(/^.*\(|\)$/g, '') + ')'
      : a.name;

    el.trkConfD.textContent = 'Clears after ' + a.conf + ' (' + a.eta + ')';
  }

  function renderReserving() {
    el.invoiceRef.textContent = 'Reserving…';
    el.cryptoAmount.textContent = 'Reserving…';
    el.exactAmount.textContent = 'shown above';
    el.addrVal.textContent = '—';
    el.kvRate.textContent = '—';
    el.copyBtn.disabled = true;
    el.sentBtn.disabled = true;
    el.cryptoAmount.disabled = true;
  }

  /* The amount is printed exactly as the server sent it. No thousands
     separators, no re-rounding to the asset's nominal precision — the digits
     are the customer's order number. */
  function renderOrder() {
    var o = state.order;
    var a = assetById(state.assetId);
    if (!o) return;

    el.invoiceRef.textContent = o.reference;
    el.addrVal.textContent = o.address;
    el.cryptoAmount.textContent = o.amount + ' ' + o.sym;
    el.exactAmount.textContent = o.amount + ' ' + o.sym;
    el.fiatEquiv.textContent = '≈ ' + P.money(o.amountUsd) + ' USD';

    el.kvRate.textContent = o.rate === 1
      ? '1 ' + o.sym + ' = $1.00'
      : '1 ' + o.sym + ' = ' + P.money(o.rate);

    el.copyBtn.disabled = false;
    el.sentBtn.disabled = false;
    el.cryptoAmount.disabled = false;

    /* An order the visitor has already declared should not offer to be
       declared a second time — a reload is not a second payment. */
    if (o.status === 'confirming') markDeclared(Boolean(o.txHash));
  }

  /* ---------- Reserving the payment --------------------------------------- */

  var reserving = false;

  function signInAgain(reason) {
    location.replace('/signin.html?next=checkout&reason=' + reason +
                     '&plan=' + encodeURIComponent(state.planId) +
                     '&months=' + encodeURIComponent(state.months));
  }

  function reserve() {
    if (reserving) return;
    reserving = true;

    persist();
    renderChrome();
    renderReserving();
    setAlert(null);

    fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        asset: state.assetId,
        plan: state.planId,
        months: String(state.months)
      })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (out) {
        reserving = false;
        var data = out.data || {};

        if (!data.ok) {
          if (data.code === 'signin_required') {
            signInAgain('expired');
            return;
          }

          /* No live rate means no honest amount to ask for, so nothing is
             shown. Quoting a stale number would be worse than waiting. */
          el.cryptoAmount.textContent = 'Unavailable';
          el.invoiceRef.textContent = 'Not reserved';
          setAlert('danger', '<b>' + escapeHtml(data.error ||
            'We could not reserve a payment amount.') + '</b> Pick another network, or try again in a moment.');
          return;
        }

        state.order = data.order;
        state.expiresAt = data.order.expiresAt;

        /* The server may hand back the order this browser already had, which
           is what makes a reload keep the same amount and the same clock
           rather than minting a new one. */
        if (data.order.plan !== state.planId || String(data.order.months) !== String(state.months)) {
          state.planId = data.order.plan;
          state.months = Number(data.order.months);
          renderSummary();
        }

        clearExpired();
        renderOrder();
        tick();
        startWatching();
      })
      .catch(function () {
        reserving = false;
        el.cryptoAmount.textContent = 'Unavailable';
        el.invoiceRef.textContent = 'Not reserved';
        setAlert('danger', '<b>We could not reach the server.</b> Check your connection and pick a network again — nothing has been reserved, so nothing is at risk.');
      });
  }

  function escapeHtml(text) {
    var div = doc.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /* ---------- Countdown --------------------------------------------------- */

  var expired = false;
  var lastAnnouncedMinute = -1;
  var declared = false;
  var settled = false;

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
    declared = false;

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
    var steps = $$('#track .track__step');
    for (var i = 2; i < steps.length; i++) {
      steps[i].classList.remove('is-active', 'is-done');
      steps[i].classList.add('is-pending');
    }
  }

  function tick() {
    if (settled || !state.order) return;

    var remaining = state.expiresAt - Date.now();

    if (remaining <= 0) {
      /* An expired window retires the quote, not the payment. A transfer that
         arrives against the old amount is still matched server-side, which is
         why the expired panel says the funds are safe. */
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
       the right one instead of missing a crossing event. Suppressed once the
       transfer has been declared: the clock is the rate lock, and someone who
       has already sent the money does not need to be told to hurry. */
    if (declared) {
      setAlert(null);
    } else if (secsTotal <= 60) {
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

  /* ---------- Declaring the transfer -------------------------------------- */

  function markDeclared(hasHash) {
    declared = true;

    el.trkWaiting.classList.remove('is-active');
    el.trkWaiting.classList.add('is-done');
    el.trkWaitingD.textContent = hasHash
      ? 'Marked as sent — matching your transaction'
      : 'Marked as sent — matching against the amount you were quoted';

    var next = el.trkWaiting.nextElementSibling;
    if (next) {
      next.classList.remove('is-pending');
      next.classList.add('is-active');
    }

    el.sentBtn.disabled = true;
    el.sentBtn.textContent = 'Watching for your transaction…';
    setAlert(null);
  }

  el.sentBtn.addEventListener('click', function () {
    if (expired || declared || settled || !state.order) return;

    var hash = el.txHash.value.trim();

    el.sentBtn.disabled = true;
    el.sentBtn.textContent = 'Recording…';
    if (el.txField) el.txField.classList.remove('is-bad');

    /* A claim, not a settlement. It moves the order to "pending" so the
       workspace says something truthful; only the deposit poller can make it
       active, and only once MEXC reports the funds as credited. */
    fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reference: state.order.reference, tx_hash: hash })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (out) {
        var data = out.data || {};

        if (!data.ok) {
          if (data.code === 'signin_required') {
            signInAgain('expired');
            return;
          }

          if (data.code === 'duplicate_hash' && el.txField) {
            el.txField.classList.add('is-bad');
            el.txHint.textContent = data.error;
          } else {
            setAlert('danger', '<b>' + escapeHtml(data.error || 'We could not record that.') + '</b>');
          }

          el.sentBtn.disabled = false;
          el.sentBtn.textContent = 'I have sent the payment';
          return;
        }

        /* Local echo so the workspace reads "pending" on the next paint
           without waiting for a round trip. The server already knows.

           Skipped for a customer who already has a live plan: this is a
           renewal, and writing "pending" over an active subscription would
           lock the workspace of somebody who has paid, for as long as it takes
           the next sync to put it back. */
        if (A && !A.hasActivePlan()) {
          A.startSubscription(state.planId, state.months, state.order.reference);
        }

        markDeclared(Boolean(hash));
        toast('Thanks — we are watching the address for your transfer');
        startWatching(true);
      })
      .catch(function () {
        setAlert('danger', '<b>We could not reach the server.</b> Your transfer is not lost — it will be matched automatically once it lands. Try this button again in a moment.');
        el.sentBtn.disabled = false;
        el.sentBtn.textContent = 'I have sent the payment';
      });
  });

  /* ---------- Watching for confirmation -----------------------------------
     Polls the one endpoint that knows. While an order is in "confirming",
     /api/subscription asks MEXC about that coin directly before answering
     (throttled server-side), so a credited transfer usually shows up here
     within seconds rather than on the next scheduled pass. */

  var watchTimer = null;

  function startWatching(immediate) {
    if (watchTimer || settled) return;
    watchTimer = setInterval(checkSettled, WATCH_MS);
    if (immediate) setTimeout(checkSettled, 1200);
  }

  function stopWatching() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  function checkSettled() {
    if (settled || doc.hidden) return;

    /* Naming the order matters. Picking a network, changing your mind and
       picking another leaves two reserved orders on the account, and the
       server cannot tell which one this page is looking at unless it is
       told. */
    var ref = state.order && state.order.reference;
    var url = '/api/subscription' + (ref ? '?reference=' + encodeURIComponent(ref) : '');

    fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok || settled) return;

        if (!data.signedIn) {
          signInAgain('expired');
          return;
        }

        /* Everything below is about THIS order, matched on the reference, not
           about the account's subscription state in general. A customer
           renewing a plan that is still running arrives here with
           status 'active' already — settling on that alone would congratulate
           them and redirect them out of the checkout before they had paid for
           the term they came to buy. */
        var mine = data.order && state.order &&
                   data.order.reference === state.order.reference ? data.order : null;

        if (!mine) return;

        /* The order on screen may have moved to "confirming" without this tab
           doing anything — a second tab, or a hash pasted on a phone. */
        if (!declared && mine.state === 'confirming') {
          markDeclared(Boolean(mine.txHash));
        }

        if (mine.state === 'paid') applySettled(data, mine);
      })
      .catch(function () {
        /* Silent. A dropped poll is not news; the next one is in eight
           seconds and the payment is being reconciled server-side either
           way. */
      });
  }

  function applySettled(data, order) {
    settled = true;
    stopWatching();

    el.timer.className = 'timer is-done';
    el.clock.textContent = 'Paid';
    el.hint.textContent = 'Payment confirmed';
    el.ring.style.strokeDashoffset = '0';
    setAlert(null);

    el.payBlock.classList.remove('is-expired');
    el.expiredBox.classList.remove('is-on');
    el.sentBtn.disabled = true;
    el.sentBtn.textContent = 'Payment confirmed';

    var steps = $$('#track .track__step');
    steps.forEach(function (step) {
      step.classList.remove('is-pending', 'is-active');
      step.classList.add('is-done');
    });

    el.trkWaitingD.textContent = 'Transfer received and credited';
    el.trkConfD.textContent = 'Confirmed on-chain';

    el.srClock.textContent = 'Payment confirmed. Opening your workspace.';
    toast('Payment confirmed — opening your workspace');

    /* The order that was just paid decides where the workspace opens, not the
       account's subscription record — on a renewal those are two different
       plans until the next sync lands. */
    var plan = (order && order.plan) || state.planId;
    var months = String((order && order.months) || state.months);

    /* The account store is refreshed before the redirect so the blocking
       script in the workspace <head> stamps data-sub="active" on the very
       first paint, instead of showing a locked console and then correcting
       itself. */
    var go = function () {
      location.replace('/dashboard.html?plan=' + encodeURIComponent(plan) +
                       '&months=' + encodeURIComponent(months));
    };

    if (A && A.sync) A.sync().then(function () { setTimeout(go, 2200); }, function () { setTimeout(go, 2200); });
    else setTimeout(go, 2200);
  }

  /* ---------- Interactions ------------------------------------------------ */

  el.assets.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (settled) return;
      var id = btn.getAttribute('data-id');
      if (id === state.assetId && state.order && !expired) return;

      state.assetId = id;
      state.order = null;
      reserve();                 // a different network means a different order
      toast('Switched to ' + assetById(id).net);
    });
  });

  el.regenBtn.addEventListener('click', function () {
    if (settled) return;
    state.order = null;
    reserve();
    toast('New address issued · 30:00 on the clock');
    el.payBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  el.chPlan.addEventListener('change', function () {
    if (settled) return;
    state.planId = el.chPlan.value;
    state.order = null;
    renderSummary();
    reserve();
  });

  el.chTerm.addEventListener('change', function () {
    if (settled) return;
    state.months = Number(el.chTerm.value);
    state.order = null;
    renderSummary();
    reserve();
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

  /* Copying the amount is the step people get wrong by hand, so the figure is
     selectable in one click as well. */
  el.cryptoAmount.addEventListener('click', function () {
    if (!state.order) return;
    copyText(state.order.amount).then(function () {
      toast('Amount copied — send it exactly as shown');
    }).catch(function () {});
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
  renderChrome();
  renderReserving();
  reserve();
  setInterval(tick, 1000);

  /* Re-sync immediately when the tab regains focus, so a backgrounded
     tab does not display a stale clock for up to a second — and check
     whether the payment landed while it was in the background. */
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) return;
    tick();
    if (!settled && state.order) checkSettled();
  });
})();
