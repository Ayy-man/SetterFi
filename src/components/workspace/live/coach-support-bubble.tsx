"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { ChatIcon, FileText, Play, Send, X } from "@/components/kit/icons";
import { displayName, displayText } from "@/lib/format/display-name";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";

/**
 * The coach's support bubble, rebuilt from `design/coach/SupportBubble.dc.html`.
 *
 * What it was: a launcher that opened three questions with chevrons, each linking to the screen
 * that answers it, over a "Message a person" button that navigated to `/coach/help`. That shape
 * came from an earlier artboard and it made the bubble a menu. The current drawing makes it the
 * conversation itself -- a named person, the messages already exchanged, one field and Send -- and
 * spec section 2.9 is explicit about why: two panes and a guide library is a help *centre*, and a
 * bubble is a way to ask a person. Nothing about that is reachable from a list of links.
 *
 * The thread is real. It reads `/api/support/threads`, the same endpoint the Help page reads, and
 * posts to the same message and thread endpoints, so a message sent here is the same object a
 * support operator picks up in the platform inbox. Nothing is stored in the browser.
 *
 * **Two things the artboard prints that are not here, and both are the same rule.** The drawing
 * gives its support person the line "Usually replies within the hour" and the panel the footer
 * "Open until 6pm". Neither is recorded anywhere in this codebase: there is no first-response
 * target, no staffed-hours window, and no support rota. Printing either would be the product
 * promising on behalf of a team that has never agreed to it, which is the same class of mistake as
 * a predicted carrier-review date. In their place the header carries a fact the thread does carry
 * -- what state the request is in -- and the footer carries only the two destinations.
 *
 * The person's name is real too, and derived rather than configured: a coach thread is always
 * opened by the coach, so the first message's author is the coach and the most recent message from
 * anybody else is the person answering them. With nobody yet answering, the panel says
 * "SetterFi support" rather than inventing a first name.
 */

export type CoachSupportBubbleProps = {
  /**
   * The coach's first name, used to label their own messages. Omitted -- and it will be omitted,
   * because a workspace can be opened by a team member whose own name we do not have on this
   * render -- their messages are labelled "You". A message addressed to the wrong person is worse
   * than one addressed to nobody.
   */
  coachName?: string;
  /** Where "Read the guides" goes. The Help route, which is the guides list. */
  helpHref?: string;
  /** Where "Tips and trainings" goes. */
  tipsHref?: string;
  /** Opens mounted. For a screen that arrives from "get help" and for tests; not a shell prop. */
  defaultOpen?: boolean;
  className?: string;
};

/**
 * The subject a thread opened from this panel carries.
 *
 * The panel has one field, and a thread needs a subject the support inbox can list. Rather than
 * take the first line of the coach's message and call it a title -- which turns half a sentence
 * into a heading and reads as a bug in the operator's queue -- the subject states where the
 * request came from, which is a fact and is the thing an operator most wants at a glance.
 */
const BUBBLE_THREAD_SUBJECT = "Message from the dashboard";

const STATUS_LINE = {
  open: "With our team",
  waiting_on_coach: "Waiting on you",
  resolved: "Resolved",
} as const;

/*
 * The coach scale, restated locally the way `coach-billing.tsx` does it. Every pressable thing in
 * here clears 44px without relying on `coach.css` to stretch it, because this component is
 * designed to be mountable outside a `[data-shell-role="coach"]` subtree: a control whose target
 * only exists because an ancestor stylesheet raised its `min-height` breaks silently when it is
 * re-parented.
 */
const SEND_CLASS =
  "inline-flex h-[48px] items-center justify-center gap-[10px] rounded-[9px] border "
  + "border-[var(--accent-line)] [background:var(--accent-fill)] px-[24px] text-[16px] leading-none "
  + `font-semibold text-[color:var(--on-accent)] ${ACCENT_FILL_SHADOW_CLASS} `
  + "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
const FOOTER_LINK_CLASS =
  "inline-flex min-h-[44px] items-center gap-[10px] px-[2px] text-[16px] leading-[1.4] "
  + "text-[color:var(--accent-text)] no-underline hover:underline";
const META_CLASS = "mt-[6px] text-[14px] leading-[1.4] text-[color:var(--muted)]";

function initialsFor(name: string): string {
  const tokens = name.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  return tokens.map((token) => token[0]!.toUpperCase()).join("") || "SF";
}

function timeLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(parsed);
}

/**
 * The thread the panel shows: the coach's most recently updated request.
 *
 * One rather than a list, because a list is the Help page and this is not it. A coach with three
 * open requests reaches the other two through "Read the guides"'s neighbour route; a coach with
 * one -- which is nearly all of them -- never has to choose.
 */
function newestThread(threads: readonly CoachSupportThreadRead[]): CoachSupportThreadRead | null {
  let newest: CoachSupportThreadRead | null = null;
  for (const thread of threads) {
    if (!newest || thread.updatedAt > newest.updatedAt) newest = thread;
  }
  return newest;
}

/** The support person answering this thread, derived from who did not open it. */
function responderName(thread: CoachSupportThreadRead | null): string {
  if (!thread) return "SetterFi support";
  const opener = thread.messages[0]?.authorId;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.authorId !== opener && message.authorName) return displayName(message.authorName);
  }
  return "SetterFi support";
}

type LoadState = "idle" | "loading" | "ready" | "error";

export function CoachSupportBubble({
  className,
  coachName,
  defaultOpen = false,
  helpHref = "/coach/help",
  tipsHref = "/coach/tips",
}: CoachSupportBubbleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<LoadState>("idle");
  const [thread, setThread] = useState<CoachSupportThreadRead | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const panelId = useId();
  const headingId = useId();
  const fieldId = useId();
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /*
   * Whether the last close should hand focus back. A close the coach asked for -- Escape, the X,
   * a click outside -- must return the caret to the launcher, or a keyboard user is dropped at
   * the top of the document. A bubble that was simply never opened must not steal focus on mount.
   */
  const returnFocusRef = useRef(false);
  /*
   * Whether the read has been started, as a ref rather than as the `state` value.
   *
   * This was `state !== "idle"` in the effect's own dependency list, and it aborted its own
   * request every time: setting "loading" inside the effect re-ran it, React tore the previous run
   * down first, and the teardown called `controller.abort()` on the fetch that had just been
   * issued. A ref is read by the effect without being a dependency of it, which is exactly the
   * difference that matters here.
   */
  const readStartedRef = useRef(false);

  const close = useCallback(() => {
    returnFocusRef.current = true;
    setOpen(false);
  }, []);

  /*
   * The thread is read when the panel opens, not when the shell mounts. The bubble is on every
   * coach page, so a read on mount would be one request per navigation for a panel most coaches
   * never open -- and the round-trip budget in `docs/BACKEND-SPEC.md` section 9.1 is the reason
   * that matters: a bare trip to the Supabase region costs 300 to 360ms whatever it fetches.
   */
  useEffect(() => {
    if (!open || readStartedRef.current) return;
    readStartedRef.current = true;
    setState("loading");
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/support/threads", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        const threads = (payload as { threads?: unknown } | null)?.threads;
        if (!response.ok || !Array.isArray(threads)) throw new Error("SUPPORT_READ_FAILED");
        if (controller.signal.aborted) return;
        setThread(newestThread(threads as CoachSupportThreadRead[]));
        setState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        void error;
        setState("error");
      }
    })();
    return () => controller.abort();
  }, [open]);

  /*
   * Escape on the document rather than on the panel, because the panel is deliberately not a
   * focus trap: it is a non-modal helper floating over a page the coach can keep reading and
   * clicking. Focus can therefore legitimately be outside it while it is open.
   */
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  /*
   * A pointer press anywhere else closes it, which is what every reader expects of a thing that
   * floats over the page. `pointerdown` rather than `click` so the panel is gone before the press
   * lands on whatever is underneath, and so a press that starts inside and drags out does not
   * count as leaving.
   */
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (launcherRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  /* Focus the panel itself on open, and the launcher again on a close the coach asked for. */
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
      return;
    }
    if (returnFocusRef.current) {
      returnFocusRef.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const response = thread
        ? await fetch(`/api/support/threads/${thread.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        })
        : await fetch("/api/support/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: BUBBLE_THREAD_SUBJECT, body }),
        });
      const payload: unknown = await response.json();
      const saved = (payload as { thread?: unknown } | null)?.thread;
      if (!response.ok || !saved) throw new Error("SUPPORT_SEND_FAILED");
      /* The saved thread, read back from the server. Nothing is added optimistically: a message
         that only exists in this browser is the one thing a coach must never be shown as sent. */
      setThread(saved as CoachSupportThreadRead);
      setState("ready");
      setDraft("");
    } catch (error) {
      void error;
      setSendError("That did not send. Nothing was added to your request.");
    } finally {
      setSending(false);
    }
  }

  const person = responderName(thread);
  const opener = thread?.messages[0]?.authorId;
  const statusLine = thread ? STATUS_LINE[thread.status] : "Ask us anything about your agent";

  return (
    <div
      /*
       * The artboard's 32px offsets from `sm` up. Below it the coach's five destinations are a
       * `fixed` 56px tab bar on the bottom edge (`coach-pillbar.tsx`), and a launcher at 32px from
       * the bottom lands on top of Leads. The phone offset clears the bar, its own safe-area inset,
       * and 16px of air -- the same expression `<main>` pads with in `app-shell.tsx`, so the two
       * stay in step if the bar's height moves.
       *
       * `coach.css` reserves this corner as page padding (`--coach-bubble-reserve`), so the
       * launcher covers nothing.
       */
      className={`fixed right-[16px] bottom-[calc(56px+16px+env(safe-area-inset-bottom))] z-50 flex flex-col items-end gap-[16px] sm:right-[32px] sm:bottom-[32px] ${className ?? ""}`}
      data-slot="coach-support-bubble"
    >
      {open ? (
        <div
          aria-labelledby={headingId}
          className={[
            "flex max-h-[min(620px,calc(100vh-160px))] w-[min(420px,calc(100vw-32px))] flex-col",
            "overflow-hidden rounded-[24px_24px_17px_17px]",
            "border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
            "shadow-[var(--shadow-raised)] outline-none",
            /*
             * The one animation, and it is opt-in rather than opt-out: the keyframes only exist
             * inside `motion-safe`, so a reader who has asked their system for less motion gets a
             * panel that is simply there, with no `animation` property to override.
             */
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-[var(--duration-quick)]",
          ].join(" ")}
          data-slot="coach-support-panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex flex-none items-center justify-between gap-[12px] border-b border-[var(--line)] px-[20px] py-[16px]">
            <div className="flex min-w-0 items-center gap-[12px]">
              <span
                aria-hidden
                className="grid size-[44px] flex-none place-items-center rounded-full border border-[var(--accent-edge)] bg-[var(--accent-wash)] font-[family-name:var(--font-mono)] text-[16px] text-[color:var(--accent-text)]"
              >
                {initialsFor(person)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className="truncate text-[17px] leading-[1.35] font-medium text-[color:var(--ink)]"
                  id={headingId}
                >
                  {person}
                </span>
                <span className="truncate text-[14px] leading-[1.4] text-[color:var(--muted)]">
                  {statusLine}
                </span>
              </span>
            </div>
            <button
              aria-label="Close support"
              className="grid size-[44px] flex-none place-items-center rounded-[10px] border border-[var(--line)] bg-[var(--well)] text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]"
              onClick={close}
              type="button"
            >
              <X size={20} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-[20px] py-[18px]">
            {state === "loading" ? (
              <p className="m-0 text-[16px] leading-[1.55] text-[color:var(--muted)]" role="status">
                Reading your conversation with us.
              </p>
            ) : null}
            {/*
              A failed read is said as a failed read. The alternative -- an empty panel with a
              composer in it -- tells a coach they have never written to us, which may be false and
              is the one thing they would act on.
            */}
            {state === "error" ? (
              <p className="m-0 text-[16px] leading-[1.55] text-[color:var(--muted)]" role="status">
                We could not read your conversation just now. You can still write to us below, and
                the whole thread is on the guides page.
              </p>
            ) : null}
            {state === "ready" && !thread ? (
              <p className="m-0 text-[16px] leading-[1.55] text-[color:var(--muted)]">
                You have not written to us yet. Say what is happening and a person reads it.
              </p>
            ) : null}
            {thread ? (
              <div aria-label="Support messages" className="flex flex-col gap-[14px]" role="log">
                {thread.messages.map((message) => {
                  const mine = message.authorId === opener;
                  const who = mine
                    ? coachName ? `${coachName}, you` : "You"
                    : displayName(message.authorName ?? person);
                  return mine ? (
                    <div className="flex justify-end" key={message.id}>
                      <div className="max-w-[300px]">
                        {/*
                          `displayText` and not the raw body. The seeders put "(demo)" at the end of
                          the rows they write on purpose, so provenance is legible in a query, and
                          `display-name.ts` strips it exactly where a human reads it. A message body
                          is not a name, which is why it takes the free-text arm rather than
                          `displayName` -- and it is the leak the audit counted six times on the
                          Help page this panel replaced.
                        */}
                        <p className="m-0 rounded-[14px_4px_14px_14px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[14px] py-[12px] text-[16px] leading-[1.55] text-[color:var(--body)]">
                          {displayText(message.body)}
                        </p>
                        <p className={`m-0 text-right ${META_CLASS}`}>
                          {who}, {timeLabel(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-[12px]" key={message.id}>
                      <span
                        aria-hidden
                        className="grid size-[36px] flex-none place-items-center rounded-full border border-[var(--accent-edge)] bg-[var(--accent-wash)] font-[family-name:var(--font-mono)] text-[14px] text-[color:var(--accent-text)]"
                      >
                        {initialsFor(who)}
                      </span>
                      <div className="min-w-0">
                        <p className="m-0 rounded-[4px_14px_14px_14px] border border-[var(--line)] bg-[var(--well)] px-[14px] py-[12px] text-[16px] leading-[1.55] text-[color:var(--body)]">
                          {displayText(message.body)}
                        </p>
                        <p className={`m-0 ${META_CLASS}`}>
                          {who}, {timeLabel(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="flex-none px-[20px] pb-[18px]">
            <label className="sr-only" htmlFor={fieldId}>Write your message</label>
            <textarea
              className="min-h-[48px] w-full resize-y rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] py-[13px] text-[16px] leading-[1.4] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)] focus-visible:border-[var(--accent-edge)]"
              id={fieldId}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write your message"
              rows={2}
              value={draft}
            />
            <div className="mt-[12px] flex items-center gap-[14px]">
              <button
                className={SEND_CLASS}
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
                type="button"
              >
                <Send size={18} />
                {sending ? "Sending" : "Send"}
              </button>
              {sendError ? (
                <p className="m-0 text-[14px] leading-[1.4] text-[color:var(--warning-text)]" role="alert">
                  {sendError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-none flex-wrap items-center gap-x-[18px] gap-y-[2px] border-t border-[var(--line-soft)] px-[20px] pb-[12px]">
            <Link className={FOOTER_LINK_CLASS} href={helpHref} onClick={close}>
              <FileText size={18} />
              Read the guides
            </Link>
            <Link className={FOOTER_LINK_CLASS} href={tipsHref} onClick={close}>
              <Play size={18} />
              Tips and trainings
            </Link>
          </div>
        </div>
      ) : null}

      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        /*
         * One name in both states, because this is a disclosure button and `aria-expanded` is what
         * says which state it is in. It said "Close support" while open, which put two controls
         * called that on screen at once -- this and the panel's own X -- and left a screen-reader
         * user picking between two identical names.
         */
        aria-label="Message support"
        /*
         * `--ink` and not the accent, which is the whole reason the bubble can sit on every page:
         * the canvas allows one filled accent control in view, and every coach screen already
         * spends it. A dark circle is unmistakably a control and competes with nothing.
         */
        /*
         * 60px, not the artboard's 56px, and the four pixels are load-bearing rather than a
         * rounding error. `coach.css` reserves this corner as `calc(32px + 60px + 16px)` of page
         * padding so the launcher covers nothing, and `coach-kit-boundary.test.ts` reads the
         * launcher's own geometry back out of this file to check the two agree. The stylesheet is
         * frozen for this rebuild, so the size that keeps them in step is the one that ships; the
         * artboard's 56px needs the reserve retuned with it, in one change rather than two.
         */
        className="inline-flex h-[60px] w-[60px] items-center justify-center rounded-full border border-[rgba(255,255,255,0.12)] bg-[var(--ink)] text-[color:var(--on-accent)] shadow-[var(--shadow-raised)]"
        data-slot="coach-support-launcher"
        onClick={() => (open ? close() : setOpen(true))}
        ref={launcherRef}
        type="button"
      >
        {open ? <X size={24} /> : <ChatIcon size={24} />}
      </button>
    </div>
  );
}
