"use client";

/*
 * Step 5 of setup, drawn from `OnboardingSms.body.html`.
 *
 * The reads, the post and the reduction are the live page's, unchanged: the same
 * `GET/POST /api/onboarding/sms-eligibility`, the same `carrierReviewFrom(...)` that coach Home
 * and Connections call, the same tracking of whether the registration read actually ran.
 *
 * The two rules this screen exists to keep are unchanged with it. The clock is a day count and
 * never a percentage or a predicted decision date, because carriers publish no schedule; and
 * nothing on the screen reads done or green while the review is outstanding. The paragraphs that
 * used to explain carrier rules are the eye's now.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { KitButton, StatusDot, kitButtonClass } from "@/components/kit/atomics";
import type { Tone } from "@/components/kit/atomics";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ShieldCheck } from "@/components/kit/icons";
import Link from "next/link";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Figure } from "@/components/workspace/rehaul/_primitives";
import {
  ONBOARDING_MONO_CLASS,
  OnboardingFooter,
  OnboardingShell,
} from "@/components/workspace/rehaul/onboarding-shell";
import { carrierReviewFrom, type CarrierReview } from "@/lib/onboarding/carrier-review";
import {
  CARRIER_TYPICAL_DAYS,
  type ContentScreenMatch,
  type ProvisioningState,
} from "@/lib/onboarding/contracts";
import { workspaceDateFormat } from "@/lib/format/datetime";

type Screen = { screenId: string; state: "clean" | "flagged" | "confirmed"; matches: unknown[]; coachAcknowledgedAt: string | null; adminConfirmedAt: string | null };
type Registration = { submittedAt: string | null; state: ProvisioningState | null };
type EligibilityPayload = { screen?: Screen | null; registration?: Registration | null };

/** The sentences this screen used to print as help text, handed to the eye instead. */
export const ONBOARDING_SMS_EYE_COPY =
  "Carrier rules can permanently refuse credit repair, direct loan marketing and debt reduction. "
  + "A flagged screen needs an explicit acknowledgement and a check by the SetterFi team; the "
  + "acknowledgement is not carrier approval and it files nothing with a carrier by itself. Once "
  + `SetterFi files, carrier vetting typically runs ${CARRIER_TYPICAL_DAYS[0]} to `
  + `${CARRIER_TYPICAL_DAYS[1]} days, and because carriers publish no decision schedule this `
  + "counts real days rather than predicting one. Instagram and Messenger are unaffected by any "
  + "of it, so the rest of your setup keeps working while this waits.";

/** The one line the dark panel gets, per state of the review. */
const REVIEW_STATE: Record<CarrierReview["kind"], { label: string; tone: Tone }> = {
  blocked: { label: "Blocked", tone: "failure" },
  failed: { label: "Setup needs review", tone: "failure" },
  "in-review": { label: "With the carriers", tone: "warning" },
  live: { label: "Carrier review complete", tone: "good" },
  "not-filed": { label: "Nothing is with the carriers yet", tone: "warning" },
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

function DarkRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--coach-on-drench-line)] py-[13px] text-[15px]">
      <span className="text-[color:var(--coach-on-drench-sub)]">{label}</span>
      <span className={`${ONBOARDING_MONO_CLASS} text-[color:var(--on-accent)]`}>{value}</span>
    </div>
  );
}

