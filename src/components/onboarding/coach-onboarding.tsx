"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Figure,
  KitButton,
  Prose,
} from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_LEAD_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { DataState } from "@/components/kit/data-state";
import { LoggedButton } from "@/components/kit/logged-button";
import { StepJourney, type JourneyStep } from "@/components/kit/step-journey";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/kit/tooltip";
import { humanError } from "@/lib/copy/errors";
import type {
  ReadinessCheck,
  ReadinessKey,
  ReadinessResult,
} from "@/lib/onboarding/contracts";
import { CARRIER_TYPICAL_DAYS, READINESS_KEYS } from "@/lib/onboarding/contracts";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";

type ReadinessPayload = { readiness: ReadinessResult };
type RegistrationPayload = { registration: CoachA2pRegistrationProjection | null };

const STEP_TITLES: Record<ReadinessKey, string> = {
  tenant_active: "Workspace activation",
  messaging_channel_live: "Text messages (SMS)",
  primary_calendar_healthy: "Calendar",
  published_offer_ready: "Published offer",
  platform_brain_published: "The Brain",
  test_passed: "Safe test",
  subscription_ready: "Subscription",
};

const ACTIVATION_COPY = "We are activating your workspace. Nothing for you to do.";
const OFF_MODE_JOURNEY: readonly JourneyStep[] = READINESS_KEYS.map((key, index) => ({
  body: "Onboarding is not enabled. This check is not running.",
  key,
  owner: "setterfi",
  state: index === 0 ? "current" : "waiting",
  title: STEP_TITLES[key],
}));

function isReadinessPayload(value: unknown): value is ReadinessPayload {
  return value !== null
    && typeof value === "object"
    && "readiness" in value
    && Boolean((value as ReadinessPayload).readiness);
}

function isRegistrationPayload(value: unknown): value is RegistrationPayload {
  return value !== null && typeof value === "object" && "registration" in value;
}

function validEvidenceAt(value: string | null) {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()));
}

function hasTerminalCarrierRejection(
  check: ReadinessCheck,
  registration: CoachA2pRegistrationProjection | null,
) {
  return check.key === "messaging_channel_live" && registration?.terminalRejection === true;
}

function ownerFor(
  check: ReadinessCheck,
  registration: CoachA2pRegistrationProjection | null,
): JourneyStep["owner"] {
  if (hasTerminalCarrierRejection(check, registration)) return "you";
  if (check.blamingParty === "coach") return "you";
  if (check.key === "messaging_channel_live") return "carrier";
  return "setterfi";
}

function bodyFor(check: ReadinessCheck, registration: CoachA2pRegistrationProjection | null) {
  if (hasTerminalCarrierRejection(check, registration)) {
    return "Carriers rejected your text registration. Open connections to review what needs changing before you resubmit.";
  }

  if (check.ready) return "This check has saved evidence. You can continue when every row is confirmed.";

  const safeError = humanError(check.code);
  if (
    check.code.includes("unavailable")
    || check.code.includes("contract")
    || safeError.title !== "Something went wrong"
  ) {
    return ACTIVATION_COPY;
  }

  if (check.key === "messaging_channel_live") {
    return registration?.submittedAt
      ? "Carriers are reviewing your text registration. Nothing for you to do."
      : "Connect a lead channel, then we can submit text registration for carrier review.";
  }
  if (check.key === "primary_calendar_healthy") {
    return "Connect the calendar your agent should use for real booking availability.";
  }
  if (check.key === "published_offer_ready") {
    return "Review and publish the offer your agent should use in lead conversations.";
  }
  if (check.key === "test_passed") {
    return "Run a safe test with real calendar availability and a simulated booking. No appointment is created.";
  }
  if (check.key === "subscription_ready") {
    return "Choose the subscription that should become active when your agent goes live.";
  }
  return ACTIVATION_COPY;
}

