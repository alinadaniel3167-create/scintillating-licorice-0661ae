/* ==========================================================================
   The platforms a customer can connect, and what each one needs to be asked
   for. Declarative on purpose, the same way assets.mts is: the credential
   fields, the brand token and the copy all live here, so adding a sixth
   platform is one entry in this file plus one verifier in platform-api.mts
   and nothing else.

   `connectable: false` is a real state, not a placeholder. Cloaking House is
   in the panel because the site integrates with it and customers expect to
   see it, but there is no documented public API to hold a key for — so the
   card says "set up by hand" rather than offering a form that cannot work.
   A connector that reports itself ready and then fails is the exact failure
   notify.mts was written to avoid, and the same rule applies here.
   ========================================================================== */

export interface CredentialField {
  /* The form field name, and the key the function reads off the body. */
  name: string
  label: string
  /* Shown under the input. Says where to find the value, not what a key is. */
  hint: string
  /* Secret fields are write-only: never echoed back, masked in any log line. */
  secret: boolean
}

export interface Platform {
  id: string
  name: string
  /* "Tracker" / "Cloaker" — the word that goes in the card subtitle. */
  kind: string
  /* The data-brand token the card carries, which is what colours the mark.
     These match the --brand-* custom properties in css/style.css. */
  brand: string
  /* The <symbol> id in the page sprite. */
  icon: string
  /* Self-hosted platforms are reached at a host the customer supplies, which
     is why they need base_url and why every one of them goes through the
     SSRF guard before a request is made. */
  selfHosted: boolean
  /* Whether there is an API to connect to at all. */
  connectable: boolean
  /* Card subtitle — what connecting actually does. */
  summary: string
  /* Shown in the connect form, above the fields. */
  note: string
  fields: CredentialField[]
}

/* The credential that is encrypted and stored. For the two-value platforms
   the pair is stored as one JSON string, so the table has one cipher column
   rather than a column per platform's idea of a credential. */
export const PLATFORMS: Platform[] = [
  {
    id: 'keitaro',
    name: 'Keitaro',
    kind: 'Tracker',
    brand: 'kt',
    icon: '#p-keitaro',
    selfHosted: true,
    connectable: true,
    summary: 'Admin API · campaign import',
    note:
      'Keitaro is self-hosted, so this needs the address of your own instance. The key is an Admin API key from Maintenance → API keys — not your login password. Self-hosted and cloud instances behave identically.',
    fields: [
      {
        name: 'baseUrl',
        label: 'Your Keitaro address',
        hint: 'For example https://track.example.com — the address you open the admin on. HTTPS only.',
        secret: false
      },
      {
        name: 'apiKey',
        label: 'Admin API key',
        hint: 'Keitaro → Maintenance → API keys. Read access is enough.',
        secret: true
      }
    ]
  },
  {
    id: 'voluum',
    name: 'Voluum',
    kind: 'Tracker',
    brand: 'vl',
    icon: '#p-voluum',
    selfHosted: false,
    connectable: true,
    summary: 'Access key pair · campaign import',
    note:
      'Voluum authenticates with an access key pair rather than a single token. Create one under Settings → Security → Access keys; the secret is shown once, when it is created.',
    fields: [
      {
        name: 'accessId',
        label: 'Access key ID',
        hint: 'Voluum → Settings → Security → Access keys.',
        secret: false
      },
      {
        name: 'accessKey',
        label: 'Access key secret',
        hint: 'The half Voluum shows you only at the moment you create the pair.',
        secret: true
      }
    ]
  },
  {
    id: 'binom',
    name: 'Binom',
    kind: 'Tracker',
    brand: 'bn',
    icon: '#p-binom',
    selfHosted: true,
    connectable: true,
    summary: 'API key · campaign import',
    note:
      'Binom is self-hosted, so this needs your own address. Both generations work: the v2 public API is tried first and the older arm.php endpoint second, so you do not have to know which one your instance speaks.',
    fields: [
      {
        name: 'baseUrl',
        label: 'Your Binom address',
        hint: 'For example https://track.example.com — the address you open the panel on. HTTPS only.',
        secret: false
      },
      {
        name: 'apiKey',
        label: 'API key',
        hint: 'Binom → Settings → API. Read access is enough.',
        secret: true
      }
    ]
  },
  {
    id: 'redtrack',
    name: 'RedTrack',
    kind: 'Tracker',
    brand: 'rt',
    icon: '#p-redtrack',
    selfHosted: false,
    connectable: true,
    summary: 'API key · campaign import',
    note:
      'RedTrack is hosted, so there is no address to supply. The key is under Tools → API, and read access is enough.',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        hint: 'RedTrack → Tools → API.',
        secret: true
      }
    ]
  },
  {
    id: 'cloakinghouse',
    name: 'Cloaking House',
    kind: 'Cloaker',
    brand: 'ch',
    icon: '#p-cloakinghouse',
    selfHosted: false,
    connectable: false,
    summary: 'CNAME pre-filter · set up by hand',
    note:
      'Cloaking House publishes no API key we can hold, so there is nothing to paste here. It is wired up at the DNS level instead — email support and we will walk the CNAME through with you.',
    fields: []
  }
]

export function platformById(id: string): Platform | null {
  const wanted = String(id || '').trim().toLowerCase()
  return PLATFORMS.find((platform) => platform.id === wanted) || null
}

/* What the browser is allowed to know about the catalogue. Identical to the
   table above minus nothing, as it happens — there is no secret in a platform
   definition — but routed through a function so that stays a decision rather
   than an accident the next time a field is added. */
export function publicCatalogue() {
  return PLATFORMS.map((platform) => ({
    id: platform.id,
    name: platform.name,
    kind: platform.kind,
    brand: platform.brand,
    icon: platform.icon,
    selfHosted: platform.selfHosted,
    connectable: platform.connectable,
    summary: platform.summary,
    note: platform.note,
    fields: platform.fields.map((field) => ({
      name: field.name,
      label: field.label,
      hint: field.hint,
      secret: field.secret
    }))
  }))
}
