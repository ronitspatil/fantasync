// Admin session check: does the caller carry a valid admin cookie? (Phase 3d)
export const fetchCache = "force-no-store"

import { isAdminRequest } from "@/lib/admin-auth"

export async function GET(req: Request) {
  return Response.json({ authed: isAdminRequest(req), configured: Boolean(process.env.ADMIN_PASSWORD) })
}
