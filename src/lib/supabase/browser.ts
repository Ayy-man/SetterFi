"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Singleton browser client; cookie storage shared with the server clients. */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
