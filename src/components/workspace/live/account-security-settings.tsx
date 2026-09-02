"use client";

import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useState } from "react";

import {
  IconTile,
  KitInput,
  Status,
  StatusAbsent,
  TONE_MARK,
  TONE_TEXT,
  type Tone,
} from "@/components/kit/atomics";
import { Callout, type CalloutTone } from "@/components/kit/callout";
import { CopyValue } from "@/components/kit/copy-value";
import { Field } from "@/components/kit/field";
import {
  Lock,
  Refresh,
  ShieldCheck,
  UserCircle,
} from "@/components/kit/icons";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import {
  beginAccountMfaEnrollment,
  changeAccountPassword,
  disableAccountMfa,
  loadAccountMfaStatus,
  loadAccountSecuritySessions,
  requestAccountEmailChange,
  requestAccountEmailVerification,
  revokeAccountSecuritySession,
  revokeOtherAccountSecuritySessions,
  verifyAccountMfa,
  type AccountMfaStatus,
  type AccountSecurityReceipt,
  type AccountSecuritySessionView,
} from "@/lib/auth/account-security-client";
import { cn } from "@/lib/utils";

/*
 * ---------------------------------------------------------------------------------------------
 * Why this page draws its own panel and row instead of importing the kit's, and why every size
 * below is a custom property with a fallback rather than a plain pixel value.
 *
 * `/account/security` is the only surface in the product that is genuinely bi-lingual. Its
 * `page.tsx` hands `AppShell` whatever workspace the signed-in actor belongs to, so an admin
 * opening this route gets `data-shell-role="admin"` and the owner console's density, and a coach
 * opening the same route gets `data-shell-role="coach"` and the 16px surface. One component tree,
 * two readers, and the console is owned by three other lanes right now -- so a port that simply
 * retyped the coach's numbers would have dragged the admin's view of this page to 16px and
 * quietly broken a language this lane has no authority over.
 *
 * That rules out `DeckPanel` and every other `.coach-*` class as the carrier of the shape. Those
 * rules live in `src/app/(workspace)/coach/coach.css` behind `[data-shell-role="coach"]`, which
 * is exactly what makes them safe for the coach side and useless here: under the admin shell a
 * `DeckPanel` renders as a bare `<section>` with no face, no radius and no type at all. What is
 * portable is the *anatomy* -- eyebrow above the name so the name can stay a plain phrase, one
 * sentence under it, the state stated on the right, a hairline under the header band, rows in the
 * panel's own face rather than in a second card -- and the anatomy is markup, not CSS.
 *
 * So the scale travels through the custom properties instead. `coach.css` declares
 * `--coach-body`, `--coach-eyebrow`, `--coach-panel-name`, `--coach-page-title` and
 * `--coach-target` on the coach shell and nowhere else, so `var(--coach-body, var(--t-body))`
 * resolves to 16px under a coach and falls through to the console's own body size under an admin,
 * without a single ancestor selector in a class string.
 *
 * **The fallback names a root token, never a number, and that is the correction.** Every fallback
 * here used to be a literal read off the kit component this page replaced -- 15px, 12.5px, 13.5px,
 * 12px, 11.5px, and a `0px` -- with a note under them saying the admin branch was pixel-identical
 * to what shipped and that changing one would move the console. That was true on the day it was
 * written and it is the wrong shape, because the two halves were then only ever equal by
 * coincidence: the coach half is a managed scale that other lanes correct, the admin half was
 * fourteen hand-numbered constants with no owner, no doc and no guard, so every correction to the
 * coach scale widened the gap silently. The literals are the reason `--coach-eyebrow` could be
 * raised from 12px to 14px for the floor in `SIMPLIFICATION-SPEC` §5 and this file kept printing
 * the retired 12.
 *
 * Pointing the second half at `--t-*` makes it a scale too. `tokens.css:965` declares them at the
 * root and `console.css` restates the ones the console reads differently, so the admin branch now
 * follows the console instead of a snapshot of it.
 *
 * **Three of them moved a value, and each was wrong before.** The panel name was 15px against a
 * comment claiming that is the console's section title; `--t-section-title` is 14px, so the
 * comment was describing a number nothing declared. A row title was 13.5px and `--t-row` is 14px.
 * The receipt was 12px and now takes `--t-body`; its guard is named "sizes it to be read", so the
 * bigger of the two is the one that assertion is actually about. The rest land on a token that
 * already carried their value.
 *
 * The one number that could not travel this way is the panel-name weight. The deck draws it at
 * 500 and the console's section title at 600, and there is no length token to hang a weight off,
 * so both densities take 600 -- a section heading that is a touch firmer than the deck's is a far
 * smaller sin than a console that quietly lost its heading weight.
 * ---------------------------------------------------------------------------------------------
 */

/** The category above the name. Sentence case at `--coach-eyebrow`; never the 9.5px overline. */
const PANEL_EYEBROW_CLASS =
  "mb-[4px] block text-[length:var(--coach-eyebrow,var(--t-label))] leading-[1.4] text-[color:var(--muted)]";
/** The panel name: `--coach-panel-name` on the coach side, the console's section title otherwise. */
const PANEL_NAME_CLASS =
  "mb-[4px] block text-[length:var(--coach-panel-name,var(--t-section-title))] leading-[1.3] font-[600] text-[color:var(--ink)]";
/** The one sentence under the name. Never two -- the measure is capped so a second will not sit well. */
const PANEL_SENTENCE_CLASS =
  "block max-w-[var(--measure-prose)] text-[length:var(--coach-body,var(--t-body))] leading-[1.45] text-[color:var(--muted)]";
/** What the panel says while it is shut: the current answer, in mono on the right of the band. */
const PANEL_SUMMARY_CLASS =
  "mono text-[length:var(--coach-eyebrow,var(--t-mono-crumb))] tabular-nums text-[color:var(--muted)]";
