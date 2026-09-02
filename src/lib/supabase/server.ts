import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { assertSupabaseProjectAgreement } from "@/lib/env-contract";

/**
 * Request-scoped client for server components, server actions, and route
 * handlers. Sessions ride httpOnly cookies via @supabase/ssr; RLS applies —
 * this client is the user, not the platform.
 */
export async function createSupabaseServerClient() {
  // A key minted for another Supabase project fails as an invalid credential, which /login reports
  // as a wrong password. Fail here, where the two values are still visible, instead.
  assertSupabaseProjectAgreement();
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Server components cannot write cookies; the proxy refreshes
            // sessions there, so swallowing the write is safe by design.
          }
        },
      },
    },
  );
}

/**
 * Service-role client: bypasses RLS entirely. Server-only, per-call, never
 * cached in a module global (no session, no cookies). Every use site is a
 * privileged action and should write audit_log in the same breath.
 */
export function createSupabaseServiceClient() {
  assertSupabaseProjectAgreement();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
