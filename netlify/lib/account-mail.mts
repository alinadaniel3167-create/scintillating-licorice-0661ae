/* ==========================================================================
   Account emails — the messages this site sends about an account rather than
   about a payment.

   Read this next to email-templates/README.md, because the split between the
   two is the thing that is easy to get wrong.

   **Netlify Identity owns the two emails that carry a token.** The
   confirmation link and the password reset link are minted inside Identity
   and travel only in mail Identity sends, rendered from the templates in
   email-templates/ and dispatched by whatever mail server the Identity
   settings point at. There is no API that hands the token to this code, so
   there is no version of this module that can send those two. Routing them
   through the same Resend domain as everything else is an Identity → Emails
   setting, done once, and the README beside the templates has the values.

   **This module owns everything either side of them**, which is every
   account event the site itself can observe:

     account live        the address is confirmed and the workspace is open —
                         sent when the confirmation token is redeemed, or at
                         registration when autoconfirm means no token is ever
                         issued. Exactly one of the two happens per account,
                         never both.
     sign-in notice      a session was opened. The one email here a customer
                         might not want, so SIGNIN_ALERT_EMAILS=off turns it
                         off without touching the rest.
     password changed    a reset completed. Not optional: the whole point of
                         it is to reach someone whose password was changed by
                         somebody else.

   Every function returns a boolean and none of them throws. An account that
   was created is created whether or not the mail went out, and a password
   that was changed is changed — so the send is awaited for the few hundred
   milliseconds Resend takes and then given up on, never retried into the
   caller's response.
   ========================================================================== */

import { renderEmail, sendMail, siteUrl, supportEmail, escapeHtml, mailerReady } from './mail.mjs'
import { quote, isKnownPlan, isKnownTerm } from './pricing.mjs'

/* Default on. The customers here run paid traffic through an account that
   holds a crypto payment history, and a sign-in they did not make is
   something they want to hear about the same day. Set SIGNIN_ALERT_EMAILS to
   off / false / 0 to stop them. */
export function signInAlertsEnabled() {
  const raw = (process.env.SIGNIN_ALERT_EMAILS || '').trim().toLowerCase()
  if (!raw) return true
  return !['off', 'false', '0', 'no', 'disabled'].includes(raw)
}

/* First name only, and only when it looks like one. "Hello Jane" reads as a
   message from a company that knows who you are; "Hello jane@example.com,"
   reads as a mail merge that did not fire. */
function greetingName(name: string | null | undefined) {
  const first = String(name || '').trim().split(/\s+/)[0] || ''
  return /^[\p{L}'-]{2,30}$/u.test(first) ? first : ''
}

function hello(name: string | null | undefined) {
  const first = greetingName(name)
  return first ? `Hello ${escapeHtml(first)} &mdash; ` : ''
}

/* The plan the visitor picked on the pricing table five pages ago, carried
   through signup as user metadata. Named in the welcome email so the message
   answers "what was I doing" rather than starting the conversation over. */
function planLine(plan?: string | null, months?: string | null) {
  const id = String(plan || '').trim()
  const term = String(months || '').trim()
  if (!id || !isKnownPlan(id) || !term || !isKnownTerm(term)) return null

  const q = quote(id, term)
  return `${q.plan.name} · ${q.termLabel} · ${money(q.total)}`
}

/* Same shape as money() in js/pricing.js, so a total in an email reads
   exactly as it did on the pricing table the visitor came from. This is a
   display figure only — the expected crypto amount a payment is matched
   against is never formatted anywhere, by anything. */
function money(n: number) {
  return `$${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

function timestamp(at: number) {
  return `${new Date(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false
  })} UTC`
}

/* ---------- Account live ------------------------------------------------- */

export interface WelcomeInput {
  to: string
  name?: string | null
  plan?: string | null
  months?: string | null
  /* true when the address was verified by redeeming a link, false when
     autoconfirm meant there was never a link to redeem. Only changes one
     sentence, but it is the sentence that would otherwise be wrong. */
  confirmed: boolean
}

export async function sendWelcomeEmail(input: WelcomeInput): Promise<boolean> {
  if (!mailerReady() || !input.to) return false

  const site = siteUrl()
  const picked = planLine(input.plan, input.months)

  const target = picked
    ? `${site}/dashboard.html?plan=${encodeURIComponent(String(input.plan))}&months=${encodeURIComponent(String(input.months))}#subscribe`
    : `${site}/dashboard.html`

  const { html, text } = renderEmail({
    title: 'Your account is ready',
    preheader: 'Your CloakShield Pro workspace is open. Here is what to do first.',
    eyebrow: input.confirmed ? 'Step 3 of 4 · Workspace' : 'Account created',
    heading: 'Your workspace is open',
    lede:
      `${hello(input.name)}${
        input.confirmed
          ? 'this address is confirmed and the account is active.'
          : 'the account is active and signed in on the browser you registered from.'
      } The workspace opens on a sample traffic set, so you can read a verdict log, ` +
      'change a filtering policy and see what the integrity monitor reports before any of ' +
      'it touches a live funnel.',
    action: { label: 'Open your workspace', href: target },
    blocks: [
      {
        kind: 'steps',
        title: 'What to do first',
        items: [
          'Read the verdict log. Every row says which signal decided, not just pass or stop.',
          'Adjust a policy row and watch the sample scores move with it.',
          picked
            ? `Start the plan you picked &mdash; ${escapeHtml(picked)} &mdash; and settle it in BTC, ETH or USDT.`
            : 'Choose a plan and settle it in BTC, ETH or USDT. Nothing auto-renews.',
          'Point a hostname at the edge and the tools begin scoring your own traffic.'
        ]
      },
      {
        kind: 'bullets',
        title: 'Worth knowing',
        items: [
          {
            strong: 'It runs alongside your stack, not instead of it.',
            text: 'Cloaking House, Keitaro, Voluum, Binom and RedTrack all keep doing what they do.'
          },
          {
            strong: 'Payment is a transfer you make, once.',
            text: 'A crypto payment cannot auto-charge, so a term ends rather than renewing and the workspace asks you to extend it first.'
          },
          {
            strong: 'Receipts and integrity alerts come to this address.',
            text: 'Landing page changes, certificate expiry and settlement references are all mailed here.'
          }
        ]
      }
    ],
    security: {
      title: 'Keeping this account safe',
      lines: [
        'CloakShield Pro staff will never email you asking for your password, a seed phrase or a wallet key.',
        `Payment addresses are shown only on the checkout page inside your own signed-in workspace, never in a message like this one. If anything claiming to be us asks otherwise, forward it to <a href="mailto:${supportEmail()}" style="color:#2358b3;text-decoration:underline;">${supportEmail()}</a>.`
      ]
    }
  })

  return sendMail({
    to: input.to,
    subject: 'Your CloakShield Pro workspace is open',
    html,
    text
  })
}

