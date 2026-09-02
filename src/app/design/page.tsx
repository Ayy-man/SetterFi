import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AtomicsSheet } from "@/app/design/atomics-sheet";
import type { UserRole } from "@/lib/auth/claims";
import { authMode } from "@/lib/auth/mode";

export const metadata: Metadata = { title: "Atomics" };
export const dynamic = "force-dynamic";

/**
 * Who may read the atomics sheet, as a name rather than three literals inside an `if`.
 *
 * It is exported so the property can be tested rather than the spelling: a test that restated
 * these three names beside themselves would pass on any change made to both at once, which is the
 * change this constant exists to catch. What its sibling test asserts instead is that `build` is
 * present and `success` is absent -- see the gate note below for why that difference is the whole
 * point, and `admin/audit/page.tsx:56` for the same shape (`AUDIT_RANGES`) in a neighbouring page.
 */
export const DESIGN_SHEET_ROLES: readonly UserRole[] = ["owner", "admin", "build"];

/**
 * The atomics sheet, live.
 *
 * It exists so the design system has one place it can be audited rather than being inferred from
 * whichever screen happens to be open, which is why it renders every variant of every primitive
 * including the failure and waiting states rather than a happy-path subset. If a state is not on
 * this page, no admin screen should be inventing it.
 *
 * It is internal, and it uses the same *mechanism* as `/admin/audit` and `/admin/overview`:
 * `loadPlatformActor()`, redirect to login when there is no session, `forbidden()` for a role that
 * may not be here. That is the codebase's own mechanism and this route does not introduce a second
 * one -- a bespoke check here would be the thing that drifts when the real one is changed.
 *
 * **The role set is deliberately not theirs, and this paragraph exists so nobody "fixes" it into
 * agreement.** Those two admit `owner`, `admin` and `success` (`admin/audit/page.tsx:346`,
 * `admin/overview/page.tsx:42`); this admits `owner`, `admin` and `build`. Both sets are platform
 * staff, and the difference is the point: `success` owns a book of coaches and has no business on a
 * component sheet, while `build` is the engineering role this page is *for* -- `/design` is the only
 * route in the app that grants it, and `api/exports/[resource]/handler.ts:2513` denies `build` every
 * export, which is the same judgement drawn from the other side. Checked 2026-09-01. An earlier
 * version of this comment claimed the gating was identical to those two routes, which was never
 * true and would have led whoever believed it to either lock out the one role that needs this page
 * or let client-success staff into an internal one.
 *
 * Under the `open` and `password` auth modes there are no claims to read at all, so every admin
 * route in the product renders without a role check and this one does the same rather than
 * redirecting a local dev session to a login it cannot complete. `open` throws in production and
 * `password` puts the whole deployment behind one shared secret, so neither mode is a coach or an
 * affiliate reaching an internal page; under `supabase`, which is what ships, the role check is
 * the real gate.
 */
export default async function DesignPage() {
  if (authMode() === "supabase") {
    const { loadPlatformActor } = await import("@/lib/auth/actors");
    const actor = await loadPlatformActor();
    if (!actor) redirect("/login?next=%2Fdesign");
    if (!DESIGN_SHEET_ROLES.includes(actor.role)) forbidden();
  }

  return <AtomicsSheet />;
}
