import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  console.warn(
    "[Noctis] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — running in offline mode (localStorage only)"
  );
}

export const supabase: SupabaseClient | null = url && key
  ? createClient(url, key)
  : null;
