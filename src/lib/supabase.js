import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Missing Supabase env vars. Copy .env.example to .env and fill them in.')
}
if (anonKey.startsWith('sb_publishable_')) {
  throw new Error('Use the legacy JWT anon key (eyJ… format), not the sb_publishable_ key.')
}

// persistSession + autoRefreshToken keep the user signed in across visits —
// the session survives as long as the refresh token is valid. Refresh token
// lifetime (default: no forced expiry) is configured in Supabase dashboard →
// Authentication → Sessions → "Time-box user sessions" — set that to 30 days
// (or leave unlimited) to match the "no re-authentication for 30 days" brief;
// it can't be set from client code.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
export default supabase
