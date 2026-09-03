import { redirect } from "next/navigation";

/**
 * Folded into the Inbox. Client requests is a lane of `/admin/alerts` now, so this route exists
 * only to carry a saved link or a bookmark to the queue it was saved for.
 */
export default async function AdminSupportPage(): Promise<never> {
  redirect("/admin/alerts");
}
