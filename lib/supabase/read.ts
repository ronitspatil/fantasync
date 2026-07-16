import { createClient } from "@supabase/supabase-js"

// Read-only Supabase client for server routes that serve precomputed engine output.
// Uses the anon/publishable key (RLS-safe); never writes.
export function supabaseRead() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error("Supabase read client missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }
  return createClient(url, key, { auth: { persistSession: false } })
}
