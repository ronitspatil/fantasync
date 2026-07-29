import { safeEqual } from "@/lib/admin-auth"

// Shared bearer-token check for the /api/cron/* routes.
//
// These endpoints are the other way into the pipeline — they run ingests and republish the board
// with no cookie involved — so the token is the only thing guarding them. It was previously
// compared with `!==` on a string, which short-circuits at the first differing byte. Over a
// network that's a hard signal to exploit, but it costs one line to remove, and it's the kind of
// thing that stops being theoretical the moment something sits closer to the process.
export function checkCronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  const auth = req.headers.get("authorization")
  if (!auth || !safeEqual(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  return null
}
