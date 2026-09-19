/* ==========================================================================
   Outbound notifications — operator alerts and customer receipts.

   Two audiences, two very different failure modes:

     · the operator needs to hear about a lapsed MEXC key or a deposit nobody
       can attribute, because both are silent on the customer-facing site;
     · the customer needs a receipt when their transfer credits, because a
       crypto payment leaves them with a hash and nothing else.

   Everything here is OPTIONAL AND OFF UNTIL CONFIGURED. Each channel checks
   for its own environment variables and returns without sending when they are
   absent, so a deploy with none of them set behaves exactly as it did before
   this file existed. Nothing in the payment path may fail because a message
   could not be delivered: an order that credited is credited whether or not
   the email went out, so every function here swallows its errors and reports
   what happened rather than throwing.

     TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   operator alerts over Telegram
     RESEND_API_KEY + ALERT_EMAIL_TO + from  operator alerts over email
     RESEND_API_KEY + from                   customer receipts

   "from" is MAIL_FROM or TRANSACTIONAL_EMAIL_FROM, resolved in lib/mail.mts,
   which is also where the Resend transport and the shared HTML shell live.
   Every message this site sends — receipts, alerts and the account emails —
   is rendered through that one shell, so they read as one product rather
   than as three files that were written in different weeks.

   The sender has no default on purpose. Resend will only send from a domain
   that has been verified against it, so a guessed sender is a send that fails
   every time — better to have receipts stay off until the address is real.
   ========================================================================== */

import {
  escapeHtml,
  mailerReady,
  renderEmail,
  sendMail,
  siteUrl,
  supportEmail
} from './mail.mjs'

const TELEGRAM_ENDPOINT = 'https://api.telegram.org'

function env(name: string) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : null
}

export interface DeliveryReport {
  /* Channel names only. No addresses, no tokens — this ends up in the poll
     state that /api/health reads out. */
  sent: string[]
  failed: string[]
  configured: boolean
}

/* ---------- Channel availability ---------------------------------------- */

function telegramReady() {
  return Boolean(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID'))
}

/* The key and the sender are the same pair every other channel needs, so
   this asks mailerReady() rather than re-deriving it — one definition of
   "the mailer is configured", in the module that owns the transport. */
function alertEmailReady() {
  return Boolean(mailerReady() && env('ALERT_EMAIL_TO'))
}

export function receiptsReady() {
  return mailerReady()
}

/* What /api/health reports so the answer to "would I actually be told?" is
   visible without sending a test message. */
export function notificationChannels() {
  return {
    telegram: telegramReady(),
    alertEmail: alertEmailReady(),
    receipts: receiptsReady(),
    /* The account path shares the same credentials, so it is reported from
       the same block rather than left to be inferred from the two above. */
    accountEmails: mailerReady()
  }
}

/* ---------- Transport --------------------------------------------------- */

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    /* Read the body for the message but never echo the request: the auth
       header is the one thing that must not end up in a log line. */
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${text.slice(0, 200)}`)
  }

  return response
}

async function sendTelegram(text: string) {
  const token = env('TELEGRAM_BOT_TOKEN')
  const chat = env('TELEGRAM_CHAT_ID')
  if (!token || !chat) return false

  await postJson(`${TELEGRAM_ENDPOINT}/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  })

  return true
}

/* ---------- Operator alerts --------------------------------------------- */

export interface AlertInput {
  title: string
  lines: string[]
  /* Where to look. Included as a plain string rather than a link because the
     health endpoint may be behind HEALTH_TOKEN. */
  hint?: string
}

/* Sends to every configured channel and reports on each. Both channels get
   the same words; there is no per-channel copy to keep in sync, because an
   alert that reads differently in two places is an alert nobody trusts. */
