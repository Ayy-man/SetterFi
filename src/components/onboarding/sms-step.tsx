"use client";

/*
 * Step 3 of 6.
 *
 * The reads, the post and the reduction are unchanged: the same
 * `GET/POST /api/onboarding/sms-eligibility`, the same `carrierReviewFrom(...)` coach Home, the
 * overview rail and the connect step all call, and the same tracking of whether the registration
 * read actually ran.
 *
 * The audit measured seven drenched elements on this one screen against a budget of two, which is
 * the largest single overspend in the coach product. Nothing here is drenched at all. The figure
 * that mattered, the day count, is a figure on an ordinary panel, and the three mono key-value
 * rows the audit called owner-console furniture are gone: "Decided by / The carriers" is a
 * sentence now, and "Starts at / Step 5" was a fact about a step number that has since changed,
 * which is exactly the kind of thing a key-value row hides.
 *
 * The two rules the screen exists to keep are unchanged with it. The clock is a real elapsed-day
 * count and never a percentage or a predicted decision date, because carriers publish no schedule;
 * and nothing reads done or green while the review is outstanding.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { TONE_LINE, TONE_MARK, TONE_TEXT, TONE_WASH, type Tone } from "@/components/kit/atomics";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import {
  OnboardingStepShell,
  STEP_MONO_CLASS,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  STEP_SECONDARY_CLASS,
  nextStepHref,
} from "@/components/onboarding/step-shell";
import { carrierReviewFrom, type CarrierReview } from "@/lib/onboarding/carrier-review";
import {
  CARRIER_TYPICAL_DAYS,
  type ContentScreenMatch,
  type ProvisioningState,
} from "@/lib/onboarding/contracts";
import { workspaceDateFormat } from "@/lib/format/datetime";

type Screen = {
  screenId: string;
  state: "clean" | "flagged" | "confirmed";
  matches: unknown[];
  coachAcknowledgedAt: string | null;
  adminConfirmedAt: string | null;
};
type Registration = { submittedAt: string | null; state: ProvisioningState | null };
type EligibilityPayload = { screen?: Screen | null; registration?: Registration | null };

/** The sentences this screen used to print as help text, handed to the eye instead. */
export const SMS_STEP_EYE_COPY =
  "Carrier rules can permanently refuse credit repair, direct loan marketing and debt reduction. "
  + "A flagged screen needs an explicit acknowledgement and a check by the SetterFi team; the "
  + "acknowledgement is not carrier approval and it files nothing with a carrier by itself. Once "
  + `SetterFi files, carrier vetting typically runs ${CARRIER_TYPICAL_DAYS[0]} to `
  + `${CARRIER_TYPICAL_DAYS[1]} days, and because carriers publish no decision schedule this `
  + "counts real days rather than predicting one. Instagram and Messenger are unaffected by any of "
  + "it, so the rest of your setup keeps working while this waits, and your agent starts texting "
  + "on its own the day the carriers finish.";

/** The one word each state of the review gets, and the tone it wears. */
const REVIEW_STATE: Record<CarrierReview["kind"], { label: string; tone: Tone }> = {
  blocked: { label: "Refused by the carriers", tone: "failure" },
  failed: { label: "Setup needs review", tone: "failure" },
  "in-review": { label: "With the carriers", tone: "waiting" },
  live: { label: "Registered", tone: "good" },
  "not-filed": { label: "Not filed yet", tone: "warning" },
  unchecked: { label: "We could not check this", tone: "neutral" },
};

function isMatch(value: unknown): value is ContentScreenMatch {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as ContentScreenMatch).phrase === "string";
}

async function fetchEligibility() {
  const response = await fetch("/api/onboarding/sms-eligibility", { cache: "no-store" });
  const payload = await response.json() as EligibilityPayload;
  if (!response.ok) throw new Error();
  return payload;
}

