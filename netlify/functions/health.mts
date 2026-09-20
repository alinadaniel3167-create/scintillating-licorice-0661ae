/* ==========================================================================
   GET /api/health — is payment confirmation actually working?

   The failure mode this exists for is a quiet one. MEXC API keys that are not
   pinned to an IP allow-list expire ninety days after they are created, and
   Netlify Functions egress from a rotating pool of addresses, so pinning is
   not available. When the key lapses, nothing on the customer-facing site
   breaks: the checkout still quotes an amount, the transfer still arrives in
   the account, and no order is ever credited.

   So there is a health check, and what it reports on is staleness rather than
   errors. A poller that has not completed a successful pass in a while is the
   symptom, whatever the cause — expired key, revoked permission, MEXC outage,
   a schedule that stopped firing.

   It reports on account email for the same reason, and since the confirmation
   and reset messages became this site's own, that report matters more than it
   used to. **With no mailer, nobody can finish registering** — the six-digit
   code has nowhere to go, and the account it belongs to can never open a
   session. It fails quietly too: the form says a message is on its way, no
   message is on its way, and the only person who finds out is the customer
   who cannot get in.

   The email block answers that question for every message this site sends
   through Resend: the confirmation code, the reset link, the welcome, the
   sign-in notice, the password-change notice and the payment receipt. It
   reports the two halves separately —
   whether there is an API key and whether there is a verified sender —
   because a variable that exists with an empty value is the failure that
   looks exactly like a variable that was never added, and one boolean cannot
   tell those apart. No key, address or other value is ever returned; only
   whether each one is present.

   Knowing the mailer is configured is not the same as knowing it can send,
   and the only thing that settles the difference is a send. ?probe=email does
   exactly one: a short message to ALERT_EMAIL_TO, reporting whether Resend
   accepted it and, when it did not, why. It is deliberately hobbled — it
   takes no recipient from the query string, so it cannot be turned into a
   way to mail a stranger from this domain, and it requires HEALTH_TOKEN even
   though the rest of the endpoint does not, because an unauthenticated
   request that causes an outbound email is a request worth sending twice.

   The identity block is a narrower question than it once was. Identity no
   longer mails anything on this site — it holds the credential and mints the
   session, and nothing else — so what is worth knowing is whether it answers
   at all, because while it does not, nobody can register, sign in or reset.
   The accounts block sits beside it and counts addresses that registered and
   never redeemed their code: a handful is ordinary abandonment, and a number
   that climbs while `email.apiKey` is false is the mailer failure above,
   already measured in customers.

   No credentials, no order data and no customer data are exposed here; it
   answers with timestamps, counts and MEXC's own error text.

   Access. The endpoint stays public while HEALTH_TOKEN is unset, because a
   monitor that has to be reconfigured before it works is a monitor that
   silently stops working — and everything above is operational noise, not
   customer data. Set HEALTH_TOKEN and it starts requiring
   ?token=… or an X-Health-Token header, which is worth doing before using
   ?detail=1: that lists the deposits sitting in review, and while their
   transaction hashes are already public on their own chains, the fact that
   this account cannot account for them is not.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { getSettings } from '@netlify/identity'
import { fail, json } from '../lib/http.mjs'
import { mailerState, renderEmail, sendMail, siteUrl } from '../lib/mail.mjs'
import { signInAlertsEnabled } from '../lib/account-mail.mjs'
import { notificationChannels } from '../lib/notify.mjs'
import { verificationBacklog } from '../lib/auth-codes.mjs'
import { POLL_STATE_KEY } from '../lib/poller.mjs'
import {
  countDepositsNeedingReview,
  listDepositsNeedingReview,
  readState
} from '../lib/store.mjs'

/* The schedule runs every two minutes. Fifteen absorbs a missed run and a
   retry; an hour means something is wrong that a person needs to look at. */
const WARN_AFTER_MS = 15 * 60 * 1000
const FAIL_AFTER_MS = 60 * 60 * 1000

/* Length-independent comparison. The token is a bookmark secret rather than a
   password, but a check that returns early on the first wrong character is
   free to write correctly, so it is. */
