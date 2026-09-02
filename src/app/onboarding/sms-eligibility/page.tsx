"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  KitButton,
  Prose,
  Status,
  Surface,
} from "@/components/kit/atomics";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { DayCounter } from "@/components/kit/day-counter";
import { carrierReviewFrom } from "@/lib/onboarding/carrier-review";
import { CARRIER_TYPICAL_DAYS, type ProvisioningState } from "@/lib/onboarding/contracts";

type Screen = { screenId: string; state: "clean" | "flagged" | "confirmed"; matches: unknown[]; coachAcknowledgedAt: string | null; adminConfirmedAt: string | null };
type Registration = { submittedAt: string | null; state: ProvisioningState | null };
type EligibilityPayload = { screen?: Screen | null; registration?: Registration | null };

async function fetchEligibility() {
  const response = await fetch("/api/onboarding/sms-eligibility", { cache: "no-store" });
  const payload = await response.json() as EligibilityPayload;
  if (!response.ok) throw new Error();
  return payload;
}

export default function SmsEligibilityPage() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState("Loading SMS eligibility…");
  /*
   * Whether the registration read ran, which `registration === null` cannot tell you on its own.
   *
   * The handler returns a null registration both for a tenant with no `a2p_campaign` row -- a
   * successful read establishing that nothing is filed -- and never for a failed one, because a
   * failed read throws and leaves this page's state untouched. Reducing with `checked: true` on a
   * read that never ran would print "nothing has been filed" on no evidence, which is the arm
   * `carrierReviewFrom` has `unchecked` for.
   */
  const [readState, setReadState] = useState<"loading" | "ok" | "failed">("loading");
  const alive = useRef(true);

  const applyEligibility = useCallback((payload: EligibilityPayload) => {
    setScreen(payload.screen ?? null);
    setRegistration(payload.registration ?? null);
    setReadState("ok");
    setStatus(payload.screen
      ? "Saved eligibility evidence loaded."
      : "Eligibility screening has not run yet. SMS cannot progress until it does.");
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

  /*
   * The registration reduced through the same function coach Home and Connections call.
   *
   * This page used to key every branch off `submittedAt` alone while `state` sat unread on the
   * payload the handler already sends, so a registration that finished, failed or was blocked
   * still rendered "With the carriers" over a day counter that never stopped -- day 47 of a
   * review that ended on day 19, on the surface whose entire subject is that clock. `terminalRejection` is
   * not carried on this payload, so `blocked` reaches the reduction through the state instead.
   */
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
      setStatus("Acknowledgement recorded and logged. An admin must confirm this flagged screen before A2P filing can continue.");
      await load();
    } catch {
      setStatus("Your acknowledgement could not be recorded.");
    }
  }

  return (
    <OnboardingStage
      lead="Carrier rules can permanently refuse credit repair, direct loan marketing, and debt reduction. A flagged screen needs an explicit acknowledgement and a check by our team; it does not file anything with a carrier by itself."
      title="Can your business send texts"
      width="narrow"
    >
      <div className="flex flex-col gap-[var(--s-5)]">

        {/*
          * The carrier's clock, gated on the registration's state rather than on its filing date.
          *
          * Two things were wrong here and they compounded. The page counted its own days off
          * `Date.now()` with a `+1`, so a registration filed an hour ago read "day 1" while every
          * other surface read "Day 0"; that was fixed on 2026-08-31 by rendering the shared
          * `DayCounter`. What survived was worse: `registration.state` was fetched, typed and sent
          * over the wire, and this page read only `submittedAt`. A filing date never gets cleared,
          * so once the `a2p_campaign` step reached `done`, `failed` or `blocked` the surface whose
          * whole subject is the A2P clock kept rendering "With the carriers" in warning tone over a
          * counter that climbed forever -- day 47 of a review that ended on day 19. That is the
          * honest-states rule broken directly, on the page it matters most on.
          *
          * The counter now appears on exactly one arm, `in-review`, which is the same gate
          * `coach-integrations.tsx` and `CoachCarrierNotice` apply to the same reduction. No arm
          * renders a percentage or a predicted decision date, because carriers publish no decision
          * schedule and inventing one is the completion theatre `CLAUDE.md` forbids. `unchecked`
          * says the read did not run instead of inferring from its silence, and `blocked` reuses
          * the sentence Connections already prints for the same event.
          */}
        <Surface
          className="flex flex-col gap-[var(--s-3)]"
          tone={review.kind === "in-review" ? "warning" : review.kind === "blocked" || review.kind === "failed" ? "failure" : "neutral"}
        >
          <p className={COACH_EYEBROW_CLASS}>Carrier review</p>
          {readState === "loading" ? (
            <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>
              Checking where carrier registration stands.
            </Prose>
          ) : null}

          {review.kind === "in-review" && submittedAt ? (
            <>
              <Status label="With the carriers" tone="warning" />
              <div className="surface-well">
                <DayCounter since={submittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
              </div>
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--warning-body)]`}>
                Carriers have not supplied a decision schedule, so this counts days rather than
                predicting one.
              </Prose>
            </>
          ) : null}

          {/*
            Filed, but the filing date was never recorded. `CoachCarrierNotice` handles the same
            hole the same way: the wait is real so the state is stated, and nothing is counted,
            because counting from today would claim we filed this morning.
          */}
          {review.kind === "in-review" && !submittedAt ? (
            <>
              <Status label="With the carriers" tone="warning" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--warning-body)]`}>
                Carrier review is recorded, but its filing date was not, so no day count is shown.
              </Prose>
            </>
          ) : null}

          {review.kind === "live" ? (
            <>
              <Status label="Carrier review complete" tone="good" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                Carrier registration is complete, so there is no review left to count. SetterFi is
                reconciling the channel receipts before text messaging can send.
              </Prose>
            </>
          ) : null}

          {review.kind === "failed" ? (
            <>
              <Status label="Setup needs review" tone="failure" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                Text messaging setup did not complete, so the carrier review is over rather than
                running. SetterFi is reviewing the saved failure and owns the next step.
              </Prose>
            </>
          ) : null}

          {review.kind === "blocked" ? (
            <>
              <Status label="Blocked" tone="failure" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                Carrier registration was permanently declined. SetterFi is reviewing the decision
                and the saved registration evidence.
              </Prose>
            </>
          ) : null}

          {review.kind === "not-filed" ? (
            <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>
              A2P registration has not been filed with carriers, so no external review has started
              and there is nothing yet to count.
            </Prose>
          ) : null}

          {review.kind === "unchecked" && readState === "failed" ? (
            <>
              <Status label="We could not check this" tone="neutral" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>
                The carrier registration check did not run, so nothing here can claim a review
                state. No state was inferred from the failed read.
              </Prose>
            </>
          ) : null}
        </Surface>

        <Surface className="flex flex-col gap-[var(--s-4)]">
          <p
            aria-live="polite"
            className={`surface-well m-0 ${COACH_READING_CLASS} text-[color:var(--body)]`}
          >
            {status}
          </p>

          {screen?.state === "clean" ? (
            <div className="flex flex-col gap-[var(--s-2)]">
              <Status label="Screen cleared" tone="good" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                The deterministic screen found no flagged content. Carrier filing and review remain
                separate external steps, so this is not an approval.
              </Prose>
            </div>
          ) : null}

          {screen?.state === "confirmed" ? (
            <div className="flex flex-col gap-[var(--s-2)]">
              <Status label="Awaiting filing" tone="waiting" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                The flagged screen was acknowledged and an admin confirmed it. This still does not
                mean carrier registration is approved.
              </Prose>
            </div>
          ) : null}

          {screen?.state === "flagged" ? (
            <div className="flex flex-col gap-[var(--s-3)]">
              <Status label="Needs your acknowledgement" tone="warning" />
              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                The saved screen found {screen.matches.length} item
                {screen.matches.length === 1 ? "" : "s"}. Correct the source content and re-run
                screening, or acknowledge that an admin must review it before filing.
              </Prose>
              <label className={`surface-well flex min-h-[var(--coach-target)] items-start gap-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--body)]`}>
                <input
                  checked={acknowledged}
                  /* The label is the target and already clears 44px; a checkbox stretched to that
                     height would float away from the first line of the sentence beside it. */
                  className="mt-[4px] size-[20px] shrink-0 accent-[var(--accent)]"
                  data-coach-target="exempt"
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  type="checkbox"
                />
                I understand this is an acknowledgement, not carrier approval.
              </label>
              <div className="flex flex-wrap items-center gap-[var(--s-3)]">
                <KitButton
                  className="h-[var(--coach-target-primary)] px-[28px] text-[18px]"
                  disabled={!acknowledged}
                  onClick={() => void submit()}
                  size="lg"
                  variant="primary"
                >
                  Record acknowledgement
                </KitButton>
                <span className={COACH_FOOTNOTE_CLASS}>
                  Your acknowledgement is logged in the onboarding audit trail.
                </span>
              </div>
            </div>
          ) : null}
        </Surface>
      </div>
    </OnboardingStage>
  );
}