export function SmsStep() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState("Loading your texting eligibility…");
  /*
   * Whether the registration read ran, which `registration === null` cannot tell you on its own:
   * the handler returns a null registration for a tenant with no `a2p_campaign` row, and a failed
   * read throws instead. Reducing with `checked: true` on a read that never ran would print
   * "nothing has been filed" on no evidence.
   */
  const [readState, setReadState] = useState<"loading" | "ok" | "failed">("loading");
  const alive = useRef(true);

  const applyEligibility = useCallback((payload: EligibilityPayload) => {
    setScreen(payload.screen ?? null);
    setRegistration(payload.registration ?? null);
    setReadState("ok");
    setStatus(payload.screen
      ? "Saved eligibility evidence loaded."
      : "Eligibility screening has not run yet.");
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await fetchEligibility();
      if (!alive.current) return;
      applyEligibility(payload);
    } catch {
      if (!alive.current) return;
      setReadState("failed");
      setStatus("SMS eligibility could not be loaded.");
    }
  }, [applyEligibility]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void fetchEligibility().then(
      (payload) => {
        if (!cancelled) applyEligibility(payload);
      },
      () => {
        if (cancelled) return;
        setReadState("failed");
        setStatus("SMS eligibility could not be loaded.");
      },
    );
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [applyEligibility]);

  const review = carrierReviewFrom({
    checked: readState === "ok",
    registrationState: registration?.state ?? null,
    submittedAt: registration?.submittedAt ?? null,
    terminalRejection: false,
  });
  const submittedAt = registration?.submittedAt ?? null;

  async function submit() {
    if (!screen || !acknowledged) return;
    setStatus("Recording your acknowledgement…");
    try {
      const response = await fetch("/api/onboarding/sms-eligibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ screenId: screen.screenId }),
      });
      if (!response.ok) throw new Error();
      setStatus("Acknowledgement recorded and logged. An admin must confirm this flagged screen before filing can continue.");
      await load();
    } catch {
      setStatus("Your acknowledgement could not be recorded.");
    }
  }

  const reviewState = REVIEW_STATE[review.kind];
  /*
   * The counter runs on exactly one arm, `in-review`, which is the gate every other carrier
   * surface applies to the same reduction. Everywhere else there is no review to count: nothing
   * before anything is filed, and no figure at all once the review is over, because a clock that
   * keeps climbing after a decision is the wrong number on the page it matters most on.
   */
  const elapsed = review.kind === "in-review" && submittedAt
    ? elapsedWorkspaceDays(submittedAt)
    : null;
  const matches = (screen?.matches ?? []).filter(isMatch);

  return (
    <OnboardingStepShell
      eyeCopy={SMS_STEP_EYE_COPY}
      eyeScreen="onboarding-sms"
      lead="This is the one step nobody here can hurry. The phone carriers vet every business that wants to text in the US."
      primary={
        <Link className={STEP_PRIMARY_CLASS} href={nextStepHref("texting")}>
          Continue to your calendar
        </Link>
      }
      stepKey="texting"
      width={860}
    >
      <div className="flex flex-col gap-[20px]">
        <section aria-labelledby="onboarding-sms-review-heading" className={STEP_PANEL_CLASS}>
          <div className="flex min-h-[78px] flex-col justify-center gap-[8px] border-b border-[var(--line)] px-[16px] py-[19px] sm:flex-row sm:items-center sm:justify-between sm:px-[20px]">
            <div className="min-w-0">
              <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                The carriers keep this clock
              </span>
              <h2
                className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                id="onboarding-sms-review-heading"
              >
                Carrier review
              </h2>
            </div>
            <StatePill label={reviewState.label} tone={reviewState.tone} />
          </div>

          <div className="px-[16px] pt-[22px] pb-[20px] sm:px-[20px]">
            {review.kind === "in-review" ? (
              elapsed === null ? (
                /*
                  Filed, and the filing date did not come back readable. That is an absence, and it
                  is said in words in the figure's own place rather than drawn as a day zero.
                */
                <p className="m-0 max-w-[24ch] text-[20px] leading-[1.35] font-[500] text-[color:var(--muted)]">
                  Your details are with the carriers. The filing date was not recorded, so no day
                  count is shown.
                </p>
              ) : (
                <>
                  <p className="m-0">
                    <span className={`${STEP_MONO_CLASS} text-[62px] leading-[0.92] font-[500] tracking-[-0.075em] text-[color:var(--ink)]`}>
                      {elapsed}
                    </span>
                  </p>
                  <p className="m-0 mt-[10px] text-[16px] leading-[1.55] text-[color:var(--muted)]">
                    {`of about ${CARRIER_TYPICAL_DAYS[1]} days`}
                  </p>
                  <p className="m-0 mt-[16px] max-w-[46ch] text-[16px] leading-[1.5] text-[color:var(--muted)]">
                    {`Filed on ${submittedAt ? workspaceDateFormat.format(new Date(submittedAt)) : "a date we did not record"}. The carriers decide when this finishes and nobody is told a date, so this counter is the whole of what we know.`}
                  </p>
                </>
              )
            ) : (
              <p className="m-0 max-w-[46ch] text-[16px] leading-[1.5] text-[color:var(--muted)]">
                {WAITING_SENTENCE[review.kind]}
              </p>
            )}
          </div>
        </section>

        <section aria-labelledby="onboarding-sms-screen-heading" className={STEP_PANEL_CLASS}>
          <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
            <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
              Run against your saved words
            </span>
            <h2
              className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
              id="onboarding-sms-screen-heading"
            >
              What the carriers will read
            </h2>
          </div>

          <div className="flex flex-col gap-[16px] px-[16px] py-[20px] sm:px-[20px]">
            <p aria-live="polite" className="m-0 text-[16px] leading-[1.4] text-[color:var(--muted)]">
              {status}
            </p>

            {screen ? (
              <p className="m-0 flex items-center gap-[10px] text-[16px] font-[500] text-[color:var(--ink)]">
                <span
                  aria-hidden="true"
                  className="size-[8px] flex-none rounded-full"
                  style={{ background: TONE_MARK[SCREEN_STATE[screen.state].tone] }}
                />
                {SCREEN_STATE[screen.state].label}
              </p>
            ) : null}

            {matches.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
                {matches.map((match, index) => (
                  <li
                    className="flex min-h-[48px] flex-wrap items-center gap-[10px] rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[14px] py-[10px]"
                    key={`${match.phrase}-${index}`}
                  >
                    <span className="text-[16px] font-[500] text-[color:var(--ink)]">
                      {match.phrase}
                    </span>
                    <span className="min-w-0 flex-1 text-[16px] text-[color:var(--body)]">
                      {match.page}
                    </span>
                    <span className="text-[14px] text-[color:var(--warning-text)]">
                      carriers may refuse
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {screen?.state === "flagged" ? (
              <>
                <label className="flex min-h-[48px] items-center gap-[14px] rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[16px] py-[10px] text-[16px] leading-[1.4] text-[color:var(--body)]">
                  <input
                    checked={acknowledged}
                    /* The label is the target and already clears 44px; a checkbox stretched to
                       that height would float away from the sentence beside it. */
                    className="size-[20px] shrink-0 accent-[var(--accent)]"
                    data-coach-target="exempt"
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  I understand this is an acknowledgement, not carrier approval
                </label>
                <button
                  className={`${STEP_SECONDARY_CLASS} w-full sm:w-auto sm:self-start`}
                  disabled={!acknowledged}
                  onClick={() => void submit()}
                  type="button"
                >
                  Record acknowledgement
                </button>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </OnboardingStepShell>
  );
}

/** What the eligibility screen itself found, said once, in its own words. */
const SCREEN_STATE: Record<Screen["state"], { label: string; tone: Tone }> = {
  clean: { label: "Nothing in your words looks like a problem", tone: "good" },
  confirmed: { label: "Checked, and waiting to be filed", tone: "waiting" },
  flagged: { label: "Needs your acknowledgement", tone: "warning" },
};

/** What each non-counting arm of the review says, in the figure's own place. */
const WAITING_SENTENCE: Record<Exclude<CarrierReview["kind"], "in-review">, string> = {
  blocked: "The carriers refused this registration. SetterFi is reviewing what has to change before it is filed again.",
  failed: "Texting setup did not complete. SetterFi owns the next step on this one, and nothing here needs doing.",
  live: "The carriers finished. Your agent can text as well as answer messages.",
  "not-filed": "SetterFi files your details once your business profile is saved, and the carriers' clock starts on the day it does.",
  unchecked: "The carrier registration check did not run, so this screen cannot say where your registration is.",
};

/** The vocabulary's 32px state pill: a dot, then the word. Never pressable. */
function StatePill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className="inline-flex h-[32px] w-fit items-center gap-[8px] rounded-full border px-[12px] text-[15px] leading-none font-[500] whitespace-nowrap"
      style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone], color: TONE_TEXT[tone] }}
    >
      <span
        aria-hidden="true"
        className="size-[8px] flex-none rounded-full"
        style={{ background: TONE_MARK[tone] }}
      />
      {label}
    </span>
  );
}
