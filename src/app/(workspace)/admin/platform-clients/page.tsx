import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { SuccessClientBook } from "@/components/workspace/live/success-client-book";
import { phase8SupportLive } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "Client book" };
export const dynamic = "force-dynamic";

export default async function PlatformClientsPage() {
  if (!phase8SupportLive()) {
    return <SuccessClientBook actorId="" actorRole="admin" enabled={false} />;
  }

  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fplatform-clients");
  if (session.impersonatingTenant
    || (session.role !== "owner" && session.role !== "admin" && session.role !== "success")) forbidden();

  return <SuccessClientBook actorId={session.userId} actorRole={session.role} enabled />;
}
