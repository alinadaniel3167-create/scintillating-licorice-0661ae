/* ==========================================================================
   CloakShield Pro — workspace integrations panel

   The "Connected platforms" panel on dashboard.html was five hand-written
   cards with invented campaign counts in them, part of the sample workspace
   like the verdict log above it. This file is what makes it answer for a real
   account: it reads /api/integrations, replaces the sample grid with the
   customer's own, and runs the three actions on a card.

   Two things about it are deliberate and worth keeping.

   The sample grid is not deleted, it is swapped. An anonymous visitor reading
   the workspace walkthrough still needs to see the shape of the panel, and
   /api/integrations answers 401 for them — so the sample stays up and this
   file does nothing at all. The live grid takes over only once the endpoint
   has answered for a session.

   Nothing here claims traffic is flowing. A green card means the key was
   accepted by that platform's API and the campaign list could be read, which
   is exactly what the state text says: "Key verified". Routing, scoring and
   postback replay are a layer that does not exist yet, and a status light
   that implies otherwise would be the one failure this panel cannot afford.
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var root = doc.getElementById('integrations');
  if (!root) return;

  var el = {
    sample: doc.getElementById('intgSample'),
    sampleNote: doc.getElementById('intgSampleNote'),
    live: doc.getElementById('intgLive'),
    cards: doc.getElementById('intgCards'),
    msg: doc.getElementById('intgMsg'),
    badge: doc.getElementById('intgBadge'),
    sub: doc.getElementById('intgSub')
  };

  if (!el.cards || !el.live) return;

  var state = {
    entitled: false,
    configured: false,
    platforms: [],
    rows: [],
    /* The platform id whose connect form is open, or null. One at a time:
       two half-filled credential forms in one panel is a way to paste a key
       into the wrong one. */
    open: null,
    /* A string key while a request is in flight, so the card that is working
       is the only one that disables. */
    busy: null,
    formError: ''
  };

  /* ---------- Small builders ---------------------------------------------
     Everything on this panel is built with DOM calls rather than markup
     strings. Three of the values on a card — the label, the address and the
     reason a sync failed — originate outside this file, and textContent is
     the only way to put them on the page that cannot become markup. */

  function node(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* The sprites are per-page, so this references a symbol the page already
     carries rather than inlining a path. */
  function icon(symbol) {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    var use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', symbol);
    svg.appendChild(use);
    return svg;
  }

  function button(cls, text, onClick) {
    var b = node('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /* Matches the clock on the sample cards — "42 s ago", "1 m ago" — because
     the two grids sit in the same panel and a different time format would
     read as two different panels. */
  function ago(ms) {
    if (!ms) return 'never';
    var secs = Math.round((Date.now() - Number(ms)) / 1000);
    if (!isFinite(secs) || secs < 0) return 'just now';
    if (secs < 60) return secs + ' s ago';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' m ago';
    var hours = Math.round(mins / 60);
    if (hours < 48) return hours + ' h ago';
    return Math.round(hours / 24) + ' d ago';
  }

  function platformById(id) {
    for (var i = 0; i < state.platforms.length; i++) {
      if (state.platforms[i].id === id) return state.platforms[i];
    }
    return null;
  }

  function rowsFor(id) {
    return state.rows.filter(function (row) { return row.platform === id; });
  }

  /* The host, without the scheme, for a card subtitle. Falls back to the
     stored string if it will not parse — it was normalised server-side, so
     this is belt and braces rather than a real branch. */
  function hostOf(baseUrl) {
    if (!baseUrl) return '';
    try {
      return new URL(baseUrl).host;
    } catch (err) {
      return String(baseUrl).replace(/^https?:\/\//, '');
    }
  }

  function message(kind, text) {
    if (!el.msg) return;
    if (!text) {
      el.msg.hidden = true;
      el.msg.textContent = '';
      el.msg.className = 'intgmsg';
      return;
    }
    el.msg.hidden = false;
    el.msg.textContent = text;
    el.msg.className = 'intgmsg intgmsg--' + kind;
  }

  /* ---------- Cards -------------------------------------------------------- */

  function shell(platform) {
    var card = node('article', 'intg');
    card.setAttribute('data-brand', platform.brand);

    var mark = node('span', 'intg__mark');
    mark.appendChild(icon(platform.icon));
    card.appendChild(mark);

    return card;
  }

  function identity(card, platform, subtitle) {
    var id = node('div', 'intg__id');
    id.appendChild(node('b', null, platform.name));
    id.appendChild(node('span', null, subtitle));
    card.appendChild(id);
  }

  function meta(card, pairs) {
    var dl = node('dl', 'intg__meta');
    pairs.forEach(function (pair) {
      var wrap = node('div');
      wrap.appendChild(node('dt', null, pair[0]));
      wrap.appendChild(node('dd', 'mono', pair[1]));
      dl.appendChild(wrap);
    });
    card.appendChild(dl);
  }

  function stateLine(card, kind, text) {
    var cls = 'intg__state';
    var dot = 'dot dot--off';
    if (kind === 'on') { cls += ' intg__state--on'; dot = 'dot dot--live'; }
    if (kind === 'work') { cls += ' intg__state--work'; dot = 'dot dot--work'; }

    var line = node('span', cls);
    line.appendChild(node('span', dot));
    line.appendChild(doc.createTextNode(text));
    card.appendChild(line);
    return line;
  }

  function actions(card, buttons) {
    if (!buttons.length) return;
    var row = node('div', 'intg__act');
    buttons.forEach(function (b) { row.appendChild(b); });
    card.appendChild(row);
  }

  /* A platform this account has connected. The campaign count is kept on an
     errored card on purpose — "refused the key, last read 31 campaigns" is a
     more useful thing to read than a card that has forgotten. */
  function connectedCard(row, first) {
    var platform = platformById(row.platform);
    if (!platform) return null;

    var card = shell(platform);
    var host = hostOf(row.baseUrl);
    var subtitle = row.label || (host ? platform.kind + ' · ' + host : platform.summary);
    identity(card, platform, subtitle);

    var errored = row.status === 'error';

    meta(card, [
      ['Campaigns', row.campaigns == null ? '—' : String(row.campaigns)],
      [errored ? 'Last error' : 'Last checked', ago(errored ? row.lastErrorAt : row.lastSyncAt)],
      ['Key', row.hint ? '···' + row.hint : '—']
    ]);

    if (errored) {
      stateLine(card, 'work', 'Needs attention');
      card.appendChild(node('p', 'intg__why', row.statusReason || 'The last check did not succeed.'));
    } else {
      stateLine(card, 'on', 'Key verified');
    }

    var busyHere = state.busy === 'sync:' + row.id || state.busy === 'drop:' + row.id;

    var refresh = button('btn btn--ghost btn--sm', busyHere ? 'Working…' : 'Check now', function () {
      sync(row.id);
    });
    var drop = button('btn btn--quiet btn--sm', 'Disconnect', function () {
      disconnect(row.id, platform.name);
    });

    if (busyHere) { refresh.disabled = true; drop.disabled = true; }

    var buttons = [refresh, drop];

    /* Self-hosted platforms can legitimately have two instances, and the
       unique index is on (account, platform, address) rather than on
       (account, platform) so the table already allows it. */
    if (platform.selfHosted && state.entitled) {
      buttons.splice(1, 0, button('btn btn--quiet btn--sm', 'Add another', function () {
        openForm(platform.id);
      }));
    }

    actions(card, buttons);

    /* "Add another" opens the same form the available card uses. It is hung
       off the first card of this platform only, so two Keitaro instances do
       not produce two copies of one form. */
    if (first && state.open === platform.id) card.appendChild(form(platform));

    return card;
  }

  /* A platform with no key on file. This is the card that used to be a dead
     hover state. */
  function availableCard(platform) {
    var card = shell(platform);
    identity(card, platform, platform.summary);

    meta(card, [
      ['Campaigns', '—'],
      ['Last checked', 'never']
    ]);

    if (!platform.connectable) {
      stateLine(card, null, 'Set up by hand');
      card.appendChild(node('p', 'intg__why', platform.note));
      return card;
    }

    stateLine(card, null, 'Not connected');

    if (!state.configured) {
      card.appendChild(node('p', 'intg__why',
        'Integrations are not configured on this deploy yet. Email Cloakshield.pro@outlook.com and we will connect it for you.'));
      return card;
    }

    if (!state.entitled) {
      /* The console is readable before it is usable — same rule the lock
         ribbon above the workspace states. The button is a link to the plan
         picker rather than a disabled control with no way forward. */
      var go = node('a', 'btn btn--ghost btn--sm', 'Activate a plan');
      go.href = '#subscribe';
      actions(card, [go]);
      return card;
    }

    var open = state.open === platform.id;
    actions(card, [
      button('btn btn--primary btn--sm', open ? 'Cancel' : 'Connect', function () {
        if (open) { closeForm(); } else { openForm(platform.id); }
      })
    ]);

    if (open) card.appendChild(form(platform));

    return card;
  }

  /* ---------- The connect form ---------------------------------------------
     Built from the platform's own field list, so a platform that needs a key
     pair and one that needs a single key are the same code path. Secret
     fields are type="password" and autocomplete="off": a tracker admin key in
     a browser's saved-password list is a copy of it nobody asked for. */

  function form(platform) {
    var f = node('form', 'intgform');
    f.setAttribute('novalidate', 'novalidate');

    f.appendChild(node('p', 'intgform__note', platform.note));

    var inputs = {};

    var fields = platform.fields.slice();
    /* The optional nickname goes last, after the values that actually matter. */
    fields.push({
      name: 'label',
      label: 'Name for this instance (optional)',
      hint: 'Only shown to you. Useful when you run more than one.',
      secret: false
    });

    fields.forEach(function (field) {
      var wrap = node('div', 'field');
      var id = 'intg-' + platform.id + '-' + field.name;

      var label = node('label', 'field__label', field.label);
      label.setAttribute('for', id);
      wrap.appendChild(label);

      var input = node('input', 'input');
      input.id = id;
      input.name = field.name;
      input.type = field.secret ? 'password' : 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (field.name === 'baseUrl') input.placeholder = 'https://track.example.com';
      wrap.appendChild(input);
      wrap.appendChild(node('p', 'field__hint', field.hint));

      inputs[field.name] = input;
      f.appendChild(wrap);
    });

    if (state.formError) {
      f.appendChild(node('p', 'intgform__err', state.formError));
    }

    var busy = state.busy === 'connect:' + platform.id;

    var submit = node('button', 'btn btn--primary btn--sm');
    submit.type = 'submit';
    submit.textContent = busy ? 'Checking the key…' : 'Connect ' + platform.name;
    submit.disabled = busy;

    var cancel = button('btn btn--quiet btn--sm', 'Cancel', closeForm);
    cancel.disabled = busy;

    var act = node('div', 'intgform__act');
    act.appendChild(submit);
    act.appendChild(cancel);
    f.appendChild(act);

    f.addEventListener('submit', function (event) {
      event.preventDefault();

      var payload = { platform: platform.id };
      var missing = null;

      platform.fields.forEach(function (field) {
        var value = (inputs[field.name].value || '').trim();
        payload[field.name] = value;
        if (!value && !missing) missing = field;
      });
      payload.label = (inputs.label.value || '').trim();

      /* Refused in the browser so an obviously incomplete form costs no round
         trip, and refused again server-side so a direct caller cannot skip
         it — the same split /api/claim uses for the transaction hash. */
      if (missing) {
        state.formError = missing.label + ' is required.';
        render();
        var back = doc.getElementById('intg-' + platform.id + '-' + missing.name);
        if (back) back.focus();
        return;
      }

      connect(platform, payload);
    });

    return f;
  }

  function openForm(id) {
    state.open = id;
    state.formError = '';
    render();

    var platform = platformById(id);
    if (!platform || !platform.fields.length) return;
    var first = doc.getElementById('intg-' + id + '-' + platform.fields[0].name);
    if (first) first.focus();
  }

  function closeForm() {
    state.open = null;
    state.formError = '';
    render();
  }

  /* ---------- Render -------------------------------------------------------- */

  function render() {
    el.cards.textContent = '';

    var seen = {};
    state.rows.forEach(function (row) {
      var first = !seen[row.platform];
      seen[row.platform] = true;
      var card = connectedCard(row, first);
      if (card) el.cards.appendChild(card);
    });

    state.platforms.forEach(function (platform) {
      if (rowsFor(platform.id).length) return;
      el.cards.appendChild(availableCard(platform));
    });

    if (el.badge) {
      var live = state.rows.filter(function (row) { return row.status === 'verified'; }).length;
      var connectable = state.platforms.filter(function (p) { return p.connectable; }).length;
      el.badge.textContent = live + ' of ' + connectable + ' connected';
    }

    if (el.sub) {
      el.sub.textContent = state.entitled
        ? 'The platforms this account has an API key for, and what each key could last read'
        : 'Connect a platform once a plan is active. Everything below is yours — nothing is shared.';
    }
  }

  /* Hand the panel over from the sample grid. Done once, and only after the
     endpoint has answered, so a visitor with no account never sees the live
     grid flash empty. */
  function takeOver() {
    if (el.sample) el.sample.hidden = true;
    if (el.sampleNote) el.sampleNote.hidden = true;
    el.live.hidden = false;
  }

  /* ---------- Requests ------------------------------------------------------ */

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false }; });
    });
  }

  function load() {
    fetch('/api/integrations', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (res.status === 401) return null;
        return res.json();
      })
      .then(function (data) {
        /* No session. The sample walkthrough is the right thing to leave on
           screen, so this does nothing rather than emptying the panel. */
        if (!data || !data.ok || !data.signedIn) return;

        state.entitled = Boolean(data.entitled);
        state.configured = Boolean(data.configured);
        state.platforms = data.platforms || [];
        state.rows = data.integrations || [];

        takeOver();
        render();
      })
      .catch(function () {
        /* Same reasoning as CSAccount.sync(): a failed fetch changes nothing.
           A flaky connection must not replace a working panel with an error. */
      });
  }

  function connect(platform, payload) {
    state.busy = 'connect:' + platform.id;
    state.formError = '';
    message(null, '');
    render();

    post('/api/integration-connect', payload)
      .then(function (data) {
        state.busy = null;

        if (!data || !data.ok) {
          /* The failure belongs against the form, not in the panel banner:
             almost all of them are a key to re-paste or an address to fix. */
          state.formError = (data && data.error) ||
            'That key could not be checked. Please try again.';
          render();
          return;
        }

        state.open = null;
        state.formError = '';
        state.rows = state.rows.filter(function (row) { return row.id !== data.integration.id; });
        state.rows.push(data.integration);

        var count = data.integration.campaigns;
        message('ok', platform.name + ' connected' + (
          count == null ? '.' : ' — ' + count + (count === 1 ? ' campaign' : ' campaigns') + ' readable.'
        ));
        render();
      })
      .catch(function () {
        state.busy = null;
        state.formError = 'We could not reach the server. Check your connection and try again.';
        render();
      });
  }

  function sync(id) {
    state.busy = 'sync:' + id;
    message(null, '');
    render();

    post('/api/integration-sync', { id: String(id) })
      .then(function (data) {
        state.busy = null;

        /* A failed check still returns the row, with the error written onto
           it, so the card can show what went wrong rather than reverting to
           whatever it said before. */
        if (data && data.integration) {
          state.rows = state.rows.map(function (row) {
            return row.id === data.integration.id ? data.integration : row;
          });
        }

        if (!data || !data.ok) {
          message('bad', (data && data.error) || 'That check did not succeed.');
        }

        render();
      })
      .catch(function () {
        state.busy = null;
        message('bad', 'We could not reach the server. Check your connection and try again.');
        render();
      });
  }

  function disconnect(id, name) {
    if (!window.confirm('Disconnect ' + name + '? We will delete the API key we hold for it.')) return;

    state.busy = 'drop:' + id;
    message(null, '');
    render();

    post('/api/integration-disconnect', { id: String(id) })
      .then(function (data) {
        state.busy = null;

        if (!data || !data.ok) {
          message('bad', (data && data.error) || 'That platform could not be disconnected.');
          render();
          return;
        }

        state.rows = state.rows.filter(function (row) { return row.id !== id; });
        message('ok', name + ' disconnected. The key we held for it is deleted.');
        render();
      })
      .catch(function () {
        state.busy = null;
        message('bad', 'We could not reach the server. Check your connection and try again.');
        render();
      });
  }

  load();
})();
