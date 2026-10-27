/* ==========================================================================
   Talking to a customer's own tracker.

   Two of the four connectable platforms are self-hosted, which means the
   address a request goes to is typed in by whoever is sitting at the
   workspace. A Netlify Function that fetches a user-supplied host is a
   server-side request forgery vector by construction: left unguarded,
   http://169.254.169.254/… or an address inside the platform's own network
   becomes a request made with this function's credentials and reachability
   rather than the customer's. Everything in the first half of this file
   exists for that one reason.

   Three controls, because no single one of them is sufficient:

     1. HTTPS only, and only to a host that resolves entirely to public
        addresses. Checked against every address the resolver returns, not
        just the first — a hostname with one public and one loopback record
        is a standard way around a naive check.
     2. Redirects are never followed. A permitted host answering 302 to a
        forbidden one would otherwise walk straight through control 1.
     3. Nothing the remote end returns is relayed to the caller. The verifier
        answers with a campaign count and a status and never a response body,
        so even a request that slips past 1 and 2 is blind — it cannot be used
        to read anything back out.

   Control 1 has a known residual gap and it is worth naming rather than
   implying otherwise: the address is resolved here and resolved again by the
   fetch, so a name that changes its answer between the two is not caught.
   Closing that properly means connecting to a pinned address with the Host
   header set by hand, which this runtime's fetch does not expose. Control 3
   is what makes the remaining gap tolerable.
   ========================================================================== */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Platform } from './platforms.mjs'

/* A failure a customer should read. `code` is for the browser to branch on,
   `message` is what the panel prints — so it has to say what to do next and
   must never carry anything the remote end sent back. */
export class PlatformError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'PlatformError'
    this.code = code
  }
}

/* A tracker is somebody's own box, sometimes a slow one, and this call sits in
   front of a customer waiting on a form. Long enough for a cold self-hosted
   instance, short enough that the function does not spend its whole budget
   on a host that is not answering. */
const VERIFY_TIMEOUT_MS = 8000

/* No campaign list is this large. The cap is here so a host that answers a
   GET with a hundred megabytes cannot exhaust the function instead. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/* ---------- Address checks ------------------------------------------------ */

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

/* Expands ::, and the ::ffff:1.2.3.4 form the resolver uses for a v4 address
   reached over a v6 socket — which has to be unpacked rather than treated as
   an opaque v6 address, because ::ffff:127.0.0.1 is loopback.

   The trailing dotted quad is pulled off first and carried as `tail`, so it
   occupies the final four bytes directly. Rewriting it as two hex groups
   instead would be double counting: the groups and the tail would both claim
   those four bytes, and the ffff marker would land four bytes to the left of
   where it belongs — which reads as an ordinary global unicast address rather
   than as the loopback it is. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0]

  const embedded = text.lastIndexOf(':')
  if (embedded === -1) return null

  let tail: number[] = []
  const last = text.slice(embedded + 1)
  if (last.indexOf('.') !== -1) {
    const v4 = ipv4Bytes(last)
    if (!v4) return null
    tail = v4
    text = text.slice(0, embedded)
    /* '::1.2.3.4' leaves a single colon behind, which is the compression
       marker rather than a separator. */
    if (text === ':') text = '::'
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const read = (chunk: string) => {
    if (!chunk) return [] as number[]
    const out: number[] = []
    for (const group of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      const value = parseInt(group, 16)
      out.push(value >> 8, value & 0xff)
    }
    return out
  }

  const head = read(halves[0])
  const rest = read(halves.length === 2 ? halves[1] : '')
  if (head === null || rest === null) return null

  const fill = 16 - tail.length - head.length - rest.length
  if (halves.length === 1 && fill !== 0) return null
  if (fill < 0) return null

  return head.concat(new Array(fill).fill(0), rest, tail)
}

function inRange(bytes: number[], prefix: number[], bits: number) {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3
    const mask = 0x80 >> (i & 7)
    if ((bytes[byte] & mask) !== (prefix[byte] & mask)) return false
  }
  return true
}

