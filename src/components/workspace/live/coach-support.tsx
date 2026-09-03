"use client";

import { useEffect, useMemo, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { Callout } from "@/components/kit/callout";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ArrowLeft } from "@/components/kit/icons";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { Prose, STATE_TONE_TO_TONE, Status } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import type { CoachSupportThreadRead, SupportStatus } from "@/lib/repositories/support";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_LEAD_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
} from "./coach-type";
import { coachSupportThreadView, supportLoadState } from "./support-view-models";

type CoachSupportProps = { enabled: boolean };
type HelpTab = "support" | "guides";

const STATUS_TONES: Record<SupportStatus, StateTone> = {
  open: "info",
  waiting_on_coach: "warning",
  resolved: "good",
};

/*
 * The provenance line, said in words rather than in a lozenge nobody over 55 can read.
 *
 * It is the same three strings `leads-surface.tsx` prints under its own head, deliberately: the
 * hard rule is that test and demo rows are labelled on screen, and a rule that is worded
 * differently on every screen is a rule a reader has to re-learn each time. Support threads only
 * ever come back real or seeded, so `demo` never appears here, but the map carries it so the two
 * heads can stay literally the same sentence set.
 */
const PROVENANCE_COPY: Record<"demo" | "real" | "test", string> = {
  demo: "Demo data, excluded from real analytics",
  real: "Real data",
  test: "Test data, excluded from real analytics",
};

/*
 * The coach scale, written as local recipes the way `coach-billing.tsx` does it.
 *
 * What this page was before: `PageHeader` at the console's 20px title, four `Overline`s at 9.5px
 * uppercase mono, `MonoMeta` timestamps at 12px, and 13px body copy. Every one of those numbers
 * is the owner console's, and the console's density is exactly what the round-1 coaches said they
 * could not read. `coach.css` raises the shell's root to 16px and the pressable floor to 44px,
 * but a class whose size is an absolute px value does not move when the root does, so the port
 * has to restate each of them at coach size. The shared ones come from `coach-type.ts`; the four
 * below are the roles that file has no name for.
 *
 * None of the behaviour moved. The threads still load from `/api/support/threads`, the composer
 * still reads its saved thread back before it claims anything, the reply still posts to the same
 * message endpoint, and the export is still the server-rendered one.
 */
const PANEL_SUB_CLASS = `m-0 max-w-[var(--measure-prose)] text-[color:var(--muted)] ${COACH_READING_CLASS}`;
/* Timestamps and counts. Mono at 15px, which is `COACH_FOOTNOTE_CLASS`'s size in the mono face. */
const MONO_META_CLASS =
  "font-[family-name:var(--font-mono)] text-[15px] leading-[1.4] text-[color:var(--faint)] [font-variant-numeric:tabular-nums_lining-nums]";
const MESSAGE_BODY_CLASS =
  "mt-[8px] max-w-[var(--measure-prose)] whitespace-pre-wrap text-[16px] leading-[1.6] text-[color:var(--body)]";

/**
 * The page's single accent fill. Help exists so a coach can reach a person, so the fill follows
 * that verb: it sits on Send reply while a request is open and being answered, and on Create
 * request otherwise. Whichever one is not live takes the secondary face, so the page never spends
 * two fills and never spends zero.
 *
 * Both are re-cut to the coach's target floor -- 52px rather than the console's 34px, 17px label
 * rather than 13px -- because `coach.css` only raises `min-height`, and a 34px-tall button that
 * has been stretched to 44px by a `min-height` rule reads as a mistake rather than as a control.
 *
 * The `background:` arbitrary property rather than the `bg-` arbitrary-value utility, and the
 * difference is the whole button: `--accent-fill` is a gradient, Tailwind compiles the `bg-`
 * spelling to `background-color`, and a background-color cannot take a gradient, so the browser
 * dropped the declaration and painted no ground under a near-white label.
 * `accent-fill-spelling.test.ts` pins this.
 */
const ACCENT_FILL_CLASS =
  "inline-flex h-[52px] items-center justify-center rounded-[12px] border border-[var(--accent-line)] [background:var(--accent-fill)] px-[26px] text-[17px] leading-none font-semibold text-[color:var(--on-accent)]" +
  ` ${ACCENT_FILL_SHADOW_CLASS} disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none`;
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-[52px] items-center justify-center rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-[24px] text-[17px] leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--line)]";

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(date);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * Local rather than `PageHeader` for the reason `LeadsHead` documents: `PageHeader` sets its
 * title with `.t-page-title`, the console's 20px, and no prop moves it. The canvas draws every
 * coach page at `--coach-page-title` -- 46px, weight 500, tracking -0.026em -- and that size is
 * the first thing a reader over 55 sees. The crumbs are not reproduced because `AppShell` already
 * renders them above this from its own `crumbs` prop, and two crumb trails on one screen is worse
 * than none.
 */
