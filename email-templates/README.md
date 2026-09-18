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

## These four are not all the mail this site sends

There are two senders, and knowing which is which saves an hour of looking in
the wrong place:

| Sent by | Which messages | Where the design lives |
| ------- | -------------- | ---------------------- |
| **Netlify Identity** | the four here — confirmation, recovery, invite, email change | these files, fetched from the deployed site at send time |
| **This repo, through Resend** | welcome, sign-in notice, password changed, payment receipt | `netlify/lib/mail.mts` (the shared shell) and `netlify/lib/account-mail.mts` |

The split is not a preference. The confirmation link and the reset link carry a
single-use token that is minted inside Identity and never handed to any code
here — there is no API that returns it — so those two messages can only be sent
by Identity, from a template it fetches over HTTP. Everything that does *not*
need a token is sent directly, which is why the welcome email can name the plan
the visitor picked and the sign-in notice can name their browser.

Both senders should be the same domain, and that is the one thing still to set
by hand: the section below points Identity at Resend over SMTP, so all seven
messages leave from the address Resend has verified.

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

Both action links land somewhere real. Confirmation is redeemed by
`/welcome.html`, recovery by `/reset.html` — `js/site.js` forwards the site root
to whichever of the two the fragment calls for. Recovery was the one that had no
landing page for a while: the template was written, the subject was set, and the
link arrived at a homepage that did nothing with it. If you add a template to
this set, check that the far end of its link exists before you point Identity at
it.

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

### 1. Sender name and address — point Identity at Resend over SMTP

Out of the box the platform's own shared mail server sends these four, and its
envelope address is not a CloakShield one. Pointing Identity at a mail server
you control is what changes the `From:` line, and it is the only thing that
does. Resend — already the provider behind the receipts and the account emails
— speaks SMTP as well as HTTP, so the same verified domain can send all seven
messages and nothing new has to be signed up for.

Under **Project configuration → Identity → Emails**, fill in the custom SMTP
settings:

| Setting          | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| Sender name      | `CloakShield Pro`                                      |
| Sender address   | the same address as `MAIL_FROM` / `TRANSACTIONAL_EMAIL_FROM` |
| SMTP host        | `smtp.resend.com`                                      |
| SMTP port        | `587`                                                  |
| SMTP username    | `resend` — the literal word, not an email address      |
| SMTP password    | your Resend API key, the same value as `RESEND_API_KEY` |

Two things about that table are easy to get wrong. The username really is the
string `resend` for every account; Resend's docs are explicit about it and an
address there fails to authenticate. And the sender address has to be on a
domain **verified** in Resend — an unverified one is refused on every send, and
the symptom is a signup flow where no confirmation email ever arrives and
nothing on the site reports a problem.

Keep it the same address the functions send from. Two senders on one domain is
fine; two *domains* means a customer sees one brand confirm their account and a
different one send the receipt.

Once that is saved, the inbox row reads **CloakShield Pro** and the address
behind it is `cloakshield.io`.

Publish `SPF`, `DKIM` and `DMARC` records for `cloakshield.io` at the same time.
Resend prints the exact records during domain verification — if the domain shows
as verified there, `SPF` and `DKIM` are already done and `DMARC` is the one
worth adding by hand. Without them a message that *claims* to be from
`cloakshield.io` is the shape of a spoof, and Gmail and Outlook will either mark
it or drop it — which for a verification email means the signup flow silently
stops working.

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
  the two paths in sync. In `recovery.html` the same placeholder carries
  `recovery_token` instead and is forwarded to `/reset.html` by the same rule.
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

## Keeping the seven in step

The masthead, the action button, the security aside and the footer in these
four files are duplicated — by hand, deliberately — in `renderEmail()` in
`netlify/lib/mail.mts`, which builds the other three messages plus the payment
receipt. There is no way to share the markup: these are Go `text/template`
files fetched over HTTP by a service that has never heard of this repo, and
that one is TypeScript running in a function. So if you move the masthead,
recolour the button or reword the security block, do it in both places and
diff a rendered example of each before deploying. The list of colours is short
and it is in **Why they look nothing like the site** above.
