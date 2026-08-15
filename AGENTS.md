# AGENTS.md

Orientation for AI agents working on this repository.

## What this is

A static marketing site plus crypto checkout for CloakShield Pro, the security layer for
cloaking and traffic routing platforms (bot filtering, geo resolution, landing page
integrity monitoring, funnel masking — positioned as running alongside platforms such as
Cloaking House, Keitaro and Voluum, not replacing them). Seven HTML pages, three
stylesheets, five scripts, one Netlify Function.

**The frontend has no build step and no framework, and that is deliberate** — it is a load
speed and auditability choice, not an oversight. There *is* a `package.json`, but only so
Netlify can install `@netlify/identity` for the one server-side function; nothing in
`css/`, `js/` or the HTML is compiled, bundled or transpiled. Do not extend the manifest
into a frontend toolchain without a concrete reason.

## Layout

```
index.html            Homepage — hero, logos, features, how it works, workspace
                      preview + journey strip, compatibility, integrations,
                      pricing, testimonials, FAQ, contact, CTA
register.html         Step 1 of 3 — email + password, nothing else
welcome.html          Step 2 of 3 — onboarding checklist after signup
checkout.html         Step 3 of 3 — crypto checkout + 30-minute countdown
dashboard.html        Workspace walkthrough (sample data, noindex)
about.html            About the company + the full contact page
privacy.html          Privacy notice
terms.html            Terms of service
css/style.css         Design tokens + everything shared, including .appshot
css/app.css           Account pages only (register, welcome, dashboard)
css/checkout.css      Checkout-only (loaded by checkout.html alone)
js/pricing.js         Shared pricing model — load before any of the others
js/site.js            Theme, nav, reveal, pricing toggle, calculator, forms
js/auth.js            Registration form, strength meter, POST to /api/register
js/welcome.js         Carries the chosen plan into checkout, reads signup result
js/checkout.js        Asset selection, countdown, clipboard, order summary
netlify/functions/register.mts
                      Server-side Netlify Identity signup, exposed at /api/register
assets/favicon.svg    The "C"-on-shield mark, also used as the app icon
assets/og-image.svg   Social card
assets/qr/*.svg       Pre-generated payment QR codes, one per network
netlify.toml          Publish root, security headers, cache policy, pretty URLs,
                      and the /api/register rewrite
package.json          Exists solely to install the function's one dependency
```

## The signup flow

`index.html` pricing → `register.html?plan=X&months=Y` → `js/auth.js` POSTs JSON to
`/api/register` → `netlify/functions/register.mts` calls `signup()` from
`@netlify/identity` → `welcome.html?plan=X&months=Y` → `checkout.html?plan=X&months=Y`.

Every hop carries `plan` and `months` in the query string, which is why the countdown
still starts on the plan the visitor picked three pages earlier. `js/auth.js` hands the
account email to the welcome page through `sessionStorage['cs-signup']` rather than the
URL, and `js/welcome.js` deletes that key after reading it once — the address should never
land in history, a bookmark or a `Referer` header.

## Conventions

- **Vanilla ES5-flavoured JavaScript** in IIFEs. No modules, no transpiler, no `const`/arrow
  churn — match the existing style so the files stay directly runnable in the browser.
- **CSS custom properties for everything themeable.** Never hard-code a colour in a rule;
  add a token to `:root` and its `[data-theme="light"]` counterpart. A hard-coded hex is
  how the light theme breaks.
- **BEM-ish class names** (`.card__ico`, `.timer__clock`, `.nav__link`).
- **Icons** are `<symbol>` definitions in a hidden sprite at the top of each `<body>`,
  referenced with `<use href="#i-name"/>`. Adding an icon to a page means adding the symbol
  to that page's sprite — the sprites are per-page and intentionally not shared.
- **No emoji in UI text.** Use an SVG icon.

## Things that will bite you

**`js/pricing.js` is the single source of truth for money.** The homepage calculator and
the checkout summary both read it. Editing a price in one HTML file and not the model puts
them out of sync silently. The tier cards do carry `data-monthly` / `data-annual` attributes
for the monthly/annual toggle — if you change a price, change it in *both* places.

