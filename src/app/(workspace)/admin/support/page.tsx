import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AdminSupport } from "@/components/workspace/live/admin-support";
import { phase8SupportLive } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

/*
 * The nav label, the crumb and the page's own heading all say "Client requests"; this said
 * "Support", so the browser tab and the history entry named a surface that appears nowhere in the
 * product. It is one destination, so it gets one name -- see `SUPPORT_NAV_LABEL` in the test
 * beside this file, which reads the label out of the navigation rather than retyping it.
 */
export const metadata: Metadata = { title: "Client requests" };
export const dynamic = "force-dynamic";

export default async function AdminSupportPage() {
  if (!phase8SupportLive()) return <AdminSupport actorId="" actorRole="admin" enabled={false} />;

  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fsupport");
  if (session.impersonatingTenant
    || (session.role !== "owner" && session.role !== "admin" && session.role !== "success")) forbidden();

  return <AdminSupport actorId={session.userId} actorRole={session.role} enabled />;
}
