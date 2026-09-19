/* ==========================================================================
   Transactional email — one Resend transport, one house style.

   Every message this site sends that is not an operator alert goes out from
   here: the account emails (welcome, sign-in notice, password changed) and
   the payment receipt. Before this module they were two different things —
   a hand-written table in notify.mts for receipts, and nothing at all for
   the account path — which is why the two looked related rather than
   identical. renderEmail() below is the shell all of them share, so a change
   to the masthead or the footer lands in every message at once.

   Four decisions worth knowing.

   **The sender is read from two variable names.** MAIL_FROM is what this
   repo has always used; TRANSACTIONAL_EMAIL_FROM is what the Resend setup
   flow creates. Either one works and MAIL_FROM wins if both are set, because
   a project that has one of them configured and mail that silently stays off
   is the exact failure this file is trying to stop being possible. Neither
   has a default: Resend refuses any address whose domain is not verified on
   the account, so a guessed sender is a channel that reports itself ready
   and then fails on every single send.

   **Nothing here can fail the request that triggered it.** sendMail()
   swallows every error and returns a boolean, and it is bounded by both a
   per-attempt timeout and a total deadline so a stalled connection to Resend
   cannot hold up a sign-in or a registration. An account that was created is
   created whether or not the welcome email went out. A rate limit or a 5xx is
   retried inside that budget, under one Idempotency-Key so a retry cannot
   duplicate a message Resend had already accepted; an unauthorised key or an
   unverified sender domain is not retried, because the second attempt would
   get the same answer as the first.

   **Every failure is logged, because every failure is otherwise invisible.**
   A lapsed key, a sender on an unverified domain and a project with no mailer
   configured at all produce exactly the same observable behaviour: the site
   works and no email arrives. So sendMail() writes the status and Resend's own
   reason to the function log, /api/health reports the two halves of the
   configuration separately, and neither ever prints the key or the address it
   would have sent to in full.

   **The HTML is written the way email has to be written**, not the way the
   site is: tables for layout, styles inline, literal hex, no SVG, no web
   font. Outlook renders through Word and drops all of those. The palette is
   copied from css/style.css by hand and kept in step with the four Identity
   templates in email-templates/ — this is the one part of the codebase where
   a hard-coded colour is the correct answer.

     RESEND_API_KEY                            required for any send
     MAIL_FROM | TRANSACTIONAL_EMAIL_FROM      required for any send
     MAIL_FROM_NAME                            optional display name
     MAIL_REPLY_TO                             optional Reply-To
     SUPPORT_EMAIL                             optional; defaults to the
                                               published support address
   ========================================================================== */

import { randomUUID } from 'node:crypto'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/* Resend answers in a few hundred milliseconds. This exists for the case
   where it does not answer at all, on a path where a customer is waiting for
   a page to move. */
const MAIL_TIMEOUT_MS = 6000

/* Retries are bounded twice over — by a count and by a wall-clock budget —
   because the caller is usually a function invocation with a customer waiting
   at the end of it. Two extra attempts inside fourteen seconds covers the
   failure these exist for (Resend's per-second rate limit, which the poller
   can reach when it credits several orders in one pass) without turning a
   provider outage into a slow sign-in. */
const MAIL_ATTEMPTS = 3
const MAIL_DEADLINE_MS = 14000

/* Retried: the rate limit and the statuses that mean "not now". Every other
   answer Resend gives is a configuration mistake — an unauthorised key, an
   unverified sender domain, a malformed address — and repeating the request
   cannot fix any of them, so it is reported instead. */
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504]

const DEFAULT_SUPPORT = 'Cloakshield.pro@outlook.com'
const DEFAULT_SITE = 'https://cloakshield.io'

/* --- Palette -------------------------------------------------------------
   Light only. An email arrives in whatever chrome the client wants and there
   is no reliable way to theme it, so these mirror the [data-theme="light"]
   half of css/style.css rather than the dark default. */