**The discount ladder is 0 / 10 / 10 / 15 / 20 percent** for 1, 2, 3, 6 and 12 months.
Twelve months is the published annual rate, which is why the tiers advertise $1,440, $3,360
and $4,800. These are not stacked discounts; stacking them would contradict the advertised
annual prices.

**The countdown uses an absolute expiry timestamp**, not a decrementing counter. That is
what makes it survive a refresh and a backgrounded tab. Do not rewrite it as
"seconds remaining minus one per tick" — the behaviour will regress in exactly the ways
the current design avoids.

**Threshold warnings are banded, not edge-triggered.** `tick()` derives the alert from the
current remaining time rather than firing on a crossing. This is why loading the page with
four minutes left correctly shows the 5-minute warning instead of nothing.

**QR codes are committed static files, not generated at runtime.** The addresses are fixed,
so this saves a dependency and a render cost. If an address changes, regenerate its SVG:

```bash
mkdir -p /tmp/qrgen && cd /tmp/qrgen && npm install qrcode@1.5.4
# then encode the plain address (no URI scheme) at errorCorrectionLevel 'M',
# margin 1, dark '#0A1012', light transparent, and rewrite width/height to 100%
# so it scales inside the fixed-size .qr container. See README for context.
```

Encode the **plain address**, not a `bitcoin:` / `ethereum:` URI — the same address serves
ETH, USDT-ERC20 and USDT-BEP20, so a chain-specific scheme would mislead wallets.

**Netlify Forms needs the static HTML to contain the form.** Both forms (`contact` and
`newsletter`) are real `<form data-netlify="true">` elements in `index.html`, which is how
the build bot detects them. `about.html` carries a second copy of the `contact` form —
same `name`, same field names, so both pages feed one submission list, and `js/site.js`
binds it by `#contactForm` without needing to know which page it is on. Because this is a
static site there is no SSR catch-all, so posting to `/` is correct and no `__forms.html`
skeleton is required. `.netlify/features/netlify-forms` marks the feature as enabled; do
not delete it. `.netlify/features/netlify-identity` does the same for the signup function.

**`/api/register` is a rewrite, not a real path.** `netlify.toml` maps it to
`/.netlify/functions/register` with a 200. The short path matters: the CSP on this site
sets `connect-src 'self'`, so the fetch has to stay same-origin. Point `js/auth.js` at the
function's real path and the rewrite becomes dead config; point it off-origin and the CSP
blocks it.

**The registration function never handles a password itself.** It validates shape (email
looks like an email, password is at least 8 characters) and then hands both to `signup()`
from `@netlify/identity`. Do not add hashing, storage or session logic to it — the whole
reason it exists is to avoid a browser bundler *and* avoid hand-rolled auth.

**`.appshot` is a real interface, not a screenshot.** The workspace console on `index.html`
and `dashboard.html` is HTML and CSS, which is why it themes, reflows and stays legible at
360px. On the homepage it carries `.appshot--preview`, which makes it inert to pointers so
a tap scrolls the page instead of chasing a link that goes nowhere. If you swap it for an
image you lose the light theme and the mobile layout in one move.

**Figures repeat across pages.** 7.2 ms p95, 2.4 ms median, 38 edge PoPs, 99.982% uptime,
30 vantage points. If you change one, grep for it — it appears on the homepage, the about
page and the dashboard, and a mismatch reads as carelessness rather than as a typo.

**Theme is applied by a blocking inline script in `<head>`** before first paint. It looks
tiny and deletable. It is not — removing it causes a flash of the wrong theme on every load.
Every page needs its own copy.

## Content and tone

Copy is concrete and specific: real mechanisms, messy numbers (6.4 ms, 99.982%, 214
connectors), invented but plausible customer names. Avoid marketing filler — "seamless",
"elevate", "unleash", "next-gen" — and avoid round fake statistics. If you add a section,
match that register.

## Verifying changes

There is nothing to compile. Open the pages in a browser, or `netlify dev --port 8889`
for forms, redirects and the register function. `node --check js/*.js` catches syntax
errors. Check both themes and a narrow viewport before considering a change done — several
components (steps, bento grid, timer, pay block, `.appshot` sidebar, `.flow` strip) have
distinct mobile layouts. If you touched the signup path, walk the whole chain once:
pricing → register → welcome → checkout, and confirm the countdown still opens on the plan
you picked at the start.
