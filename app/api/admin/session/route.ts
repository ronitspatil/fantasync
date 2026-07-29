// Admin session check: does the caller carry a valid, unexpired session?
export const fetchCache = "force-no-store"

import { isAdminRequest, passwordIsWeak, MIN_PASSWORD_LENGTH } from "@/lib/admin-auth"

export async function GET(req: Request) {
  const authed = isAdminRequest(req)
  return Response.json({
    authed,
    configured: Boolean(process.env.ADMIN_PASSWORD),
    // Only disclosed to an authenticated caller. Telling an anonymous visitor that the password
    // guarding this page is short would be handing an attacker the one hint worth having.
    weakPassword: authed ? passwordIsWeak() : false,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  })
}
