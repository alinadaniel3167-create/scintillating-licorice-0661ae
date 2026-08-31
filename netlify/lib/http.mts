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