const C = {
  page: '#eef1f6',
  card: '#ffffff',
  cardLine: '#dde2ea',
  mast: '#0b0f16',
  head: '#101720',
  body: '#39424f',
  muted: '#5b6675',
  solid: '#2f6bd4',
  link: '#2358b3',
  panel: '#f5f7fa',
  panelLine: '#e3e8ef',
  footer: '#f9fafc',
  amber: '#8a5d12',
  amberPanel: '#fdf6ea',
  amberLine: '#ecd9b0',
  green: '#2f7d59'
}

const SANS = 'Helvetica,Arial,sans-serif'
const MONO = 'Menlo,Consolas,monospace'

/* --- Environment ---------------------------------------------------------- */

function env(name: string) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : null
}

/* One warning per container rather than one per send. These are read on
   every message, and a misconfiguration that reports itself a hundred times
   an hour buries the thing it is trying to report. */
const warned: Record<string, boolean> = {}

function warnOnce(tag: string, message: string) {
  if (warned[tag]) return
  warned[tag] = true
  console.warn(`[mail] ${message}`)
}

export function apiKey() {
  const key = env('RESEND_API_KEY')

  /* Every Resend key is `re_`-prefixed. A value that is not one is almost
     always a paste that brought its quotes along, or the wrong secret
     entirely — and both of those otherwise surface only as an unauthorised
     answer on every send. The key is still used exactly as given; this only
     says so out loud, once. */
  if (key && !key.startsWith('re_')) {
    warnOnce(
      'key-shape',
      'RESEND_API_KEY does not begin with "re_". If sends come back unauthorised, check the variable for stray quotes or whitespace.'
    )
  }

  return key
}

/* MAIL_FROM first, TRANSACTIONAL_EMAIL_FROM second. Both are accepted so
   that whichever one the project happens to have set is the one that works;
   see the header note. */
export function sender() {
  const address = env('MAIL_FROM') || env('TRANSACTIONAL_EMAIL_FROM')
  if (!address) return null

  /* An address that already carries a display name ("Name <a@b>") is passed
     through untouched — MAIL_FROM_NAME is for the plain-address case, and
     wrapping a wrapped address is how a From: line ends up malformed. */
  if (address.includes('<')) return address

  const name = env('MAIL_FROM_NAME')
  return name ? `${name} <${address}>` : address
}

export function supportEmail() {
  return env('SUPPORT_EMAIL') || DEFAULT_SUPPORT
}

/* Both halves have to be present for a send to be possible, and the two are
   reported separately by /api/health so "no key" and "no sender" are
   distinguishable without a test message. */
export function mailerReady() {
  return Boolean(apiKey() && sender())
}

export function mailerState() {
  return {
    provider: 'resend',
    apiKey: Boolean(apiKey()),
    sender: Boolean(sender()),
    replyTo: Boolean(env('MAIL_REPLY_TO')),
    ready: mailerReady()
  }
}

/* The primary URL at send time. Every link in every message is absolute,
   because an email has no origin to be relative to. URL is Netlify's
   canonical primary domain; DEPLOY_PRIME_URL keeps links working on a branch
   deploy, which is where these get tested. */
export function siteUrl() {
  const raw = env('URL') || env('SITE_URL') || env('DEPLOY_PRIME_URL') || DEFAULT_SITE
  return raw.replace(/\/+$/, '')
}

/* --- Transport ------------------------------------------------------------ */

export interface MailInput {
  to: string
  subject: string
  html: string
  text: string
}

/* Enough of an address to recognise in a log line, and not enough to be a
   mailing list if those logs are ever shared. The domain is the half that
   matters for a delivery problem anyway. */
function maskAddress(address: string) {
  const at = address.lastIndexOf('@')
  if (at < 1) return '(invalid)'
  return `${address[0]}***${address.slice(at)}`
}

/* Belt and braces. Resend does not echo the key back in an error, but these
   messages go to a log and the key must not reach one by any route. */
function redact(message: string) {
  return message.replace(/re_[A-Za-z0-9_-]+/g, 're_[redacted]')
}

/* Resend answers an error as { statusCode, name, message }. Any of the three
   can be absent — a proxy error or an HTML error page has none of them — so
   the status off the response is what the log line actually leans on and the
   body only adds detail when there is some. */
