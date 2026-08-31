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
     RESEND_API_KEY + ALERT_EMAIL_TO         operator alerts over email
     RESEND_API_KEY + MAIL_FROM              customer receipts

   MAIL_FROM has no default on purpose. Resend will only send from a domain
   that has been verified against it, so a guessed sender is a send that fails
   every time — better to have receipts stay off until the address is real.
   ========================================================================== */

const TELEGRAM_ENDPOINT = 'https://api.telegram.org'
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

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

function alertEmailReady() {
  return Boolean(env('RESEND_API_KEY') && env('ALERT_EMAIL_TO') && env('MAIL_FROM'))
}

export function receiptsReady() {
  return Boolean(env('RESEND_API_KEY') && env('MAIL_FROM'))
}

/* What /api/health reports so the answer to "would I actually be told?" is
   visible without sending a test message. */
export function notificationChannels() {
  return {
    telegram: telegramReady(),
    alertEmail: alertEmailReady(),
    receipts: receiptsReady()
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

async function sendEmail(to: string, subject: string, html: string, text: string) {
  const key = env('RESEND_API_KEY')
  const from = env('MAIL_FROM')
  if (!key || !from) return false

  await postJson(
    RESEND_ENDPOINT,
    { from, to: [to], subject, html, text },
    { Authorization: `Bearer ${key}` }
  )

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

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/* Sends to every configured channel and reports on each. Both channels get
   the same words; there is no per-channel copy to keep in sync, because an
   alert that reads differently in two places is an alert nobody trusts. */
export async function alertOps(input: AlertInput): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: [], failed: [], configured: false }

  const body = input.lines.filter(Boolean)
  if (input.hint) body.push(input.hint)

  const plain = [`CloakShield Pro — ${input.title}`, '', ...body].join('\n')

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
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#101720;line-height:1.6">` +
      `<p style="margin:0 0 12px;font-weight:700">CloakShield Pro — ${escapeHtml(input.title)}</p>` +
      body.map((line) => `<p style="margin:0 0 8px">${escapeHtml(line)}</p>`).join('') +
      `</div>`

    try {
      await sendEmail(to, `CloakShield Pro alert: ${input.title}`, html, plain)
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

/* Written in the same idiom as email-templates/: tables, inline styles, literal
   hex. No stylesheet, custom property, SVG or web font survives Outlook, so the
   palette is copied from css/style.css by hand and kept in step with the four
   identity templates beside it. */
function receiptHtml(input: ReceiptInput) {
  const ends = formatDay(input.termEndsAt)

  const row = (label: string, value: string) =>
    `<tr>` +
    `<td style="padding:9px 0;border-bottom:1px solid #e3e8ef;font-size:14px;color:#5b6675;">${escapeHtml(label)}</td>` +
    `<td align="right" style="padding:9px 0;border-bottom:1px solid #e3e8ef;font-size:14px;color:#101720;font-weight:600;">${escapeHtml(value)}</td>` +
    `</tr>`

  const rows = [
    row('Reference', input.reference),
    row('Plan', input.planName),
    row('Term', input.termLabel),
    row('Amount', `$${input.amountUsd}`),
    row('Paid in', `${input.amountCrypto} ${input.sym} · ${input.network}`),
    ends ? row('Term ends', ends) : '',
    input.txHash
      ? `<tr><td colspan="2" style="padding:9px 0;font-size:12px;color:#5b6675;font-family:Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(input.txHash)}</td></tr>`
      : ''
  ].join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>Payment confirmed — ${escapeHtml(input.reference)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
  Your ${escapeHtml(input.planName)} plan is active. Reference ${escapeHtml(input.reference)}.
  &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #dde2ea;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:26px 32px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;background:#2f6bd4;border-radius:9px;color:#ffffff;font-family:Georgia,serif;font-size:19px;font-weight:700;">C</td>
        <td style="padding-left:11px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#101720;">CloakShield&nbsp;Pro</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:22px 32px 4px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
      <h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#101720;">Payment confirmed</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:#39424f;">
        Your transfer was credited and the plan is active. Every tool in the workspace is
        now scoring your own traffic rather than the sample set. Keep the reference below
        if you ever need to ask us about this payment.
      </p>
    </td></tr>
    <tr><td style="padding:0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">${rows}</table>
    </td></tr>
    <tr><td style="padding:22px 32px 4px;" align="left">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" style="background:#2f6bd4;border-radius:8px;">
          <a href="https://cloakshield.io/dashboard.html" style="display:inline-block;padding:12px 22px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open your workspace</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 32px 28px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5b6675;">
      <p style="margin:0 0 6px;">${ends ? `This term runs to ${escapeHtml(ends)}. Nothing renews on its own &mdash; crypto payments cannot auto-charge &mdash; so you will be asked to extend it from the workspace before it ends.` : 'Nothing renews on its own, so you will be asked to extend the term from the workspace before it ends.'}</p>
      <p style="margin:0;">Questions about this payment: <a href="mailto:Cloakshield.pro@outlook.com" style="color:#2358b3;">Cloakshield.pro@outlook.com</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`
}

function receiptText(input: ReceiptInput) {
  const ends = formatDay(input.termEndsAt)
  return [
    'CloakShield Pro — payment confirmed',
    '',
    `Reference: ${input.reference}`,
    `Plan: ${input.planName}`,
    `Term: ${input.termLabel}`,
    `Amount: $${input.amountUsd}`,
    `Paid in: ${input.amountCrypto} ${input.sym} (${input.network})`,
    input.txHash ? `Transaction: ${input.txHash}` : '',
    ends ? `Term ends: ${ends}` : '',
    '',
    'Your workspace: https://cloakshield.io/dashboard.html',
    'Questions: Cloakshield.pro@outlook.com'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/* Returns true only when a receipt actually left. false covers both "not
   configured" and "the provider refused", and the caller distinguishes them by
   asking receiptsReady() — because one of those should be retried and the
   other should not. */
export async function sendReceipt(input: ReceiptInput) {
  if (!receiptsReady() || !input.to) return false

  try {
    return await sendEmail(
      input.to,
      `CloakShield Pro — payment confirmed (${input.reference})`,
      receiptHtml(input),
      receiptText(input)
    )
  } catch {
    return false
  }
}
