# AGENTS.md

Orientation for AI agents working on this repository.

## What this is

A static marketing site plus crypto checkout for CloakShield Pro, a data protection
platform (encryption, privacy monitoring, compliance evidence). Four HTML pages, two
stylesheets, three scripts. **No build step, no framework, no package.json.** Do not
introduce one without a concrete reason — the absence of a toolchain is a deliberate
choice for load speed and auditability, not an oversight.

## Layout

```
index.html            Homepage — all nine sections
checkout.html         Crypto checkout + 30-minute countdown
privacy.html          Privacy notice
terms.html            Terms of service
css/style.css         Design tokens + everything shared
css/checkout.css      Checkout-only (loaded by checkout.html alone)
js/pricing.js         Shared pricing model — load before the other two
js/site.js            Theme, nav, reveal, pricing toggle, calculator, forms
js/checkout.js        Asset selection, countdown, clipboard, order summary
assets/favicon.svg    The "C"-on-shield mark, also used as the app icon
assets/og-image.svg   Social card
assets/qr/*.svg       Pre-generated payment QR codes, one per network
netlify.toml          Publish root, security headers, cache policy, pretty URLs
```

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
the build bot detects them. Because this is a static site there is no SSR catch-all, so
posting to `/` is correct and no `__forms.html` skeleton is required. `.netlify/features/netlify-forms`
marks the feature as enabled; do not delete it.

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
for forms and redirects. `node --check js/*.js` catches syntax errors. Check both themes
and a narrow viewport before considering a change done — several components (steps,
bento grid, timer, pay block) have distinct mobile layouts.
