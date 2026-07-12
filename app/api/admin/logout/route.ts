// Admin logout: clear the admin cookie (Phase 3d).
export const fetchCache = "force-no-store"

import { ADMIN_COOKIE } from "@/lib/admin-auth"

export async function POST() {
  const cookie = `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  })
}
