// Admin logout: clear the session cookie.
export const fetchCache = "force-no-store"

import { clearedSessionCookie } from "@/lib/admin-auth"

// No auth check and no origin check on purpose. Logging someone out is not a harmful action, and
// refusing an unauthenticated logout would only make it harder to clear a session that's already
// in a bad state.
export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearedSessionCookie() },
  })
}