export async function alertOps(input: AlertInput): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: [], failed: [], configured: false }

  const body = input.lines.filter(Boolean)
  if (input.hint) body.push(input.hint)

  if (telegramReady()) {
    report.configured = true
    try {
      await sendTelegram(
        `<b>CloakShield Pro — ${escapeHtml(input.title)}</b>\n\n${body.map(escapeHtml).join('\n')}`
      )
      report.sent.push('telegram')
    } catch {
      report.failed.push('telegram')
    }
  }

  if (alertEmailReady()) {
    report.configured = true
    const to = env('ALERT_EMAIL_TO') as string

    /* Rendered through the same shell as the customer mail, minus the
       "need a hand?" block — this one goes to the person who answers it. */
    const { html, text } = renderEmail({
      title: input.title,
      preheader: body[0] || input.title,
      eyebrow: 'Operations alert',
      heading: input.title,
      lede: 'This is an automated alert from the payment reconciliation path.',
      blocks: [{ kind: 'note', tone: 'amber', lines: body.map(escapeHtml) }],
      support: false,
      footerNote: 'Sent to ALERT_EMAIL_TO. Throttled to one message per issue every six hours.'
    })

    try {
      if (!(await sendMail({ to, subject: `CloakShield Pro alert: ${input.title}`, html, text }))) {
        throw new Error('send refused')
      }
      report.sent.push('email')
    } catch {
      report.failed.push('email')
    }
  }

  return report
}

/* ---------- Customer receipts ------------------------------------------- */

export interface ReceiptInput {
  to: string
  reference: string
  planName: string
  termLabel: string
  amountUsd: string
  amountCrypto: string
  sym: string
  network: string
  txHash: string | null
  termEndsAt: number | null
}

function formatDay(ms: number | null) {
  if (!ms) return null
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

/* Rendered through the shared shell in lib/mail.mts, which is what keeps this
   looking like the account emails and the four Identity templates rather than
   like a third design. The plain-text part comes off the same spec, so the two
   cannot drift. */
function receipt(input: ReceiptInput) {
  const ends = formatDay(input.termEndsAt)
  const site = siteUrl()

  const rows: Array<[string, string]> = [
    ['Reference', input.reference],
    ['Plan', input.planName],
    ['Term', input.termLabel],
    ['Amount', `$${input.amountUsd}`],
    ['Paid in', `${input.amountCrypto} ${input.sym} · ${input.network}`]
  ]
  if (ends) rows.push(['Term ends', ends])

  return renderEmail({
    title: `Payment confirmed — ${input.reference}`,
    preheader: `Your ${input.planName} plan is active. Reference ${input.reference}.`,
    eyebrow: 'Step 4 of 4 · Payment',
    heading: 'Payment confirmed',
    lede:
      'Your transfer was credited and the plan is active. Every tool in the workspace is ' +
      'now scoring your own traffic rather than the sample set. Keep the reference below ' +
      'if you ever need to ask us about this payment.',
    blocks: [
      { kind: 'rows', rows },
      ...(input.txHash
        ? [{ kind: 'mono' as const, label: 'Transaction', value: input.txHash }]
        : []),
      {
        kind: 'note',
        lines: [
          ends
            ? `This term runs to ${escapeHtml(ends)}. Nothing renews on its own &mdash; a crypto payment cannot auto-charge &mdash; so the workspace will ask you to extend it before it ends.`
            : 'Nothing renews on its own, so the workspace will ask you to extend the term before it ends.',
          `Questions about this payment: <a href="mailto:${supportEmail()}" style="color:#2358b3;text-decoration:underline;">${supportEmail()}</a> &mdash; quote the reference above.`
        ]
      }
    ],
    action: { label: 'Open your workspace', href: `${site}/dashboard.html` }
  })
}

/* Returns true only when a receipt actually left. false covers both "not
   configured" and "the provider refused", and the caller distinguishes them by
   asking receiptsReady() — because one of those should be retried and the
   other should not. */
export async function sendReceipt(input: ReceiptInput) {
  if (!receiptsReady() || !input.to) return false

  const { html, text } = receipt(input)

  return sendMail({
    to: input.to,
    subject: `CloakShield Pro — payment confirmed (${input.reference})`,
    html,
    text
  })
}
