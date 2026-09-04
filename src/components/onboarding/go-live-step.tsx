"use client";

/*
 * Step 6 of 6, drawn from `OnboardingGoLive.dc.html`.
 *
 * The reads and the write are unchanged: `GET /api/onboarding/readiness`,
 * `GET /api/onboarding/a2p-registration`, and the audited `POST /api/onboarding/go-live` that the
 * endpoint itself refuses when a check is unmet.
 *
 * **Nothing here says all set while anything is provisioning.** The board's two panels are what is
 * ready now and what is still waiting, and the second one carries the carrier day count rather
 * than a percentage or a date. The headline counts what is outstanding, so a coach with two checks
 * left reads two rather than a cheerful sentence over an amber rail. That is the honest-states rule
 * in `CLAUDE.md`, and this is the screen it exists for.
 *
 * **One button.** Before the press it is "Turn my agent on", refused with its reason when a check
 * is unmet; after it, and on an account that is already live, it is the way into the console. The
 * shipped screen spent its accent on a drenched panel of prose while the real button sat grey
 * underneath, which is the audit's defect 3.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { TONE_MARK, type Tone } from "@/components/kit/atomics";
import { ShieldCheck } from "@/components/kit/icons";
import { DataState } from "@/components/kit/data-state";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { COUNT_IN_WORDS } from "@/components/onboarding/setup-status";
import {
  OnboardingStepShell,
  STEP_MONO_CLASS,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
} from "@/components/onboarding/step-shell";
import { humanError } from "@/lib/copy/errors";
import { carrierReviewFrom } from "@/lib/onboarding/carrier-review";
import {
  CARRIER_TYPICAL_DAYS,
  type ReadinessCheck,
  type ReadinessKey,
  type ReadinessResult,
} from "@/lib/onboarding/contracts";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";

/** The coach-facing name of each go-live check. */
const CHECK_TITLES: Record<ReadinessKey, string> = {
  tenant_active: "Your workspace",
  messaging_channel_live: "Instagram and Messenger",
  primary_calendar_healthy: "Your calendar",
  published_offer_ready: "Your offer",
  platform_brain_published: "The industry knowledge your agent answers from",
  test_passed: "The safe test",
  subscription_ready: "Your subscription",
};

/** What a check that is not ready is waiting on, in the coach's own words. */
const CHECK_WAITING: Record<ReadinessKey, string> = {
  tenant_active: "We are still activating your workspace. Nothing for you to do.",
  messaging_channel_live: "No channel is answering yet. Connect Instagram or Messenger first.",
  primary_calendar_healthy: "Your agent has nowhere to put the calls it books yet.",
  published_offer_ready: "Your agent has nothing of yours to say about your business yet.",
  platform_brain_published: "SetterFi is publishing the shared industry knowledge. Nothing for you to do.",
  test_passed: "A safe test has not run yet. It books nothing and creates no appointment.",
  subscription_ready: "No subscription is ready to start when your agent goes live.",
};

/** What a ready check has actually established. */
const CHECK_READY: Record<ReadinessKey, string> = {
  tenant_active: "Your workspace is active.",
  messaging_channel_live: "Your agent answers direct messages and page messages.",
  primary_calendar_healthy: "Your agent can see when you are free and book into your calendar.",
  published_offer_ready: "Your agent knows what you sell, what it costs and who is a good fit.",
  platform_brain_published: "Your agent answers funding questions from knowledge we keep current.",
  test_passed: "A safe test ran end to end without booking anybody.",
  subscription_ready: "Your subscription is ready to start the moment you press the button.",
};

/** The sentences this screen used to print as a drenched panel, handed to the eye instead. */
export /**
 * The refused face of the one button on this step.
 *
 * It keeps the border, the fill and the 48px box of a button, because a refused action still has to
 * read as the thing the sentence above it is talking about. Dropping to bare grey text, which is
 * what the shared logged button did at its secondary variant on this surface, left a coach with a
 * paragraph naming "the button below" above no button at all.
 *
 * It is deliberately not the accent face at reduced opacity. The accent on this page means "this is
 * the press that turns your agent on", and wearing it while the press is refused would say the
 * work is finished when the panel beside it lists what is not.
 */
const STEP_REFUSED_CLASS =
  "inline-flex h-[48px] w-full cursor-not-allowed items-center justify-center gap-[10px] "
  + "rounded-[9px] border border-[var(--line)] bg-[var(--control-fill)] px-[24px] text-[16px] "
  + "font-[600] text-[color:var(--muted)] sm:w-auto";