/* Everything that is not a public unicast address on the open internet.
   Loopback, the link-local block the cloud metadata endpoints live in, the
   three RFC1918 ranges, carrier-grade NAT, multicast, and the reserved and
   documentation blocks. */
const V4_BLOCKED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4]
]

function v6Prefix(groups: number[]) {
  const bytes = new Array(16).fill(0)
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8
    bytes[index * 2 + 1] = group & 0xff
  })
  return bytes
}

const V6_BLOCKED: Array<[number[], number]> = [
  [v6Prefix([0, 0, 0, 0, 0, 0, 0, 0]), 128], /* unspecified */
  [v6Prefix([0, 0, 0, 0, 0, 0, 0, 1]), 128], /* loopback */
  [v6Prefix([0x0100]), 64], /* discard */
  [v6Prefix([0x64, 0xff9b]), 96], /* v4 translated */
  [v6Prefix([0xfc00]), 7], /* unique local */
  [v6Prefix([0xfe80]), 10], /* link local */
  [v6Prefix([0xff00]), 8], /* multicast */
  [v6Prefix([0x2001, 0x0db8]), 32] /* documentation */
]

export function isPublicAddress(address: string) {
  const family = isIP(address)

  if (family === 4) {
    const bytes = ipv4Bytes(address)
    if (!bytes) return false
    return !V4_BLOCKED.some(([prefix, bits]) => inRange(bytes, prefix, bits))
  }

  if (family === 6) {
    const bytes = ipv6Bytes(address)
    if (!bytes) return false

    /* A v4 address carried inside a v6 one is a v4 address; judge it as one,
       or ::ffff:169.254.169.254 is read as an ordinary global unicast. Both
       embeddings are unpacked: the ::ffff:0:0/96 form a dual-stack resolver
       returns, and the deprecated ::/96 form, which is still parsed by the
       platform's own networking stack and so is still a way to reach
       127.0.0.1. Unpacking ::/96 also subsumes :: and ::1, which decode to
       0.0.0.0 and 0.0.0.1 and are refused as v4 addresses. */
    const mapped = inRange(bytes, v6Prefix([0, 0, 0, 0, 0, 0xffff]), 96)
    const compatible = inRange(bytes, v6Prefix([0, 0, 0, 0, 0, 0]), 96)
    if (mapped || compatible) {
      return isPublicAddress(bytes.slice(12).join('.'))
    }

    return !V6_BLOCKED.some(([prefix, bits]) => inRange(bytes, prefix, bits))
  }

  return false
}

/* Hostnames that never belong to a customer's tracker, rejected before the
   resolver is asked. Not a security control on its own — the address check
   below is — but it turns the common typo into a sentence somebody can act on
   rather than a DNS failure. */
const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i

/* Takes what the customer typed and returns the origin to store, or throws.
   The path, query and fragment are dropped deliberately: the endpoints are
   this file's business, and a stored base_url carrying a query string is a
   stored URL somebody can shape. */
