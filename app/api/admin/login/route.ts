// Admin login: verify ADMIN_PASSWORD and set the httpOnly admin cookie (Phase 3d).
export const fetchCache = "force-no-store"

import { ADMIN_COOKIE, adminCookieValue, passwordMatches } from "@/lib/admin-auth"

export async function POST(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: "ADMIN_PASSWORD not configured" }, { status: 500 })
  }
  let password = ""
  try {
    const body = (await req.json()) as { password?: string }
    password = body.password ?? ""
  } catch {
    return Response.json({ ok: false, error: "invalid body" }, { status: 400 })
  }

  if (!passwordMatches(password)) {
    return Response.json({ ok: false, error: "incorrect password" }, { status: 401 })
  }

  const token = adminCookieValue()!
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  // httpOnly so client JS can't read it; SameSite=Lax; 30-day expiry.
  const cookie = `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  })
}