/**
 * The audit line, in the page's own words.
 *
 * The shared `LoggedButton` prints this caption through the `text-over` utility, which is
 * `text-transform: uppercase` at 11px. Both halves of that are refused on a coach surface: nothing
 * here goes below 14px and nothing is set in capitals. The fact itself is worth keeping and the
 * wording is already sentence case in `AUDIT_ACTIONS`, so the caption is drawn here at body size
 * instead, the same shape the agent screen uses beside its own save.
 */
function LoggedNote() {
  const accountability = AUDIT_ACTIONS["tenant.went_live"];
  return (
    <span
      aria-label={accountability.ariaLabel}
      className="inline-flex items-center justify-center gap-[8px] text-[15px] leading-[1.4] text-[color:var(--muted)] sm:justify-start"
    >
      <ShieldCheck aria-hidden className="size-[16px] flex-none" />
      {accountability.microcopy}
    </span>
  );
}

const GO_LIVE_STEP_EYE_COPY =
  "Pressing the button turns your agent on for Instagram and Facebook page messages. The next "
  + "person who messages you gets an answer from your agent, day or night. Anyone who clears your "
  + "rules is offered the times your calendar actually has open and books one of them. Anything "
  + "the agent will not answer, like a rate, a guarantee or a promise, lands in your inbox marked "
  + "for you, and it will not touch anyone already in a conversation with you. Texting is not part "
  + "of this: it joins on its own the day the carriers finish, and nothing here needs doing for "
  + "that. You can pause your agent at any time from your agent screen.";

function validEvidenceAt(value: string | null) {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()));
}

type ReadinessPayload = { readiness: ReadinessResult };
type RegistrationPayload = { registration: CoachA2pRegistrationProjection | null };

function isReadinessPayload(value: unknown): value is ReadinessPayload {
  return value !== null && typeof value === "object" && "readiness" in value
    && Boolean((value as ReadinessPayload).readiness);
}

function isRegistrationPayload(value: unknown): value is RegistrationPayload {
  return value !== null && typeof value === "object" && "registration" in value;
}

