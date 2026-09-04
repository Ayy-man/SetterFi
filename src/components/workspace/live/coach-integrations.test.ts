import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { calendarAvailabilityErrorCopy } from "@/lib/copy/errors";
import { COACH_INTEGRATION_LABELS } from "@/lib/integrations/coach-integration-labels";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Coach Integrations live reachability", () => {
  /*
   * `/coach/integrations` renders Setup now.
   *
   * `docs/SIMPLIFICATION-SPEC.md` 2.6 killed Connections as a destination and folded the four
   * channel rows into `rehaul/coach-setup.tsx`; the route stays because `META_CONNECT_RETURN_PATH`
   * sends every Meta sign-in back to it and `workspace-navigation.test.ts` pins that both demoted
   * coach destinations remain reachable. So the three assertions below moved with the page rather
   * than being deleted: what they were protecting is that this route is a real, dynamic,
   * claims-bound page reading on the server, and every one of those is still true and still
   * checkable. What went with the old surface -- the message templates, the stored calendar error,
   * the install card -- is asserted absent instead, because the spec sent all three to admin and
   * a guard that only stopped watching would let them drift back.
   */
  it("uses a dedicated dynamic claims-bound page reading on the server", () => {
    const page = source("src/app/(workspace)/coach/integrations/page.tsx");
    const read = source("src/components/workspace/rehaul/coach-setup-read.ts");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain('coachSetupContext("/coach/integrations")');
    expect(page).toContain("loadCoachSetup(context.tenantId");
    expect(page).toContain("<CoachSetup");
    expect(page).not.toContain("FixtureWorkspaceShell");
    expect(read).toContain("parseAppClaims");
    expect(read).toContain("canAccessWorkspace");
    expect(read).toContain("listChannelConnections(tenantId)");
  });

  it("carries none of the diagnostics the spec moved to admin", () => {
    const page = source("src/app/(workspace)/coach/integrations/page.tsx");
    for (const gone of [
      "listMessageTemplates",
      "listCapiDatasets",
      "listGhlInstallLocationsForTenant",
      "last_error",
      "channelActivity",
    ]) {
      expect(page, gone).not.toContain(gone);
    }
  });

  it("keeps Integrations out of the fixture catch-all and uses only the four approved labels", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/(workspace)/[role]/[[...screen]]/page.tsx"))).toBe(false);
    expect(COACH_INTEGRATION_LABELS).toEqual([
      { channel: "instagram", label: "Instagram" },
      { channel: "messenger", label: "Facebook Messenger" },
      { channel: "whatsapp", label: "WhatsApp" },
      { channel: "sms", label: "Text messages (SMS)" },
    ]);
    expect(JSON.stringify(COACH_INTEGRATION_LABELS))
      .not.toMatch(/GoHighLevel|GHL|Twilio|usually|up to|\d+[–-]\d+\s+(day|week)/i);
  });

  /*
   * Two `it` blocks read `coach-integrations.tsx` here until 2026-09-04 and are gone with it.
   *
   * They asserted `deriveChannelTruths`, the demo marker derived from `templateIsDemo`, the
   * prerequisite list, the "2 to 3 weeks" phrase, the messaging-install card and the conversion
   * control. Every one of those is machinery spec 2.6 sent to admin, so there is no coach file
   * left to repoint them at: retargeting them at Setup would mean asserting a surface carries
   * something it was rebuilt to drop, which is a guard that has stopped describing the product.
   *
   * Neither claim goes unwatched. The brand ban they ended on is now `ghl-branding-wall.test.ts`,
   * which walks the import graph out of every client route rather than naming one file, and was
   * written precisely so a surface added in a redesign is covered the day it is written. The demo
   * marker is `coach-setup.test.tsx`'s "names the account on a connected row", which reads the
   * rendered row and asserts the seeder's marker is off it.
   */

  /**
   * `calendar_connections.last_error` holds `AVAILABILITY_NOT_VERIFIED:<reason>` on the arm where
   * the authorization was recorded and the availability read was not. Two things have to be true
   * of what a coach reads. The reason code never appears: it is one of several the verification
   * path can produce and none of them is a sentence. And the copy does not come from the generic
   * fallback in `humanError`, which says nothing changed -- something did change, the connection
   * is stored, only the read did not verify.
   */
  it("turns every stored availability failure into the same plain sentence, reason code included", () => {
    const reasons = ["CALENDAR_ERRORS", "CALENDAR_NOT_RETURNED", "BUSY_NOT_RETURNED", "GOOGLE_FREEBUSY_FAILED"];
    for (const reason of reasons) {
      const copy = calendarAvailabilityErrorCopy(`AVAILABILITY_NOT_VERIFIED:${reason}`);
      expect(copy).toBeTruthy();
      expect(copy).not.toContain(reason);
      expect(copy).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
      expect(copy).not.toMatch(/nothing changed/i);
    }
    // A bare code with no reason attached is the same answer.
    expect(calendarAvailabilityErrorCopy("AVAILABILITY_NOT_VERIFIED")).toBeTruthy();
    // Anything else belongs to the shared error copy, so this must not swallow it.
    expect(calendarAvailabilityErrorCopy("OFFER_READ_FAILED")).toBeNull();
    expect(calendarAvailabilityErrorCopy("AVAILABILITY_VERIFIED")).toBeNull();
  });

  /*
   * The two assertions that used to sit here read the old page for a stored calendar error and a
   * messaging-install card, and Setup renders neither: spec 2.6 sends last error to admin, and the
   * install card was never a coach control -- the install route refuses a coach's role. What
   * survives of both is the rule that made them worth guarding, which is that a read failing must
   * not collapse into a claim. `coach-setup-read.ts` is where that now lives.
   */
  it("never lets a failed read collapse into a claim about the connection", () => {
    const read = source("src/components/workspace/rehaul/coach-setup-read.ts");
    // Three reads, three unchecked arms: channels, the A2P filing, the calendar.
    expect(read).toContain("checked: false");
    expect(read).not.toContain("listGhlInstallsByTenant");
    // `loadCoachA2pRegistration` answers null for a tenant with no filing, so a bare catch-to-null
    // around it would spend that same null on a query that threw.
    expect(read).not.toMatch(/loadCoachA2pRegistration\(tenantId\)\.catch/u);
  });
});
