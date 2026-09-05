"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Check, CircleAlert, ExternalLink, FacebookLogo, InstagramLogo, ShieldCheck } from "@/components/kit/icons";
import { startMetaConnection } from "@/components/workspace/live/coach-meta-connect";
import {
  CHANNEL_WORDS,
  FAILURE_COPY,
  NEVER_LINE,
  NOT_READY_COPY,
  POLL_INTERVAL_MS,
  REHEARSAL_STEPS,
  SIGN_IN_WINDOW_FEATURES,
  SIGN_IN_WINDOW_NAME,
  SIGN_IN_WINDOW_RETURN_PATH,
  WAIT_LIMIT_MS,
  channelListName,
  connectedCopy,
  defaultChoice,
  parseConnectAssets,
  permissionLines,
  type ConnectAsset,
  type ConnectChannel,
  type ConnectFailure,
  type ConnectStage,
} from "@/components/workspace/rehaul/connect-channel-flow";

/*
 * The connect sheet: one frame, seven states, and the page behind it never changes.
 *
 * Before this existed, every "Connect Instagram" in the product was a link to a page whose own
 * "Connect" linked back, and nothing on the client ever asked for the accounts a sign-in returns,
 * so a real sign-in dead-ended after the callback. The sheet owns the whole round trip: it opens
 * the Facebook window, waits for the callback's session, lists the accounts, saves the one the
 * coach chooses, and says what now works. Closing it at any point leaves the coach exactly where
 * they pressed the button.
 *
 * The sheet is drawn at the coach density (16px body, 48px buttons, 26px title) with the coach
 * tokens, and it carries `data-shell-role="coach"` itself because a portal renders outside the
 * shell that normally sets it.
 */

export type ConnectChannelSheetProps = {
  /** The channels to connect, in order. Two entries run one after the other in the same sheet. */
  channels: readonly ConnectChannel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where the sheet starts. `"choose"` when the page was reached by the callback's redirect (a
   * browser that blocked the window), `"error"` when the callback refused the sign-in.
   */
  resume?: "choose" | "error" | null;
  /** Called once when the sheet closes after at least one account was saved. */
  onConnected?: () => void;
  /**
   * `"not_ready"` short-circuits to the honest state before any request is made. Left out, the
   * sheet tries and reads the answer from the route.
   */
  availability?: "ready" | "not_ready";
  now?: () => Date;
};

type Fetcher = typeof fetch;

const TITLE_CLASS = "m-0 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] text-[var(--ink)]";
const BODY_CLASS = "m-0 text-[16px] leading-[1.55] text-[var(--body)]";
const MUTED_CLASS = "m-0 text-[15px] leading-[1.55] text-[var(--muted)]";
const NEVER_LINE_CLASS = "m-0 text-[15px] leading-[1.55] text-[var(--body)]";
const PRIMARY_CLASS =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-transparent [background:var(--accent-fill)] px-5 text-[16px] font-medium text-[var(--on-accent)] disabled:opacity-60";
const SECONDARY_CLASS =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-[var(--line-input)] bg-[var(--card)] px-5 text-[16px] font-medium text-[var(--ink)] disabled:opacity-60";
const QUIET_CLASS =
  "inline-flex h-12 w-full items-center justify-center rounded-xl px-5 text-[16px] font-medium text-[var(--muted)] hover:text-[var(--ink)]";

