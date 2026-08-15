# CloakShield Pro

Marketing site and crypto checkout for **CloakShield Pro**, the security layer for cloaking
and traffic routing platforms (bot filtering, geo resolution, landing page integrity
monitoring and funnel masking, running alongside platforms like Cloaking House, Keitaro
and Voluum rather than replacing them).

Primary domain: **cloakshield.io**

## What's here

| Page | Purpose |
|---|---|
| `index.html` | Homepage — hero, client logos, features, how it works, workspace preview + journey strip, compatible platforms, integrations, pricing + calculator, testimonials, FAQ, contact, footer |
| `register.html` | Step 1 of 3 — create an account with an email and a password |
| `welcome.html` | Step 2 of 3 — onboarding checklist, carries the chosen plan forward |
| `checkout.html` | Step 3 of 3 — crypto checkout with a 30-minute rate-locked countdown |
| `dashboard.html` | Workspace walkthrough — verdict log, integrity monitor, latency (sample data) |
| `about.html` | The company, the people, security posture and the full contact page |
| `privacy.html` | Privacy notice |
| `terms.html` | Terms of service |

## The signup flow

```
/#pricing  →  /register.html?plan=X&months=Y
           →  POST /api/register  (Netlify Function → Netlify Identity signup)
           →  /welcome.html?plan=X&months=Y
           →  /checkout.html?plan=X&months=Y   ← 30-minute crypto countdown
           →  /dashboard.html
```

`plan` and `months` travel in the query string the whole way, so the countdown opens on
the plan chosen back on the pricing page. Returning customers can skip straight from
registration to payment with the link under the form.

The account email is passed from the register page to the welcome page through
`sessionStorage`, not the URL, and the key is deleted after one read — it never reaches
browser history or a `Referer` header.

## Technology

The frontend is **zero-dependency static HTML, CSS and JavaScript**. There is no build
step, no framework and no bundler — the files you edit are the files that ship. That keeps
first paint fast and makes the site trivial to audit.

`package.json` exists for exactly one reason: Netlify needs it to install
`@netlify/identity` for `netlify/functions/register.mts`. Calling `signup()` on the server
is what lets the browser stay bundler-free — the register page just POSTs JSON to
`/api/register`, same-origin, which also keeps it inside the site's `connect-src 'self'`
content security policy. No frontend asset is compiled.

- **Hosting** — Netlify, publishing the repository root (`netlify.toml`)
- **Accounts** — Netlify Identity, via a single server-side function
- **Forms** — Netlify Forms, submitted over `fetch` without a page reload
- **Fonts** — Chivo (display), Public Sans (body), JetBrains Mono (numerics) via Google Fonts
- **Icons** — inline SVG `<symbol>` sprite, one per page, no icon font
- **QR codes** — pre-generated SVGs in `assets/qr/`, committed rather than generated at runtime

## Running locally

No install step for the site itself. Serve the directory with any static server:

```bash
npx serve .
# or
python3 -m http.server 8888
```

To exercise Netlify Forms, redirects and the registration function locally:

```bash
npm install          # only needed for the function's dependency
netlify dev --port 8889
```

## The payment countdown

The checkout locks a quoted rate for **30 minutes**. The countdown stores an absolute
expiry timestamp in `localStorage`, so refreshing the page, backgrounding the tab or
closing the laptop resumes the real remaining time rather than restarting the clock.

State escalates as the window closes: teal above 10 minutes, amber under 10, red and
pulsing under 5, blinking under 1. At zero the address is retired, the QR dims, submission
is disabled, and a **Generate new payment address** button restarts the window.

Changing the plan, the term or the network issues a new reference and a fresh 30 minutes,
because each of those changes the amount owed.

## Editing common things

- **Crypto addresses** — `checkout.html`, the `data-addr` attribute on each `.asset` button.
  Regenerate the matching QR in `assets/qr/` if an address changes (see `AGENTS.md`).
- **Exchange rates** — `data-rate` on the same buttons. They are labelled indicative.
- **Prices and discounts** — `js/pricing.js`. It is the single source of truth shared by the
  homepage calculator and the checkout summary.
- **Countdown duration** — `WINDOW_MS` in `js/checkout.js`.
- **Contact details** — email and Telegram links appear in `index.html` (contact section,
  footer, CTA band), `about.html`, `welcome.html` and `checkout.html`.
- **Brand colours** — the `:root` and `[data-theme="light"]` token blocks in `css/style.css`.
  Teal is the brand and means "passed / filtered clean" in the product UI; violet and azure
  are the secondary hues, kept away from any verdict state so a colour never means two
  things at once.
- **The workspace console** — the `.appshot` block in `css/style.css`, used at full size on
  `dashboard.html` and as an inert preview on the homepage. It is real markup, not an
  image, which is why it themes and reflows.

## Accessibility and performance notes

- Full keyboard support, visible focus rings, skip link, and `prefers-reduced-motion` honoured.
- The countdown announces to screen readers on a throttle rather than every second.
- Dark and light themes are both first-class; the choice persists and is applied before paint.
- No render-blocking JavaScript; every script is deferred, and no page loads more than three.
- The chart on the dashboard carries a text `aria-label` describing its shape, because a
  bar chart read cell by cell tells a screen reader user nothing.

## A note on the product screenshots

There are none, and that is deliberate. The workspace shown on the homepage and
`dashboard.html` is a working HTML interface rendered live from `.appshot`, populated with
representative sample figures and labelled as such on the page. It is not a photograph of a
running deployment, and nothing here should be presented as one.