function actionFor(
  check: ReadinessCheck,
  registration: CoachA2pRegistrationProjection | null,
  startStep: (step: "calendar_connect" | "offer_layer") => void,
): JourneyStep["action"] {
  if (hasTerminalCarrierRejection(check, registration)) {
    return { href: "/coach/integrations", label: "Open connections" };
  }
  if (check.ready || check.blamingParty !== "coach") return undefined;
  if (check.key === "messaging_channel_live") {
    return { href: "/coach/integrations", label: "Open connections" };
  }
  if (check.key === "primary_calendar_healthy") {
    return { label: "Connect calendar", onClick: () => startStep("calendar_connect") };
  }
  if (check.key === "published_offer_ready") {
    return { label: "Review offer", onClick: () => startStep("offer_layer") };
  }
  if (check.key === "test_passed") {
    return { href: "/meet-agent", label: "Run safe test" };
  }
  if (check.key === "subscription_ready") {
    return { href: "/coach/billing", label: "Choose subscription" };
  }
  return undefined;
}

/**
 * The sentence that says what is happening right now, derived from the journey rather than written.
 *
 * The journey already states ownership per row, but a coach landing on this page reads a column of
 * seven rows and has to work out for themselves whether any of it is theirs. Saying it once, in
 * words, is the same finding the Get-started rebuild made on 2026-08-30: nothing here overstated
 * readiness, but nothing said in plain English that nothing needed doing either, so the reader had
 * to infer it from a timeline and a disabled button.
 *
 * It scans every step the coach owns rather than only the first one that is not done. Claiming
 * nothing needs them while one of their own controls is on screen is the same overstatement
 * inverted, and on this flow that would be the worst thing the page could say: they have paid, and
 * they are being asked to wait.
 */
function rightNow(steps: readonly JourneyStep[]): string {
  const blocked = steps.find((step) => step.state === "blocked");
  if (blocked) return `${blocked.title} is blocked and needs you before setup can continue.`;

  const yours = steps.find((step) => step.state !== "done" && step.owner === "you");
  if (yours) return `Waiting on you: ${yours.title.toLowerCase()}.`;

  const elsewhere = steps.find((step) => step.state !== "done");
  if (!elsewhere) return "Every check has saved evidence. Nothing is waiting on you.";

  return elsewhere.owner === "carrier"
    ? "Nothing needs you. Text registration is with the carriers on their own clock."
    : `Nothing needs you. ${elsewhere.title} is with ${OWNER_SENTENCE[elsewhere.owner]}.`;
}

const OWNER_SENTENCE: Record<JourneyStep["owner"], string> = {
  carrier: "the carriers",
  meta: "Meta",
  setterfi: "SetterFi",
  you: "you",
};

/**
 * The journey's own face: a deck panel, which is the only card shape on the coach side.
 *
 * A card contains wells, not cards, so the summary is a well sunk into the same face the steps sit
 * on rather than a second card stacked above it. The count is a real figure at the deck's size
 * because "3 of 7" is the number a coach opens this page for; it is derived from the receipt-backed
 * rows and nothing else, so it can never read 7 of 7 while a row is still amber.
 */