export function ConnectChannelSheet({
  availability,
  channels,
  now = () => new Date(),
  onConnected,
  onOpenChange,
  open,
  resume = null,
}: ConnectChannelSheetProps) {
  const [index, setIndex] = useState(0);
  const channel = channels[Math.min(index, channels.length - 1)];
  const [stage, setStage] = useState<ConnectStage>(() => initialStage(availability, resume));
  const connectedCount = useRef(0);
  const popup = useRef<Window | null>(null);
  const waitStarted = useRef<number>(0);
  const titleId = useId();

  /* One poll loop for the waiting state, torn down the moment the stage moves on. */
  useEffect(() => {
    if (!open || stage.kind !== "waiting") return;
    let active = true;
    let missesAfterClose = 0;
    if (!waitStarted.current) waitStarted.current = Date.now();

    const tick = async () => {
      if (!active) return;
      if (Date.now() - waitStarted.current > WAIT_LIMIT_MS) {
        closePopup();
        setStage({ kind: "failed", reason: "timed_out" });
        return;
      }
      const outcome = await readAssets(fetch, channel);
      if (!active) return;
      if (outcome.kind === "items") {
        closePopup();
        waitStarted.current = 0;
        if (outcome.items.length === 0) setStage({ kind: "failed", reason: "no_accounts" });
        else setStage({ kind: "choose", items: outcome.items, chosen: defaultChoice(outcome.items), saving: false, error: null });
        return;
      }
      if (outcome.kind === "failed") {
        closePopup();
        setStage({ kind: "failed", reason: outcome.reason });
        return;
      }
      /* Not yet. A closed window with still no session, twice in a row, is a coach who gave up. */
      const window_ = popup.current;
      if (window_ && window_.closed) {
        missesAfterClose += 1;
        if (missesAfterClose >= 2) {
          popup.current = null;
          setStage({ kind: "failed", reason: "window_closed" });
          return;
        }
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, stage.kind, channel]);

  function closePopup() {
    const window_ = popup.current;
    if (window_ && !window_.closed) window_.close();
    popup.current = null;
  }

  function close(nextOpen: boolean) {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    closePopup();
    waitStarted.current = 0;
    onOpenChange(false);
    if (connectedCount.current > 0) {
      connectedCount.current = 0;
      onConnected?.();
    }
  }

  async function openFacebook(reopen = false) {
    if (availability === "not_ready") {
      setStage({ kind: "not_ready" });
      return;
    }
    /*
     * The window is opened on the click itself, blank, and filled once the route answers. A
     * window opened after an `await` is a pop-up a browser is entitled to block; one opened in
     * the click and navigated later is not. If the browser refuses even that, the sign-in runs in
     * this tab and the callback brings the coach back to this page with the sheet at "choose".
     */
    let window_: Window | null = null;
    try {
      window_ = window.open("about:blank", SIGN_IN_WINDOW_NAME, SIGN_IN_WINDOW_FEATURES);
    } catch {
      window_ = null;
    }
    popup.current = window_;
    setStage({ kind: "waiting", reopened: reopen });
    waitStarted.current = Date.now();
    const result = await startMetaConnection({
      assign: (url) => {
        if (window_ && !window_.closed) window_.location.href = url;
        else window.location.assign(url);
      },
      channel,
      fetch: (url, init) => fetch(url, init),
      returnPath: window_ ? SIGN_IN_WINDOW_RETURN_PATH : window.location.pathname,
    });
    if (result.status === "failed") {
      closePopup();
      waitStarted.current = 0;
      if (result.reason === "unavailable") setStage({ kind: "not_ready" });
      else setStage({ kind: "failed", reason: result.reason === "refused" ? "refused" : "error" });
    }
  }

  async function saveChoice() {
    if (stage.kind !== "choose" || !stage.chosen) return;
    const chosen = stage.items.find((item) => item.assetId === stage.chosen);
    if (!chosen) return;
    setStage({ ...stage, saving: true, error: null });
    const outcome = await saveAsset(fetch, channel, chosen.assetId);
    if (outcome === "saved") {
      connectedCount.current += 1;
      setStage({ kind: "connected", label: chosen.label });
      return;
    }
    setStage({ kind: "failed", reason: outcome });
  }

  function nextChannel() {
    setIndex((current) => current + 1);
    setStage({ kind: "intro", note: null });
  }

  const hasNext = index < channels.length - 1;
  const words = CHANNEL_WORDS[channel];

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full gap-0 border-l border-[var(--line)] bg-[var(--card)] p-0 text-[var(--ink)] sm:max-w-[520px]"
        data-slot="connect-channel-sheet"
        showCloseButton={false}
        side="right"
      >
        <div className="flex h-full flex-col overflow-y-auto" data-shell-role="coach">
          <SheetHead
            channel={channel}
            onClose={() => close(false)}
            step={stepLabel(stage, channels.length > 1 ? words.name : null)}
          />
          <div className="flex flex-1 flex-col gap-6 px-6 pb-8 pt-6 sm:px-8">
            {stage.kind === "intro" ? (
              <Intro
                channel={channel}
                channels={index === 0 ? channels : [channel]}
                note={stage.note}
                onContinue={() => setStage({ kind: "rehearsal" })}
                onNotNow={() => close(false)}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "rehearsal" ? (
              <Rehearsal
                onBack={() => setStage({ kind: "intro", note: null })}
                onOpen={() => void openFacebook()}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "waiting" ? (
              <Waiting
                onReopen={() => void openFacebook(true)}
                reopened={stage.reopened}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "choose" ? (
              <Choose
                channel={channel}
                onChoose={(assetId) => setStage({ ...stage, chosen: assetId })}
                onSave={() => void saveChoice()}
                stage={stage}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "connected" ? (
              <Connected
                channel={channel}
                hasNext={hasNext}
                label={stage.label}
                nextName={hasNext ? CHANNEL_WORDS[channels[index + 1]].name : null}
                now={now()}
                onDone={() => close(false)}
                onNext={nextChannel}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "failed" ? (
              <Failed
                onClose={() => close(false)}
                onRetry={() => setStage({ kind: "rehearsal" })}
                reason={stage.reason}
                titleId={titleId}
              />
            ) : null}
            {stage.kind === "not_ready" ? (
              <NotReady channelName={words.name} onClose={() => close(false)} titleId={titleId} />
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function initialStage(availability: ConnectChannelSheetProps["availability"], resume: ConnectChannelSheetProps["resume"]): ConnectStage {
  if (availability === "not_ready") return { kind: "not_ready" };
  if (resume === "choose") return { kind: "waiting", reopened: false };
  if (resume === "error") return { kind: "failed", reason: "error" };
  return { kind: "intro", note: null };
}

function stepLabel(stage: ConnectStage, channelName: string | null): string | null {
  const prefix = channelName ? `${channelName}, ` : "";
  switch (stage.kind) {
    case "intro": return `${prefix}step 1 of 3`;
    case "rehearsal": return `${prefix}step 2 of 3`;
    case "waiting": return `${prefix}step 2 of 3`;
    case "choose": return `${prefix}step 3 of 3`;
    default: return null;
  }
}

/* ---- wire ---- */

type AssetsOutcome =
  | { kind: "items"; items: readonly ConnectAsset[] }
  | { kind: "not_yet" }
  | { kind: "failed"; reason: ConnectFailure };

async function readAssets(fetcher: Fetcher, channel: ConnectChannel): Promise<AssetsOutcome> {
  try {
    const response = await fetcher("/api/channels/meta/assets", { cache: "no-store" });
    if (response.status === 200) {
      const body: unknown = await response.json().catch(() => null);
      return { kind: "items", items: parseConnectAssets(body, channel) };
    }
    if (response.status === 404) return { kind: "not_yet" };
    if (response.status === 401 || response.status === 403) return { kind: "failed", reason: "refused" };
    return { kind: "failed", reason: "error" };
  } catch {
    return { kind: "not_yet" };
  }
}

async function saveAsset(fetcher: Fetcher, channel: ConnectChannel, assetId: string): Promise<"saved" | ConnectFailure> {
  try {
    const response = await fetcher("/api/channels/meta/assets", {
      body: JSON.stringify({ assetId, channel }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (response.status === 202) return "saved";
    if (response.status === 401 || response.status === 403) return "refused";
    if (response.status === 409 || response.status === 400) return "not_saved";
    return "error";
  } catch {
    return "error";
  }
}

/* ---- the frame ---- */

function SheetHead({ channel, onClose, step }: { channel: ConnectChannel; onClose: () => void; step: string | null }) {
  const Icon = channel === "instagram" ? InstagramLogo : FacebookLogo;
  return (
    <div className="flex items-center gap-4 border-b border-[var(--line-soft)] px-6 py-5 sm:px-8">
      <span className="grid size-11 flex-none place-items-center rounded-[12px] border border-[var(--line)] bg-[var(--well)] text-[var(--body)]">
        <Icon size={22} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 text-[15px] leading-[1.4] text-[var(--muted)]">
        {step ?? CHANNEL_WORDS[channel].name}
      </span>
      <button
        aria-label="Close"
        className="grid size-11 flex-none place-items-center rounded-[12px] border border-transparent text-[var(--muted)] hover:border-[var(--line)] hover:text-[var(--ink)]"
        onClick={onClose}
        type="button"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="18">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex flex-col gap-3 pt-2">{children}</div>;
}

/* ---- the states ---- */

function Intro({
  channel,
  channels,
  note,
  onContinue,
  onNotNow,
  titleId,
}: {
  channel: ConnectChannel;
  channels: readonly ConnectChannel[];
  note: string | null;
  onContinue: () => void;
  onNotNow: () => void;
  titleId: string;
}) {
  const words = CHANNEL_WORDS[channel];
  return (
    <>
      {note ? (
        <p className="m-0 rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-4 py-3 text-[15px] leading-[1.5] text-[var(--body)]">
          {note}
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>Connect {channelListName(channels)}</h2>
        <p className={BODY_CLASS}>
          Your assistant will read new messages sent to {words.place} and reply to them for you.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <p className={MUTED_CLASS}>To do that, Facebook will ask you to let SetterFi:</p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {permissionLines(channel).map((line) => (
            <li className="flex items-start gap-3" key={line}>
              <span className="mt-[2px] grid size-6 flex-none place-items-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-text)]">
                <Check size={14} strokeWidth={2.5} />
              </span>
              <span className={BODY_CLASS}>{line}</span>
            </li>
          ))}
        </ul>
        <p className="m-0 flex items-start gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-4 py-3">
          <ShieldCheck className="mt-[3px] flex-none text-[var(--good-text)]" size={18} strokeWidth={1.75} />
          <span className={NEVER_LINE_CLASS}>{NEVER_LINE}</span>
        </p>
      </div>
      <Actions>
        <button className={PRIMARY_CLASS} onClick={onContinue} type="button">Continue</button>
        <button className={QUIET_CLASS} onClick={onNotNow} type="button">Not now</button>
      </Actions>
    </>
  );
}

function Rehearsal({ onBack, onOpen, titleId }: { onBack: () => void; onOpen: () => void; titleId: string }) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>Facebook will open in a new window</h2>
        <p className={BODY_CLASS}>Here is what to do in it. It takes about a minute.</p>
      </div>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {REHEARSAL_STEPS.map((step, position) => (
          <li className="flex items-start gap-4" key={step}>
            <span className="grid size-9 flex-none place-items-center rounded-full border border-[var(--line)] bg-[var(--well)] text-[16px] font-medium text-[var(--ink)]">
              {position + 1}
            </span>
            <span className={`${BODY_CLASS} pt-[6px]`}>{step}</span>
          </li>
        ))}
      </ol>
      <p className={MUTED_CLASS}>When you are done, this window updates on its own.</p>
      <Actions>
        <button className={PRIMARY_CLASS} onClick={onOpen} type="button">
          Open Facebook
          <ExternalLink size={16} strokeWidth={2} />
        </button>
        <button className={QUIET_CLASS} onClick={onBack} type="button">Back</button>
      </Actions>
    </>
  );
}

function Waiting({ onReopen, reopened, titleId }: { onReopen: () => void; reopened: boolean; titleId: string }) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>Waiting for Facebook</h2>
        <p className={BODY_CLASS}>
          Finish signing in on the Facebook window. This one updates the moment you are done.
        </p>
      </div>
      <div className="flex items-center gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-4 py-4" role="status">
        <Spinner />
        <span className={BODY_CLASS}>Watching for the sign-in to finish</span>
      </div>
      {reopened ? (
        <p className={MUTED_CLASS}>
          If no window appeared this time either, your browser is blocking pop-ups for this site. Allow them in the address bar and press the button once more.
        </p>
      ) : null}
      <Actions>
        <button className={SECONDARY_CLASS} onClick={onReopen} type="button">
          The Facebook window did not open
        </button>
      </Actions>
    </>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-6 flex-none animate-spin rounded-full border-[3px] border-[var(--line-strong)] border-t-[var(--accent)] motion-reduce:animate-none"
    />
  );
}

function Choose({
  channel,
  onChoose,
  onSave,
  stage,
  titleId,
}: {
  channel: ConnectChannel;
  onChoose: (assetId: string) => void;
  onSave: () => void;
  stage: Extract<ConnectStage, { kind: "choose" }>;
  titleId: string;
}) {
  const words = CHANNEL_WORDS[channel];
  const groupName = `connect-${channel}-asset`;
  return (
    <>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>Which {words.account} should answer?</h2>
        <p className={BODY_CLASS}>
          Facebook handed back these. Your assistant will answer on the one you choose.
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0" role="radiogroup" aria-labelledby={titleId}>
        {stage.items.map((item) => {
          const chosen = stage.chosen === item.assetId;
          return (
            <li key={item.assetId}>
              <label
                className={[
                  "flex min-h-[64px] cursor-pointer items-center gap-4 rounded-[14px] border px-4 py-3",
                  item.eligible ? "border-[var(--line-input)] bg-[var(--card)]" : "cursor-not-allowed border-[var(--line-soft)] bg-[var(--well)]",
                  chosen ? "border-[var(--accent)] ring-2 ring-[var(--accent-edge)]" : "",
                ].join(" ")}
                data-eligible={item.eligible ? "true" : "false"}
              >
                <input
                  checked={chosen}
                  className="size-5 flex-none accent-[var(--accent)]"
                  disabled={!item.eligible || stage.saving}
                  name={groupName}
                  onChange={() => onChoose(item.assetId)}
                  type="radio"
                  value={item.assetId}
                />
                <span className="flex min-w-0 flex-col">
                  <span className={`text-[17px] leading-[1.3] font-medium ${item.eligible ? "text-[var(--ink)]" : "text-[var(--muted)]"}`}>
                    {item.label}
                  </span>
                  {!item.eligible ? (
                    <span className="text-[14px] leading-[1.45] text-[var(--muted)]">
                      {item.reason ?? "Cannot be connected."}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {stage.error ? <p className={`${MUTED_CLASS} text-[var(--warning-text)]`}>{stage.error}</p> : null}
      <Actions>
        <button className={PRIMARY_CLASS} disabled={!stage.chosen || stage.saving} onClick={onSave} type="button">
          {stage.saving ? "Saving" : "Use this account"}
        </button>
      </Actions>
    </>
  );
}

function Connected({
  channel,
  hasNext,
  label,
  nextName,
  now,
  onDone,
  onNext,
  titleId,
}: {
  channel: ConnectChannel;
  hasNext: boolean;
  label: string;
  nextName: string | null;
  now: Date;
  onDone: () => void;
  onNext: () => void;
  titleId: string;
}) {
  const copy = connectedCopy(channel, label, now);
  return (
    <>
      <span className="grid size-14 place-items-center rounded-full bg-[var(--good-wash)] text-[var(--good-text)]">
        <Check size={28} strokeWidth={2.5} />
      </span>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>{copy.title}</h2>
        <p className={BODY_CLASS}>{copy.body}</p>
        <p className={MUTED_CLASS}>{copy.older}</p>
      </div>
      <Actions>
        {hasNext && nextName ? (
          <>
            <button className={PRIMARY_CLASS} onClick={onNext} type="button">Connect {nextName} next</button>
            <button className={QUIET_CLASS} onClick={onDone} type="button">Done for now</button>
          </>
        ) : (
          <button className={PRIMARY_CLASS} onClick={onDone} type="button">Done</button>
        )}
      </Actions>
    </>
  );
}

function Failed({ onClose, onRetry, reason, titleId }: { onClose: () => void; onRetry: () => void; reason: ConnectFailure; titleId: string }) {
  const copy = FAILURE_COPY[reason];
  return (
    <>
      <span className="grid size-14 place-items-center rounded-full bg-[var(--warning-wash)] text-[var(--warning-text)]">
        <CircleAlert size={28} strokeWidth={2} />
      </span>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>{copy.title}</h2>
        <p className={BODY_CLASS}>{copy.body}</p>
      </div>
      <Actions>
        {reason === "refused" ? null : (
          <button className={PRIMARY_CLASS} onClick={onRetry} type="button">Try again</button>
        )}
        <button className={QUIET_CLASS} onClick={onClose} type="button">Close</button>
      </Actions>
    </>
  );
}

function NotReady({ channelName, onClose, titleId }: { channelName: string; onClose: () => void; titleId: string }) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <h2 className={TITLE_CLASS} id={titleId}>{channelName}: {NOT_READY_COPY.title.toLowerCase()}</h2>
        <p className={BODY_CLASS}>{NOT_READY_COPY.body}</p>
        <p className={MUTED_CLASS}>{NOT_READY_COPY.meanwhile}</p>
      </div>
      <Actions>
        <button className={SECONDARY_CLASS} onClick={onClose} type="button">Close</button>
      </Actions>
    </>
  );
}