function HelpHead({ provenance }: { provenance: "demo" | "real" | "test" | null }) {
  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="help">
      <h1 className="coach-page-title m-0">Help and support</h1>
      <Prose className={`m-0 ${COACH_LEAD_CLASS}`}>
        Ask us anything about your agent, and read what we have already answered. These
        conversations are with our team, never with your leads.
      </Prose>
      {provenance ? (
        <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`} data-provenance={provenance}>
          {PROVENANCE_COPY[provenance]}
        </p>
      ) : null}
    </header>
  );
}

/**
 * One request in the list, and the row this page most needed re-cut.
 *
 * The pre-port row put a truncating subject and a `shrink-0` timestamp on one flex line inside a
 * 360px column. That is the exact shape that turned the inbox's lead names into "Jo…" and "M…":
 * at coach scale a formatted timestamp is wider still, so the clock takes the line and the
 * subject -- the only thing a coach is actually scanning for -- gets whatever is left. Nothing
 * goes red when that happens, because `truncate` is invisible to jsdom.
 *
 * So the metadata goes on its own line. The subject gets the full width and wraps if it needs to,
 * and the status and the time sit under it where neither can crowd it. `coach-support.test.tsx`
 * asserts the placement -- that the time is not a descendant of the subject's own line -- rather
 * than a pixel width, because placement is the thing that was wrong and the thing a test can see.
 */
function RequestRow({
  onSelect,
  selected,
  view,
}: {
  onSelect(): void;
  selected: boolean;
  view: ReturnType<typeof coachSupportThreadView>;
}) {
  return (
    <li className="border-t border-[var(--line-soft)] first:border-t-0">
      <button
        aria-pressed={selected}
        className="grid w-full min-w-0 gap-[8px] rounded-[12px] px-[14px] py-[14px] text-left outline-none hover:bg-[var(--row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] aria-pressed:bg-[var(--accent-wash)] motion-reduce:transition-none"
        onClick={onSelect}
        type="button"
      >
        <span className={`block min-w-0 ${COACH_ROW_NAME_CLASS}`} data-request-subject>
          {view.subject}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-[12px]" data-request-meta>
          <Status
            label={view.statusLabel}
            tone={STATE_TONE_TO_TONE[STATUS_TONES[view.status]]}
            treatment="bare"
          />
          <time className={MONO_META_CLASS} dateTime={view.updatedAt}>{timestamp(view.updatedAt)}</time>
        </span>
      </button>
    </li>
  );
}

export function CoachSupport({ enabled }: CoachSupportProps) {
  const [tab, setTab] = useState<HelpTab>("support");
  const [threads, setThreads] = useState<CoachSupportThreadRead[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  /*
   * Which of the two panes a narrow screen is showing. At 390px both columns used to stack, so a
   * coach opening a request scrolled past the whole composer and the request list to reach the
   * conversation, with nothing to get back with. The wide layout is unaffected: it shows both, and
   * this only decides which one a narrow screen hides.
   */
  const [narrowPane, setNarrowPane] = useState<"list" | "detail">("list");
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/support/threads", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await responseJson(response);
        if (!response.ok || !Array.isArray(payload.threads)) throw new Error("SUPPORT_READ_FAILED");
        if (controller.signal.aborted) return;
        const next = payload.threads as CoachSupportThreadRead[];
        setThreads(next);
        setSelectedId((current) => next.some((thread) => thread.id === current)
          ? current
          : next[0]?.id ?? null);
      } catch {
        if (!controller.signal.aborted) {
          setLoadError("Support requests could not be loaded. No changes were made.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [enabled, loadVersion]);

  const state = supportLoadState({ enabled, loading, error: loadError, rows: threads });
  const selected = useMemo(
    () => threads.find((thread) => thread.id === selectedId) ?? threads[0] ?? null,
    [selectedId, threads],
  );
  const selectedView = selected ? coachSupportThreadView(selected) : null;
  // The One Fill Rule, resolved against what is actually live: while a request is open in front of
  // the coach, replying to it is the verb the page exists for, and starting a new one steps down to
  // the secondary face. With nothing open, starting one is the only action there is.
  const replyIsLive = state.kind === "ready" && selectedView !== null;
  const provenance = threads.some(
    (thread) => thread.isTest || thread.messages.some((message) => message.isTest),
  ) ? "test" as const : "real" as const;
  const headProvenance = enabled && !loading && !loadError && threads.length > 0 ? provenance : null;

  function retryLoad() {
    setLoading(true);
    setLoadError(null);
    setLoadVersion((current) => current + 1);
  }

  async function createThread() {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/support/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      const payload = await responseJson(response);
      if (!response.ok || !payload.thread) throw new Error("SUPPORT_CREATE_FAILED");
      const thread = payload.thread as CoachSupportThreadRead;
      setThreads((current) => [thread, ...current.filter((row) => row.id !== thread.id)]);
      setSelectedId(thread.id);
      setSubject("");
      setBody("");
      setFeedback({ kind: "success", message: "Request created after the saved message was read back." });
    } catch {
      setFeedback({ kind: "error", message: "The support request could not be confirmed. Nothing was added." });
    } finally {
      setBusy(false);
    }
  }

  async function appendReply() {
    if (!selected || !reply.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/support/threads/${selected.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim() }),
      });
      const payload = await responseJson(response);
      if (!response.ok || !payload.thread) throw new Error("SUPPORT_REPLY_FAILED");
      const thread = payload.thread as CoachSupportThreadRead;
      setThreads((current) => current.map((row) => row.id === thread.id ? thread : row));
      setReply("");
      setFeedback({ kind: "success", message: "Reply sent after the saved message was read back." });
    } catch {
      setFeedback({ kind: "error", message: "The reply could not be confirmed. The thread is unchanged." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-[24px]">
      <HelpHead provenance={headProvenance} />

      <Tabs onValueChange={(value) => setTab(value as HelpTab)} value={tab}>
        <TabsList aria-label="Help section" variant="line">
          <TabsTrigger value="support">
            Support{threads.length > 0 ? ` (${threads.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="guides">Guides</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-[20px] min-w-0" value="support">
          {!enabled ? (
            <DataState
              body="Your support conversations will appear here when messaging is active for this workspace."
              kind="empty"
              title="Support messages are not active"
            />
          ) : (
            /*
             * Two columns, and the split is the reading order rather than a layout convenience:
             * the left column is everything the coach says to us -- the composer, then the list of
             * what they have already asked -- and the right column is everything we have said
             * back. A single stacked column put the composer above a conversation the coach was
             * mid-way through reading, which is the wrong thing at the top of the screen.
             */
            <div className="@container/help min-w-0">
              <div className="grid min-w-0 items-start gap-[16px] @4xl/help:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <div
                  className={`flex min-w-0 flex-col gap-[16px]${narrowPane === "detail" ? " @max-4xl/help:hidden" : ""}`}
                >
                  <DeckPanel
                    eyebrow="Reach a person"
                    headingId="new-support-request"
                    name="Start a support request"
                  >
                    <Prose className={`${PANEL_SUB_CLASS} mb-[18px]`}>
                      The request appears after its thread and first message are saved and read back.
                    </Prose>
                    <div className="flex min-w-0 flex-col gap-[16px]">
                      <Field label="Subject" required>
                        <Input
                          onChange={(event) => setSubject(event.target.value)}
                          placeholder="What do you need help with?"
                          value={subject}
                        />
                      </Field>
                      <Field label="Message" required>
                        <Textarea
                          className="min-h-[120px] resize-y"
                          onChange={(event) => setBody(event.target.value)}
                          placeholder="Share the context the support team needs"
                          value={body}
                        />
                      </Field>
                      <button
                        className={`self-start ${replyIsLive ? SECONDARY_BUTTON_CLASS : ACCENT_FILL_CLASS}`}
                        disabled={busy || !subject.trim() || !body.trim()}
                        onClick={() => void createThread()}
                        type="button"
                      >
                        {busy ? "Saving…" : "Create request"}
                      </button>
                    </div>
                  </DeckPanel>

                  {feedback ? (
                    <div role={feedback.kind === "error" ? "alert" : "status"}>
                      <Callout
                        body={feedback.message}
                        title={feedback.kind === "error" ? "Not saved" : "Saved"}
                        tone={feedback.kind === "error" ? "critical" : "good"}
                      />
                    </div>
                  ) : null}

                  {state.kind === "ready" ? (
                    <DeckPanel
                      eyebrow="What you have asked us"
                      headingId="support-request-list"
                      name="Your requests"
                    >
                      <ul aria-label="Support requests" className="m-0 min-w-0 list-none p-0">
                        {state.rows.map((thread) => {
                          const view = coachSupportThreadView(thread);
                          return (
                            <RequestRow
                              key={view.id}
                              onSelect={() => {
                                setSelectedId(view.id);
                                setNarrowPane("detail");
                              }}
                              selected={selectedView?.id === view.id}
                              view={view}
                            />
                          );
                        })}
                      </ul>
                    </DeckPanel>
                  ) : null}
                </div>

                <div
                  className={`min-w-0${narrowPane === "list" ? " @max-4xl/help:hidden" : ""}`}
                >
                  <button
                    className="mb-[16px] inline-flex items-center gap-[8px] rounded-[10px] border border-[var(--line)] bg-[var(--well)] px-[14px] py-[10px] text-[15px] leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)] @4xl/help:hidden"
                    onClick={() => setNarrowPane("list")}
                    type="button"
                  >
                    <ArrowLeft aria-hidden className="size-[var(--s-4)]" />
                    Back to requests
                  </button>
                  {state.kind === "loading" ? <DataState kind="loading" rows={4} /> : null}
                  {state.kind === "error" ? (
                    <DataState
                      body={state.message}
                      kind="unavailable"
                      retry={retryLoad}
                      title="Support requests could not be loaded"
                    />
                  ) : null}
                  {state.kind === "empty" ? (
                    <DataState
                      body="Start a request and its messages will appear here after they are saved."
                      kind="empty"
                      title="No support requests"
                    />
                  ) : null}
                  {state.kind === "ready" && selectedView ? (
                    <DeckPanel
                      eyebrow="Your conversation with us"
                      headingId="support-conversation"
                      name={selectedView.subject}
                    >
                      {/*
                        The export lives in the panel body rather than in the header band, because
                        `DeckPanel`'s one header action is a `Link` to a destination and this is a
                        menu. Every table on the coach side exports, and a support thread is one.
                      */}
                      <div className="mb-[16px] flex min-w-0 flex-wrap items-center justify-between gap-[12px] border-b border-[var(--line-soft)] pb-[16px]">
                        <Status
                          label={selectedView.statusLabel}
                          tone={STATE_TONE_TO_TONE[STATUS_TONES[selectedView.status]]}
                          treatment="pill"
                        />
                        <ExportMenu
                          filename="setterfi-coach-support-messages"
                          mode="server"
                          query={{ threadId: selectedView.id }}
                          resource="coach-support-messages"
                        />
                      </div>

                      {selectedView.messages.length > 0 ? (
                        <div
                          aria-label="Support messages"
                          aria-live="polite"
                          className="min-w-0 flex-1"
                          data-support-message-list
                          role="feed"
                        >
                          {selectedView.messages.map((message) => (
                            <article className="border-b border-[var(--line-soft)] py-[18px] first:pt-0 last:border-b-0" key={message.id}>
                              {/*
                                Author and time on two lines for the same reason the request rows
                                are: a name and a formatted timestamp sharing one line is what
                                crushed the inbox, and the message panel is the narrower of the two
                                columns whenever a coach has a browser window rather than a monitor.
                              */}
                              <h3 className={`m-0 ${COACH_ROW_NAME_CLASS}`}>{message.authorName ?? "Support team"}</h3>
                              <time className={`mt-[3px] block ${MONO_META_CLASS}`} dateTime={message.createdAt}>
                                {timestamp(message.createdAt)}
                              </time>
                              <p className={MESSAGE_BODY_CLASS}>{message.body}</p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <DataState
                          body="Messages will appear here after the first saved reply is read back."
                          className="my-[16px]"
                          kind="empty"
                          title="No messages in this request"
                        />
                      )}

                      <div className="mt-[18px] min-w-0 rounded-[14px] border border-[var(--line)] bg-[var(--well)] p-[18px]">
                        <Field label="Reply">
                          <Textarea
                            onChange={(event) => setReply(event.target.value)}
                            placeholder="Write a reply"
                            value={reply}
                          />
                        </Field>
                        <button
                          className={`mt-[16px] ${ACCENT_FILL_CLASS}`}
                          disabled={busy || !reply.trim()}
                          onClick={() => void appendReply()}
                          type="button"
                        >
                          {busy ? "Saving…" : "Send reply"}
                        </button>
                      </div>
                    </DeckPanel>
                  ) : null}
                  {state.kind === "ready" && !selectedView ? (
                    <DataState
                      body="Select a request to review the conversation with the support team."
                      kind="empty"
                      title="Choose a support request"
                    />
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent className="mt-[20px]" value="guides">
          <DataState
            body="Coach-safe setup, inbox, handoff, and troubleshooting guides will appear here after their copy is approved."
            kind="empty"
            title="Operating guides are being prepared"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
