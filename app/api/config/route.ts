// Public app config read. Every deployed client fetches this so an admin's season-live override
// applies to all users (not just the admin's browser). Anon/RLS-safe read.
export const fetchCache = "force-no-store"

import { getSeasonLiveSetting } from "@/lib/config"

export async function GET() {
  const seasonIsLive = await getSeasonLiveSetting()
  return Response.json({ season_is_live: seasonIsLive })
}