export async function safeOrigin(raw: string): Promise<string> {
  const text = String(raw || '').trim()
  if (!text) {
    throw new PlatformError('Enter the address of your instance.', 'base_url_required')
  }

  let url: URL
  try {
    url = new URL(text.indexOf('://') === -1 ? `https://${text}` : text)
  } catch {
    throw new PlatformError(
      'That does not look like a web address. It should read like https://track.example.com',
      'base_url_invalid'
    )
  }

  if (url.protocol !== 'https:') {
    throw new PlatformError(
      'The address has to be https. An API key sent over plain http is readable in transit.',
      'base_url_insecure'
    )
  }

  const host = url.hostname
  if (!host || BLOCKED_HOSTS.test(host)) {
    throw new PlatformError(
      'That address is not reachable from the internet, so we cannot connect to it from here.',
      'base_url_private'
    )
  }

  /* An address typed as a literal is checked directly; a name is checked
     against every record the resolver hands back. */
  if (isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new PlatformError(
        'That address is on a private network, so we cannot reach it from here.',
        'base_url_private'
      )
    }
  } else {
    let records: Array<{ address: string }>
    try {
      records = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw new PlatformError(
        `We could not look up ${host}. Check the address and try again.`,
        'base_url_unresolved'
      )
    }

    if (!records.length || !records.every((record) => isPublicAddress(record.address))) {
      throw new PlatformError(
        'That address resolves to a private network, so we cannot reach it from here.',
        'base_url_private'
      )
    }
  }

  return url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`
}

/* ---------- The guarded request ------------------------------------------- */

interface RemoteResponse {
  status: number
  body: unknown
}

/* Every outbound call in this file goes through here. `redirect: 'manual'` is
   the load-bearing option: without it a host that passed the address check
   can hand the request to one that would not have. */
async function call(url: string, init: RequestInit): Promise<RemoteResponse> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    })
  } catch (error) {
    const name = (error as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PlatformError(
        'Your instance did not answer in time. Check it is reachable and try again.',
        'timeout'
      )
    }
    throw new PlatformError(
      'We could not reach your instance. Check the address and try again.',
      'unreachable'
    )
  }

  if (res.status >= 300 && res.status < 400) {
    throw new PlatformError(
      'Your instance redirected the request. Use the address the API answers on directly.',
      'redirected'
    )
  }

  const length = Number(res.headers.get('content-length') || 0)
  if (length > MAX_BODY_BYTES) {
    throw new PlatformError('Your instance returned more data than we can read.', 'too_large')
  }

  const text = await res.text()
  if (text.length > MAX_BODY_BYTES) {
    throw new PlatformError('Your instance returned more data than we can read.', 'too_large')
  }

  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* Left null. A tracker answering HTML to an API path is almost always the
       wrong address rather than a broken tracker, and the verifier below says
       so — but the body itself is never handed back, so a login page cannot
       be read through this. */
  }

  return { status: res.status, body }
}

/* How many campaigns the answer describes. Every one of these APIs wraps its
   list differently and more than one has changed the wrapper between
   versions, so this looks for the list rather than asserting where it is. */
function countOf(body: unknown): number | null {
  if (Array.isArray(body)) return body.length

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>

    for (const key of ['campaigns', 'items', 'data', 'rows', 'result', 'list']) {
      const value = record[key]
      if (Array.isArray(value)) return value.length
      /* Some wrap twice: { data: { campaigns: [...] } } */
      if (value && typeof value === 'object') {
        const inner = countOf(value)
        if (inner !== null) return inner
      }
    }

    for (const key of ['total', 'totalRows', 'count']) {
      const value = record[key]
      if (typeof value === 'number' && isFinite(value)) return value
    }
  }

  return null
}

/* An HTTP status, in words a customer can act on. Deliberately does not
   include anything the remote end said — a tracker's own error text is
   attacker-influenced for the self-hosted platforms. */
function statusError(status: number, name: string): PlatformError {
  if (status === 401 || status === 403) {
    return new PlatformError(
      `${name} rejected that key. Check it is an API key with read access and has not been revoked.`,
      'rejected'
    )
  }
  if (status === 404) {
    return new PlatformError(
      `${name} has no API at that address. Check the address points at your instance.`,
      'not_found'
    )
  }
  if (status === 429) {
    return new PlatformError(`${name} is rate limiting us. Try again in a minute.`, 'rate_limited')
  }
  return new PlatformError(
    `${name} answered with an error (${status}). Try again, or check the instance.`,
    'upstream_error'
  )
}

/* ---------- The verifiers -------------------------------------------------- */

export interface VerifyResult {
  campaigns: number | null
}

export interface Credential {
  apiKey?: string
  accessId?: string
  accessKey?: string
}

async function verifyKeitaro(baseUrl: string, cred: Credential): Promise<VerifyResult> {
  const res = await call(`${baseUrl}/admin_api/v1/campaigns`, {
    headers: { 'Api-Key': String(cred.apiKey || ''), Accept: 'application/json' }
  })

  if (res.status !== 200) throw statusError(res.status, 'Keitaro')

  const count = countOf(res.body)
  if (count === null) {
    throw new PlatformError(
      'That address answered, but not with a Keitaro campaign list. Check it is the address you open the admin on.',
      'unexpected_shape'
    )
  }

  return { campaigns: count }
}

async function verifyVoluum(cred: Credential): Promise<VerifyResult> {
  const session = await call('https://api.voluum.com/auth/access/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      accessId: String(cred.accessId || ''),
      accessKey: String(cred.accessKey || '')
    })
  })

  if (session.status !== 200) throw statusError(session.status, 'Voluum')

  const token = (session.body as Record<string, unknown> | null)?.token
  if (!token || typeof token !== 'string') {
    throw new PlatformError(
      'Voluum accepted the request but returned no session. Check the access key pair.',
      'rejected'
    )
  }

  /* The session token is short-lived and is never stored — the key pair is
     the credential, and a token is minted per pass. */
  const campaigns = await call('https://api.voluum.com/campaign', {
    headers: { 'cwauth-token': token, Accept: 'application/json' }
  })

  if (campaigns.status !== 200) throw statusError(campaigns.status, 'Voluum')

  return { campaigns: countOf(campaigns.body) }
}

async function verifyBinom(baseUrl: string, cred: Credential): Promise<VerifyResult> {
  const key = String(cred.apiKey || '')

  /* Binom v2 first. An instance on the older generation answers 404 here,
     which is why the fallback is keyed on the status rather than on asking
     the customer which generation they run. */
  const modern = await call(`${baseUrl}/public/api/v1/campaign`, {
    headers: { 'Api-Key': key, Accept: 'application/json' }
  })

  if (modern.status === 200) {
    const count = countOf(modern.body)
    if (count !== null) return { campaigns: count }
  }

  if (modern.status === 401 || modern.status === 403) throw statusError(modern.status, 'Binom')

  const legacy = await call(
    `${baseUrl}/arm.php?page=campaigns&api_key=${encodeURIComponent(key)}`,
    { headers: { Accept: 'application/json' } }
  )

  if (legacy.status !== 200) throw statusError(legacy.status, 'Binom')

  const count = countOf(legacy.body)
  if (count === null) {
    throw new PlatformError(
      'That address answered, but not with a Binom campaign list. Check it is the address you open the panel on.',
      'unexpected_shape'
    )
  }

  return { campaigns: count }
}

async function verifyRedTrack(cred: Credential): Promise<VerifyResult> {
  const res = await call(
    `https://api.redtrack.io/campaigns?api_key=${encodeURIComponent(String(cred.apiKey || ''))}`,
    { headers: { Accept: 'application/json' } }
  )

  if (res.status !== 200) throw statusError(res.status, 'RedTrack')

  return { campaigns: countOf(res.body) }
}

/* The one entry point. Throws PlatformError for anything a customer can fix,
   which is every failure this function knows how to produce. */
export async function verifyCredential(
  platform: Platform,
  credential: Credential,
  baseUrl: string | null
): Promise<VerifyResult> {
  if (!platform.connectable) {
    throw new PlatformError(`${platform.name} is set up by hand, not with a key.`, 'not_connectable')
  }

  if (platform.selfHosted && !baseUrl) {
    throw new PlatformError('Enter the address of your instance.', 'base_url_required')
  }

  switch (platform.id) {
    case 'keitaro':
      return verifyKeitaro(baseUrl as string, credential)
    case 'voluum':
      return verifyVoluum(credential)
    case 'binom':
      return verifyBinom(baseUrl as string, credential)
    case 'redtrack':
      return verifyRedTrack(credential)
    default:
      throw new PlatformError('That platform cannot be connected yet.', 'not_connectable')
  }
}