export function OnboardingSmsRehaul() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState("Loading SMS eligibility…");
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
   * The counter runs on exactly one arm, `in-review`, which is the gate the two workspace surfaces
   * apply to the same reduction. Everywhere else there is no review to count: day 0 before
   * anything is filed, and no figure at all once the review is over, because a clock that keeps
   * climbing after a decision is the wrong number on the page it matters most on.
   */
  const elapsed = review.kind === "in-review" && submittedAt
    ? elapsedWorkspaceDays(submittedAt)
    : null;
  const dayFigure = review.kind === "in-review"
    ? (elapsed === null ? null : `day ${elapsed}`)
    : review.kind === "not-filed"
      ? "day 0"
      : null;
  const matches = (screen?.matches ?? []).filter(isMatch);
  const waitingSentence = review.kind === "unchecked"
    ? "The carrier registration check did not run."
    : review.kind === "live"
      ? "Carrier registration is complete."
      : review.kind === "failed"
        ? "Text messaging setup did not complete. SetterFi owns the next step."
        : review.kind === "blocked"
          ? "Carrier registration was permanently declined. SetterFi is reviewing it."
          : null;

  return (
    <OnboardingShell
      status={[{ label: reviewState.label, tone: reviewState.tone }]}
      step={5}
      title="Can your business send texts"
    >
      <div className="grid grid-cols-1 items-stretch gap-[20px] @min-[900px]/onboarding:grid-cols-[420px_minmax(0,1fr)]">
        <DeckPanel
          className="flex flex-col"
          dataSlot="rehaul-sms-review"
          drench="info"
          eyebrow="The carriers keep this clock"
          headingId="rehaul-sms-review"
          name="Carrier review"
        >
          <div className="flex h-full flex-col gap-[16px]">
            {dayFigure ? (
              <>
                <Figure className="text-[color:var(--on-accent)]" size="hero">{dayFigure}</Figure>
                <p className={`m-0 text-[14px] text-[color:var(--coach-on-drench-sub)] ${ONBOARDING_MONO_CLASS}`}>
                  {`typically ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days once filed`}
                </p>
              </>
            ) : null}

{/*
              Only the arms with no figure get a line, and each states what happened rather than
              explaining it. The two waiting arms carry the day count above instead: their sentence
              was the eye's own wording about carriers publishing no schedule.
            */}
            {waitingSentence ? (
              <p className="m-0 max-w-[var(--measure-deck)] text-[16px] leading-[1.5] text-[color:var(--coach-on-drench-sub)]">
                {waitingSentence}
              </p>
            ) : null}

            <div className="mt-auto flex flex-col">
              <DarkRow
                label="Filed on"
                value={review.kind === "in-review" && submittedAt
                  ? workspaceDateFormat.format(new Date(submittedAt))
                  : "Not filed"}
              />
              <DarkRow label="Decided by" value="The carriers" />
              <DarkRow label="Instagram and Messenger" value="Unaffected" />
            </div>
          </div>
        </DeckPanel>

        <div className="flex min-w-0 flex-col gap-[20px]">
          <DeckPanel
            dataSlot="rehaul-sms-screen"
            eyebrow="Run against your saved words"
            headingId="rehaul-sms-screen"
            meta={
              <span className={`text-[14px] text-[color:var(--warning-text)] ${ONBOARDING_MONO_CLASS}`}>
                {`${matches.length} item${matches.length === 1 ? "" : "s"}`}
              </span>
            }
            name="Eligibility screen"
          >
            <div className="flex flex-col gap-[14px]">
              <p aria-live="polite" className="m-0 text-[15px] leading-[1.4] text-[color:var(--muted)]">
                {status}
              </p>

              {screen ? (
                <p className="m-0 flex items-center gap-[10px] text-[16px] font-medium text-[color:var(--ink)]">
                  <StatusDot
                    size={6}
                    tone={screen.state === "flagged" ? "warning" : screen.state === "confirmed" ? "waiting" : "good"}
                  />
                  {screen.state === "flagged"
                    ? "Needs your acknowledgement"
                    : screen.state === "confirmed"
                      ? "Awaiting filing"
                      : "Screen cleared"}
                </p>
              ) : null}

              {matches.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
                  {matches.map((match, index) => (
                    <li
                      className="flex min-h-[48px] flex-wrap items-center gap-[14px] rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[14px] py-[8px]"
                      key={`${match.phrase}-${index}`}
                    >
                      <span className={`w-[170px] text-[15px] font-medium text-[color:var(--ink)] ${ONBOARDING_MONO_CLASS}`}>
                        {match.phrase}
                      </span>
                      <span className="min-w-0 flex-1 text-[15px] text-[color:var(--body)]">{match.page}</span>
                      <span className={`text-[14px] text-[color:var(--warning-text)] ${ONBOARDING_MONO_CLASS}`}>
                        carriers may refuse
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </DeckPanel>

          <DeckPanel
            dataSlot="rehaul-sms-agreement"
            eyebrow="Before anything is filed"
            headingId="rehaul-sms-agreement"
            name="What you are agreeing to"
          >
            <div className="flex flex-col gap-[16px]">
              <label className="flex min-h-[48px] items-center gap-[14px] rounded-[10px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] py-[10px] text-[16px] leading-[1.4] text-[color:var(--body)]">
                <input
                  checked={acknowledged}
                  /* The label is the target and already clears 44px; a checkbox stretched to that
                     height would float away from the sentence beside it. */
                  className="size-[20px] shrink-0 accent-[var(--accent)]"
                  data-coach-target="exempt"
                  disabled={screen?.state !== "flagged"}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  type="checkbox"
                />
                I understand this is an acknowledgement, not carrier approval
              </label>

              <div className="flex flex-wrap items-center gap-[16px] border-t border-[var(--line-soft)] pt-[16px]">
                <KitButton
                  className="h-[48px] px-[28px] text-[17px]"
                  disabled={!acknowledged || screen?.state !== "flagged"}
                  onClick={() => void submit()}
                  size="lg"
                  variant="primary"
                >
                  Record acknowledgement
                </KitButton>
                <span className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]">
                  <ShieldCheck aria-hidden className="size-[16px]" />
                  Logged in your onboarding audit trail
                </span>
                <Link
                  className={kitButtonClass({
                    className: "h-[48px] px-[22px] text-[16px] no-underline",
                    variant: "secondary",
                  })}
                  href="/onboarding"
                >
                  Finish setup without texting
                </Link>
              </div>
            </div>
          </DeckPanel>
        </div>
      </div>

      <OnboardingFooter
        actions={
          <Link
            className={kitButtonClass({
              className: "h-[48px] px-[22px] text-[16px] no-underline",
              variant: "secondary",
            })}
            href="/onboarding/calendar"
          >
            Back
          </Link>
        }
        sentence="Filing starts the carriers' own review; nothing here approves your business to send."
      />

      <ContextEye copy={ONBOARDING_SMS_EYE_COPY} screen="onboarding-sms" />
    </OnboardingShell>
  );
}
