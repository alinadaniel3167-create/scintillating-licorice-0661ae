# AGENTS.md

Orientation for AI agents working on this repository.

## What this is

A static marketing site plus crypto checkout for CloakShield Pro, the security layer for
cloaking and traffic routing platforms (bot filtering, geo resolution, landing page
integrity monitoring, funnel masking — positioned as running alongside platforms such as
Cloaking House, Keitaro and Voluum, not replacing them). Eight HTML pages, three
stylesheets, seven scripts, two Netlify Functions and four Identity email templates.

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
register.html         Step 1 of 4 — the full account form (seven fields)
welcome.html          Step 2 of 4 — redeems the confirmation token from the email
dashboard.html        Step 3 of 4 — workspace walkthrough (sample data, noindex),
                      and the only place a plan can be started (#subscribe)
checkout.html         Step 4 of 4 — crypto checkout + 30-minute countdown
about.html            About the company + the full contact page
privacy.html          Privacy notice
terms.html            Terms of service
css/style.css         Design tokens + everything shared, including .appshot
css/app.css           Account pages only (register, welcome, dashboard)
css/checkout.css      Checkout-only (loaded by checkout.html alone)
js/pricing.js         Shared pricing model — load before any of the others
js/site.js            Theme, nav, reveal, pricing toggle, calculator, forms
js/account.js         The `cs-account` store, the page guard, the signed-in chip
js/auth.js            Registration form, strength meter, POST to /api/register
js/welcome.js         Redeems the confirmation token, marks the account verified
js/subscribe.js       Workspace plan picker — the only link to the checkout
js/checkout.js        Asset selection, countdown, clipboard, order summary
netlify/functions/register.mts
                      Server-side Netlify Identity signup, exposed at /api/register
netlify/functions/confirm.mts
                      Redeems the emailed confirmation token, at /api/confirm
email-templates/*.html
                      The four Identity transactional emails. Published as
                      static files; pointed at by path in the Identity
                      settings. See the README beside them.
assets/favicon.svg    The "C"-on-shield mark, also used as the app icon
assets/og-image.svg   Social card
assets/qr/*.svg       Pre-generated payment QR codes, one per network
netlify.toml          Publish root, security headers, cache policy, pretty URLs,
                      and the /api/register and /api/confirm rewrites
package.json          Exists solely to install the function's one dependency
```

## The signup flow

Nobody reaches a payment address without an account and a confirmed email. The chain is:

`index.html` pricing → `register.html?plan=X&months=Y` → `js/auth.js` POSTs JSON to
`/api/register` → `netlify/functions/register.mts` calls `signup()` from
`@netlify/identity` → `welcome.html?plan=X&months=Y` → the visitor clicks the link in
their confirmation email → `js/welcome.js` POSTs the token to `/api/confirm` →
`dashboard.html#subscribe` → `checkout.html?plan=X&months=Y`.

Every hop carries `plan` and `months` in the query string, which is why the countdown
still starts on the plan the visitor picked five pages earlier.

**`localStorage['cs-account']` is the gate, not a session.** `js/account.js` owns it. It
records the address, name, account type, chosen plan, a `verified` flag and a
`subscription` record; Netlify Identity still owns the real session and the password.
`CSAccount.require()` is what sends an anonymous visitor back to registration and an
unconfirmed one back to `welcome.html`. Clearing the key signs the browser out.

**Identity mails the confirmation link to the site root**, with the token in the URL
fragment (`/#confirmation_token=…`). `js/site.js` therefore forwards any page carrying
that fragment to `/welcome.html`, which redeems it and then `history.replaceState`s the
token out of the address bar — it is single-use and does not belong in history. Redemption
happens server-side in `confirm.mts` on purpose: doing it in the browser would mean
bundling the Identity client into a site that has no build step.

**A fresh redemption hands off to the workspace on its own.** `js/welcome.js` shows the
confirmed state, then `location.replace`s to `/dashboard.html?plan=…&months=…` after three
seconds — the visitor arrived from their inbox, not from the site, and the account they
wanted already exists, so sending them back to a "create account" screen would be wrong.
The button underneath stays live and cancels the timer, and someone who opens
`welcome.html` again later is *not* forwarded: they came deliberately.

**The only link to `checkout.html` is `#subGo` inside the dashboard panel.** If you add a
second one, add the guard with it — `checkout.html` also runs a blocking pre-paint check
of `cs-account` in `<head>`, so an unregistered visitor never sees a payment address, but
that is a backstop rather than the design.

## The subscription gate

A confirmed address gets you the workspace; it does not get you the tools. `js/account.js`
carries a `subscription` record with three states, and everything downstream reads them:

| `status`  | What it means                                              | What the visitor sees |
| --------- | ---------------------------------------------------------- | --------------------- |
| `none`    | no order started                                            | the plan picker, the console behind a lock ribbon |
| `pending` | transfer declared on the checkout, not yet reconciled       | a blue notice with the order reference, picker still open |
| `active`  | plan paid                                                   | the live-plan panel, the console unlocked and renamed to the account |

`CSAccount.hasActivePlan()` is the one question a tool asks. `subscription()` returns
`null` for anything that is not `pending` or `active`, so a hand-edited `localStorage`
value cannot unlock anything by inventing a fourth state.

`pending` is entered by the "I have sent the payment" button in `js/checkout.js`, which is
why `checkout.html` loads `js/account.js` — it is a *claim*, not a settlement. Nothing in
the browser flips it to `active`; that is reconciliation's job. Do not shortcut it to
`active` on click, however tempting the demo is.

The blocking `<head>` script on `dashboard.html` stamps `data-sub="none|pending|active"`
on `<html>` before first paint, and `js/account.js` shows and hides `[data-sub-show]`
elements — a space-separated list of the states that element belongs to. Every one of them
starts `hidden` in the markup, so nothing flashes before the script runs.

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

**`/api/register` and `/api/confirm` are rewrites, not real paths.** `netlify.toml` maps
them to `/.netlify/functions/register` and `/.netlify/functions/confirm` with a 200. The
short paths matter: the CSP on this site sets `connect-src 'self'`, so the fetches have to
stay same-origin. Point `js/auth.js` at the function's real path and the rewrite becomes
dead config; point it off-origin and the CSP blocks it.

**The registration function never handles a password itself.** It validates shape — the
address looks like an address, the password is at least 8 characters and matches the
confirmation, the account type is one of the three known values, and the name, country and
use case are present — then hands the credentials plus the rest as metadata to `signup()`
from `@netlify/identity`. The profile fields ride along as Identity user metadata; nothing
is stored on the site side. Do not add hashing, storage or session logic to it — the whole
reason it exists is to avoid a browser bundler *and* avoid hand-rolled auth.

**`.appshot` is a real interface, not a screenshot.** The workspace console on `index.html`
and `dashboard.html` is HTML and CSS, which is why it themes, reflows and stays legible at
360px. On the homepage it carries `.appshot--preview`, which makes it inert to pointers so
a tap scrolls the page instead of chasing a link that goes nowhere. If you swap it for an
image you lose the light theme and the mobile layout in one move.

**Figures repeat across pages.** 7.2 ms p95, 2.4 ms median, 38 edge PoPs, 99.982% uptime,
30 vantage points. If you change one, grep for it — it appears on the homepage, the about
page and the dashboard, and a mismatch reads as carelessness rather than as a typo.

**The platform marks are ours, not the platforms'.** The five symbols in each sprite —
`#p-cloakinghouse`, `#p-keitaro`, `#p-voluum`, `#p-binom`, `#p-redtrack` — are geometric
artwork drawn for this site, each carrying a `--brand-*` token so a connector is
identifiable before its name is read. They are deliberately *not* the real logos: the site
names these products because it integrates with them, and drawing our own marks keeps that
factual without reproducing anyone's trademark or adding a third-party request. If you
replace them with fetched logos you take on both problems at once. The tokens sit outside
the signal palette and have darkened light-theme counterparts, because none of them means
"passed" or "stopped".

**The Identity emails are the one place a hard-coded colour is correct.** `email-templates/`
holds four table-based, inline-styled HTML files that Outlook can render. No stylesheet, no
custom property, no SVG, no web font survives the trip, so the palette is literal hex kept
in sync with `css/style.css` by hand. Netlify does not find them by convention — each has
to be pasted as a path under Project configuration → Identity → Emails. The README beside
them has the table.

**`js/account.js` loads before `js/site.js`.** It rewrites the pricing calls to action
for a signed-in visitor — `/register.html?plan=…` becomes `/dashboard.html?plan=…#subscribe`
— and it has to do that before `site.js` renders the calculator, which builds its own CTA
href through `CSAccount.entry()`. Swap the two `<script>` tags and a returning visitor gets
sent back through the signup form from the calculator.

**Theme is applied by a blocking inline script in `<head>`** before first paint. It looks
tiny and deletable. It is not — removing it causes a flash of the wrong theme on every load.
Every page needs its own copy. On `index.html`, `dashboard.html` and `welcome.html` the same
script also stamps `data-auth="in|out"` on `<html>` from `cs-account`, which is what the
`[data-auth] [data-account-hide]` rules in `style.css` key off; without it the nav would
paint "Create account" to a signed-in visitor and then correct itself. On `dashboard.html`
it stamps `data-sub` from the same object, for the same reason.

## Content and tone

Copy is concrete and specific: real mechanisms, messy numbers (6.4 ms, 99.982%, 214
connectors), invented but plausible customer names. Avoid marketing filler — "seamless",
"elevate", "unleash", "next-gen" — and avoid round fake statistics. If you add a section,
match that register.

## Verifying changes

There is nothing to compile. Open the pages in a browser, or `netlify dev --port 8889`
for forms, redirects and the two functions. `node --check js/*.js` catches syntax
errors. Check both themes and a narrow viewport before considering a change done — several
components (steps, bento grid, timer, pay block, `.appshot` sidebar, `.flow` strip, the
`.choices` radio cards, the `.flowsteps` rail, the `.subpanel`, the `.acctbar`, the
`.conlock` ribbon, the `.intg` connector cards, the `.cfg` policy rows and the `.conns`
strip) have distinct mobile layouts. If you touched the signup path, walk the whole chain
once: pricing → register → confirm the email → dashboard → checkout, and confirm the
countdown still opens on the plan you picked at the start.
`localStorage.removeItem('cs-account')` puts the browser back to anonymous, which is the
quickest way to re-test the guards.

The three subscription states are quickest to check from the console — edit the stored
object and reload:

```js
var a = JSON.parse(localStorage['cs-account']);
a.subscription = { plan: 'professional', months: '6', status: 'active', reference: 'CS-TEST' };
localStorage['cs-account'] = JSON.stringify(a);
```

`status: 'pending'` gives the notice-and-lock state, and deleting `a.subscription`
gives `none`.
