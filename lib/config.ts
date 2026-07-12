// App-wide config stored in the `app_config` table (public-readable, admin-writable). Currently
// just the season-live override, but the key/value shape leaves room for more toggles later.
import { supabaseRead } from "@/lib/supabase/read"
import { supabaseAdmin } from "@/lib/supabase/admin"

// "auto"     → use the automatic isSeasonLive(league) detection (default, current behavior)
// "live"     → force the whole app into live-season mode
// "preseason"→ force preseason/draft-prep mode
export type SeasonLiveSetting = "auto" | "live" | "preseason"

const SEASON_LIVE_KEY = "season_is_live"
const VALID: SeasonLiveSetting[] = ["auto", "live", "preseason"]

export function isSeasonLiveSetting(v: unknown): v is SeasonLiveSetting {
  return typeof v === "string" && (VALID as string[]).includes(v)
}

// Read the season-live override with the anon (RLS-safe) client. Falls back to "auto" on any error
// so a config hiccup never accidentally forces a mode change.
export async function getSeasonLiveSetting(): Promise<SeasonLiveSetting> {
  try {
    const { data, error } = await supabaseRead()
      .from("app_config")
      .select("value")
      .eq("key", SEASON_LIVE_KEY)
      .maybeSingle()
    if (error) return "auto"
    const v = data?.value
    return isSeasonLiveSetting(v) ? v : "auto"
  } catch {
    return "auto"
  }
}

// Persist the season-live override (admin/service-role only).
export async function setSeasonLiveSetting(value: SeasonLiveSetting): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("app_config")
    .upsert({ key: SEASON_LIVE_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" })
  if (error) throw new Error(error.message)
}
