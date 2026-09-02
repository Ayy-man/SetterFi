import type { Metadata } from "next";

import { renderTiersPage } from "@/app/(workspace)/admin/tiers/render-tiers-page";

export const metadata: Metadata = { title: "Plans and pricing" };
export const dynamic = "force-dynamic";

export default async function AdminTiersPage() {
  return renderTiersPage();
}
