import { createClient, SupabaseClient } from "@supabase/supabase-js";

// The anon key is intentionally embedded — it is designed to be public.
// Security is enforced by Supabase Row Level Security policies, not by
// keeping the anon key secret.  Without this fallback the app runs in
// localStorage-only mode when the .env file is absent (e.g. Netlify CI).
const url =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  "https://brgxtdnpgeqyafhmemgp.supabase.co";
const key =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJyZ3h0ZG5wZ2VxeWFmaG1lbWdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjU5NzcsImV4cCI6MjA5NDg0MTk3N30.tcHP9i0uuJNon3ja2TMcDt7tS5oOXR5D3Opc4wnZW2s";

export const supabase: SupabaseClient = createClient(url, key);