async function describeFailure(response: Response) {
  const raw = await response.text().catch(() => '')
  let name = ''
  let message = ''

  try {
    const parsed = JSON.parse(raw) as { name?: string; message?: string }
    name = String(parsed?.name || '')
    message = String(parsed?.message || '')
  } catch {
    message = raw.slice(0, 200)
  }

  return {
    code: name || 'unknown',
    message: redact(message || `HTTP ${response.status}`).slice(0, 300)
  }
}

/* How long to wait before trying again. Resend sends Retry-After with a 429;
   where it does not, a short fixed backoff is enough for a per-second rate
   limit. Capped either way, because a large Retry-After must not park a
   function that has a customer waiting on its response. */
function backoffMs(response: Response | null, attempt: number) {
  const header = response?.headers.get('retry-after')
  const seconds = header ? Number(header) : NaN
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 4000)
  return attempt === 1 ? 400 : 1200
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* Returns true only when Resend accepted the message. false covers "not
   configured", "timed out" and "the provider refused" alike; callers that
   need to tell those apart ask mailerReady() first, because one of them is
   worth retrying and the other is not.

   **Every failure is written to the function log**, and that is the point of
   the noise below. All of them are otherwise completely silent: the account
   is created, the password is changed, the order is credited, and the only
   thing missing is a message whose absence nobody can see. An unverified
   sender domain and a lapsed key both look exactly like a site that has no
   mailer configured, which is why the log line carries the status and the
   provider's own reason rather than just the word "failed".

   A retried attempt reuses one Idempotency-Key, so a request that timed out
   *after* Resend had accepted it cannot turn into a second copy in the
   customer's inbox. A separate call — the poller re-attempting a receipt on
   its next pass — is a new message and gets a new key. */
export async function sendMail(input: MailInput): Promise<boolean> {
  const key = apiKey()
  const from = sender()

  if (!key || !from) {
    warnOnce(
      'unconfigured',
      `transactional email is off — ${
        !key && !from
          ? 'neither RESEND_API_KEY nor MAIL_FROM / TRANSACTIONAL_EMAIL_FROM holds a value'
          : !key
            ? 'RESEND_API_KEY is missing or empty'
            : 'no sender address is set — set MAIL_FROM or TRANSACTIONAL_EMAIL_FROM to an address on a domain verified with Resend'
      }. Nothing is being sent.`
    )
    return false
  }

  if (!input.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
    console.error(`[mail] no usable recipient for "${input.subject}" — nothing sent.`)
    return false
  }

  const body: Record<string, unknown> = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text
  }

  const replyTo = env('MAIL_REPLY_TO')
  if (replyTo) body.reply_to = [replyTo]

  const payload = JSON.stringify(body)
  const to = maskAddress(input.to)
  const idempotencyKey = randomUUID()
  const startedAt = Date.now()

  for (let attempt = 1; attempt <= MAIL_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS)
    let response: Response | null = null

    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Idempotency-Key': idempotencyKey
        },
        body: payload,
        signal: controller.signal
      })

      if (response.ok) {
        /* The id is what a message is looked up by in the Resend dashboard,
           so it is the one field worth carrying into the log. */
        const id = await response
          .json()
          .then((data: { id?: string }) => String(data?.id || ''))
          .catch(() => '')

        console.log(
          `[mail] sent to=${to} subject="${input.subject}" attempt=${attempt}${id ? ` id=${id}` : ''}`
        )
        return true
      }

      const { code, message } = await describeFailure(response)

      if (RETRY_STATUSES.indexOf(response.status) === -1) {
        console.error(
          `[mail] refused to=${to} subject="${input.subject}" status=${response.status} code=${code}: ${message}`
        )
        return false
      }

      console.warn(
        `[mail] retryable failure to=${to} subject="${input.subject}" status=${response.status} code=${code} attempt=${attempt}/${MAIL_ATTEMPTS}: ${message}`
      )
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError'
      const reason = aborted
        ? `no answer within ${MAIL_TIMEOUT_MS}ms`
        : `request failed (${redact(String((error as Error)?.message || error))})`

      console.warn(`[mail] ${reason} to=${to} subject="${input.subject}" attempt=${attempt}/${MAIL_ATTEMPTS}`)
    } finally {
      clearTimeout(timer)
    }

    if (attempt === MAIL_ATTEMPTS) break

    /* Stop early rather than start an attempt the budget cannot finish. */
    const wait = backoffMs(response, attempt)
    if (Date.now() - startedAt + wait + MAIL_TIMEOUT_MS > MAIL_DEADLINE_MS) break
    await sleep(wait)
  }

  console.error(
    `[mail] gave up to=${to} subject="${input.subject}" after ${Date.now() - startedAt}ms — not delivered.`
  )
  return false
}

