import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Missing Supabase env vars. Copy .env.example to .env and fill them in.')
}
if (anonKey.startsWith('sb_publishable_')) {
  throw new Error('Use the legacy JWT anon key (eyJ… format), not the sb_publishable_ key.')
}

export const supabase = createClient(url, anonKey)
export default supabase