function JourneyCard({
  confirmed,
  steps,
  total,
}: {
  confirmed?: number;
  steps: readonly JourneyStep[];
  total?: number;
}) {
  return (
    <DeckPanel
      eyebrow="Where each piece stands"
      headingId="setup-journey-panel"
      hero
      name="Your setup"
    >
      {confirmed !== undefined && total !== undefined ? (
        <div className="surface-well mb-[var(--s-5)] grid gap-[var(--s-4)] @min-[520px]:grid-cols-[auto_minmax(0,1fr)] @min-[520px]:gap-[var(--s-6)]">
          <div>
            <p className={COACH_EYEBROW_CLASS}>Confirmed</p>
            <Figure className="mt-[var(--s-2)] block" size="lg">
              {confirmed} of {total}
            </Figure>
          </div>
          <div className="min-w-0">
            <p className={COACH_EYEBROW_CLASS}>Right now</p>
            <Prose className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[color:var(--body)]`}>
              {rightNow(steps)}
            </Prose>
          </div>
        </div>
      ) : null}
      <StepJourney steps={steps} />
    </DeckPanel>
  );
}

/**
 * What pressing the button actually does, in three sentences a coach can check afterwards.
 *
 * The screen's one drench. It is `info` rather than `live` because nothing here is running yet --
 * `live` is the saturation the product spends on a thing that is already happening, and using it
 * on a description of what would happen would be the panel dressing an intention up as a state.
 *
 * Every statement is something the product does and nothing is a performance promise. The
 * artboard's version said a reply arrives "within about a minute, day or night"; nothing in the
 * product measures reply latency and no coach could hold us to a number we do not record, so the
 * claim here is that an answer comes, which is true, rather than how fast, which is not measured.
 */
function WhatHappensPanel() {
  return (
    <DeckPanel
      drench="info"
      eyebrow="In plain words"
      headingId="what-happens-panel"
      name="What happens when you press it"
    >
      <ol className="m-0 flex list-none flex-col gap-[var(--s-4)]">
        {WHAT_HAPPENS.map((statement, index) => (
          <li className="flex items-start gap-[var(--s-3)]" key={statement}>
            <span
              aria-hidden="true"
              className="mt-[2px] grid size-[28px] shrink-0 place-items-center rounded-full border border-[rgba(255,255,255,0.22)] bg-[rgba(255,255,255,0.14)] font-mono text-[15px] tabular-nums"
            >
              {index + 1}
            </span>
            <span className={COACH_READING_CLASS}>{statement}</span>
          </li>
        ))}
      </ol>
    </DeckPanel>
  );
}

const WHAT_HAPPENS = [
  "The next person who messages your Instagram or your Facebook page gets an answer from your agent, day or night.",
  "Anyone who clears your rules is offered the times your calendar actually has open, and books one of them.",
  "Anything it will not answer, like a rate, a guarantee or a promise, lands in your inbox marked for you.",
] as const;

export function CoachOnboarding({ enabled = true }: { enabled?: boolean }) {
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [registration, setRegistration] = useState<CoachA2pRegistrationProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [workingStep, setWorkingStep] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    setSignedOut(false);
    try {
      const [readinessResponse, registrationResponse] = await Promise.all([
        fetch("/api/onboarding/readiness", { cache: "no-store" }),
        fetch("/api/onboarding/a2p-registration", { cache: "no-store" }),
      ]);
      if (readinessResponse.status === 401 || registrationResponse.status === 401) {
        setReadiness(null);
        setRegistration(null);
        setSignedOut(true);
        return;
      }
      const [readinessPayload, registrationPayload]: unknown[] = await Promise.all([
        readinessResponse.json(),
        registrationResponse.json(),
      ]);
      if (
        !readinessResponse.ok
        || !registrationResponse.ok
        || !isReadinessPayload(readinessPayload)
        || !isRegistrationPayload(registrationPayload)
      ) {
        setError(humanError(`HTTP_${Math.max(readinessResponse.status, registrationResponse.status)}`).body);
        return;
      }
      setReadiness(readinessPayload.readiness);
      setRegistration(registrationPayload.registration);
    } catch {
      setError(humanError("HTTP_503").body);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [enabled, load]);

  const startStep = useCallback(async (step: "calendar_connect" | "offer_layer") => {
    setWorkingStep(step);
    setError(null);
    try {
      const response = await fetch(`/api/onboarding/steps/${step}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", input: {} }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object") {
        setError(humanError(`HTTP_${response.status}`).body);
        return;
      }
      if ("actionTarget" in payload && typeof payload.actionTarget === "string") {
        window.location.assign(payload.actionTarget);
        return;
      }
      await load();
    } catch {
      setError(humanError("HTTP_503").body);
    } finally {
      setWorkingStep(null);
    }
  }, [load]);

  async function goLive() {
    setWorkingStep("go_live");
    setError(null);
    try {
      const response = await fetch("/api/onboarding/go-live", { method: "POST" });
      if (!response.ok) {
        setError(humanError(`HTTP_${response.status}`).body);
        return;
      }
      await load();
    } catch {
      setError(humanError("HTTP_503").body);
    } finally {
      setWorkingStep(null);
    }
  }

  const journey = useMemo(() => {
    if (!readiness) return [];
    const receiptBacked = readiness.checks.map(
      (check) => check.ready && validEvidenceAt(check.evidenceAt),
    );
    const terminallyBlocked = readiness.checks.map(
      (check) => registration?.terminalRejection === true
        && check.key === "messaging_channel_live",
    );
    const currentIndex = readiness.checks.findIndex(
      (_check, index) => !receiptBacked[index] && !terminallyBlocked[index],
    );

    const steps = readiness.checks.map((check, index): JourneyStep => {
      const confirmed = receiptBacked[index];
      const state: JourneyStep["state"] = terminallyBlocked[index]
        ? "blocked"
        : confirmed
        ? "done"
        : index === currentIndex
          ? "current"
          : "waiting";
      const submittedAt = check.key === "messaging_channel_live"
        && registration?.submittedAt
        && validEvidenceAt(registration.submittedAt)
        ? registration.submittedAt
        : null;

      return {
        action: actionFor(check, registration, (step) => void startStep(step)),
        body: bodyFor(check, registration),
        key: check.key,
        owner: ownerFor(check, registration),
        receipt: state === "done" && check.evidenceAt
          ? { at: check.evidenceAt, label: "Saved evidence confirmed" }
          : undefined,
        state,
        title: STEP_TITLES[check.key],
        wait: submittedAt && state !== "done" && !terminallyBlocked[index]
          ? {
            since: submittedAt,
            typicalDays: [CARRIER_TYPICAL_DAYS[0], CARRIER_TYPICAL_DAYS[1]],
          }
          : undefined,
      };
    });

    if (currentIndex === -1) {
      const allConfirmed = receiptBacked.every(Boolean) && !terminallyBlocked.some(Boolean);
      steps.push({
        action: allConfirmed
          ? undefined
          : { href: "/coach/integrations", label: "Open connections" },
        body: allConfirmed
          ? "Every check has saved evidence. Go live when you are ready."
          : "A blocked provider check needs updated registration details before setup can continue.",
        key: allConfirmed ? "go_live" : "resolve_blocked_check",
        owner: "you",
        state: "current",
        title: allConfirmed ? "Go live" : "Resolve the blocked check",
      });
    }

    return steps;
  }, [readiness, registration, startStep]);

  if (!enabled) {
    return (
      <section aria-labelledby="setup-journey-title" className="flex flex-col gap-[var(--s-4)]">
        <div>
          <p className={COACH_EYEBROW_CLASS}>Seven go-live checks</p>
          <h2
            className="mt-[var(--s-2)] text-[20px] leading-[1.25] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
            id="setup-journey-title"
          >
            What your agent still needs
          </h2>
          <Prose className={`mt-[var(--s-2)] ${COACH_LEAD_CLASS}`}>
            Onboarding is not enabled. These checks are shown for reference and are not running, so
            no count is shown for them.
          </Prose>
        </div>
        <JourneyCard steps={OFF_MODE_JOURNEY} />
      </section>
    );
  }

  if (signedOut) {
    return (
      <DataState
        action={{ href: "/login?next=%2Fonboarding", label: "Sign in" }}
        body="Sign in to see the saved checks for your workspace and continue setup."
        kind="empty"
        title="Sign in to continue"
      />
    );
  }

  if (!readiness && !error) return <DataState kind="loading" rows={7} />;
  if (error) {
    return (
      <DataState
        body={error}
        kind="error"
        retry={() => void load()}
        title="Setup checks could not load"
      />
    );
  }
  if (!readiness) return null;

  const blockingCheck = readiness.checks.find((check) => (
    (check.key === "messaging_channel_live" && registration?.terminalRejection === true)
    || !check.ready
    || !validEvidenceAt(check.evidenceAt)
  ));
  const canGoLive = !blockingCheck && readiness.ready;
  // Rendered from the list it describes, and on the same receipt-backed rule the journey marks a
  // row done with. A count derived any other way could say "7 of 7" while a row still read amber.
  const confirmedCount = readiness.checks.filter(
    (check) => check.ready && validEvidenceAt(check.evidenceAt),
  ).length;
  const blockingCopy = blockingCheck
    ? `Finish ${STEP_TITLES[blockingCheck.key]} before going live.`
    : "Every check has saved evidence.";

  return (
    <section aria-labelledby="setup-journey-title" className="flex flex-col gap-[var(--s-4)]">
      <div className="flex flex-wrap items-end justify-between gap-[var(--s-4)]">
        <div>
          <p className={COACH_EYEBROW_CLASS}>Seven go-live checks</p>
          <h2
            className="mt-[var(--s-2)] text-[20px] leading-[1.25] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
            id="setup-journey-title"
          >
            What your agent still needs
          </h2>
          <Prose className={`mt-[var(--s-2)] ${COACH_LEAD_CLASS}`}>
            Each row changes only when saved evidence confirms it. Carrier review keeps its own day
            count, and no date is predicted for it.
          </Prose>
        </div>
        <Link
          className={`${COACH_READING_CLASS} inline-flex items-center text-[color:var(--accent-text)] hover:underline`}
          href="/coach/get-started"
        >
          Open setup details
        </Link>
      </div>

      <div className="grid gap-[var(--s-4)] @min-[1000px]:grid-cols-[minmax(0,1fr)_460px] @min-[1000px]:items-start">
        <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
          <JourneyCard confirmed={confirmedCount} steps={journey} total={readiness.checks.length} />
          <div className="border-t border-[var(--line)] pt-[var(--s-4)]">
            <KitButton
              disabled={workingStep !== null}
              onClick={() => void load()}
              size="lg"
              variant="secondary"
            >
              {workingStep ? "Checking" : "Try again"}
            </KitButton>
            <Prose className={`mt-[var(--s-3)] ${COACH_FOOTNOTE_CLASS}`} measure="tight">
              Re-runs the seven readiness checks and the carrier status check. It does not change
              setup.
            </Prose>
          </div>
        </div>

        <div className="flex flex-col gap-[var(--s-4)]">
          <WhatHappensPanel />

          <div className="flex flex-col gap-[var(--s-3)]">
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex w-full" />}>
                {/*
                  * The One Fill Rule, across two components. `StepJourney` already fills the
                  * coach's first actionable step, so a permanently primary go-live button would be
                  * a second fill on every screen where the coach still has work -- and it would be
                  * spent on the one control that is disabled precisely because that work is not
                  * done. It fills only once every check is receipt-backed, which is exactly when
                  * the journey stops filling anything.
                  *
                  * "Turn my agent on" rather than "Go live", which is the artboard's label and the
                  * better one: it names what the button does to a coach rather than what the
                  * industry calls the event, and the journey row above still reads "Go live" so
                  * the check and the control are not two names for the same word.
                  */}
                <LoggedButton
                  actionKey="tenant.went_live"
                  /* Full width of the 460px column and 68px tall, which is the artboard's size and
                     the widest control on the screen once it is genuinely pressable. It stays that
                     size while disabled too: a button that grows when it unlocks would move the
                     thing under the pointer. */
                  className="h-[68px] w-full justify-center px-[28px] text-[18px]"
                  disabled={!canGoLive || workingStep !== null}
                  onClick={() => void goLive()}
                  type="button"
                  variant={canGoLive ? "primary" : "secondary"}
                >
                  {workingStep === "go_live" ? "Checking" : "Turn my agent on"}
                </LoggedButton>
              </TooltipTrigger>
              {!canGoLive ? <TooltipContent>{blockingCopy}</TooltipContent> : null}
            </Tooltip>

            {/*
              * The scope sentence, and the one line on this screen that costs honesty by being
              * absent. Without it the button reads as turning the whole product on, and a coach
              * who signed up partly for texting would press it believing their texts were now
              * answered. It states no date for the carriers and no percentage, which is the same
              * rule the SMS row's day counter follows.
              */}
            <Prose className={`${COACH_FOOTNOTE_CLASS}`} measure="wide">
              This turns on Instagram and Messenger only. Texting is not part of it yet. It joins
              on its own the day the carriers finish, and nothing here needs doing for that.
            </Prose>

            <Link
              className={`${COACH_READING_CLASS} inline-flex min-h-[var(--coach-target)] items-center text-[color:var(--accent-text)] hover:underline`}
              href="/coach/settings"
            >
              Not yet, take me back to my settings
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