/* --- Rendering ------------------------------------------------------------ */

export function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type Block =
  | { kind: 'para'; text: string }
  /* A numbered sequence. Used where the reader's real question is "what
     happens next", which a paragraph answers badly. */
  | { kind: 'steps'; title?: string; items: string[] }
  | { kind: 'bullets'; title?: string; items: Array<{ strong?: string; text: string }> }
  /* Label/value pairs — the receipt's detail table, and the sign-in
     notice's when-and-where. */
  | { kind: 'rows'; rows: Array<[string, string]> }
  | { kind: 'mono'; label?: string; value: string }
  | { kind: 'note'; tone?: 'info' | 'amber'; title?: string; lines: string[] }

export interface EmailSpec {
  /* The <title>, and the first line of the plain-text part. */
  title: string
  /* The grey line an inbox shows next to the subject. */
  preheader: string
  eyebrow?: string
  heading: string
  lede: string
  blocks?: Block[]
  action?: { label: string; href: string; showUrl?: boolean }
  /* Rendered as the left-ruled aside every one of these messages ends with.
     Transactional mail about an account is where phishing lands, so the
     security wording is part of the shell rather than per-message copy. */
  security?: { title: string; lines: string[] }
  /* "Need a hand?" block. On by default; off for the operator alerts, which
     go to the person who would be answering it. */
  support?: boolean
  footerNote?: string
}

