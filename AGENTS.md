# AGENTS.md

Orientation for AI agents working on this repository.

## What this is

A static marketing site plus crypto checkout for CloakShield Pro, the security layer for
cloaking and traffic routing platforms (bot filtering, geo resolution, landing page
integrity monitoring, funnel masking — positioned as running alongside platforms such as
Cloaking House, Keitaro and Voluum, not replacing them). Nine HTML pages, three
stylesheets, eight scripts, nine Netlify Functions, seven server-side modules, two Postgres
migrations and four Identity email templates.

**The frontend has no build step and no framework, and that is deliberate** — it is a load
speed and auditability choice, not an oversight. There *is* a `package.json`, but only so
Netlify can install `@netlify/identity` and `@netlify/database` for the server-side
functions; nothing in `css/`, `js/` or the HTML is compiled, bundled or transpiled. Do not
extend the manifest into a frontend toolchain without a concrete reason.

**Payments are confirmed automatically, and that is the part with real consequences.** A
customer pays into the project's MEXC account; a scheduled function reads MEXC's deposit
history, matches each deposit to an order, and flips that order to paid. The rest of the
site reads the result. Everything in "The order and payment model" below exists to make
that matching exact, and to make a payment that cannot be matched a review item rather
than a loss.

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
signin.html           Returning customers and lapsed cookies (noindex). Not part
                      of the four-step flow — the way back into it.
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
js/checkout.js        Asset selection, countdown, clipboard, order summary. Reserves
                      the order through /api/order and waits for /api/subscription
                      to say it is paid — it computes no amounts of its own.
js/signin.js          Sign-in form, POST to /api/login
netlify/lib/pricing.mts
                      Server mirror of js/pricing.js. The prices a payment is
                      actually checked against.
netlify/lib/assets.mts
                      The six payment options: deposit address, network, decimals,
                      MEXC coin and ticker symbol. Authoritative.
netlify/lib/mexc.mts  The two MEXC calls — signed deposit history, public ticker.
netlify/lib/store.mts Orders and deposits. Every SQL statement on the money path.
netlify/lib/poller.mts
                      Reconciliation. The only code that can write status 'paid'.
netlify/lib/notify.mts
                      Operator alerts and customer receipts. Every channel is
                      off until its environment variables exist, and nothing
                      here can fail a payment.
netlify/lib/http.mts  json() / fail() / readBody() for the functions.
netlify/functions/register.mts
                      Server-side Netlify Identity signup, exposed at /api/register
netlify/functions/confirm.mts
                      Redeems the emailed confirmation token, at /api/confirm
netlify/functions/login.mts, logout.mts
                      /api/login and /api/logout. Identity sets its cookies here.
netlify/functions/order.mts
                      /api/order — reserves an amount at a locked rate
netlify/functions/claim.mts
                      /api/claim — "I have sent it", optionally with a tx hash
netlify/functions/subscription.mts
                      /api/subscription — the authoritative signed-in + paid state
netlify/functions/mexc-poll.mts
                      Scheduled every two minutes. Runs the reconciliation pass.
netlify/functions/health.mts
                      /api/health — is confirmation actually running? Bookmark it.
                      Optionally gated by HEALTH_TOKEN; ?detail=1 lists the
                      review queue.