/* ---------- Sign-in notice ---------------------------------------------- */

export interface SignInInput {
  to: string
  name?: string | null
  at: number
  ip?: string | null
  location?: string | null
  device?: string | null
}

export async function sendSignInEmail(input: SignInInput): Promise<boolean> {
  if (!signInAlertsEnabled() || !mailerReady() || !input.to) return false

  const site = siteUrl()

  const rows: Array<[string, string]> = [['When', timestamp(input.at)]]
  if (input.location) rows.push(['Approximate location', input.location])
  if (input.device) rows.push(['Browser', input.device])
  if (input.ip) rows.push(['IP address', input.ip])

  const { html, text } = renderEmail({
    title: 'New sign-in to your account',
    preheader: 'A session was opened on your CloakShield Pro account. If it was you, nothing to do.',
    eyebrow: 'Security notice',
    heading: 'A new sign-in to your account',
    lede:
      `${hello(input.name)}someone signed in to your CloakShield Pro account. ` +
      'If that was you, this message needs nothing from you and you can file it. ' +
      'If it was not, change the password now &mdash; that ends every other session with it.',
    blocks: [
      { kind: 'rows', rows },
      {
        kind: 'note',
        tone: 'amber',
        title: 'If this was not you',
        lines: [
          `Reset the password at <a href="${site}/reset.html" style="color:#2358b3;text-decoration:underline;">${site}/reset.html</a>. The link goes to this address, so whoever signed in cannot complete it unless they also read this inbox.`,
          `Then email <a href="mailto:${supportEmail()}" style="color:#2358b3;text-decoration:underline;">${supportEmail()}</a> with the time above and we will check what the session did.`
        ]
      }
    ],
    action: { label: 'Change my password', href: `${site}/reset.html` },
    security: {
      title: 'Why you got this',
      lines: [
        'One of these is sent every time a session is opened on your account, because an account here holds a payment history and a set of live traffic policies.',
        'We never include a payment address or ask for a password, a seed phrase or a wallet key in a message like this one.'
      ]
    },
    footerNote: 'Sent because a sign-in happened, not on a schedule.'
  })

  return sendMail({
    to: input.to,
    subject: 'New sign-in to your CloakShield Pro account',
    html,
    text
  })
}

/* ---------- Password changed -------------------------------------------- */

export interface PasswordChangedInput {
  to: string
  name?: string | null
  at: number
  ip?: string | null
  location?: string | null
}

export async function sendPasswordChangedEmail(input: PasswordChangedInput): Promise<boolean> {
  if (!mailerReady() || !input.to) return false

  const site = siteUrl()

  const rows: Array<[string, string]> = [['When', timestamp(input.at)]]
  if (input.location) rows.push(['Approximate location', input.location])
  if (input.ip) rows.push(['IP address', input.ip])

  const { html, text } = renderEmail({
    title: 'Your password was changed',
    preheader: 'The password on your CloakShield Pro account has just been changed.',
    eyebrow: 'Security notice',
    heading: 'Your password was changed',
    lede:
      `${hello(input.name)}the password on your CloakShield Pro account was reset and the new one is ` +
      'in effect now. The reset link that did it has been spent and will not work a second time.',
    blocks: [
      { kind: 'rows', rows },
      {
        kind: 'note',
        tone: 'amber',
        title: 'If you did not do this',
        lines: [
          `Request a fresh reset at <a href="${site}/reset.html" style="color:#2358b3;text-decoration:underline;">${site}/reset.html</a> straight away &mdash; the link comes to this address, so it puts the account back in your hands.`,
          `Then tell us at <a href="mailto:${supportEmail()}" style="color:#2358b3;text-decoration:underline;">${supportEmail()}</a>, with the time above, and we will check the account for anything the session changed.`
        ]
      }
    ],
    action: { label: 'Open your workspace', href: `${site}/dashboard.html` },
    security: {
      title: 'What this message never does',
      lines: [
        'It never asks you to confirm the new password, and it never contains it.',
        'It never carries a payment address. Those appear only on the checkout page inside your own signed-in workspace.'
      ]
    },
    footerNote: 'Sent because the password changed, not on a schedule.'
  })

  return sendMail({
    to: input.to,
    subject: 'Your CloakShield Pro password was changed',
    html,
    text
  })
}