function tokenMatches(supplied: string, expected: string) {
  if (supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/* One real message to the operator's own alert address, and nothing else.
   The recipient is read from the environment rather than from the request on
   purpose: a health endpoint that mails an arbitrary address is an open relay
   wearing a monitoring badge. The reason string is what makes this worth
   having — "the domain cloakshield.io is not verified" is a fix, where a bare
   false is a mystery. */
async function probeEmail() {
  const mailer = mailerState()

  if (!mailer.ready) {
    return {
      attempted: false,
      ok: false,
      reason: !mailer.apiKey
        ? 'RESEND_API_KEY is missing or empty'
        : 'no sender address — set MAIL_FROM or TRANSACTIONAL_EMAIL_FROM'
    }
  }

  const to = (process.env.ALERT_EMAIL_TO || '').trim()
  if (!to) {
    return {
      attempted: false,
      ok: false,
      reason: 'ALERT_EMAIL_TO is not set — nowhere to send the probe'
    }
  }

  const { html, text } = renderEmail({
    title: 'Email delivery probe',
    preheader: 'Transactional email is working on this deploy.',
    eyebrow: 'Operations check',
    heading: 'Email delivery probe',
    lede:
      'This message was sent by /api/health?probe=email. Receiving it confirms that the ' +
      'Resend key, the sender domain and the transport all work on this deploy — which is ' +
      'the one thing the rest of the health response cannot tell you.',
    blocks: [
      {
        kind: 'rows',
        rows: [
          ['Sent at', new Date().toISOString()],
          ['Site', siteUrl()]
        ]
      }
    ],
    support: false,
    footerNote: 'Sent to ALERT_EMAIL_TO. Triggered by hand; nothing schedules this message.'
  })

  const sent = await sendMail({
    to,
    subject: 'CloakShield Pro — email delivery probe',
    html,
    text
  })

  return {
    attempted: true,
    ok: sent,
    reason: sent ? undefined : 'Resend refused the message — see the function log for the status and reason'
  }
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url)
  const expected = (process.env.HEALTH_TOKEN || '').trim()

  if (expected) {
    const supplied =
      req.headers.get('x-health-token') || url.searchParams.get('token') || ''
    if (!tokenMatches(supplied, expected)) {
      return fail('Not found.', 404)
    }
  }

  const wantDetail = url.searchParams.get('detail') === '1'

  /* A send, so it stays behind the token even when the rest of the endpoint
     would have been public. */
  const wantProbe = Boolean(expected) && url.searchParams.get('probe') === 'email'
  const probe = wantProbe ? await probeEmail() : undefined

  const record = await readState(POLL_STATE_KEY)
  const state = (record?.value || {}) as Record<string, unknown>

  const lastSuccessAt = Number(state.lastSuccessAt || 0) || null
  const lastRunAt = Number(state.lastRunAt || 0) || null
  const age = lastSuccessAt ? Date.now() - lastSuccessAt : null

  let status: 'ok' | 'warn' | 'fail' = 'ok'
  const notes: string[] = []

  if (!lastSuccessAt) {
    status = 'fail'
    notes.push('The deposit poller has never completed a successful run on this deploy.')
  } else if (age !== null && age > FAIL_AFTER_MS) {
    status = 'fail'
    notes.push(
      `The deposit poller last succeeded ${Math.round(age / 60000)} minutes ago. Payments are arriving but nothing is being credited.`
    )
  } else if (age !== null && age > WARN_AFTER_MS) {
    status = 'warn'
    notes.push(`The deposit poller last succeeded ${Math.round(age / 60000)} minutes ago.`)
  }

  if (state.lastAuthFailure) {
    status = 'fail'
    notes.push(
      'MEXC rejected the API credentials. Renew the key from MEXC → API Management → Action → Renew; a renewed key keeps the same value, so the Netlify environment variables do not change.'
    )
  }

  /* Best-effort, and never allowed to take the endpoint down with it: this
     is a report on the account path, not part of it. A monitor that returns
     nothing because one of the things it monitors is unwell is no monitor. */
  const identity: {
    reachable: boolean
    signupOpen: boolean | null
    /* Who sends the confirmation and reset messages. Fixed, and reported
       rather than computed, because the answer changed: it is this repo over
       Resend now, and an operator reading a stale runbook will otherwise go
       looking for an Identity SMTP setting that no longer does anything. */
    confirmationEmails: 'site'
  } = { reachable: false, signupOpen: null, confirmationEmails: 'site' }

  try {
    const settings = await getSettings()
    identity.reachable = true
    identity.signupOpen = !settings.disableSignup
  } catch {
    identity.reachable = false
  }

  if (!identity.reachable) {
    if (status === 'ok') status = 'warn'
    notes.push(
      'Netlify Identity did not answer. While that lasts, nobody can register, sign in, confirm an address or reset a password — and scheduled functions do not run on preview deploys, so check this against a published deploy before treating it as an incident.'
    )
  } else if (identity.signupOpen === false) {
    if (status === 'ok') status = 'warn'
    notes.push(
      'Identity signup is disabled, so /api/register will refuse every attempt. Turn it back on under Project configuration → Identity → Registration.'
    )
  }

  /* A warning rather than a failure, and the line between the two is worth
     stating. The payment path does not need email: an order still credits, a
     term still starts and a signed-in customer is unaffected by a mailer that
     does not work. The *signup* path does need it — the confirmation code has
     nowhere to go, so nobody new can get an account that opens a session.
     That is half the site down for new customers and fine for existing ones,
     which is exactly what 'warn' is for.

     Each half is reported separately because a variable that exists with an
     empty value reads identically to one that was never added, and that is
     the state somebody lands in after adding it and leaving the value blank. */
  const mailer = mailerState()

  if (!mailer.apiKey || !mailer.sender) {
    if (status === 'ok') status = 'warn'
  }

  if (!mailer.apiKey && !mailer.sender) {
    notes.push(
      'No transactional email is configured, so no confirmation code or reset link can be sent and nobody new can complete registration. Set RESEND_API_KEY and MAIL_FROM (or TRANSACTIONAL_EMAIL_FROM) to an address on a domain verified with Resend.'
    )
  } else if (!mailer.apiKey) {
    notes.push(
      'A sender address is configured but RESEND_API_KEY is empty, so nothing can be sent and nobody new can complete registration. Check that the variable actually holds a value — an empty secret reads the same as a missing one.'
    )
  } else if (!mailer.sender) {
    notes.push(
      'RESEND_API_KEY is set but no sender address is, so nothing can be sent and nobody new can complete registration. Set MAIL_FROM (or TRANSACTIONAL_EMAIL_FROM) to an address on the domain verified with Resend.'
    )
  }

  /* Addresses that registered and never redeemed a code. Best-effort: this
     is a report on the signup path, not part of it, and the endpoint must
     still answer about the payment path if the accounts table is unwell. */
  let accounts: { awaitingVerification: number; codesIssuedLastHour: number } | null = null
  try {
    const backlog = await verificationBacklog()
    accounts = {
      awaitingVerification: backlog.pending,
      codesIssuedLastHour: backlog.issuedLastHour
    }
  } catch {
    accounts = null
  }

  /* Only worth a sentence alongside a broken mailer, where it stops being
     ordinary abandonment and starts being a count of customers who could not
     finish. On its own it is neither actionable nor a fault. */
  if (accounts && accounts.awaitingVerification > 0 && (!mailer.apiKey || !mailer.sender)) {
    notes.push(
      `${accounts.awaitingVerification} address${accounts.awaitingVerification === 1 ? ' is' : 'es are'} waiting on a confirmation code that cannot currently be sent.`
    )
  }

  const review = await countDepositsNeedingReview()
  if (review > 0) {
    if (status === 'ok') status = 'warn'
    notes.push(
      `${review} deposit${review === 1 ? '' : 's'} could not be matched to an order and are waiting on a manual check.`
    )
  }

  return json(
    {
      ok: status !== 'fail',
      status,
      poller: {
        lastRunAt,
        lastRunOk: Boolean(state.lastRunOk),
        lastSuccessAt,
        lastFullSuccessAt: Number(state.lastFullSuccessAt || 0) || null,
        minutesSinceSuccess: age === null ? null : Math.round(age / 60000),
        lastFailures: state.lastFailures || [],
        totals: state.totals || null
      },
      depositsNeedingReview: review,
      /* Whether an alert would actually reach anyone. A monitoring endpoint
         that cannot say this is only half a monitoring endpoint: silence looks
         the same whether nothing is wrong or nothing is configured. */
      notifications: notificationChannels(),
      /* Booleans only — never the key, never the sender address. */
      email: { ...mailer, signInNotices: signInAlertsEnabled(), probe },
      /* Whether the credential and session store answers at all. It no
         longer sends anything — see the header. */
      identity,
      /* Counts only: how many addresses registered and never confirmed, and
         how many codes went out in the last hour. No addresses. */
      accounts,
      review: wantDetail ? await listDepositsNeedingReview() : undefined,
      notes
    },
    status === 'fail' ? 503 : 200
  )
}
