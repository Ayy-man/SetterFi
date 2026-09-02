import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AdminSystemHealth } from "@/components/workspace/live/admin-system-health";
import { phase8Live } from "@/lib/env-contract";
import { loadSystemHealth } from "@/lib/operations/system-health";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

export default async function AdminSystemPage() {
  if (!phase8Live()) {
    return <AdminSystemHealth enabled={false} />;
  }
  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fsystem");
  if (session.impersonatingTenant || !["owner", "admin", "success"].includes(session.role)) forbidden();
  const health = await loadSystemHealth();
  return <AdminSystemHealth health={health} />;
}
