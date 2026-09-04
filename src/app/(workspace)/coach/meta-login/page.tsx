import type { Metadata } from "next";

import { DemoMetaLogin } from "@/components/workspace/rehaul/demo-meta-login";
import { RETURN_QUERY } from "@/components/workspace/rehaul/connect-channel-flow";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/**
 * The sign-in window's landing page. No shell, no navigation: it is the inside of a 640px
 * pop-up, and the only things it ever says are "you can close this" and, on the demo tenant,
 * the rehearsal of Facebook's permission dialog. See `demo-meta-login.tsx`.
 */
export default async function CoachMetaLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? null : value ?? null);
  return (
    <DemoMetaLogin
      channel={one(params.channel)}
      finished={one(params[RETURN_QUERY.key]) === RETURN_QUERY.chooseValue}
      state={one(params.state)}
    />
  );
}