function pad(text: string) {
  /* Padding characters after a hidden preheader. Without them the client
     pulls the first visible sentence in behind it. */
  return (
    escapeHtml(text) +
    '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;'
  )
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'para':
      return `<tr><td style="padding:0 32px 4px 32px;font-family:${SANS};">
        <p style="margin:0 0 14px 0;font-size:15px;line-height:1.62;color:${C.body};">${block.text}</p>
      </td></tr>`

    case 'steps': {
      const rows = block.items
        .map(
          (item, i) =>
            `<tr>
               <td width="22" valign="top" style="width:22px;padding:5px 0;font-family:${SANS};font-size:14px;font-weight:bold;color:${C.solid};">${i + 1}.</td>
               <td valign="top" style="padding:5px 0;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body};">${item}</td>
             </tr>`
        )
        .join('')

      return `<tr><td style="padding:6px 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};border:1px solid ${C.panelLine};border-radius:10px;">
          ${
            block.title
              ? `<tr><td style="padding:18px 20px 6px 20px;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:0.7px;text-transform:uppercase;color:${C.muted};">${escapeHtml(block.title)}</td></tr>`
              : ''
          }
          <tr><td style="padding:${block.title ? '0' : '16px'} 20px 16px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
          </td></tr>
        </table>
      </td></tr>`
    }

    case 'bullets': {
      const rows = block.items
        .map(
          (item) =>
            `<tr>
               <td width="16" valign="top" style="width:16px;padding:4px 0;font-family:${SANS};font-size:14px;font-weight:bold;color:${C.solid};">&bull;</td>
               <td valign="top" style="padding:4px 0 4px 8px;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body};">${
                 item.strong ? `<strong style="color:${C.head};">${item.strong}</strong> ` : ''
               }${item.text}</td>
             </tr>`
        )
        .join('')

      return `<tr><td style="padding:8px 32px 0 32px;font-family:${SANS};">
        ${
          block.title
            ? `<p style="margin:0 0 10px 0;font-size:12px;font-weight:bold;letter-spacing:0.7px;text-transform:uppercase;color:${C.muted};">${escapeHtml(block.title)}</p>`
            : ''
        }
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
      </td></tr>`
    }

    case 'rows': {
      const rows = block.rows
        .map(
          ([label, value]) =>
            `<tr>
               <td style="padding:9px 0;border-bottom:1px solid ${C.panelLine};font-family:${SANS};font-size:14px;color:${C.muted};">${escapeHtml(label)}</td>
               <td align="right" style="padding:9px 0;border-bottom:1px solid ${C.panelLine};font-family:${SANS};font-size:14px;color:${C.head};font-weight:bold;">${escapeHtml(value)}</td>
             </tr>`
        )
        .join('')

      return `<tr><td style="padding:10px 32px 6px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
      </td></tr>`
    }

    case 'mono':
      return `<tr><td style="padding:4px 32px 10px 32px;font-family:${SANS};">
        ${block.label ? `<p style="margin:0 0 5px 0;font-size:12px;color:${C.muted};">${escapeHtml(block.label)}</p>` : ''}
        <p style="margin:0;font-family:${MONO};font-size:12px;line-height:1.55;color:${C.head};word-break:break-all;">${escapeHtml(block.value)}</p>
      </td></tr>`

    case 'note': {
      const amber = block.tone === 'amber'
      const bg = amber ? C.amberPanel : C.panel
      const line = amber ? C.amberLine : C.panelLine
      const rule = amber ? C.amber : C.solid

      return `<tr><td style="padding:16px 32px 4px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${line};border-left:3px solid ${rule};border-radius:8px;">
          <tr><td style="padding:16px 18px;font-family:${SANS};">
            ${block.title ? `<p style="margin:0 0 8px 0;font-size:13px;font-weight:bold;color:${C.head};">${escapeHtml(block.title)}</p>` : ''}
            ${block.lines
              .map(
                (line_, i) =>
                  `<p style="margin:0${i === block.lines.length - 1 ? '' : ' 0 7px 0'};font-size:13px;line-height:1.6;color:${C.body};">${line_}</p>`
              )
              .join('')}
          </td></tr>
        </table>
      </td></tr>`
    }
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'para':
      return stripTags(block.text)
    case 'steps':
      return [block.title ? `${block.title}:` : '', ...block.items.map((i, n) => `  ${n + 1}. ${stripTags(i)}`)]
        .filter(Boolean)
        .join('\n')
    case 'bullets':
      return [
        block.title ? `${block.title}:` : '',
        ...block.items.map((i) => `  - ${i.strong ? `${i.strong} ` : ''}${stripTags(i.text)}`)
      ]
        .filter(Boolean)
        .join('\n')
    case 'rows':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n')
    case 'mono':
      return block.label ? `${block.label}\n${block.value}` : block.value
    case 'note':
      return [block.title ? `${block.title}` : '', ...block.lines.map(stripTags)].filter(Boolean).join('\n')
  }
}

/* The plain-text part is generated from the same spec as the HTML rather
   than written twice, so the two cannot drift. Copy carries the odd <strong>
   and <a>, which the text part wants as words. */
