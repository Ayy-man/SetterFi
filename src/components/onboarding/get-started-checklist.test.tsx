import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView } from "@/app/api/onboarding/artifacts/handler";
import { GetStartedChecklist } from "@/components/onboarding/get-started-checklist";
import { READINESS_KEYS, type ReadinessResult } from "@/lib/onboarding/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const RECEIPT_AT = "2026-08-14T15:12:41.000Z";

const artifact: ArtifactView = {
  artifactId: "artifact-1",
  version: 2,
  templateVersion: "consent-v2",
  controls: [
    {
      key: "marketing" as const,
      checked: false as const,
      required: false as const,
      renderedLanguage: "I agree to receive marketing texts.",
      renderedLanguageHash: "marketing-hash",
    },
    {
      key: "non_marketing" as const,
      checked: false as const,
      required: false as const,
      renderedLanguage: "I agree to receive appointment texts.",
      renderedLanguageHash: "service-hash",
    },
  ] as const,
  termsUrl: "/terms",
  privacyUrl: "/privacy",
  campaignDescriptionHash: "campaign-hash",
  placeholder: false,
  confirmedAt: RECEIPT_AT,
};

const contentScreen = {
  screenId: "screen-1",
  inputHash: "input-hash",
  state: "confirmed" as const,
  matches: [],
  coachAcknowledgedAt: RECEIPT_AT,
  adminConfirmedAt: RECEIPT_AT,
};

const TEST_RECEIPT_AT = "2026-08-20T09:03:00.000Z";

function readiness(messagingReady = false, testReady = false): ReadinessResult {
  const readyKeys = new Set<string>(["tenant_active"]);
  if (messagingReady) readyKeys.add("messaging_channel_live");
  if (testReady) readyKeys.add("test_passed");
  return {
    ready: messagingReady,
    checks: READINESS_KEYS.map((key) => ({
      key,
      ready: readyKeys.has(key),
      code: key === "test_passed" && !testReady ? "test_pass_required" : "waiting",
      evidenceAt: readyKeys.has(key) ? (key === "test_passed" ? TEST_RECEIPT_AT : RECEIPT_AT) : null,
      blamingParty: "provider" as const,
    })),
  };
}

