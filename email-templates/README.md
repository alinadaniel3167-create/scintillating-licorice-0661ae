# Identity email templates

The four transactional emails Netlify Identity sends on behalf of this site.
They are plain files in the publish root, so a deploy publishes them at

```
/email-templates/confirmation.html
/email-templates/recovery.html
/email-templates/invite.html
/email-templates/email-change.html
```

Netlify does not pick them up by path convention. Each one has to be pointed at
once, under **Project configuration → Identity → Emails**, by pasting the path
(leading slash, no domain) into the matching template field:

| Field             | Path                                  |
| ----------------- | ------------------------------------- |
| Confirmation      | `/email-templates/confirmation.html`  |
| Invitation        | `/email-templates/invite.html`        |
| Recovery          | `/email-templates/recovery.html`      |
| Email change      | `/email-templates/email-change.html`  |

Identity fetches the file from the deployed site at send time and renders it
with Go's `text/template`, which is why the placeholders are `{{ .Name }}` and
not `${name}`. The ones used here:

- `{{ .ConfirmationURL }}` — the single-use action link. Identity points it at
  the **site root** with the token in the fragment (`/#confirmation_token=…`),
  which is why `js/site.js` forwards any page carrying that fragment to
  `/welcome.html`. Do not rewrite it to `/welcome.html` in the template; the
  redirect is what keeps the two paths in sync.
- `{{ .SiteURL }}` — the site's primary URL, no trailing slash. Footer links
  append their own path.
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

## Changing one

There is nothing to compile. Edit the file, deploy, then send yourself a real
one — register a throwaway address, or use the recovery form. Check it in a
dark-mode client too: `<meta name="color-scheme" content="light">` asks clients
not to invert, but Gmail on Android ignores it and forces its own inversion, so
the design has to survive being flipped. That is why the body is light and the
only dark surface is the masthead.
