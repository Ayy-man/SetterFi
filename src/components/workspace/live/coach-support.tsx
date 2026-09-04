"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DeckPanel } from "@/components/kit/deck-panel";
import { ArrowLeft } from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { STATE_TONE_TO_TONE, Status } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import { displayName, displayText } from "@/lib/format/display-name";
import type { CoachSupportThreadRead, SupportStatus } from "@/lib/repositories/support";
import { COACH_FOOTNOTE_CLASS, COACH_LEAD_CLASS } from "./coach-type";
import { SUPPORT_STATUS_LABELS } from "./support-view-models";

/**
 * The Help route, reduced to what is left of it once the support bubble exists.
 *
 * Spec section 2.9 demotes this page: two panes and a guide library is a help *centre*, and the
 * bubble is the way to ask a person. The audit's section 9 measured what keeping both cost -- two
 * floating circles 250px apart in one corner, three support entry points on a support page, two
 * accent-filled primary actions in view, and `(demo)` printed six times. All of that was the page
 * competing with the bubble to be the way in.
 *
 * So the composer, the request list, the thread selection, the two-pane split, the Support and
 * Guides tabs and the export menu are gone. What is left is the guides list the bubble links to,
 * and -- deliberately, beyond the brief -- the coach's own past requests, read only.
 *
 * That second half is an addition and it is worth saying why. The bubble shows the coach's most
 * recently updated request and only that one, so with this page reduced to guides alone, a coach
 * with three requests would have had no way to read the other two. Deleting a person's record of
 * what they asked us is not a presentation change, and the brief was about the page's *centre*
 * being a help centre rather than about the record. It is read only: writing happens in the
 * bubble, so there is still exactly one place to say something and one thing to press.
 *
 * **The guides do not exist yet, and the page says so at the scale of the page.** There is no
 * coach guide catalogue anywhere in the tree: `lib/admin-help-guides.ts` is operator runbooks whose
 * own docblock says a coach must never see them, and nothing under `src/app/api` serves a coach
 * one. The absence is stated in words where the list would be, which is the canvas rule, rather
 * than filled with headings somebody would then have to write copy behind.
 */

type CoachSupportProps = { enabled: boolean };

const STATUS_TONES: Record<SupportStatus, StateTone> = {
  open: "info",
  waiting_on_coach: "warning",
  resolved: "good",
};

/* The absence line the canvas specifies: 20px/500 muted, capped short, and the card ends after it. */
const ABSENCE_CLASS =
  "m-0 max-w-[34ch] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]";
const MESSAGE_BODY_CLASS =
  "m-0 mt-[8px] max-w-[var(--measure-prose)] whitespace-pre-wrap text-[16px] leading-[1.6] text-[color:var(--body)]";

/* The sentences this screen used to print as help text, handed to the eye instead. */
const HELP_EYE_COPY =
  "The guides are written explanations of the five screens, and they are not written yet. To ask a "
  + "person, use the round button in the bottom corner of any screen: it opens the same "
  + "conversation this page lists, and a message sent there reaches our team rather than your "
  + "leads. Requests here are read only for that reason, so there is one place to write and one "
  + "place to read. Nothing on this page is visible to a lead.";

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(date);
}

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * Local rather than `PageHeader` for the reason `LeadsHead` documents: `PageHeader` sets its
 * title with `.t-page-title`, the console's 20px, and no prop moves it.
 */
function HelpHead() {
  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="help">
      <Link
        className="inline-flex min-h-[44px] items-center gap-[8px] px-[2px] text-[16px] leading-[1.4] font-medium text-[color:var(--accent-text)] no-underline hover:underline"
        data-slot="help-back"
        href="/coach/home"
      >
        <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
        Back to Home
      </Link>
      <h1 className="coach-page-title m-0">Guides</h1>
      <p className={`m-0 max-w-[var(--measure-prose)] ${COACH_LEAD_CLASS}`}>
        Written explanations of the five screens, and everything you have already asked us.
      </p>
    </header>
  );
}

export function CoachSupport({ enabled }: CoachSupportProps) {
  const [threads, setThreads] = useState<readonly CoachSupportThreadRead[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">(
    enabled ? "loading" : "error",
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/support/threads", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        const rows = (payload as { threads?: unknown } | null)?.threads;
        if (!response.ok || !Array.isArray(rows)) throw new Error("SUPPORT_READ_FAILED");
        if (controller.signal.aborted) return;
        setThreads(rows as CoachSupportThreadRead[]);
        setState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        void error;
        setState("error");
      }
    })();
    return () => controller.abort();
  }, [enabled]);

  return (
    <div className="flex min-w-0 flex-col gap-[24px]">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-[24px]">
        <HelpHead />
        <ContextEye copy={HELP_EYE_COPY} placement="header" scale="coach" screen="coach-help" />
      </div>

      <DeckPanel
        eyebrow="Written by your coaching team"
        headingId="coach-guides"
        name="Guides"
      >
        <p className={ABSENCE_CLASS}>No guides have been written yet.</p>
        <p className={`m-0 mt-[12px] max-w-[var(--measure-prose)] ${COACH_FOOTNOTE_CLASS}`}>
          Until they are, the round button in the corner of every screen reaches a person, and Tips
          and trainings carries the videos your coaching team has already recorded.
        </p>
      </DeckPanel>

      <DeckPanel
        eyebrow="Read only, because the corner button is where you write"
        headingId="coach-support-requests"
        name="What you have asked us"
      >
        {state === "loading" ? (
          <p className="m-0 text-[16px] leading-[1.55] text-[color:var(--muted)]" role="status">
            Reading your requests.
          </p>
        ) : null}
        {state === "error" ? (
          <p className={ABSENCE_CLASS}>
            {enabled
              ? "Your requests could not be read just now."
              : "Support messaging is not active for this workspace."}
          </p>
        ) : null}
        {state === "ready" && threads.length === 0 ? (
          <p className={ABSENCE_CLASS}>You have not written to us yet.</p>
        ) : null}
        {state === "ready" && threads.length > 0 ? (
          <ul aria-label="Support requests" className="m-0 flex list-none flex-col p-0">
            {threads.map((thread) => (
              <li
                className="border-t border-[var(--line-soft)] py-[20px] first:border-t-0 first:pt-0"
                key={thread.id}
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-[12px]">
                  <h3 className="m-0 min-w-0 text-[17px] leading-[1.35] font-medium text-[color:var(--ink)]">
                    {displayText(thread.subject)}
                  </h3>
                  <Status
                    label={SUPPORT_STATUS_LABELS[thread.status]}
                    tone={STATE_TONE_TO_TONE[STATUS_TONES[thread.status]]}
                    treatment="pill"
                  />
                </div>
                {thread.messages.map((message) => (
                  <article className="mt-[16px]" key={message.id}>
                    <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
                      {displayName(message.authorName ?? "Support team")}
                      {", "}
                      {timestamp(message.createdAt)}
                    </p>
                    <p className={MESSAGE_BODY_CLASS}>{displayText(message.body)}</p>
                  </article>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
      </DeckPanel>
    </div>
  );
}
