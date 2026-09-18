/* ==========================================================================
   Transactional email — one Resend transport, one house style.

   Every message this site sends that is not an operator alert goes out from
   here: the account emails (welcome, sign-in notice, password changed) and
   the payment receipt. Before this module they were two different things —
   a hand-written table in notify.mts for receipts, and nothing at all for
   the account path — which is why the two looked related rather than
   identical. renderEmail() below is the shell all of them share, so a change
   to the masthead or the footer lands in every message at once.

   Three decisions worth knowing.

   **The sender is read from two variable names.** MAIL_FROM is what this
   repo has always used; TRANSACTIONAL_EMAIL_FROM is what the Resend setup
   flow creates. Either one works and MAIL_FROM wins if both are set, because
   a project that has one of them configured and mail that silently stays off
   is the exact failure this file is trying to stop being possible. Neither
   has a default: Resend refuses any address whose domain is not verified on
   the account, so a guessed sender is a channel that reports itself ready
   and then fails on every single send.

   **Nothing here can fail the request that triggered it.** sendMail()
   swallows every error and returns a boolean, and it aborts at MAIL_TIMEOUT
   so a stalled connection to Resend cannot hold up a sign-in or a
   registration. An account that was created is created whether or not the
   welcome email went out.

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

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/* Resend answers in a few hundred milliseconds. This exists for the case
   where it does not answer at all, on a path where a customer is waiting for
   a page to move. */
const MAIL_TIMEOUT_MS = 6000

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

export function apiKey() {
  return env('RESEND_API_KEY')
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

/* Returns true only when Resend accepted the message. false covers "not
   configured", "timed out" and "the provider refused" alike; callers that
   need to tell those apart ask mailerReady() first, because one of them is
   worth retrying and the other is not. */
export async function sendMail(input: MailInput): Promise<boolean> {
  const key = apiKey()
  const from = sender()
  if (!key || !from || !input.to) return false

  const body: Record<string, unknown> = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text
  }

  const replyTo = env('MAIL_REPLY_TO')
  if (replyTo) body.reply_to = [replyTo]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS)

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
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
