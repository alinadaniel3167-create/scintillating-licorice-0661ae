# Transactional email templates

The four messages CloakShield Pro sends on behalf of an account. They are plain
files in the publish root, so a deploy publishes them at

```
/email-templates/confirmation.html
/email-templates/recovery.html
/email-templates/invite.html
/email-templates/email-change.html
```

Everything a visitor *reads* in those messages is in this directory and is under
version control. Three things a visitor *sees in their inbox list* — the sender
name, the sender address and the subject — are not in the file at all. They are
account settings, and they have to be set once by hand. That split is the whole
reason this README exists; see **Making the mail say CloakShield Pro** below.

## Pointing the templates at the files

The templates are not picked up by path convention. Each one has to be pointed
at once, under **Project configuration → Identity → Emails**, by pasting the
path (leading slash, no domain) into the matching template field, along with the
subject line:

| Field        | Template path                        | Subject line                                        |
| ------------ | ------------------------------------ | --------------------------------------------------- |
| Confirmation | `/email-templates/confirmation.html` | `Verify your CloakShield Pro account`               |
| Recovery     | `/email-templates/recovery.html`     | `Reset your CloakShield Pro password`               |
| Invitation   | `/email-templates/invite.html`       | `You have been invited to a CloakShield Pro workspace` |
| Email change | `/email-templates/email-change.html` | `Confirm your new CloakShield Pro email address`    |

Each template's own header comment repeats its path and subject, so the pair
stays discoverable from the file you are editing.

## Making the mail say CloakShield Pro

A confirmation email has four places a brand can leak. Two are fixed in this
repo; two are account settings and cannot be fixed from code, because the code
never sees them.

| What the recipient sees          | Where it comes from                | Fixed here? |
| -------------------------------- | ---------------------------------- | ----------- |
| Body, masthead, wording, footer  | the files in this directory        | yes         |
| Links inside the body            | `{{ .SiteURL }}` / `{{ .ConfirmationURL }}` | follows the primary domain |
| Sender name and sender address   | the sending mail server             | **no — set it once, below** |
| Subject line                     | the Identity email settings         | **no — set it once, above** |

### 1. Sender name and address — configure an outbound mail server

Out of the box the platform's own shared mail server sends these messages, and
its envelope address is not a CloakShield one. Pointing Identity at a mail
server you control is what changes the `From:` line, and it is the only thing
that does.

Under **Project configuration → Identity → Emails**, fill in the custom SMTP
settings with credentials from whichever provider sends your mail — Postmark,
Amazon SES, Mailgun, SendGrid and Google Workspace all work, and any of them
will do:

| Setting          | Value                                       |
| ---------------- | ------------------------------------------- |
| Sender name      | `CloakShield Pro`                           |
| Sender address   | `no-reply@cloakshield.io`                   |
| SMTP host / port | from your provider (usually port 587)       |
| SMTP username    | from your provider                          |
| SMTP password    | from your provider — store it as a secret, never in this repo |

Once that is saved, the inbox row reads **CloakShield Pro** and the address
behind it is `cloakshield.io`.

Publish `SPF`, `DKIM` and `DMARC` records for `cloakshield.io` at the same time.
Your provider prints the exact records. Without them a message that *claims* to
be from `cloakshield.io` is the shape of a spoof, and Gmail and Outlook will
either mark it or drop it — which for a verification email means the signup flow
silently stops working.

### 2. Links — attach the custom domain

`{{ .SiteURL }}` and `{{ .ConfirmationURL }}` both resolve to whatever the
project's **primary** domain is at send time. Attach `cloakshield.io` under
**Domain management** and set it as primary, and every link in every one of
these messages becomes a `cloakshield.io` link with no further edits here.

Leave the default deploy subdomain as primary and the links keep pointing at it
— the templates cannot override this, because they are rendered before the
message leaves and have no way to know a canonical hostname. Do not hard-code
`https://cloakshield.io/...` into the templates to force it: the confirmation
token is minted against the primary domain, so a hand-written host produces a
link that looks right and fails to redeem.

The footer link *text* is already the literal string `cloakshield.io`, so the
visible wordmark is correct either way. The href is what follows the setting.

## The placeholders

Identity fetches the file from the deployed site at send time and renders it
with Go's `text/template`, which is why the placeholders are `{{ .Name }}` and
not `${name}`. The ones used here:

- `{{ .ConfirmationURL }}` — the single-use action link. It points at the **site
  root** with the token in the fragment (`/#confirmation_token=…`), which is why
  `js/site.js` forwards any page carrying that fragment to `/welcome.html`. Do
  not rewrite it to `/welcome.html` in the template; the redirect is what keeps
  the two paths in sync.
- `{{ .SiteURL }}` — the primary URL, no trailing slash. Footer links append
  their own path.
- `{{ .Email }}` — the recipient. In `email-change.html` it is the *old*
  address, paired with `{{ .NewEmail }}`.

## Why they look nothing like the site

Email is not the web. Outlook renders through Word: no flexbox, no grid, no
custom properties, no external stylesheet, no SVG, no web font. So every one of
these is a fixed-width `<table>` with styles inline, the mark is a rounded table
cell with a letter in it rather than `assets/favicon.svg`, and the colours are
literal hex rather than tokens — the one place in this repo where a hard-coded
colour is correct. Keep the palette matched to `css/style.css` by hand:
`#0b0f16` masthead, `#2f6bd4` action, `#eef1f6` page.

Each file also opens with a hidden preheader — the grey line an inbox shows
after the subject. The `&#847;&zwnj;` padding after it stops the client pulling
the first visible sentence in behind it.

`robots.txt` disallows the directory. Nothing here is secret, but a template
full of unsubstituted `{{ … }}` is a poor search result.

## What the confirmation email has to carry

`confirmation.html` is the one message in the set that a stranger reads, so it
does more than link out. In order: what the account is and why the mail arrived,
the action button, a paste-able copy of the link, the four-step flow the visitor
is standing in, what confirming actually buys them, a security block, and a
support route. Keep all seven if you rework it — the security block in
particular is load-bearing. It states that CloakShield Pro never asks for a
password, a seed phrase or a wallet key by email, and that payment addresses
appear only inside a signed-in workspace. On a site that takes crypto, that
paragraph is the thing standing between a customer and a convincing phishing
message wearing this design.

## Changing one

There is nothing to compile. Edit the file, deploy, then send yourself a real
one — register a throwaway address, or use the recovery form. Check it in a
dark-mode client too: `<meta name="color-scheme" content="light">` asks clients
not to invert, but Gmail on Android ignores it and forces its own inversion, so
the design has to survive being flipped. That is why the body is light and the
only dark surface is the masthead.

Read the rendered mail once with the inbox list in view, not just the message:
sender name, subject and preheader are three of the four things that decide
whether it gets opened, and only the preheader lives in this directory.
