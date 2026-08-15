# CloakShield Pro

Marketing site and crypto checkout for **CloakShield Pro**, the security layer for cloaking
and traffic routing platforms (bot filtering, geo resolution, landing page integrity
monitoring and funnel masking, running alongside platforms like Cloaking House, Keitaro
and Voluum rather than replacing them).

Primary domain: **cloakshield.io**

## What's here

| Page | Purpose |
|---|---|
| `index.html` | Homepage — hero, features, how it works, compatible platforms, integrations, pricing + calculator, testimonials, FAQ, contact, footer |
| `checkout.html` | Crypto checkout with a 30-minute rate-locked payment countdown |
| `privacy.html` | Privacy notice |
| `terms.html` | Terms of service |

## Technology

Deliberately **zero-dependency static HTML, CSS and JavaScript**. There is no build
step, no framework and no bundler — the files you edit are the files that ship.
That keeps first paint fast and makes the site trivial to audit.

- **Hosting** — Netlify, publishing the repository root (`netlify.toml`)
- **Forms** — Netlify Forms, submitted over `fetch` without a page reload
- **Fonts** — Chivo (display), Public Sans (body), JetBrains Mono (numerics) via Google Fonts
- **Icons** — inline SVG `<symbol>` sprite, one per page, no icon font
- **QR codes** — pre-generated SVGs in `assets/qr/`, committed rather than generated at runtime

## Running locally

No install step. Serve the directory with any static server:

```bash
npx serve .
# or
python3 -m http.server 8888
```

To exercise Netlify Forms and redirects locally:

```bash
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
  footer, CTA band) and `checkout.html`.
- **Brand colours** — the `:root` and `[data-theme="light"]` token blocks in `css/style.css`.

## Accessibility and performance notes

- Full keyboard support, visible focus rings, skip link, and `prefers-reduced-motion` honoured.
- The countdown announces to screen readers on a throttle rather than every second.
- Dark and light themes are both first-class; the choice persists and is applied before paint.
- No render-blocking JavaScript; both scripts are deferred.