function stripTags(value: string) {
  return value
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href, label) => {
      /* A mailto reads fine as the address alone, and so does a link whose
         text is already the URL — appending it again gives "at https://x
         (https://x)", which is how a plain-text part starts looking
         machine-generated. */
      if (href.startsWith('mailto:') || label === href) return String(label)
      return `${label} (${href})`
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

export function renderEmail(spec: EmailSpec): { html: string; text: string } {
  const site = siteUrl()
  const support = supportEmail()
  const wantSupport = spec.support !== false
  const blocks = spec.blocks || []

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${escapeHtml(spec.title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">

<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${pad(spec.preheader)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.card};border:1px solid ${C.cardLine};border-radius:12px;overflow:hidden;">

    <tr><td style="background:${C.mast};padding:22px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="34" style="width:34px;height:34px;background:${C.solid};border-radius:8px;text-align:center;vertical-align:middle;font-family:${SANS};font-size:18px;font-weight:bold;color:#ffffff;line-height:34px;">C</td>
        <td style="padding-left:12px;font-family:${SANS};font-size:17px;font-weight:bold;letter-spacing:-0.2px;color:#ffffff;vertical-align:middle;">CloakShield&nbsp;Pro</td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:36px 32px 8px 32px;font-family:${SANS};">
      ${
        spec.eyebrow
          ? `<p style="margin:0 0 6px 0;font-size:12px;font-weight:bold;letter-spacing:0.7px;text-transform:uppercase;color:${C.muted};">${escapeHtml(spec.eyebrow)}</p>`
          : ''
      }
      <h1 style="margin:0 0 16px 0;font-size:25px;line-height:1.25;font-weight:bold;letter-spacing:-0.4px;color:${C.head};">${escapeHtml(spec.heading)}</h1>
      <p style="margin:0 0 14px 0;font-size:15px;line-height:1.62;color:${C.body};">${spec.lede}</p>
    </td></tr>

    ${
      spec.action
        ? `<tr><td style="padding:10px 32px 8px 32px;">
             <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
               <td align="center" style="background:${C.solid};border-radius:8px;">
                 <a href="${escapeHtml(spec.action.href)}" style="display:inline-block;padding:14px 26px;font-family:${SANS};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;letter-spacing:-0.1px;">${escapeHtml(spec.action.label)}</a>
               </td>
             </tr></table>
           </td></tr>
           ${
             spec.action.showUrl
               ? `<tr><td style="padding:14px 32px 0 32px;font-family:${SANS};">
                    <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:${C.muted};">If the button does not work, paste this address into your browser:</p>
                    <p style="margin:0 0 14px 0;font-size:12px;line-height:1.55;word-break:break-all;"><a href="${escapeHtml(spec.action.href)}" style="color:${C.link};text-decoration:underline;">${escapeHtml(spec.action.href)}</a></p>
                  </td></tr>`
               : `<tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>`
           }`
        : ''
    }

    ${blocks.map(blockHtml).join('')}

    ${
      spec.security
        ? blockHtml({ kind: 'note', tone: 'info', title: spec.security.title, lines: spec.security.lines })
        : ''
    }

    ${
      wantSupport
        ? `<tr><td style="padding:22px 32px 30px 32px;font-family:${SANS};">
             <p style="margin:0 0 6px 0;font-size:13px;font-weight:bold;color:${C.head};">Need a hand?</p>
             <p style="margin:0;font-size:13px;line-height:1.62;color:${C.muted};">
               Email <a href="mailto:${escapeHtml(support)}" style="color:${C.link};text-decoration:underline;">${escapeHtml(support)}</a>
               and a human answers &mdash; typically within one business day. Include the address this message was sent to so we can find the account.
             </p>
           </td></tr>`
        : `<tr><td style="height:20px;line-height:20px;">&nbsp;</td></tr>`
    }

    <tr><td style="border-top:1px solid ${C.panelLine};background:${C.footer};padding:22px 32px;font-family:${SANS};">
      <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:${C.muted};">
        <a href="${site}" style="color:${C.link};text-decoration:none;font-weight:bold;">cloakshield.io</a>
        &nbsp;&middot;&nbsp;<a href="${site}/about.html" style="color:${C.muted};text-decoration:none;">Contact</a>
        &nbsp;&middot;&nbsp;<a href="${site}/privacy.html" style="color:${C.muted};text-decoration:none;">Privacy</a>
        &nbsp;&middot;&nbsp;<a href="${site}/terms.html" style="color:${C.muted};text-decoration:none;">Terms</a>
      </p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:${C.muted};">
        ${spec.footerNote ? `${escapeHtml(spec.footerNote)}<br/>` : ''}
        You are receiving this because an account on CloakShield Pro uses this address. This is a transactional message about that account, not marketing.
      </p>
    </td></tr>

  </table>

</td></tr></table>
</body></html>`

  const text = [
    `CloakShield Pro — ${spec.title}`,
    '',
    spec.heading,
    '',
    stripTags(spec.lede),
    spec.action ? `\n${spec.action.label}: ${spec.action.href}` : '',
    ...blocks.map((b) => `\n${blockText(b)}`),
    spec.security ? `\n${spec.security.title}\n${spec.security.lines.map(stripTags).join('\n')}` : '',
    wantSupport ? `\nNeed a hand? Email ${support}` : '',
    `\ncloakshield.io — ${site}`
  ]
    .filter((part) => part !== '')
    .join('\n')

  return { html, text }
}