/*
 * The face, written out rather than taken from `.surface-card`, for one reason: the coach side's
 * panel radius is asymmetric (24px on top, 17px on the bottom, so a column of them reads as a deck
 * of cards) and `.surface-card` hard-sets `border-radius: var(--r-card)`. A Tailwind `rounded-[]`
 * utility and `.surface-card` carry the same specificity, so which one won would have depended on
 * stylesheet order -- a coin flip dressed up as a rule. Everything else here is `.surface-card`
 * verbatim, minus its padding, which the header band and the rows own instead.
 */
const PANEL_FACE_CLASS =
  "min-w-0 overflow-hidden rounded-[var(--coach-panel-radius,var(--r-card))] border border-[var(--line)] shadow-[var(--shadow-card)] [background:linear-gradient(180deg,var(--card-top),var(--card))]";
/** The name of one decision inside a panel. */
const ROW_TITLE_CLASS =
  "mb-[3px] text-[length:var(--coach-body,var(--t-row))] leading-[1.3] font-[500] text-[color:var(--ink)]";
/** The sentence that says what the decision does. Every row carries one; a bare label is not a row. */
const ROW_TEXT_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[length:var(--coach-body,var(--t-body))] leading-[1.45] text-pretty";
/** Machine metadata inside a row -- an IP address, a key. Mono, and a step down from the sentence. */
const ROW_META_CLASS =
  "mono text-[length:var(--coach-eyebrow,var(--t-label))] text-[color:var(--muted)]";
/** A value a coach reads back rather than a number they scan: the sign-in address, the setup key. */
const MONO_VALUE_CLASS =
  "mono min-w-0 break-all text-[length:var(--coach-body,var(--t-body))] text-[color:var(--body)]";
/**
 * The audit microcopy. It is the visible half of "privileged actions are logged", so it is sized
 * to be read rather than to be technically present: the coach eyebrow under a coach, and the
 * console's body size rather than its smallest label under an admin. It used to be a bare 12px on
 * the admin half, which is the size this page gives machine metadata, and a receipt for a
 * privileged action is not metadata.
 */
const RECEIPT_CLASS =
  "mt-[var(--s-2)] text-[length:var(--coach-eyebrow,var(--t-body))] leading-[1.4] text-[color:var(--faint)]";
/**
 * The hairline between adjacent rows. `--line-soft` rather than `--line`, because a divider inside
 * a panel drawn at the same weight as the panel's own edge makes the card read as four cards.
 */
const ROW_DIVIDERS =
  "[&>[data-slot='setting-row']+[data-slot='setting-row']]:border-t [&>[data-slot='setting-row']+[data-slot='setting-row']]:border-[var(--line-soft)]";

type AccountSecuritySettingsProps = {
  currentEmail: string;
  emailVerified: boolean;
  securityEnabled: boolean;
  mfaEnabled: boolean;
  emailChangeEnabled: boolean;
};

type Section = "sessions" | "password" | "email" | "authenticator";
type Feedback = {
  tone: CalloutTone;
  title: string;
  body: string;
  receipt?: AccountSecurityReceipt;
};
type SessionState =
  | { kind: "disabled" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: AccountSecuritySessionView[]; audit: AccountSecurityReceipt };
type MfaState =
  | { kind: "disabled" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: AccountMfaStatus };
type RevokeTarget =
  | { kind: "one"; session: AccountSecuritySessionView }
  | { kind: "others" };

/*
 * The eyebrow is the one thing the port adds to the copy, and it earns its line by letting the
 * name stay a plain phrase. "Password" under the category "Sign-in" says more than "Password
 * settings" does, and a reader scanning four shut panels reads four category words before they
 * read a single sentence.
 */
const SECTION_COPY = {
  sessions: {
    eyebrow: "Devices",
    title: "Active sessions",
    description: "Review every signed-in device and end access you no longer recognize.",
  },
  password: {
    eyebrow: "Sign-in",
    title: "Password",
    description: "Confirm the current password before replacing it and ending other sessions.",
  },
  email: {
    eyebrow: "Sign-in",
    title: "Email address",
    description: "The address used for sign-in and account security messages.",
  },
  authenticator: {
    eyebrow: "Extra checks",
    title: "Authenticator verification",
    description: "Add a rotating code to supported sensitive account changes.",
  },
} as const;

/**
 * The disclosure chevron, a 26px glyph inside the header button.
 *
 * Always `aria-hidden`, and deliberately not raised to the coach surface's 44px floor: the button
 * around it is the target and already clears 44px twice over, so growing the decoration would only
 * take room from the sentence beside it. The rotation is suppressed under `prefers-reduced-motion`.
 */
function DisclosureChevron({ expanded }: { expanded?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border border-[var(--line)] bg-[rgba(255,255,255,0.04)]"
      data-slot="disclosure-chevron"
    >
      <span
        className="size-[8px] border-r-[1.5px] border-b-[1.5px] border-[var(--muted)] transition-transform duration-[var(--duration-quick)] motion-reduce:transition-none"
        style={{
          marginBottom: expanded ? -3 : 0,
          marginTop: expanded ? 0 : -3,
          transform: expanded ? "rotate(-135deg)" : "rotate(45deg)",
        }}
      />
    </span>
  );
}

/**
 * One panel: the deck's header band -- eyebrow, name, sentence, state, chevron -- over its own rows.
 *
 * The rows live inside the panel's face rather than in a second card underneath it, which is the
 * rule that stops an open section reading as a card inside a card. The header is a `<button>`
 * carrying `aria-expanded`, so open and shut are announced rather than left to a rotated glyph,
 * and `headingId` names the group so a reader who lands on the rows knows which panel they are in.
 */
