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

   It reports on account email for the same reason. Registration confirmation
   and password reset are both Identity sending a link, and both fail the same
   quiet way: the form says a message is on its way, no message is on its way,
   and the only person who finds out is the customer who cannot get in. There
   is no send receipt to read from here, but there is the question one step
   before it — is Identity reachable at all, and is it configured to send
   confirmations — and that is what the identity block answers. It sits next to
   the notifications block for the same reason that one exists: silence looks
   identical whether nothing is wrong or nothing is configured.

   The email block answers the same question for the messages this site sends
   itself through Resend: the welcome, the sign-in notice, the password-change
   notice and the payment receipt. It reports the two halves separately —
   whether there is an API key and whether there is a verified sender —
   because a variable that exists with an empty value is the failure that
   looks exactly like a variable that was never added, and one boolean cannot
   tell those apart. No key, address or other value is ever returned; only
   whether each one is present.

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
import { mailerState } from '../lib/mail.mjs'
import { signInAlertsEnabled } from '../lib/account-mail.mjs'
import { notificationChannels } from '../lib/notify.mjs'
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
    autoconfirm: boolean | null
    signupOpen: boolean | null
    confirmationEmails: 'sending' | 'not-sent' | 'unknown'
  } = { reachable: false, autoconfirm: null, signupOpen: null, confirmationEmails: 'unknown' }

  try {
    const settings = await getSettings()
    identity.reachable = true
    identity.autoconfirm = settings.autoconfirm
    identity.signupOpen = !settings.disableSignup
    /* Autoconfirm on means new accounts are confirmed without being asked,
       so no confirmation mail is sent at all. That is a valid setting and not
       an error — but it is worth being able to read off a page rather than
       inferring it from customers who never got an email. */
    identity.confirmationEmails = settings.autoconfirm ? 'not-sent' : 'sending'
  } catch {
    identity.reachable = false
  }

  if (!identity.reachable) {
    if (status === 'ok') status = 'warn'
    notes.push(
      'Netlify Identity did not answer. While that lasts, nobody can register, sign in, confirm an address or reset a password — and scheduled functions do not run on preview deploys, so check this against a published deploy before treating it as an incident.'
    )
  } else if (identity.autoconfirm) {
    notes.push(
      'Autoconfirm is on, so new accounts are confirmed without a confirmation email. Turn it off under Project configuration → Identity to have the address verified before an account can sign in.'
    )
  }

  /* Deliberately a note rather than a status change. Email is not the
     payment path: an order still credits, a term still starts and the site
     still works with no mailer at all, so an unconfigured one must not make
     a monitor go red. A half-configured one is worth saying out loud though,
     because it is the state somebody lands in after adding the variable and
     leaving the value blank. */
  const mailer = mailerState()

  if (!mailer.apiKey && !mailer.sender) {
    notes.push(
      'No transactional email is configured. Set RESEND_API_KEY and MAIL_FROM (or TRANSACTIONAL_EMAIL_FROM) to turn on the welcome, sign-in, password-change and payment-receipt emails.'
    )
  } else if (!mailer.apiKey) {
    notes.push(
      'A sender address is configured but RESEND_API_KEY is empty, so nothing can be sent. Check that the variable actually holds a value — an empty secret reads the same as a missing one.'
    )
  } else if (!mailer.sender) {
    notes.push(
      'RESEND_API_KEY is set but no sender address is. Set MAIL_FROM (or TRANSACTIONAL_EMAIL_FROM) to an address on the domain verified with Resend.'
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
      email: { ...mailerState(), signInNotices: signInAlertsEnabled() },
      /* Whether the two account emails — the confirmation link and the reset
         link — have a service behind them at all. */
      identity,
      review: wantDetail ? await listDepositsNeedingReview() : undefined,
      notes
    },
    status === 'fail' ? 503 : 200
  )
}