const registration = {
  submittedAt: RECEIPT_AT,
  registrationState: "awaiting_provider" as const,
  terminalRejection: false,
  terminalCode: null,
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function successfulGet(input: string, artifactValue = artifact) {
  if (input.endsWith("/artifacts")) return json({ artifact: artifactValue });
  if (input.endsWith("/content-screen")) return json({ screen: contentScreen });
  if (input.endsWith("/readiness")) return json({ readiness: readiness() });
  if (input.endsWith("/a2p-registration")) return json({ registration });
  throw new Error(`Unexpected request: ${input}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GetStartedChecklist", () => {
  /*
   * Setup left the coach pill bar in the nine-to-five cut, so the only routes to it are the Home
   * setup card and the carrier notice -- both of which are on Home, and neither of which is a way
   * out of here. The artboard draws the return above the title for that reason.
   */
  it("offers a way back, since Setup is off the pill bar", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const back = await screen.findByRole("link", { name: /Back to Home/u });
    expect(back).toHaveAttribute("href", "/coach/home");
  });

  it("renders exactly one current step and no action for the carrier-owned step", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    const carrierHeading = await screen.findByRole("heading", { name: /^Carrier review/ });
    const carrierStep = carrierHeading.closest("li");

    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelectorAll('.step[data-state="done"]')).toHaveLength(0);
    expect(carrierStep).not.toBeNull();
    expect(carrierStep).toHaveAttribute("aria-current", "step");
    // The only control on a carrier-owned step is the quiet disclosure; no coach action exists.
    const carrierButtons = within(carrierStep as HTMLElement).getAllByRole("button");
    expect(carrierButtons).toHaveLength(1);
    expect(carrierButtons[0]).toHaveAccessibleName("What the carrier is checking");
    expect(within(carrierStep as HTMLElement).getByText("Nothing for you to do"))
      .toBeInTheDocument();

    const carrierPanel = (carrierStep as HTMLElement)
      .querySelector('[data-step-panel="carrier-review"]');
    expect(carrierPanel).toHaveTextContent("We do not get told which of these has passed.");
    expect(carrierPanel?.querySelector("svg")).toBeNull();
    expect(carrierPanel?.querySelector('[class*="complete"], [class*="done"]')).toBeNull();
  });

  it("collapses the carrier checks behind a quiet disclosure instead of a second heading", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const disclosure = await screen.findByRole("button", { name: "What the carrier is checking" });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("heading", { name: "What the carrier is checking" }))
      .not.toBeInTheDocument();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[data-step-panel="carrier-review"]')).toBeNull();
  });

  it("builds the filing evidence only from fields the loaded payloads carry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/a2p-registration")) return json({ registration: null });
      return successfulGet(url);
    }));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const evidence = await screen.findByLabelText("Filing evidence");

    // No registration payload means no filing row and no invented reference.
    expect(within(evidence as HTMLElement).queryByText("Submitted")).not.toBeInTheDocument();
    expect(within(evidence as HTMLElement).queryByText("Filed by")).not.toBeInTheDocument();
    expect(within(evidence as HTMLElement).getByText("History")).toBeInTheDocument();
    expect(within(evidence as HTMLElement).getByText("Consent page confirmed")).toBeInTheDocument();
    expect(evidence).toHaveTextContent("Read-only. Logged.");
  });

  it("sequences the go-live action instead of leaving it a bare nothing-to-do", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const goLive = (await screen.findByRole("heading", {
      name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/,
    })).closest("li");
    const action = within(goLive as HTMLElement).getByRole("button", { name: "Review go-live" });

    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(goLive).toHaveTextContent("after step 5");
  });

  it("marks prior steps done only after provider delivery evidence is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/readiness")) return json({ readiness: readiness(true) });
      if (url.endsWith("/a2p-registration")) {
        return json({ registration: { ...registration, registrationState: "done" as const } });
      }
      return successfulGet(url);
    }));

    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    await screen.findByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ });

    // Four steps carry the approved filing's receipt. Go-live is not one of them and is not
    // current either: the safe test sits between them and has no receipt in this fixture, so the
    // journey stops there rather than skipping a gate the runner still enforces.
    expect(container.querySelectorAll('.step[data-state="done"]')).toHaveLength(4);
    expect(screen.getByRole("heading", { name: /^Safe test(?:Ready for you|Waiting on .*|After .*)?$/ }).closest("li"))
      .toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ }).closest("li"))
      .not.toHaveAttribute("aria-current");
  });

  /**
   * Screen 2j promises a checklist that ticks itself. It does, and this is what makes that honest
   * rather than optimistic: the safe test moves to done on `test_passed`'s own `evidenceAt` and on
   * nothing else. A `ready` flag with no timestamp behind it leaves the step where it was.
   */
  it("ticks the safe test on its recorded receipt, never on a bare ready flag", async () => {
    function stub(readinessValue: ReadinessResult) {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/readiness")) return json({ readiness: readinessValue });
        if (url.endsWith("/a2p-registration")) {
          return json({ registration: { ...registration, registrationState: "done" as const } });
        }
        return successfulGet(url);
      }));
    }

    stub(readiness(true, true));
    const passed = render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);
    const safeTest = (await passed.findByRole("heading", {
      name: /^Safe test(?:Ready for you|Waiting on .*|After .*)?$/,
    })).closest("li");

    expect(safeTest).toHaveAttribute("data-state", "done");
    expect(safeTest).toHaveTextContent("Safe test passed, recorded");
    expect(passed.container.querySelectorAll('.step[data-state="done"]')).toHaveLength(5);
    expect(passed.getByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ }).closest("li"))
      .toHaveAttribute("aria-current", "step");

    passed.unmount();
    vi.unstubAllGlobals();

    // The same fixture with the receipt stripped out. Nothing else changes, and the step does not
    // tick: a claim of readiness with no timestamp is not a receipt.
    const unproven = readiness(true, true);
    stub({
      ...unproven,
      checks: unproven.checks.map((check) => check.key === "test_passed"
        ? { ...check, evidenceAt: null }
        : check),
    });
    const bare = render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);
    const bareTest = (await bare.findByRole("heading", {
      name: /^Safe test(?:Ready for you|Waiting on .*|After .*)?$/,
    })).closest("li");

    expect(bareTest).not.toHaveAttribute("data-state", "done");
    expect(bare.container.querySelectorAll('.step[data-state="done"]')).toHaveLength(4);
  });

  it("withholds go-live while A2P awaits the provider even when global readiness is green", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/readiness")) {
        const value = readiness(true);
        return json({ readiness: { ...value, ready: true } });
      }
      return successfulGet(url);
    }));

    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    await screen.findByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ });

    expect(screen.queryByRole("link", { name: "Review go-live" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Every required check has a receipt/)).not.toBeInTheDocument();
  });

  it("keeps the other resource-backed steps rendered when one fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/artifacts")) throw new TypeError("blocked");
      if (url.endsWith("/content-screen")) {
        return json({ screen: { ...contentScreen, adminConfirmedAt: null } });
      }
      return successfulGet(url);
    }));

    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const unavailableHeading = await screen.findByRole("heading", {
      name: "Your consent page could not be checked",
    });
    const consentStep = screen.getByRole("heading", {
      name: /^Your consent page(?:Ready for you|Waiting on .*|After .*)?$/,
    }).closest("li");
    const welcomeStep = screen.getByRole("heading", { name: /^Your welcome message(?:Ready for you|Waiting on .*|After .*)?$/ }).closest("li");
    const carrierStep = screen.getByRole("heading", { name: /^Carrier review/ }).closest("li");

    expect(consentStep).not.toBeNull();
    // The kit DataState panel is scoped to the failed resource and hoisted above the journey
    // (its markup cannot nest inside the step paragraph); the step itself points at it.
    const unavailablePanel = unavailableHeading.closest("main");
    expect(unavailablePanel).not.toBeNull();
    expect(within(unavailablePanel as HTMLElement).getByRole("button", { name: "Retry" }))
      .toBeInTheDocument();
    expect(consentStep).toHaveAttribute("aria-current", "step");
    expect(consentStep).toHaveTextContent("Use its Retry above the steps.");
    expect(screen.getByRole("heading", { name: /^Your business details(?:Ready for you|Waiting on .*|After .*)?$/ }).closest("li"))
      .toHaveTextContent("Your active workspace receipt is available for the remaining setup checks.");

    expect(welcomeStep).not.toBeNull();
    expect(welcomeStep).toHaveTextContent(
      "Your acknowledgement is saved. Our team is checking the message before filing.",
    );

    expect(carrierStep).not.toBeNull();
    expect(carrierStep).toHaveTextContent("Registering · day 10");
    expect(screen.getByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ })).toBeInTheDocument();
  });

  it("states the carrier wait as an elapsed-day figure, never a percentage or a finish date", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const carrierStep = (await screen.findByRole("heading", { name: /^Carrier review/ }))
      .closest("li") as HTMLElement;
    const well = carrierStep.querySelector(".surface-well");

    // Submitted 14 Aug, read on 24 Aug: ten whole days, in mono, in a recessed readout.
    expect(well).not.toBeNull();
    expect(well).toHaveTextContent("Day 10");
    expect(well).toHaveTextContent("submitted Aug 14, 2026");
    expect(well).toHaveTextContent("typical 14 to 21 days");
    // The figure itself, not merely something mono somewhere in the well: the overline above it
    // is also on the mono face, so a query scoped to the well passed even while the day count sat
    // in Archivo. The kit's Figure atomic is the mono role, and it is what has to carry "Day 10".
    const dayFigure = well?.querySelector('[data-slot="figure"]');
    expect(dayFigure).not.toBeNull();
    expect(dayFigure).toHaveTextContent("Day 10");
    expect(dayFigure?.className).toContain("mono");
    // A2P vetting has no honest progress bar and no honest completion date.
    expect(carrierStep.textContent ?? "").not.toMatch(/%|\d+\s*(?:percent|complete)|by [A-Z][a-z]{2} \d/);
  });

  it("says nothing needs the coach, and spends no accent fill, while an external clock holds the journey", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    await screen.findByRole("heading", { name: /^Carrier review/ });

    expect(screen.getByText("Nothing needs you yet. This step is with the carrier."))
      .toBeInTheDocument();
    // The same sentence, held to the copy rule it used to break: docs/DESIGN.md bans the em dash
    // in UI copy, and this line carried one for as long as the assertion quoted it back.
    expect(container.textContent ?? "").not.toContain("—");
    // The page's one accent fill belongs to a real next action; there is none to spend it on.
    expect(container.querySelectorAll(".bg-primary")).toHaveLength(0);
  });

  it("names the one step waiting on the coach when a control of theirs is live", async () => {
    const unconfirmedArtifact = { ...artifact, confirmedAt: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) =>
      successfulGet(String(input), unconfirmedArtifact)));

    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    expect(await screen.findByRole("button", { name: "Confirm consent page" })).toBeInTheDocument();
    expect(screen.getByText("Waiting on you: your consent page.")).toBeInTheDocument();
    expect(screen.queryByText(/^Nothing needs you yet/)).not.toBeInTheDocument();
  });

  /**
   * The drift this catches: the lead sentence going back to being a written string.
   *
   * The canvas words it "Two are finished, one is with the phone carriers, and two are waiting on
   * you", and that is the first line on the page to go stale -- every clause is a claim about state
   * that moves the moment a receipt lands, and a hard-coded copy would keep reading as authored copy
   * long after it stopped being true. Two fixtures that differ only in their receipts must produce
   * two different sentences; a constant passes the first assertion and fails the second.
   */
  it("counts the lead sentence from the step states rather than stating it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const waiting = render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);
    await waiting.findByRole("heading", { name: /^Carrier review/ });

    expect(waiting.container.querySelector('[data-slot="setup-summary"]')).toHaveTextContent(
      "Six steps, in order. Three are with SetterFi and the carrier, and three are waiting on you.",
    );

    waiting.unmount();
    vi.unstubAllGlobals();

    // The same six steps with the carrier filing approved and the safe test recorded. Nothing about
    // the page changed except the receipts, and the sentence has to move with them.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/readiness")) return json({ readiness: readiness(true, true) });
      if (url.endsWith("/a2p-registration")) {
        return json({ registration: { ...registration, registrationState: "done" as const } });
      }
      return successfulGet(url);
    }));
    const finished = render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);
    await finished.findByRole("heading", { name: /^Go live(?:Ready for you|Waiting on .*|After .*)?$/ });

    expect(finished.container.querySelector('[data-slot="setup-summary"]')).toHaveTextContent(
      "Six steps, in order. Five are finished, and one is waiting on you.",
    );
  });

  /**
   * The drift this catches: a step row putting its name and its state on one clipped line.
   *
   * The inbox shipped every lead's name as "Jo..." because a shrink-0 timestamp shared a flex line
   * with a truncating name, and `truncate` is invisible to jsdom, so nothing went red. A step title
   * is the same shape -- the name plus a "Waiting on the carrier" badge -- and this page renders it
   * a size larger than the console does, so it has less room, not more. The guard is on placement
   * rather than on pixels: the title line must wrap, it must not clip, and the carrier's day-count
   * readout must live outside the title in its own well.
   */
  it("wraps the step name and its state instead of clipping them onto one line", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const carrierStep = (await screen.findByRole("heading", { name: /^Carrier review/ }))
      .closest("li") as HTMLElement;
    const title = carrierStep.querySelector(".step__title") as HTMLElement;

    // Positive control: the row really rendered both halves before anything is asserted absent.
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent("Carrier review");
    expect(title).toHaveTextContent("Waiting on the carrier");

    expect(title.className).toContain("flex-wrap");
    expect(title.className).not.toMatch(/truncate|whitespace-nowrap|overflow-hidden/);
    // The day counter is metadata about the step, not part of its name, and it sits in its own
    // recessed readout below. A well inside the title line would be the inbox bug again.
    expect(title.querySelector(".surface-well")).toBeNull();
    expect(carrierStep.querySelector(".surface-well")).not.toBeNull();
  });

  /**
   * The drift this catches: the closing panel going back to naming itself rather than its claim,
   * and the audit microcopy falling off the receipts it labels.
   */
  it("closes with the receipts panel and keeps its logged microcopy", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const receipts = await screen.findByLabelText("Filing evidence");

    expect(within(receipts as HTMLElement).getByRole("heading", {
      name: "Every step above has a receipt",
    })).toBeInTheDocument();
    expect(receipts).toHaveTextContent("the carrier campaign code and the checksum of what we filed");
    expect(receipts).toHaveTextContent("Read-only. Logged.");
    // GoHighLevel is backend plumbing and must never surface in a coach-visible receipt.
    expect((receipts.textContent ?? "").toLowerCase()).not.toContain("gohighlevel");
    expect(receipts.textContent ?? "").not.toMatch(/\bGHL\b/);
  });

  /*
   * `/coach/integrations` is a live page whose every other route in fires on a failure: Home's
   * attention queue only lists a blocked channel, and the per-channel action on this strip only
   * appears while that channel is not live. A coach with healthy channels had no door to it. The
   * strip's link is therefore unconditional, including when the connections read returned nothing
   * -- absent facts must not take the route to the page that owns them with them.
   */
  it("routes to Connections whatever the channels say, including when there are none", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    await screen.findByLabelText("Filing evidence");
    // Rendered with no `channels` prop at all, which is what a failed connections read produces.
    const link = container.querySelector('[data-slot="channel-strip-connections"]');
    expect(link, "the route out survives an empty channel list").not.toBeNull();
    expect(link).toHaveAttribute("href", "/coach/integrations");
    expect(link).toHaveTextContent("Manage your connections");
  });

  /*
   * The canvas ends the page on one low-contrast strip whose body is entirely folded away
   * (`CoachSetup.dc.html:178-189` -- "The receipts, folded away"). These two pin both halves of
   * that: the claim and the single button are the only things visible, and the references
   * themselves are behind the fold rather than rendered open under it.
   */
  it("folds every reference behind one button rather than ending the page on a wall of them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const receipts = await screen.findByLabelText("Filing evidence");
    const folds = receipts.querySelectorAll("details");

    // One disclosure, not a "Technical detail" drawer beside two open tables.
    expect(folds).toHaveLength(1);
    expect(folds[0]!.open).toBe(false);
    expect(within(receipts as HTMLElement).getByText("Show the technical record"))
      .toBeInTheDocument();
    expect(receipts).not.toHaveTextContent("Technical detail");

    // Filing and History are inside the closed fold, not rendered above it.
    const filing = within(receipts as HTMLElement).getByRole("heading", { name: "Filing" });
    expect(folds[0]!.contains(filing)).toBe(true);
  });

  it("opens the fold onto the references it promised", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    const receipts = await screen.findByLabelText("Filing evidence");
    const fold = receipts.querySelector("details")!;
    fireEvent.click(within(receipts as HTMLElement).getByText("Show the technical record"));

    expect(within(fold).getByRole("heading", { name: "Filing" })).toBeInTheDocument();
    expect(within(fold).getByRole("heading", { name: "History" })).toBeInTheDocument();
  });

  /*
   * Each step is already a bordered card with its own tile, status lozenge and action, so the hero
   * panel the page used to wrap them in was a card around a stack of cards, titled "The steps"
   * above a list that plainly is the steps. The artboard draws them on the page ground.
   */
  it("puts the steps on the page ground rather than inside a panel of their own", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    await screen.findByLabelText("Filing evidence");
    const journey = container.querySelector('[data-slot="get-started-journey"]')!;

    expect(journey.closest(".coach-panel")).toBeNull();
    expect(container.textContent).not.toContain("The steps");
  });

  /**
   * The coach floor, asserted over the whole journey rather than over the line that was found.
   *
   * `COACH_JOURNEY_SCALE` lifts `StepJourney` into the coach's sizes from outside, because the
   * component is shared with admin provisioning and forking it would move two other readers'
   * screens. That technique has one failure mode and it is silent: a line rendered with a bare
   * token utility and no class name has nothing for an arbitrary variant to select, so it keeps
   * the console's 13px on a page whose floor is 14px, and every guard stays green -- the stylesheet
   * suite reads `coach.css`, and `coach-type-floor.test.ts` matches `text-[Npx]` literals in
   * coach-only modules while this markup lives in `kit/`. "Nothing for you to do" sat there for
   * four audits.
   *
   * So this does not pin that sentence. It reads the lift rules off the wrapper that actually
   * shipped, then walks every element the journey rendered and fails on any that carries a console
   * type token without carrying a class one of those rules reaches. A line added later with the
   * same mistake fails here on the day it lands.
   */
  it("leaves no line in the journey wearing a console type size the coach scale cannot reach", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => successfulGet(String(input))));
    const { container } = render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />,
    );

    await screen.findByLabelText("Filing evidence");
    const journey = container.querySelector('[data-slot="get-started-journey"]') as HTMLElement;

    // The rules, read off the rendered wrapper rather than imported: this is the string the page
    // actually sets, which is the only version Tailwind compiled and the browser will apply.
    const lifted = new Map<string, number>();
    for (const rule of journey.className.matchAll(/\[&_\.([\w\\-]+)\]:text-\[(\d+)px\]/gu)) {
      lifted.set(rule[1].replaceAll("\\", ""), Number(rule[2]));
    }
    // Positive control: a renamed or emptied scale would leave the walk below with nothing to
    // check and nothing to fail on.
    expect([...lifted.keys()]).toContain("step__title");
    expect([...lifted.keys()]).toContain("step__nothing");
    expect(lifted.size).toBeGreaterThanOrEqual(7);
    for (const [name, size] of lifted) {
      expect(size, `${name} is lifted below the coach floor`).toBeGreaterThanOrEqual(15);
    }

    // Second positive control: the carrier step has to have actually rendered the sentence, or
    // the sweep proves nothing about it.
    expect(journey.querySelector(".step__nothing")).toHaveTextContent("Nothing for you to do");

    // `--t-body` is 13px and `--t-row` 14px; both are the console's density, and an absolute size
    // does not move with the root the coach shell already raised.
    const consoleType = /(?:^|\s)text-(?:body|row|faint|badge)(?:\s|$)/u;
    const unreachable = [...journey.querySelectorAll("*")]
      .filter((element) => {
        const classes = element.getAttribute("class") ?? "";
        // Ornament is out of scope on purpose: the numbered dot's glyph sits inside an
        // `aria-hidden` column and its size is its geometry, which a font-size rule cannot fix.
        if (element.closest('[aria-hidden="true"]')) return false;
        return consoleType.test(classes) && (element.textContent ?? "").trim().length > 0;
      })
      .filter((element) => ![...element.classList].some((name) => lifted.has(name)))
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);

    expect(
      unreachable,
      "SIMPLIFICATION-SPEC \u00a75: nothing on the coach surface below 14px. Give the line a `step__*` class and list it in COACH_JOURNEY_SCALE.",
    ).toEqual([]);
  });

  it("keeps a refusal message and last good data when the affected reload fails", async () => {
    const unconfirmedArtifact = { ...artifact, confirmedAt: null };
    let artifactReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/artifacts") && init?.method === "POST") {
        return json({ error: "refused" }, 409);
      }
      if (url.endsWith("/artifacts")) {
        artifactReads += 1;
        if (artifactReads > 1) throw new TypeError("reload blocked");
      }
      return successfulGet(url, unconfirmedArtifact);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm consent page" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Consent page confirmation was refused. Its saved state has not changed.",
    );
    expect(await screen.findByRole("heading", {
      name: "Your consent page could not be checked",
    })).toBeInTheDocument();
    await waitFor(() => expect(artifactReads).toBe(2));

    const consentStep = screen.getByRole("heading", {
      name: /^Your consent page(?:Ready for you|Waiting on .*|After .*)?$/,
    }).closest("li");
    expect(consentStep).not.toBeNull();
    expect(consentStep).toHaveTextContent(
      "Consent page confirmation was refused. Its saved state has not changed.",
    );
    const reloadPanel = screen.getByRole("heading", {
      name: "Your consent page could not be checked",
    }).closest("main");
    expect(reloadPanel).not.toBeNull();
    expect(within(reloadPanel as HTMLElement).getByRole("button", { name: "Retry" }))
      .toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Its saved state has not changed.");
  });
});

/**
 * The workspace provenance label, which is a hard rule rather than a styling choice.
 *
 * Coach setup carried a provenance line before this and it answered a different question: it says
 * "Sample setup records" when the hosted consent artifact is a placeholder, which is about the
 * filing rather than about the workspace. The two came apart in both directions -- a seeded tenant
 * with a genuine artifact was unlabelled on the one screen whose whole subject is whether the
 * account is live yet -- so these assert the workspace line by its own slot, not by whatever text
 * happens to be in the head.
 */
describe("GetStartedChecklist workspace provenance", () => {
  const provenanceLine = () => document.querySelector('[data-slot="setup-provenance"]');

  it("labels a seeded workspace with the same sentence every other coach surface prints", () => {
    render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" provenance="demo" />,
    );

    const line = provenanceLine();
    expect(line, "the setup head renders no workspace provenance line at all").not.toBeNull();
    expect(line).toHaveTextContent("Demo data, excluded from real analytics");
    expect(line).toHaveAttribute("data-provenance", "demo");
  });

  /*
   * The arm that matters most, and the one a reasonable implementation gets wrong by omission.
   *
   * When the provenance read fails, printing nothing leaves the page indistinguishable from one
   * whose rows are known to be real, and printing "Real data" is an invented affirmative on the
   * product's most safety-relevant label. Asserting the visible sentence rather than the attribute
   * alone is deliberate: `data-provenance="unknown"` with an empty element would satisfy an
   * attribute check and tell a coach nothing.
   */
  it("says so in words when the read could not confirm what the workspace holds", () => {
    render(
      <GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" provenance="unknown" />,
    );

    const line = provenanceLine();
    expect(line).not.toBeNull();
    expect(line?.textContent ?? "").toMatch(/could not confirm/i);
    expect(line?.textContent ?? "").not.toMatch(/^Real data$/);
  });

  it("renders no workspace line when the caller states no provenance", () => {
    render(<GetStartedChecklist enabled nowIso="2026-08-24T12:00:00.000Z" />);

    // Paired with a positive so this cannot pass on a component that rendered nothing at all.
    expect(screen.getByRole("heading", { level: 1, name: "Your setup" })).toBeVisible();
    expect(provenanceLine()).toBeNull();
  });
});