netlify/database/migrations/*.sql
                      Schema for orders, deposits and system_state, then the term
                      end and receipt columns. Netlify applies these
                      automatically; never run them by hand.
email-templates/*.html
                      The four Identity transactional emails. Published as
                      static files; pointed at by path in the Identity
                      settings. See the README beside them.
assets/favicon.svg    The "C"-on-shield mark, also used as the app icon
assets/og-image.svg   Social card
assets/qr/*.svg       Pre-generated payment QR codes, one per network
netlify.toml          Publish root, security headers, cache policy, pretty URLs,
                      and the eight /api/* rewrites
package.json          Exists solely to install the functions' two dependencies
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

**`localStorage['cs-account']` is a cache, not the authority.** It was the gate once. It
is not any more: `/api/subscription` is, and `CSAccount.sync()` runs on every page load
and overwrites the local `subscription` record with whatever the server says. What the
store is still *for* is the blocking `<head>` script — it lets a page stamp `data-auth`
and `data-sub` on `<html>` before first paint instead of flashing the wrong state and
correcting itself a moment later.

Three consequences worth knowing before you touch it:

- Editing the stored object by hand still changes what the page paints, and still gets
  reverted a few hundred milliseconds later when `sync()` returns. That is the intended
  behaviour, and it is also the quickest way to see a state (see "Verifying changes").
- If the server does not recognise the browser at all, `sync()` drops the cached
  subscription and sets `sessionLapsed: true`. A plan this browser cannot prove is not a
  plan.
- If the *fetch fails*, `sync()` deliberately changes nothing. A flaky connection must
  never lock a workspace somebody has paid for.

`CSAccount.require()` still sends an anonymous visitor back to registration and an
unconfirmed one back to `welcome.html`. Signing out now POSTs `/api/logout` as well as
clearing the key, because Identity holds a real cookie session — clearing localStorage
alone would sign the visitor straight back in on the next load.

**Returning customers come in through `signin.html`.** The four-step flow assumes a
brand-new visitor; a paying customer on a new device or with an expired cookie has no way
through it, because their address is already registered. `js/signin.js` POSTs
`/api/login`, and on success seeds `cs-account` before navigating so the pre-paint guards
on `dashboard.html` and `checkout.html` do not bounce someone who has just signed in. The
`next` parameter is a *name* (`dashboard`, `checkout`, `home`) resolved to a path
server-side — never a URL, because an open redirect on a login endpoint is exactly how a
phishing page borrows a real domain.

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

A confirmed address gets you the workspace; it does not get you the tools. Three states,
and everything downstream reads them:

| `status`  | What it means                                              | What the visitor sees |
| --------- | ---------------------------------------------------------- | --------------------- |
| `none`    | no order, an order opened and never declared, or a term that has run out | the plan picker, the console behind a lock ribbon |
| `pending` | transfer declared on the checkout, not yet credited by MEXC  | a blue notice with the order reference, picker still open |
| `active`  | the poller saw the money land **and the term it bought has not ended** | the live-plan panel, the console unlocked and renamed to the account |

They are derived in `uiStatus()` in `subscription.mts`, from two separate lookups rather
than one: `findPaidOrderForUser()` and `findOpenOrderForUser()`. `active` means the paid
order is still `isInTerm()`; `pending` means an open order has reached `confirming`;
everything else is `none`. `CSAccount.hasActivePlan()` is the one question a tool asks,
and it now answers from the synced cache rather than from anything the browser decided for
itself.

**The two lookups are separate because a renewing customer is in both at once** — a term
still running and a transfer still in flight. A single ranked query has to pick one, and
whichever it picks is wrong for somebody: rank the paid order first and the checkout never
sees the transfer it is watching; rank the open order first and a paying customer's
workspace locks the moment they open the checkout.

**A lapsed term reads as `none`, and that is reported separately.** The response carries a
`lapsed` block — plan, reference, `termEndsAt`, `graceEndsAt` — which `js/subscribe.js`
renders as the notice above the picker. The status is genuinely `none` (the tools do lock),
but "your Professional term ended on the 4th" and "you have never had a plan" are different
things to say, and only one of them tells the customer what to do next.

`pending` is entered by the "I have sent the payment" button, which POSTs `/api/claim` —
a *claim*, not a settlement. **Only `netlify/lib/poller.mts` can write `paid`, and only on
MEXC deposit status 5 or 12.** Nothing in the browser, and nothing in any other function,
may shortcut that, however tempting the demo is.

The blocking `<head>` script on `dashboard.html` stamps `data-sub="none|pending|active"`
on `<html>` before first paint, and `js/account.js` shows and hides `[data-sub-show]`
elements — a space-separated list of the states that element belongs to. Every one of them
starts `hidden` in the markup, so nothing flashes before the script runs.

## The order and payment model

This is the part to read before changing anything in `netlify/lib/` or `js/checkout.js`.

**MEXC gives out one deposit address per coin and network, shared by every customer.** So
the address cannot say who paid. The amount does. `createOrder()` takes the quoted USD
total, converts it at a rate locked from MEXC's own ticker, then adds a jitter of 1–99 of
the asset's smallest units — and a partial unique index guarantees that tail is unique
among *open* orders:

```sql
CREATE UNIQUE INDEX orders_open_amount_uniq
  ON orders (coin, expected_amount)
  WHERE status IN ('awaiting', 'confirming');
```

That index is the whole attribution scheme. `createOrder()` retries on its unique
violation (Postgres `23505`) until it finds a free tail. There are only 99 tails per
(coin, whole amount), which for USDT — two decimals, so tails of $0.01 to $0.99 — means
99 simultaneously-open orders on the same plan and term. Well past this business's scale,
but if it is ever reached `createOrder()` refuses rather than reusing an amount, and the
customer sees a 500 instead of an unattributable payment. Widening it means more decimals
in the jitter, not a fuzzier match. Matching in the poller is then an
exact `=` comparison and never a fuzzy one — which is why nothing anywhere may round,
reformat or "tidy" an expected amount, including for display. `js/checkout.js` prints the
string the server sent, verbatim.

**Abandoned reservations hand their tail back, and only once they are provably dead.**
`expireAbandonedOrders()` in `store.mts` runs at the end of every *full* poll pass and moves
an order to `cancelled` when it is still `awaiting`, has no `tx_hash`, and its rate lock
expired more than `ABANDON_AFTER_MS` (eight days) ago. Without it nothing ever released a
tail, which is a slow leak with a hard wall at the end of it: BTC, ETH and SOL re-base with
the exchange rate so collisions are rare, but USDT is quoted 1:1, so a Starter month in
USDT is always $150.xx and there are exactly ninety-nine of those. Ninety-nine abandoned
USDT checkouts on one plan and term — across all customers, ever — and `createOrder()` runs
out of tails and answers the checkout with a 500 for that combination permanently.

Eight days is not a round number, it is the deposit window plus room: the poller reads a
rolling seven days, so a transfer for an order older than that cannot appear in any window
it asks for and the reservation is being held against a payment the automatic path can no
longer see. Such a transfer lands in the review queue with the money safely in the account,
which is the documented right failure. This does **not** contradict "expiry releases the
rate, not the order" — the conditions exclude every order anyone has actually paid into, so
the customer who paid four minutes late, or four days late, is still credited.

**A reserved amount is checked against MEXC's minimum deposit before it is quoted.**
`asset.minDeposit` in `assets.mts` is that floor, and `order.mts` refuses with a 422
`below_minimum` rather than quoting under it — a transfer below the floor is swallowed by
the exchange, never appears in deposit history, and so can be neither matched nor refunded.
No plan here comes close to any of those floors, which is the point: the only thing that
can trip the check is an exchange rate that is wrong by orders of magnitude, and refusing
to quote is the right answer to that.

**A transaction hash says *which* order, never *whether it paid*.** `/api/claim` accepts
one; `deposits.tx_id` and `orders.tx_hash` are both `UNIQUE`, so one real transfer cannot
pay for two orders no matter how many people paste it. Hashes are normalised (lower-cased,
`0x` stripped) by `normalizeTxId()` on every read and write, so the same hash in two
notations is the same hash.

**And a hash match is corroborated before it credits anything** — `hashCorroboration()` in
`poller.mts`. The hash is supplied by whoever is sitting at the checkout and `claim.mts` can
only check the shape of the string, so the deposit behind it still has to be in the order's
own `coin` and to cover its `expected_amount` (`compareAmounts()` in `store.mts`, exact
decimal arithmetic, no floats), and the order still has to be in a status that can act on a
deposit — `cancelled` deliberately cannot. Do not remove this. Without it the hash bypassed
the amount completely: reserving the annual plan, sending one dollar of USDT to the shared
deposit address and pasting that transfer's hash credited the order in full, and a hash
lifted off the address's public on-chain history did the same for nothing — while also
stopping the customer who really sent that transfer from ever matching on amount. A hash
that fails corroboration is recorded against the order it named with a `review_reason`, and
attribution falls back to the amount, which is the scheme the whole design rests on.

**Every deposit MEXC reports is written to `deposits`, matched or not.** An unattributable
payment becomes a row with a `review_reason`, counted by `/api/health`. It is never a
payment that quietly did not happen. Terminal MEXC failures (7, 8, 10, 11 — rejected,
refunded, invalid, restricted) are recorded with a reason and never move an order forward.

**Expiry releases the rate, not the order.** `rate_expires_at` is what the 30-minute
countdown shows. An order stays `awaiting` past it, keeps its reserved amount, and is still
matched and credited whenever the transfer lands. This is deliberate: a customer who paid
four minutes late has paid.

**A paid term ends, and the end date is written once.** `markOrderPaid()` sets
`orders.term_ends_at` at the moment the deposit credits, and *chains* it: the new term
starts at `GREATEST(NOW(), <the customer's furthest existing term end>)`, so renewing three
weeks early adds a month to the end of the current term rather than throwing the remainder
away. Nothing recalculates it afterwards.

**Expiry is therefore a read-time comparison, not a job.** `isInTerm()` in `store.mts` is
the whole mechanism: `term_ends_at` plus `TERM_GRACE_MS`, compared against now. No cron has
to fire for a term to lapse, which matters on a site whose only scheduled function is the
deposit poller — a poller outage must not silently extend everybody's plan.

**The grace period is three days, and it is deliberately generous.** A crypto renewal is a
manual act: notice the term ended, pick a term, open a wallet, wait for confirmations. An
order with no determinable end date (`term_ends_at` and `paid_at` both missing, which only a
hand-edited row can produce) is treated as *current*. Locking out someone who paid is the
worse error, by a distance.

**`TERM_GRACE_MS` is duplicated in the browser, in two places, on purpose.** `js/account.js`
and the blocking `<head>` script on `dashboard.html` both carry the literal `259200000`, so
a cached `active` record whose term has already run out does not paint an unlocked console
and then lock itself when `sync()` returns. Change the constant in `store.mts` and change
both. The server remains the authority; the copies only stop the page showing an answer it
is about to contradict.

**Renewal is a new order, and the checkout must not settle on somebody else's.** The route
is `#liveRenew` and `#liveChange` in the `data-sub-show="active"` panel. Two consequences
that used to be bugs:

- `checkSettled()` in `js/checkout.js` settles only when the returned order's **reference
  matches the one on screen** and its state is `paid`. Settling on `status === 'active'`
  alone congratulated a renewing customer and redirected them out of the checkout before
  they had paid.
- `/api/subscription` accepts `?reference=` and returns that order (ownership checked) in
  preference to guessing. Picking BTC, changing your mind and paying in USDT leaves two
  open orders, and "the newest open order" is not necessarily the one on screen.
- `js/checkout.js` skips the local `startSubscription()` echo when `hasActivePlan()` is
  already true, because writing `pending` over an active record locks the workspace of
  somebody who has paid until the next sync puts it back.

**The poll window is rolling, not incremental.** `depositHistory()` always asks for the
last week rather than "everything since my last success". A poller that was down for an
afternoon, or a key that lapsed over a weekend, catches up on its next run instead of
leaving a permanent hole. Deduplication is the unique constraint on `deposits.tx_id`.

**It asks for slightly under seven days, and the margin is not cosmetic.** MEXC caps the
span between `startTime` and `endTime` on deposit history at seven days and rejects the
whole call when it is exceeded. `DEPOSIT_WINDOW_MS` in `mexc.mts` is therefore seven days
minus two hours: both timestamps are built from the function's clock and checked against
MEXC's, so asking for exactly seven days sat on the boundary, where a second of skew in the
wrong direction turns every poll into a 400 — no deposit credited, and an alert worded as a
MEXC outage rather than as a bad request. Two hours is far more skew than can occur and
costs nothing, because the poller runs every two minutes and consecutive windows still
overlap by days.

**Every MEXC call has a deadline.** `timedFetch()` in `mexc.mts` aborts at eight seconds for
the signed deposit call and five for the public ticker, which sits in front of a customer
waiting on `/api/order`. A stalled connection would otherwise consume the function's whole
execution budget and return nothing at all — no state written, no failure recorded, and
`/api/health` showing only that the poller has gone quiet.

**One unreconcilable deposit no longer takes the batch with it.** `runPoll()` wraps each
deposit in its own try/catch. Before that, a single row that could not be written aborted
the loop, so every deposit after it in the same response went unread — and because the
window is rolling, a persistent bad row blocked the deposits behind it on every subsequent
pass too, paying customers included. The run is still marked failed, so it stays out of
`lastSuccessAt` and the reason shows up on `/api/health`.

**Two things trigger reconciliation, and only one of them is a guarantee.** The guarantee
is `mexc-poll.mts`, scheduled every two minutes. The other is `nudge()`, a throttled
single-coin pass that `/api/subscription` runs when the caller has an open order, so a
customer sitting on the checkout usually sees confirmation within seconds. Scheduled
functions **only run on published deploys** — on a branch or preview deploy the nudge is
all there is, which is worth remembering when confirmation seems not to work.

**The MEXC key expires after 90 days** and nothing visible breaks when it does — that is
the failure mode this design worries about most. `/api/health` reports how long it has been
since the poller last succeeded (`warn` after 15 minutes, `fail` after an hour), counts
deposits awaiting review, and returns 503 when it is unhappy. Renew the key in place from
MEXC's My API Key → Action → Renew; the environment variables do not change.

**`MEXC_API_SECRET` must never reach a browser.** It signs requests against the exchange
account. The site's CSP sets `connect-src 'self'`, every call is a same-origin `/api/*`
rewrite, and the secret is read only inside `netlify/lib/mexc.mts`.

## Alerts, receipts and health

`netlify/lib/notify.mts` is the only module that talks to a third party that is not MEXC,
and **every channel in it is off until its own environment variables exist.** That is not a
stub: the readiness check is the feature. A site with no notification credentials behaves
exactly as it did before the module was added, and nothing on the payment path can fail
because a message could not be delivered.

| Channel | Needs | Used for |
| ------- | ----- | -------- |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | operator alerts |
| Alert email | `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `MAIL_FROM` | operator alerts |
| Receipts | `RESEND_API_KEY`, `MAIL_FROM` | the customer's payment receipt |

**`MAIL_FROM` deliberately has no default.** Resend will only send from a domain that has
been verified on the account, so a fallback address would produce a channel that reports
itself ready and then fails on every send — the exact failure this design is trying to make
impossible. `/api/health` returns a `notifications` block naming which of the three are
live, so silence can be told apart from "nothing is configured".

**Alerts are raised by the scheduled poller and by nothing else.** `runPoll()` takes
`{ alert: true }`, and only `mexc-poll.mts` passes it. `nudge()` from `/api/subscription`
runs the same reconciliation pass on a customer's page load; letting it alert would mean one
bad minute paging the operator once per visitor.

There are four alert kinds, throttled independently to one message every six hours through
`system_state['ops-alerts']`:

- `credentials` — a MEXC call failed in a way that looks like authentication. This is the
  90-day expiry, and it is the one worth waking up for.
- `stale` — the poller has not succeeded for 15 minutes. Suppressed while a `credentials`
  alert is already outstanding, because that is the same incident.
- `review` — the unmatched-deposit queue **grew**. It fires on an increase rather than on a
  non-zero count, and the high-water mark only advances when a message actually left, so
  configuring a channel weeks later still reports the accumulated backlog instead of
  starting from a clean slate.
- `recovered` — sent past the throttle when a run succeeds after an open issue, and it only
  clears the open issue if the send itself succeeded.

**`orders.receipt_sent_at` is an idempotence lock, not a log line.** `claimReceipt()` sets
it with `WHERE receipt_sent_at IS NULL … RETURNING id`, so of two concurrent passes exactly
one gets the receipt; `releaseReceipt()` puts it back if the provider refuses. `reconcile()`
also re-attempts a receipt for an order that is *already* paid but has no
`receipt_sent_at` — which, because the poll window is a rolling seven days, turns a failed
send into a week of retries rather than one lost email.

**`/api/health` is public unless `HEALTH_TOKEN` is set**, so an existing bookmark keeps
working. Set it and the endpoint wants `x-health-token` or `?token=`, compares in constant
time, and answers **404** — not 401 — to a wrong or missing one, because a health endpoint
that admits it exists is a free liveness probe for the payment path. `?detail=1` adds the
actual rows awaiting review; the count alone is in the default response.

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

**A price now lives in three places, and all three have to agree.** `js/pricing.js` is
what the browser reads — the homepage calculator and the checkout summary both come from
it. `netlify/lib/pricing.mts` is the server mirror, and it is the one that decides what a
customer is actually charged; a figure that only exists in the browser copy is a figure
nobody is billed for. The tier cards additionally carry `data-monthly` / `data-annual`
attributes for the monthly/annual toggle. Change a price and you change all three, or the
checkout quietly asks for a different number than the page advertised.

The duplication is on purpose — the alternative is a build step to share one module
between a browser with no bundler and a TypeScript function. Keep the two files
structurally identical so a diff between them reads as a diff.

**The discount ladder is 0 / 10 / 10 / 15 / 20 percent** for 1, 2, 3, 6 and 12 months.
Twelve months is the published annual rate, which is why the tiers advertise $1,440, $3,360
and $4,800. These are not stacked discounts; stacking them would contradict the advertised
annual prices.

**The countdown uses an absolute expiry timestamp**, not a decrementing counter. That is
what makes it survive a refresh and a backgrounded tab. It now comes from the order's
`rate_expires_at` rather than from localStorage, so the clock on screen is the same rate
lock the server is honouring. Do not rewrite it as "seconds remaining minus one per tick"
— the behaviour will regress in exactly the ways the current design avoids.

**`checkout.html` no longer carries `data-addr` or `data-rate`.** The asset buttons hold
labels only: name, network, symbol, decimals, confirmations, ETA. The address, the amount,
the locked rate and the reference all arrive from `/api/order`, and `js/checkout.js`
computes none of them. Putting an address back in the markup would mean the page could
show one thing while the poller waited for another, which is the one failure this whole
design exists to prevent. `localStorage['cs-pay-session']` survives, but it now holds only
a UI preference — which network was last selected — and there is nothing in it worth
forging.

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
not delete it. `.netlify/features/netlify-identity` does the same for accounts. Both are
written by `node scripts/enable.cjs` in the corresponding skill directory; if either
marker goes missing, re-run that script rather than creating the file by hand.

**Every `/api/*` path is a rewrite, not a real path.** `netlify.toml` maps the eight of
them — `register`, `confirm`, `login`, `logout`, `order`, `claim`, `subscription`,
`health` — onto `/.netlify/functions/*` with a 200. The short paths matter: the CSP on
this site sets `connect-src 'self'`, so every fetch has to stay same-origin. Point a
script at the function's real path and the rewrite becomes dead config; point it
off-origin and the CSP blocks it. Add an endpoint and you add a rewrite, above the
`AGENTS.md` 404 block.

**The cookie-authenticated mutations check `Origin`.** `register`, `login`, `logout`,
`order` and `claim` all call `verifyRequestOrigin(req)` before they do anything, because a
session cookie alone would let another site drive them from a visitor's browser.
Same-origin POSTs always send the header, including plain HTML form posts, so the
no-JavaScript fallback on the register form still works.

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

There is nothing to compile on the frontend. Open the pages in a browser, or
`netlify dev --port 8889` for forms, redirects and the functions. `node --check js/*.js`
catches syntax errors in the browser scripts; it does not apply to the `.mts` files, which
Netlify compiles at deploy time. Check both themes and a narrow viewport before
considering a change done — several
components (steps, bento grid, timer, pay block, `.appshot` sidebar, `.flow` strip, the
`.choices` radio cards, the `.flowsteps` rail, the `.subpanel`, the `.acctbar`, the
`.conlock` ribbon, the `.intg` connector cards, the `.cfg` policy rows and the `.conns`
strip) have distinct mobile layouts. If you touched the signup path, walk the whole chain
once: pricing → register → confirm the email → dashboard → checkout, and confirm the
countdown still opens on the plan you picked at the start.
`localStorage.removeItem('cs-account')` puts the browser back to anonymous, but it no
longer signs you out — the Identity cookie survives it. Use the Sign out button, or
`CSAccount.signOut()`, when you want a genuinely anonymous browser.

The three subscription states are still quickest to *paint* from the console — edit the
stored object and reload:

```js
var a = JSON.parse(localStorage['cs-account']);
a.subscription = { plan: 'professional', months: '6', status: 'active', reference: 'CS-TEST' };
localStorage['cs-account'] = JSON.stringify(a);
```

`status: 'pending'` gives the notice-and-lock state, and deleting `a.subscription` gives
`none`. Expect it to snap back within a second or so: `CSAccount.sync()` has run by then
and the server disagrees. That is the feature. To hold a state, change the order's status
in the database instead.

**Checking the payment path itself.** `/api/health` is the fastest read — it says whether
the poller has run, when it last succeeded, and how many deposits are sitting unmatched.
Two things about it are easy to trip over:

- **The scheduled function does not run on preview deploys.** Only the throttled nudge
  from `/api/subscription` fires there, and only while somebody has an open order. If
  confirmation looks broken on a branch deploy, check that first.
- **A real end-to-end test costs a real deposit.** The smallest safe one is a Starter month
  in USDT: reserve the order, send the exact amount including its jitter tail, and watch
  the checkout advance on its own. Sending a rounded amount is the useful negative test —
  it should land in `deposits` with a `review_reason` and show up in the `/api/health`
  count, not unlock anything.

To exercise the UI without paying, update the order row directly:

```sql
UPDATE orders SET status = 'paid', paid_at = NOW() WHERE reference = 'CS-XXXXXX';
```

The checkout page picks that up on its next poll — within about eight seconds — and takes
you into the workspace, which is the behaviour worth confirming after any change to
`js/checkout.js` or `subscription.mts`. Note that this row now needs a `term_ends_at` too if
you want it to behave like a real payment; `markOrderPaid()` writes one, a hand-edit does
not, and an order with neither `term_ends_at` nor a lapsed `paid_at` reads as current
forever.

**Testing a lapsed term and a renewal.** Push the end date into the past — five days is past
the three-day grace:

```sql
UPDATE orders SET term_ends_at = NOW() - INTERVAL '5 days' WHERE reference = 'CS-XXXXXX';
```

Reload the dashboard: the console locks, the plan picker comes back, and the amber note
above it names the plan that ended and the date it ended on. `INTERVAL '1 day'` instead puts
the order inside the grace period, where the workspace stays open. Then reserve a second
order and mark it paid to check the chaining — with a term still running, the new
`term_ends_at` should land its months *after* the old end date, not after today. Both
"Extend this plan" and "Change plan" in the live panel lead to the checkout; the thing worth
watching there is that the countdown page does **not** immediately congratulate you and
redirect, which is what it did before it started matching on the order reference.

**Testing notifications without credentials.** There is nothing to see — that is the
expected result. `/api/health` reports `notifications: { telegram: false, alertEmail: false,
receipts: false }` and every send is skipped. Add the variables from the table in "Alerts,
receipts and health" and the same endpoint flips them to `true`; the fastest live check is
to leave a rounded deposit unmatched and wait for the `review` alert on the next scheduled
pass, which only happens on a published deploy.
