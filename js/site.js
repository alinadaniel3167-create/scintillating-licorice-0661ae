/* ==========================================================================
   CloakShield Pro — site behaviour
   Theme, navigation, scroll reveal, pricing toggle, calculator, forms.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var $ = function (sel, root) { return (root || doc).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  /* ---------- Confirmation links ---------------------------------------
     Identity mails the confirmation link back to the site root with the
     token in the fragment. Every page loads this file, so wherever it
     lands it gets handed to the page that knows how to redeem it. */

  if (location.hash.indexOf('confirmation_token=') > -1 &&
      location.pathname.indexOf('/welcome') !== 0) {
    location.replace('/welcome.html' + location.hash);
    return;
  }

  /* ---------- Theme ---------------------------------------------------- */

  var toggle = $('#themeToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = doc.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      doc.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('cs-theme', next); } catch (e) {}
      toggle.setAttribute('aria-label', next === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    });
  }

  /* ---------- Sticky nav + mobile menu ---------------------------------- */

  var nav = $('#nav');
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-stuck', window.scrollY > 10);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var burger = $('#navBurger');
  var links = $('#navLinks');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = burger.getAttribute('aria-expanded') === 'true';
      burger.setAttribute('aria-expanded', String(!open));
      links.classList.toggle('is-open', !open);
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        burger.setAttribute('aria-expanded', 'false');
        links.classList.remove('is-open');
      }
    });
  }

  /* ---------- Scroll reveal -------------------------------------------- */

  var reveals = $$('.reveal');
  if (reveals.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      reveals.forEach(function (el) { io.observe(el); });
    } else {
      reveals.forEach(function (el) { el.classList.add('is-in'); });
    }
  }

  /* ---------- Pointer-tracked card glow -------------------------------- */

  if (matchMedia('(hover: hover)').matches) {
    $$('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
      });
    });
  }

  /* ---------- Tabs ------------------------------------------------------
     Panels are plain elements toggled with [hidden], so the first one is
     visible before this file runs and stays visible without JavaScript. */

  $$('[data-tabs]').forEach(function (group) {
    var btns = $$('[role="tab"]', group);
    if (!btns.length) return;

    function select(btn) {
      btns.forEach(function (b) {
        var on = b === btn;
        b.setAttribute('aria-selected', String(on));
        b.setAttribute('tabindex', on ? '0' : '-1');
        var panel = doc.getElementById(b.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    }

    btns.forEach(function (btn, i) {
      btn.setAttribute('tabindex', btn.getAttribute('aria-selected') === 'true' ? '0' : '-1');
      btn.addEventListener('click', function () { select(btn); });
      btn.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var next = btns[(i + step + btns.length) % btns.length];
        select(next);
        next.focus();
      });
    });
  });

  /* ---------- Console ticker (hero) ------------------------------------ */

  var scanCount = $('#scanCount');
  var ctrlPct = $('#ctrlPct');
  if (scanCount && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var n = 1284;
    setInterval(function () {
      n += 1 + Math.floor(Math.random() * 4);
      scanCount.textContent = n.toLocaleString('en-US');
    }, 2600);
  }
  if (ctrlPct) {
    var passing = 312;
    setInterval(function () {
      passing = passing === 312 ? 313 : 312;
      ctrlPct.textContent = passing + ' / 318';
    }, 7400);
  }

  /* ---------- Current year --------------------------------------------- */

  $$('#yr').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  /* ---------- Pricing: monthly / annual toggle -------------------------- */

  var billingBtns = $$('[data-billing]');
  if (billingBtns.length) {
    var money = function (n) {
      return '$' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: n % 1 ? 2 : 0
      });
    };

    /* Every figure on a tier card is derived from its own data-monthly and
       data-annual attributes: the yearly rate, the twelve-monthly figure it
       is struck against, the saving between them and the monthly equivalent.
       Nothing is held in a positional list, so the three cards cannot drift
       out of step with each other or with a price change. */
    var setBilling = function (mode) {
      var annual = mode === 'annual';

      billingBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-billing') === mode));
      });

      /* Scoped to .tier deliberately. [data-price] and [data-billing-note]
         only exist on these cards, but an unscoped [data-sub] lookup used to
         match <html> as well — js/account.js stamps the subscription state
         there — and rewriting that element's contents replaced the page. */
      $$('.tier').forEach(function (tier) {
        var amt  = tier.querySelector('[data-price]');
        var per  = tier.querySelector('[data-per]');
        var was  = tier.querySelector('[data-was]');
        var note = tier.querySelector('[data-billing-note]');
        if (!amt) return;

        var monthly = Number(amt.getAttribute('data-monthly'));
        var yearly  = Number(amt.getAttribute('data-annual'));
        var listed  = monthly * 12;
        var saved   = listed - yearly;

        amt.textContent = money(annual ? yearly : monthly);
        if (per) per.textContent = annual ? '/ year' : '/ month';

        /* The struck figure is what twelve monthly payments come to, so the
           saving on the line below has something visible to be a saving on. */
        if (was) {
          was.textContent = money(listed);
          was.hidden = !annual || saved <= 0;
        }

        if (!note) return;
        if (!annual) {
          note.textContent = 'Billed monthly · cancel anytime';
        } else if (saved > 0) {
          note.innerHTML = money(yearly / 12) + ' / month, billed annually · <b>save ' +
            money(saved) + '</b>';
        } else {
          note.textContent = 'Billed annually';
        }
      });

      /* Keep the tier CTAs pointing at the matching term. */
      $$('.tier a.btn').forEach(function (a) {
        var url = new URL(a.getAttribute('href'), location.origin);
        url.searchParams.set('months', annual ? '12' : '1');
        a.setAttribute('href', url.pathname + url.search);
      });
    };

    billingBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setBilling(btn.getAttribute('data-billing'));
      });
    });
  }

  /* ---------- Pricing calculator --------------------------------------- */

  var calc = $('#calc');
  if (calc && window.CSPricing) {
    var P = window.CSPricing;
    var state = { plan: 'professional', months: 1 };

    var els = {
      listLabel: $('#calcListLabel'),
      list: $('#calcList'),
      discRow: $('#calcDiscRow'),
      discLabel: $('#calcDiscLabel'),
      disc: $('#calcDisc'),
      total: $('#calcTotal'),
      perMonth: $('#calcPerMonth'),
      go: $('#calcGo')
    };

    function renderCalc() {
      var q = P.quote(state.plan, state.months);

      els.listLabel.textContent = P.money(q.plan.monthly) + ' × ' + q.termLabel;
      els.list.textContent = P.money(q.list);

      if (q.discount > 0) {
        els.discRow.hidden = false;
        els.discLabel.textContent = q.months === 12
          ? 'Annual rate (−' + q.offPct + '%)'
          : q.termLabel + ' term (−' + q.offPct + '%)';
        els.disc.textContent = '−' + P.money(q.discount);
      } else {
        els.discRow.hidden = true;
      }

      els.total.textContent = P.money(q.total);
      els.perMonth.textContent = P.money(q.perMonth);
      /* Registration comes first, and it forwards both parameters on to the
         crypto checkout — so the countdown still starts from the plan the
         visitor picked here. A visitor who already has an account skips
         straight to the plan panel in the workspace instead. */
      els.go.setAttribute('href', window.CSAccount
        ? window.CSAccount.entry(q.planId, q.months)
        : '/register.html?plan=' + q.planId + '&months=' + q.months);
    }

    $$('[data-calc-plan]', calc).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.plan = btn.getAttribute('data-calc-plan');
        $$('[data-calc-plan]', calc).forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        renderCalc();
      });
    });

    $$('[data-calc-months]', calc).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.months = Number(btn.getAttribute('data-calc-months'));
        $$('[data-calc-months]', calc).forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        renderCalc();
      });
    });

    renderCalc();
  }

  /* ---------- Contact / newsletter form submission ---------------------- */

  function encode(formData) {
    var pairs = [];
    formData.forEach(function (value, key) {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return pairs.join('&');
  }

  var contactForm = $('#contactForm');
  if (contactForm) {
    var ok = $('#cfOk');
    var err = $('#cfErr');
    var submit = $('#cfSubmit');

    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      ok.classList.remove('is-on');
      err.classList.remove('is-on');
      submit.disabled = true;
      submit.textContent = 'Sending…';

      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encode(new FormData(contactForm))
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          ok.classList.add('is-on');
          contactForm.reset();
          submit.textContent = 'Message sent';
        })
        .catch(function () {
          err.classList.add('is-on');
          submit.disabled = false;
          submit.textContent = 'Send message';
        });
    });
  }

  var nlForm = $('#newsletterForm');
  if (nlForm) {
    var nlStatus = $('#nlStatus');
    nlForm.addEventListener('submit', function (e) {
      e.preventDefault();
      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encode(new FormData(nlForm))
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          nlForm.reset();
          nlStatus.textContent = 'Subscribed — see you next month.';
          nlStatus.style.color = 'var(--accent)';
          nlStatus.style.display = 'block';
        })
        .catch(function () {
          nlStatus.textContent = 'Could not subscribe. Please email us instead.';
          nlStatus.style.color = 'var(--red)';
          nlStatus.style.display = 'block';
        });
    });
  }
})();