export function GoLiveStep() {
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [registration, setRegistration] = useState<CoachA2pRegistrationProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [working, setWorking] = useState(false);
  const [wentLive, setWentLive] = useState(false);

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function goLive() {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/go-live", { method: "POST" });
      if (!response.ok) {
        setError(humanError(`HTTP_${response.status}`).body);
        return;
      }
      setWentLive(true);
      await load();
    } catch {
      setError(humanError("HTTP_503").body);
    } finally {
      setWorking(false);
    }
  }

  const checks = readiness?.checks ?? [];
  const confirmed = (check: ReadinessCheck) => check.ready && validEvidenceAt(check.evidenceAt);
  const ready = checks.filter(confirmed);
  const waiting = checks.filter((check) => !confirmed(check));
  const canGoLive = readiness !== null && readiness.ready && waiting.length === 0;

  const carrier = carrierReviewFrom({
    checked: registration !== null || readiness !== null,
    registrationState: registration?.registrationState ?? null,
    submittedAt: registration?.submittedAt ?? null,
    terminalRejection: registration?.terminalRejection ?? false,
  });
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt)
    : null;

  /*
   * The headline counts what is outstanding rather than asserting a state. Every fixed sentence
   * here is right or wrong depending on evidence it cannot see, which is how the shipped screen
   * came to promise a coach they were one press away over a rail saying otherwise.
   */
  const lead = readiness === null
    ? "Reading what your agent still needs."
    : wentLive
      ? "Your agent is on. The next person who messages you gets an answer from it."
      : waiting.length === 0
        ? "Everything your agent needs is in place. Pressing the button turns it on for Instagram and Messenger."
        : `${waiting.length === 1
          ? "One thing is"
          : `${COUNT_IN_WORDS[waiting.length] ?? String(waiting.length)} things are`
        } still outstanding, so the button below is refused until they are done.`;

  const primary = wentLive
    ? (
      <Link className={STEP_PRIMARY_CLASS} href="/coach/home">
        Open your console
      </Link>
    )
    : (
      <span className="flex w-full flex-col items-stretch gap-[10px] sm:w-auto sm:items-start">
        <button
          className={canGoLive && !working ? STEP_PRIMARY_CLASS : STEP_REFUSED_CLASS}
          disabled={!canGoLive || working}
          onClick={() => void goLive()}
          type="button"
        >
          {working ? "Checking" : "Turn my agent on"}
        </button>
        <LoggedNote />
      </span>
    );

  return (
    <OnboardingStepShell
      eyeCopy={GO_LIVE_STEP_EYE_COPY}
      eyeScreen="onboarding-go-live"
      lead={lead}
      primary={primary}
      stepKey="go_live"
      width={980}
    >
      {signedOut ? (
        <DataState
          action={{ href: "/login?next=%2Fonboarding%2Fgo-live", label: "Sign in" }}
          body="Sign in to see the saved checks for your workspace and finish setup."
          kind="empty"
          title="Sign in to continue"
        />
      ) : error ? (
        <DataState
          body={error}
          kind="error"
          retry={() => void load()}
          title="Setup checks could not load"
        />
      ) : readiness === null ? (
        <DataState kind="loading" rows={6} />
      ) : (
        <div className="flex flex-col gap-[20px]">
          <div className="grid grid-cols-1 items-start gap-[20px] md:grid-cols-2">
            <CheckPanel
              checks={ready}
              emptyLine="Nothing is ready yet. Every check below is still outstanding."
              eyebrow="Working the moment you press the button"
              id="onboarding-go-live-ready"
              name="Ready now"
              sentences={CHECK_READY}
              tone="good"
            />
            <CheckPanel
              checks={waiting}
              emptyLine="Nothing is outstanding."
              eyebrow="Holding the button"
              id="onboarding-go-live-waiting"
              name="Still waiting"
              sentences={CHECK_WAITING}
              tone="warning"
            />
          </div>

          <section aria-labelledby="onboarding-go-live-texting" className={STEP_PANEL_CLASS}>
            <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
              <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                Not part of this button
              </span>
              <h2
                className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                id="onboarding-go-live-texting"
              >
                Text messages
              </h2>
            </div>
            <div className="px-[16px] py-[20px] sm:px-[20px]">
              {carrierDay === null ? (
                <p className="m-0 max-w-[var(--measure-tight)] text-[16px] leading-[1.5] text-[color:var(--muted)]">
                  {carrier.kind === "live"
                    ? "The carriers finished, so your agent can text as well as answer messages."
                    : "Texting is not with the carriers yet. It joins on its own once it is filed and they finish, and nothing here needs doing for that."}
                </p>
              ) : (
                <>
                  <p className="m-0 flex items-baseline gap-[10px]">
                    <span className={`${STEP_MONO_CLASS} text-[46px] leading-[0.92] font-[500] tracking-[-0.075em] text-[color:var(--ink)]`}>
                      {carrierDay}
                    </span>
                    <span className="text-[16px] leading-[1.5] text-[color:var(--muted)]">
                      {`of about ${CARRIER_TYPICAL_DAYS[1]} days`}
                    </span>
                  </p>
                  <p className="m-0 mt-[12px] max-w-[var(--measure-tight)] text-[16px] leading-[1.5] text-[color:var(--muted)]">
                    Your agent starts texting the day the carriers finish, without you coming back.
                    Nobody is told a finish date, so this counter is the whole of what we know.
                  </p>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </OnboardingStepShell>
  );
}

/**
 * One of the board's two lists: the checks in a state, each named and said once.
 *
 * An empty list is a sentence rather than an omitted panel, because "nothing is ready" and
 * "nothing is waiting" are both facts a reader on this screen came for, and a panel that vanished
 * would leave the other one looking like the whole story.
 */
function CheckPanel({
  checks,
  emptyLine,
  eyebrow,
  id,
  name,
  sentences,
  tone,
}: {
  checks: readonly ReadinessCheck[];
  emptyLine: string;
  eyebrow: string;
  id: string;
  name: string;
  sentences: Record<ReadinessKey, string>;
  tone: Tone;
}) {
  return (
    <section aria-labelledby={id} className={STEP_PANEL_CLASS} data-slot={id}>
      <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
        <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
          {eyebrow}
        </span>
        <h2
          className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
          id={id}
        >
          {name}
        </h2>
      </div>

      {checks.length === 0 ? (
        <p className="m-0 max-w-[var(--measure-caption)] px-[16px] py-[20px] text-[20px] leading-[1.35] font-[500] text-[color:var(--muted)] sm:px-[20px]">
          {emptyLine}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {checks.map((check, index) => (
            <li
              className="flex items-start gap-[14px] px-[16px] py-[18px] sm:gap-[18px] sm:px-[20px]"
              key={check.key}
              style={
                index === checks.length - 1
                  ? undefined
                  : { borderBottom: "1px solid var(--line-soft)" }
              }
            >
              <span
                aria-hidden="true"
                className="mt-[8px] size-[10px] flex-none rounded-full"
                style={{ background: TONE_MARK[tone] }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-[17px] leading-[1.3] font-[500] text-[color:var(--ink)]">
                  {CHECK_TITLES[check.key]}
                </span>
                <span className="mt-[4px] max-w-[var(--measure-sentence)] text-[16px] leading-[1.55] text-[color:var(--muted)]">
                  {sentences[check.key]}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