function SecurityPanel({
  children,
  description,
  expanded = false,
  eyebrow,
  headingId,
  onToggle,
  summary,
  title,
}: {
  children?: ReactNode;
  description: ReactNode;
  expanded?: boolean;
  eyebrow: string;
  headingId: string;
  onToggle: () => void;
  summary?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      aria-labelledby={headingId}
      className={cn("@container", PANEL_FACE_CLASS)}
      data-expanded={expanded ? "true" : undefined}
      data-slot="security-panel"
      role="group"
    >
      <button
        aria-expanded={expanded}
        className="@container flex w-full flex-col gap-[var(--s-3)] px-[18px] py-[15px] text-left transition-colors duration-[var(--duration-quick)] hover:bg-[var(--row-hover)] motion-reduce:transition-none @min-[520px]:flex-row @min-[520px]:items-center @min-[520px]:gap-[14px]"
        data-slot="security-panel-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span className={PANEL_EYEBROW_CLASS} data-slot="security-panel-eyebrow">
            {eyebrow}
          </span>
          <span className={PANEL_NAME_CLASS} id={headingId}>
            {title}
          </span>
          <span className={PANEL_SENTENCE_CLASS}>{description}</span>
        </span>
        <span className="flex shrink-0 items-center gap-[11px] @min-[520px]:ml-auto">
          {summary ? (
            <span className={PANEL_SUMMARY_CLASS} data-slot="security-panel-summary">
              {summary}
            </span>
          ) : null}
          <DisclosureChevron expanded={expanded} />
        </span>
      </button>
      {expanded ? (
        <div
          className={cn("@container min-w-0 border-t border-[var(--line)]", ROW_DIVIDERS)}
          data-slot="security-panel-rows"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row: icon tile, name, sentence, control.
 *
 * The layout is container-queried rather than viewport-queried, so the control drops under the
 * text at the point this row runs out of width -- which at the coach surface's 16px happens far
 * earlier than it does in the console, and is the whole reason it is a container query.
 *
 * `align="start"` caps the control column, which is where a form lives. The console's cap is
 * 230px and stays 230px; the coach side needs more, because the same three fields carry 16px
 * labels and 44px inputs and 230px of that is the inbox failure repeating itself in a form. The
 * cap is therefore written as `230px + --coach-body * 15`: under a coach shell `--coach-body` is
 * 16px and the column opens to 470px, and under an admin shell the property does not exist, the
 * fallback of `0px` collapses the second term, and the console keeps the 230px it had.
 */
function SecurityRow({
  align = "center",
  control,
  description,
  icon,
  title,
  tone = "neutral",
}: {
  align?: "center" | "start";
  control?: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  tone?: Tone;
}) {
  const toned = tone !== "neutral";
  return (
    <div
      className={cn(
        "@container flex flex-col gap-[var(--s-3)] px-[17px] py-[14px]",
        "@min-[440px]:flex-row @min-[440px]:gap-[14px]",
        align === "center" ? "@min-[440px]:items-center" : "@min-[440px]:items-start",
      )}
      data-slot="setting-row"
      data-tone={tone}
      style={
        toned
          ? { background: `color-mix(in oklab, ${TONE_MARK[tone]} 4.5%, transparent)` }
          : undefined
      }
    >
      <div className="flex min-w-0 items-start gap-[14px]">
        {icon ? (
          <IconTile size="lg" tone={toned ? tone : "accent"}>
            {icon}
          </IconTile>
        ) : null}
        <div className="min-w-0">
          <div className={ROW_TITLE_CLASS}>{title}</div>
          <p
            className={ROW_TEXT_CLASS}
            data-slot="setting-row-description"
            style={{ color: toned ? TONE_TEXT[tone] : "var(--muted)" }}
          >
            {description}
          </p>
        </div>
      </div>
      {control ? (
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-[13px] @min-[440px]:ml-auto @min-[440px]:justify-end",
            align === "center"
              ? "shrink-0"
              : "@min-[440px]:max-w-[calc(230px+var(--coach-body,var(--t-body))*15)]",
          )}
          data-slot="setting-row-control"
        >
          {control}
        </div>
      ) : null}
    </div>
  );
}

function formattedDate(value: string | null) {
  if (!value) return "No recent activity recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return workspaceTimestampFormat.format(date);
}

function deviceLabel(userAgent: string | null) {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//u.test(userAgent)
    ? "Edge"
    : /Chrome\//u.test(userAgent)
      ? "Chrome"
      : /Firefox\//u.test(userAgent)
        ? "Firefox"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";
  const device = /iPhone|iPad/u.test(userAgent)
    ? "iOS"
    : /Android/u.test(userAgent)
      ? "Android"
      : /Windows/u.test(userAgent)
        ? "Windows"
        : /Macintosh|Mac OS/u.test(userAgent)
          ? "macOS"
          : /Linux/u.test(userAgent)
            ? "Linux"
            : "device";
  return `${browser} on ${device}`;
}

function retryMessage(message: string, retryAfter: number | null) {
  return retryAfter === null ? message : `${message} Try again in ${retryAfter} seconds.`;
}

function ReceiptLine({ receipt }: { receipt?: AccountSecurityReceipt }) {
  if (!receipt) return null;
  return (
    <p className={RECEIPT_CLASS} data-slot="account-security-receipt">
      Logged after server confirmation · audit receipt #{receipt.id}
    </p>
  );
}

function FeedbackCallout({ feedback }: { feedback: Feedback | null }) {
  return feedback ? (
    <div aria-live={feedback.tone === "critical" ? "assertive" : "polite"}>
      <Callout body={feedback.body} title={feedback.title} tone={feedback.tone} />
      <ReceiptLine receipt={feedback.receipt} />
    </div>
  ) : null;
}

function sectionSummary(
  section: Section,
  sessions: SessionState,
  mfa: MfaState,
  emailVerified: boolean,
) {
  if (section === "sessions") {
    if (sessions.kind === "disabled") return "Not released";
    if (sessions.kind === "loading") return "Checking";
    if (sessions.kind === "error") return "Unavailable";
    return `${sessions.sessions.length} active`;
  }
  if (section === "password") return sessions.kind === "disabled" ? "Not released" : "Available";
  if (section === "email") return emailVerified ? "Verified" : "Needs verification";
  if (mfa.kind === "disabled") return "Not released";
  if (mfa.kind === "loading") return "Checking";
  if (mfa.kind === "error") return "Unavailable";
  if (mfa.status === "active") return "Active";
  if (mfa.status === "pending") return "Setup pending";
  return "Not set up";
}

export function AccountSecuritySettings({
  currentEmail,
  emailChangeEnabled,
  emailVerified,
  mfaEnabled,
  securityEnabled,
}: AccountSecuritySettingsProps) {
  const [expanded, setExpanded] = useState<Section>("sessions");
  const [sessions, setSessions] = useState<SessionState>(
    securityEnabled ? { kind: "loading" } : { kind: "disabled" },
  );
  const [mfa, setMfa] = useState<MfaState>(
    mfaEnabled ? { kind: "loading" } : { kind: "disabled" },
  );
  const [feedback, setFeedback] = useState<Record<Section, Feedback | null>>({
    sessions: null,
    password: null,
    email: null,
    authenticator: null,
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [replacementPassword, setReplacementPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [replacementEmail, setReplacementEmail] = useState("");
  const [emailChangePassword, setEmailChangePassword] = useState("");
  const [emailChangeCode, setEmailChangeCode] = useState("");
  const [emailChangeBusy, setEmailChangeBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [secretSaved, setSecretSaved] = useState(false);

  useEffect(() => {
    if (!securityEnabled) return;
    let active = true;
    void loadAccountSecuritySessions().then((result) => {
      if (!active) return;
      setSessions(result.ok
        ? { kind: "ready", sessions: result.value.sessions, audit: result.value.audit }
        : { kind: "error", message: retryMessage(result.message, result.retryAfter) });
    });
    return () => {
      active = false;
    };
  }, [securityEnabled]);

  useEffect(() => {
    if (!mfaEnabled) return;
    let active = true;
    void loadAccountMfaStatus().then((result) => {
      if (!active) return;
      setMfa(result.ok
        ? { kind: "ready", status: result.value.status }
        : { kind: "error", message: retryMessage(result.message, result.retryAfter) });
    });
    return () => {
      active = false;
    };
  }, [mfaEnabled]);

  function updateFeedback(section: Section, next: Feedback | null) {
    setFeedback((current) => ({ ...current, [section]: next }));
  }

  async function refreshSessions() {
    setSessions({ kind: "loading" });
    const result = await loadAccountSecuritySessions();
    setSessions(result.ok
      ? { kind: "ready", sessions: result.value.sessions, audit: result.value.audit }
      : { kind: "error", message: retryMessage(result.message, result.retryAfter) });
    return result;
  }

  async function refreshMfa() {
    setMfa({ kind: "loading" });
    const result = await loadAccountMfaStatus();
    setMfa(result.ok
      ? { kind: "ready", status: result.value.status }
      : { kind: "error", message: retryMessage(result.message, result.retryAfter) });
    return result;
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFeedback("password", null);
    if (replacementPassword.length < 12) {
      updateFeedback("password", {
        tone: "critical",
        title: "Password not changed",
        body: "Use at least twelve characters. Your existing password is still active.",
      });
      return;
    }
    if (replacementPassword !== confirmPassword) {
      updateFeedback("password", {
        tone: "critical",
        title: "Password not changed",
        body: "The new passwords do not match. Your existing password is still active.",
      });
      return;
    }
    if (replacementPassword === currentPassword) {
      updateFeedback("password", {
        tone: "critical",
        title: "Password not changed",
        body: "Choose a password different from the current one.",
      });
      return;
    }

    setPasswordBusy(true);
    const result = await changeAccountPassword({
      currentPassword,
      password: replacementPassword,
    });
    setPasswordBusy(false);
    if (!result.ok) {
      updateFeedback("password", {
        tone: "critical",
        title: "Password not changed",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }

    setCurrentPassword("");
    setReplacementPassword("");
    setConfirmPassword("");
    const readBack = await refreshSessions();
    updateFeedback("password", {
      tone: readBack.ok ? "good" : "warning",
      title: readBack.ok ? "Password changed" : "Password changed; sessions need a refresh",
      body: readBack.ok
        ? result.value.message
        : "The server confirmed the password change, but the active-session list could not be read back.",
      receipt: result.value.audit,
    });
  }

  async function resendEmailVerification() {
    if (emailVerified) return;
    setEmailBusy(true);
    updateFeedback("email", null);
    const result = await requestAccountEmailVerification(currentEmail);
    setEmailBusy(false);
    updateFeedback("email", result.ok
      ? {
          tone: "warning",
          title: "Verification request accepted",
          body: `${result.value.message} This response does not confirm provider delivery; use the link in the message to finish verification.`,
        }
      : {
          tone: "critical",
          title: "Verification not requested",
          body: retryMessage(result.message, result.retryAfter),
        });
  }

  async function submitEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFeedback("email", null);
    if (replacementEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase()) {
      updateFeedback("email", {
        tone: "critical",
        title: "Email not changed",
        body: "That is already the sign-in address on this account.",
      });
      return;
    }
    setEmailChangeBusy(true);
    const result = await requestAccountEmailChange({
      newEmail: replacementEmail.trim(),
      currentPassword: emailChangePassword,
      mfaCode: emailChangeCode.trim() ? emailChangeCode.trim() : null,
    });
    setEmailChangeBusy(false);
    if (!result.ok) {
      updateFeedback("email", {
        tone: "critical",
        title: "Email not changed",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }
    setEmailChangePassword("");
    setEmailChangeCode("");
    updateFeedback("email", {
      tone: "warning",
      title: "Confirmation requested",
      body: `Sign-in still uses ${currentEmail}. It moves when the link sent to ${replacementEmail.trim()} is opened, which also ends every session on this account. The link stops working ${formattedDate(result.value.expiresAt)}, and the message to your current address can refuse the change.`,
      receipt: result.value.audit,
    });
  }

  async function submitRevocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = revokeTarget;
    const reason = revokeReason.trim();
    if (!target || !reason) return;
    setRevokeBusy(true);
    const result = target.kind === "one"
      ? await revokeAccountSecuritySession(target.session.id, reason)
      : await revokeOtherAccountSecuritySessions(reason);
    if (!result.ok) {
      setRevokeBusy(false);
      updateFeedback("sessions", {
        tone: "critical",
        title: "Session access unchanged",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }

    if (target.kind === "one" && target.session.isCurrent) {
      window.location.assign(new URL("/login", window.location.origin).toString());
      return;
    }
    const readBack = await refreshSessions();
    setRevokeBusy(false);
    setRevokeTarget(null);
    setRevokeReason("");
    const confirmed = readBack.ok && (
      target.kind === "one"
        ? !readBack.value.sessions.some((session) => session.id === target.session.id)
        : readBack.value.sessions.every((session) => session.isCurrent)
    );
    const revokedCount = "revokedCount" in result.value ? result.value.revokedCount : 0;
    updateFeedback("sessions", {
      tone: confirmed ? "good" : "warning",
      title: confirmed ? "Session access ended" : "Revocation accepted; list not confirmed",
      body: confirmed
        ? target.kind === "one"
          ? "The selected session is no longer active."
          : `${revokedCount} other session${revokedCount === 1 ? "" : "s"} ended. This device stayed signed in.`
        : "The server accepted the revocation, but the active-session list did not confirm the final state.",
      receipt: result.value.audit,
    });
  }

  async function startMfa() {
    setMfaBusy(true);
    updateFeedback("authenticator", null);
    const result = await beginAccountMfaEnrollment();
    setMfaBusy(false);
    if (!result.ok) {
      updateFeedback("authenticator", {
        tone: "critical",
        title: "Setup not started",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }
    setMfaSecret(result.value.secret);
    setMfa({ kind: "ready", status: "pending" });
    updateFeedback("authenticator", {
      tone: "warning",
      title: "Setup key issued once",
      body: "Save the key before entering a code. The factor is pending and has not been activated.",
      receipt: result.value.audit,
    });
  }

  async function activateMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(mfaCode) || !secretSaved) return;
    setMfaBusy(true);
    const result = await verifyAccountMfa(mfaCode);
    if (!result.ok) {
      setMfaBusy(false);
      updateFeedback("authenticator", {
        tone: "critical",
        title: "Code not verified",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }
    const readBack = await refreshMfa();
    setMfaBusy(false);
    const confirmed = readBack.ok && readBack.value.status === "active";
    if (confirmed) {
      setMfaSecret(null);
      setMfaCode("");
      setSecretSaved(false);
    }
    updateFeedback("authenticator", {
      tone: confirmed ? "good" : "warning",
      title: confirmed ? "Extra verification active" : "Activation accepted; status not confirmed",
      body: confirmed
        ? "Authenticator codes now protect the sensitive changes that support this check. Sign-in itself does not yet request this code."
        : "The activation receipt was returned, but the current factor status could not be read back.",
      receipt: result.value.audit,
    });
  }

  async function removeMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(mfaCode)) return;
    setMfaBusy(true);
    const result = await disableAccountMfa(mfaCode);
    if (!result.ok) {
      setMfaBusy(false);
      updateFeedback("authenticator", {
        tone: "critical",
        title: "Extra verification unchanged",
        body: retryMessage(result.message, result.retryAfter),
      });
      return;
    }
    const readBack = await refreshMfa();
    setMfaBusy(false);
    const confirmed = readBack.ok && readBack.value.status === "none";
    if (confirmed) setMfaCode("");
    updateFeedback("authenticator", {
      tone: confirmed ? "good" : "warning",
      title: confirmed ? "Extra verification removed" : "Removal accepted; status not confirmed",
      body: confirmed
        ? "The server read-back shows no active authenticator factor."
        : "The removal receipt was returned, but the current factor status could not be read back.",
      receipt: result.value.audit,
    });
  }

  function toggle(section: Section) {
    setExpanded((current) => current === section ? current : section);
  }

  return (
    /*
     * `--t-body` is redefined here, on this component's own root and nowhere wider, for the sake
     * of `kit/field.tsx`: its label is the one piece of type on this page that a class of ours
     * cannot reach, and it is set at `var(--t-body)`. Under a coach shell the declaration below
     * resolves to 16px, so "Current password" is read at the size the rest of the surface is read
     * at. It is scoped to this subtree because a token redefined in a shared stylesheet moves
     * every screen at once, including the ones other lanes are porting right now.
     *
     * **The fallback is `inherit` and it cannot be a token here.** It used to be a literal 13px,
     * justified as restating "the console's own 13px, so nothing moves". That justification was
     * checked against the root declaration and not against the console: `tokens.css:970` is 13px
     * but `console.css:430` restates `--t-body` at 13.5px under `[data-shell-role="admin"]`, so
     * this line was quietly shrinking every `Field` label on the page for the one reader it
     * claimed to leave alone.
     *
     * The obvious repair -- `var(--coach-body, var(--t-body))` -- is the one thing that cannot be
     * written, because a custom property whose value references itself is invalid at computed
     * value time, which would drop the declaration and un-style the labels rather than resize
     * them. `inherit` takes the value from the shell above instead, so the admin branch follows
     * `console.css` and no number is restated anywhere.
     */
    <div
      className="flex min-w-0 flex-col gap-[var(--s-3)]"
      data-slot="account-security"
      style={{ "--t-body": "var(--coach-body, inherit)" } as CSSProperties}
    >
      {!securityEnabled ? (
        <Callout
          body="This deployment has not released signed-in account controls, so no security mutation is available here."
          title="Account controls not released"
          tone="warning"
        />
      ) : null}

      {(Object.keys(SECTION_COPY) as Section[]).map((section) => (
        <SecurityPanel
          description={SECTION_COPY[section].description}
          expanded={expanded === section}
          eyebrow={SECTION_COPY[section].eyebrow}
          headingId={`account-security-${section}`}
          key={section}
          onToggle={() => toggle(section)}
          summary={sectionSummary(section, sessions, mfa, emailVerified)}
          title={SECTION_COPY[section].title}
        >
          {section === "sessions" ? (
            <>
              {sessions.kind === "loading" ? (
                <SecurityRow
                  description="Reading the server-owned session list."
                  icon={<Refresh className="animate-spin motion-reduce:animate-none" />}
                  title="Loading active sessions"
                />
              ) : null}
              {sessions.kind === "error" ? (
                <SecurityRow
                  control={
                    <Button onClick={() => void refreshSessions()} type="button" variant="outline">
                      Retry
                    </Button>
                  }
                  description={sessions.message}
                  icon={<UserCircle />}
                  title="Sessions unavailable"
                  tone="failure"
                />
              ) : null}
              {sessions.kind === "disabled" ? (
                <SecurityRow
                  description="The account-security release gate is off, so this page will not call a session endpoint."
                  icon={<UserCircle />}
                  title="Session controls unavailable"
                />
              ) : null}
              {sessions.kind === "ready" && sessions.sessions.length === 0 ? (
                <SecurityRow
                  description="The signed-in account returned no active session rows."
                  icon={<UserCircle />}
                  title="No sessions returned"
                  control={<StatusAbsent label="No active sessions returned" />}
                />
              ) : null}
              {sessions.kind === "ready" ? sessions.sessions.map((session) => (
                /*
                 * The device row is the shape that broke the inbox: an identity that has to be read
                 * in full sharing a line with metadata that refuses to shrink. There it was a 14px
                 * mono clock next to a 17px name in a 324px column, and the name came out as "Jo…".
                 * Here the identity line carries the device and, when it applies, the "This device"
                 * pill, and nothing else -- every timestamp and the IP address are their own lines
                 * in a column underneath. At 16px that is the only arrangement that survives a
                 * narrow pane, and `truncate` would have hidden the failure from jsdom entirely, so
                 * the test asserts the placement rather than a width.
                 */
                <SecurityRow
                  align="start"
                  control={
                    <Button
                      onClick={() => {
                        setRevokeReason("");
                        setRevokeTarget({ kind: "one", session });
                      }}
                      type="button"
                      variant={session.isCurrent ? "destructive" : "outline"}
                    >
                      {session.isCurrent ? "Sign out this device" : "Revoke"}
                    </Button>
                  }
                  description={
                    <span className="flex flex-col gap-[var(--s-1)]" data-slot="session-meta">
                      <span data-slot="session-started">Started {formattedDate(session.startedAt)}</span>
                      <span data-slot="session-last-seen">Last seen {formattedDate(session.lastSeenAt)}</span>
                      <span className={ROW_META_CLASS} data-slot="session-ip">
                        {session.ipAddress ?? "IP address unavailable"}
                      </span>
                    </span>
                  }
                  icon={<UserCircle />}
                  key={session.id}
                  title={
                    <span
                      className="flex flex-wrap items-center gap-[var(--s-2)]"
                      data-slot="session-identity"
                    >
                      <span className="min-w-0">{deviceLabel(session.userAgent)}</span>
                      {session.isCurrent ? <Status label="This device" tone="good" /> : null}
                    </span>
                  }
                />
              )) : null}
              {sessions.kind === "ready" ? (
                <SecurityRow
                  control={
                    <div className="flex flex-wrap gap-[var(--s-2)]">
                      <Button onClick={() => void refreshSessions()} type="button" variant="outline">
                        Refresh
                      </Button>
                      <Button
                        disabled={!sessions.sessions.some((session) => !session.isCurrent)}
                        onClick={() => {
                          setRevokeReason("");
                          setRevokeTarget({ kind: "others" });
                        }}
                        type="button"
                        variant="destructive"
                      >
                        Revoke other sessions
                      </Button>
                    </div>
                  }
                  description="This keeps the current device signed in and requires a reason for the audit trail."
                  icon={<ShieldCheck />}
                  title="Other devices"
                />
              ) : null}
              <div className="px-[17px] py-[14px]">
                <FeedbackCallout feedback={feedback.sessions} />
              </div>
            </>
          ) : null}

          {section === "password" ? (
            <>
              <SecurityRow
                align="start"
                control={securityEnabled ? (
                  <form className="flex w-full min-w-[230px] flex-col gap-[var(--s-3)]" onSubmit={(event) => void submitPassword(event)}>
                    <Field htmlFor="account-current-password" label="Current password" required>
                      <KitInput
                        autoComplete="current-password"
                        disabled={passwordBusy}
                        id="account-current-password"
                        onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                        required
                        type="password"
                        value={currentPassword}
                      />
                    </Field>
                    <Field hint="At least twelve characters." htmlFor="account-new-password" label="New password" required>
                      <KitInput
                        autoComplete="new-password"
                        disabled={passwordBusy}
                        id="account-new-password"
                        minLength={12}
                        onChange={(event) => setReplacementPassword(event.currentTarget.value)}
                        required
                        type="password"
                        value={replacementPassword}
                      />
                    </Field>
                    <Field htmlFor="account-confirm-password" label="Confirm new password" required>
                      <KitInput
                        autoComplete="new-password"
                        disabled={passwordBusy}
                        id="account-confirm-password"
                        minLength={12}
                        onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                        required
                        type="password"
                        value={confirmPassword}
                      />
                    </Field>
                    <Button aria-busy={passwordBusy} disabled={passwordBusy} type="submit">
                      {passwordBusy ? "Changing password…" : "Change password"}
                    </Button>
                  </form>
                ) : <StatusAbsent label="Password change unavailable" />}
                description="A successful change ends every other active session and returns an audit receipt."
                icon={<Lock />}
                title="Replace password"
              />
              <div className="px-[17px] py-[14px]">
                <FeedbackCallout feedback={feedback.password} />
              </div>
            </>
          ) : null}

          {section === "email" ? (
            <>
              <SecurityRow
                control={<span className={MONO_VALUE_CLASS}>{currentEmail}</span>}
                description="This is the address the authenticated provider returned for the current user."
                icon={<UserCircle />}
                title="Current sign-in email"
              />
              <SecurityRow
                control={emailVerified
                  ? <Status label="Verified" tone="good" />
                  : (
                      <Button
                        aria-busy={emailBusy}
                        disabled={emailBusy}
                        onClick={() => void resendEmailVerification()}
                        type="button"
                        variant="outline"
                      >
                        {emailBusy ? "Requesting…" : "Resend verification"}
                      </Button>
                    )}
                description={emailVerified
                  ? "Supabase has confirmed this sign-in address."
                  : "Supabase has not confirmed this address. Request a new verification link for the provider-owned email shown above."}
                icon={<ShieldCheck />}
                title="Email verification"
                tone={emailVerified ? "neutral" : "warning"}
              />
              {emailChangeEnabled ? (
                <SecurityRow
                  control={
                    <form className="grid w-full max-w-[320px] gap-[10px]" onSubmit={(event) => void submitEmailChange(event)}>
                      <Field htmlFor="account-new-email" label="New email address" required>
                        <KitInput
                          autoComplete="email"
                          disabled={emailChangeBusy}
                          id="account-new-email"
                          onChange={(event) => setReplacementEmail(event.currentTarget.value)}
                          required
                          type="email"
                          value={replacementEmail}
                        />
                      </Field>
                      <Field htmlFor="account-email-password" label="Current password" required>
                        <KitInput
                          autoComplete="current-password"
                          disabled={emailChangeBusy}
                          id="account-email-password"
                          onChange={(event) => setEmailChangePassword(event.currentTarget.value)}
                          required
                          type="password"
                          value={emailChangePassword}
                        />
                      </Field>
                      {mfa.kind === "ready" && mfa.status === "active" ? (
                        <Field htmlFor="account-email-code" label="Authenticator code" required>
                          <KitInput
                            autoComplete="one-time-code"
                            disabled={emailChangeBusy}
                            id="account-email-code"
                            inputMode="numeric"
                            onChange={(event) => setEmailChangeCode(event.currentTarget.value)}
                            required
                            value={emailChangeCode}
                          />
                        </Field>
                      ) : null}
                      <Button aria-busy={emailChangeBusy} disabled={emailChangeBusy} type="submit">
                        {emailChangeBusy ? "Requesting confirmation…" : "Change email"}
                      </Button>
                    </form>
                  }
                  description="The address moves only when the new mailbox opens its confirmation link. That step writes the sign-in identity and the account record together and ends every session. A separate message to the current address can refuse the change."
                  icon={<ShieldCheck />}
                  title="Change email"
                />
              ) : (
                <SecurityRow
                  control={<Status label="Not released" tone="warning" />}
                  description="The email-change release gate is off, so no change endpoint is called. Confirmation moves the Supabase sign-in identity and the account record together, and the gate opens once the confirmation email has a live provider behind it."
                  icon={<ShieldCheck />}
                  title="Change email"
                />
              )}
              <div className="px-[17px] py-[14px]">
                <FeedbackCallout feedback={feedback.email} />
              </div>
            </>
          ) : null}

          {section === "authenticator" ? (
            <>
              {!mfaEnabled || mfa.kind === "disabled" ? (
                <SecurityRow
                  control={<Status label="Not released" tone="warning" />}
                  description="The authenticator release gate is off, so no factor endpoint is called."
                  icon={<ShieldCheck />}
                  title="Extra verification"
                />
              ) : null}
              {mfa.kind === "loading" ? (
                <SecurityRow
                  description="Reading the current factor state."
                  icon={<Refresh className="animate-spin motion-reduce:animate-none" />}
                  title="Loading authenticator status"
                />
              ) : null}
              {mfa.kind === "error" ? (
                <SecurityRow
                  control={
                    <Button onClick={() => void refreshMfa()} type="button" variant="outline">
                      Retry
                    </Button>
                  }
                  description={mfa.message}
                  icon={<ShieldCheck />}
                  title="Authenticator status unavailable"
                  tone="failure"
                />
              ) : null}
              {mfa.kind === "ready" && mfa.status === "none" ? (
                <SecurityRow
                  control={
                    <Button aria-busy={mfaBusy} disabled={mfaBusy} onClick={() => void startMfa()} type="button">
                      {mfaBusy ? "Starting setup…" : "Start setup"}
                    </Button>
                  }
                  description="The setup key is shown once. SetterFi does not issue recovery codes yet, so save that key in a password manager before activation."
                  icon={<ShieldCheck />}
                  title="No authenticator factor"
                />
              ) : null}
              {mfa.kind === "ready" && mfa.status === "pending" && !mfaSecret ? (
                <SecurityRow
                  control={<Status label="Support required" tone="warning" />}
                  description="Setup is pending, but the one-time key is no longer available. There is no recovery or pending-factor reset route, so this screen will not guess or start over."
                  icon={<ShieldCheck />}
                  title="Setup interrupted"
                  tone="waiting"
                />
              ) : null}
              {mfa.kind === "ready" && mfa.status === "pending" && mfaSecret ? (
                <SecurityRow
                  align="start"
                  control={
                    <form className="flex w-full min-w-[230px] flex-col gap-[var(--s-3)]" onSubmit={(event) => void activateMfa(event)}>
                      <div className="rounded-[var(--r-input)] border border-[var(--line)] bg-[var(--quiet)] p-[var(--s-3)]">
                        <p className={PANEL_EYEBROW_CLASS}>One-time setup key</p>
                        <div className="flex items-center gap-[var(--s-2)]">
                          <code className={`${MONO_VALUE_CLASS} flex-1 text-[color:var(--ink)]`}>{mfaSecret}</code>
                          <CopyValue label="authenticator setup key" value={mfaSecret} />
                        </div>
                      </div>
                      {/*
                        * The checkbox is exempted from the coach surface's 44px floor deliberately,
                        * and it is the one exemption on this page. That floor is a `min-height`, so
                        * applied to a 16px square box it does not grow the control -- it stretches
                        * it into a 16x44 rectangle that no longer reads as a checkbox. The target
                        * the rule is actually protecting is the label, which toggles the box and,
                        * wrapping two lines of 16px copy beside a 16px square, clears 44px on its
                        * own; `min-h` states that floor rather than leaving it to the copy length.
                        */}
                      {/*
                        Two links, not three, and no keyword at the end. `--t-target` is 44px at
                        the root and `console.css` re-authors it to `--console-target`, so this
                        reads 44px on the coach shell, 32px on the admin shell, and 44px on the
                        affiliate shell -- which is the point of the change. The chain this
                        replaced ended in `auto`, and `auto` is not a small floor, it is no floor:
                        an affiliate turning on MFA had no pressable target on the one page where
                        that matters most, because no affiliate stylesheet declares a target and
                        the fallback had nowhere left to go.
                      */}
                      <label className="flex min-h-[var(--coach-target,var(--t-target))] items-start gap-[var(--s-2)] text-[length:var(--coach-body,var(--t-body))] leading-[1.45] text-[color:var(--muted)]">
                        <input
                          checked={secretSaved}
                          className="mt-[2px] size-[var(--s-4)]"
                          data-coach-target="exempt"
                          onChange={(event) => setSecretSaved(event.currentTarget.checked)}
                          type="checkbox"
                        />
                        <span>I saved this key securely and understand recovery codes are not available.</span>
                      </label>
                      <Field hint="Enter the six-digit code from the authenticator app." htmlFor="account-mfa-activate-code" label="Authenticator code" required>
                        <KitInput
                          autoComplete="one-time-code"
                          disabled={mfaBusy}
                          id="account-mfa-activate-code"
                          inputMode="numeric"
                          maxLength={6}
                          onChange={(event) => setMfaCode(event.currentTarget.value.replace(/\D/gu, "").slice(0, 6))}
                          pattern="[0-9]{6}"
                          required
                          value={mfaCode}
                        />
                      </Field>
                      <Button disabled={mfaBusy || !secretSaved || mfaCode.length !== 6} type="submit">
                        {mfaBusy ? "Verifying code…" : "Verify and activate"}
                      </Button>
                    </form>
                  }
                  description="Activation is confirmed only after the factor status reads back as active."
                  icon={<ShieldCheck />}
                  title="Finish authenticator setup"
                />
              ) : null}
              {mfa.kind === "ready" && mfa.status === "active" ? (
                <SecurityRow
                  align="start"
                  control={
                    <form className="flex w-full min-w-[230px] flex-col gap-[var(--s-3)]" onSubmit={(event) => void removeMfa(event)}>
                      <Field hint="A current code is required to remove the factor." htmlFor="account-mfa-remove-code" label="Authenticator code" required>
                        <KitInput
                          autoComplete="one-time-code"
                          disabled={mfaBusy}
                          id="account-mfa-remove-code"
                          inputMode="numeric"
                          maxLength={6}
                          onChange={(event) => setMfaCode(event.currentTarget.value.replace(/\D/gu, "").slice(0, 6))}
                          pattern="[0-9]{6}"
                          required
                          value={mfaCode}
                        />
                      </Field>
                      <Button disabled={mfaBusy || mfaCode.length !== 6} type="submit" variant="destructive">
                        {mfaBusy ? "Removing…" : "Remove extra verification"}
                      </Button>
                    </form>
                  }
                  description="This factor protects supported sensitive changes. It is not currently enforced as a second step during sign-in, and no recovery-code flow exists."
                  icon={<ShieldCheck />}
                  title={<span className="flex flex-wrap items-center gap-[var(--s-2)]">Extra verification <Status label="Active" tone="good" /></span>}
                />
              ) : null}
              <div className="px-[17px] py-[14px]">
                <FeedbackCallout feedback={feedback.authenticator} />
              </div>
            </>
          ) : null}
        </SecurityPanel>
      ))}

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => {
        if (!open && !revokeBusy) {
          setRevokeTarget(null);
          setRevokeReason("");
        }
      }}>
        <AlertDialogContent>
          <form className="contents" onSubmit={(event) => void submitRevocation(event)}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {revokeTarget?.kind === "one"
                  ? revokeTarget.session.isCurrent ? "Sign out this device?" : "Revoke this session?"
                  : "Revoke every other session?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                The session is ended on the server and the reason is kept in the audit trail.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field hint="Say whether the device is old, lost, or unrecognized." htmlFor="account-session-revoke-reason" label="Reason" required>
              <KitInput
                disabled={revokeBusy}
                id="account-session-revoke-reason"
                maxLength={500}
                onChange={(event) => setRevokeReason(event.currentTarget.value)}
                required
                value={revokeReason}
              />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={revokeBusy}>Cancel</AlertDialogCancel>
              <Button
                aria-busy={revokeBusy}
                disabled={revokeBusy || !revokeReason.trim()}
                type="submit"
                variant="destructive"
              >
                {revokeBusy ? "Revoking…" : "Revoke access"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
