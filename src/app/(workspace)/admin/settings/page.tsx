import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Notifications" };

export default function AdminSettingsPage() {
  redirect("/admin/alerts");
}
