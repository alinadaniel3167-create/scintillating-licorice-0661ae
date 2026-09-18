/* ==========================================================================
   Shared response helpers. Same shape the register and confirm functions
   already use, so every endpoint on this site answers the same way:

     { ok: true,  … }
     { ok: false, error: string, code?: string }
   ========================================================================== */

export function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}

export function fail(error: string, status: number, code?: string) {
  return json(code ? { ok: false, error, code } : { ok: false, error }, status)
}

/* Both endpoints that take a body accept JSON or urlencoded, matching
   register.mts, so a form still works without JavaScript. */
export async function readBody(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') || ''

  if (type.includes('application/json')) {
    const body = (await req.json()) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const key of Object.keys(body || {})) out[key] = String(body[key] ?? '')
    return out
  }

  const form = await req.formData()
  const out: Record<string, string> = {}
  form.forEach((value, key) => {
    out[key] = String(value ?? '')
  })
  return out
}

/* ==========================================================================
   Where a request came from, in words.

   Used only by the security emails — the sign-in notice and the password
   change notice. "Chrome on macOS, London, United Kingdom" is what makes one
   of those messages actionable: the recipient can tell their own session from
   somebody else's without knowing what a user agent string is.

   Everything here is optional and best-effort. Netlify populates
   context.ip and context.geo, but a local `netlify dev` run and a preview
   deploy may not, so every field can come back null and the email simply
   leaves that row out rather than printing "unknown".
   ========================================================================== */

export interface RequestSignals {
  ip: string | null
  location: string | null
  device: string | null
}

/* A handful of families rather than a user-agent library. The point is for
   the reader to recognise their own browser, not for the string to be
   forensically exact — and a dependency that has to be kept current to keep
   being accurate is the wrong trade for one line of one email. */
function describeAgent(agent: string): string | null {
  if (!agent) return null

  const browser =
    /\bEdg\//.test(agent) ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(agent) ? 'Opera'
    : /\bChrome\//.test(agent) && !/\bChromium\//.test(agent) ? 'Chrome'
    : /\bChromium\//.test(agent) ? 'Chromium'
    : /\bFirefox\//.test(agent) ? 'Firefox'
    : /\bSafari\//.test(agent) && /\bVersion\//.test(agent) ? 'Safari'
    : null

  const os =
    /\bWindows NT\b/.test(agent) ? 'Windows'
    : /\bAndroid\b/.test(agent) ? 'Android'
    : /\b(iPhone|iPad|iPod)\b/.test(agent) ? 'iOS'
    : /\bMac OS X\b/.test(agent) ? 'macOS'
    : /\bCrOS\b/.test(agent) ? 'ChromeOS'
    : /\bLinux\b/.test(agent) ? 'Linux'
    : null

  if (browser && os) return `${browser} on ${os}`
  return browser || os || null
}

/* The Context type is declared by @netlify/functions, which is supplied by
   the runtime rather than installed here, so this reads the two fields it
   wants off a loose shape instead of importing the interface into lib/. */
interface GeoLike {
  city?: string | null
  subdivision?: { name?: string | null } | null
  country?: { name?: string | null; code?: string | null } | null
}

export function requestSignals(
  req: Request,
  context?: { ip?: string | null; geo?: GeoLike | null }
): RequestSignals {
  const geo = context?.geo || null

  const place = [geo?.city, geo?.country?.name || geo?.country?.code]
    .map((part) => (part ? String(part).trim() : ''))
    .filter(Boolean)

  return {
    ip: context?.ip ? String(context.ip) : null,
    location: place.length ? place.join(', ') : null,
    device: describeAgent(req.headers.get('user-agent') || '')
  }
}
