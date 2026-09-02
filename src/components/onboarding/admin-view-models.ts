import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import {
  CARRIER_TYPICAL_DAYS,
  type ProvisioningStep,
  type ProvisioningTrackerRow,
} from "@/lib/onboarding/contracts";

export type ProvisioningPartyGroup = "coach" | "platform" | "provider";

export type ProvisioningAdminAction =
  | {
      kind: "retry";
      label: "Retry";
      actionKey: "onboarding.step_retried";
      tenantId: string;
      step: ProvisioningStep;
    }
  | {
      kind: "unblock";
      label: "Unblock";
      actionKey: "onboarding.step_unblocked";
      tenantId: string;
      step: ProvisioningStep;
      requiresReason: true;
    }
  | {
      kind: "confirm_content";
      label: "Confirm content";
      actionKey: "onboarding.a2p_filing_confirmed";
      tenantId: string;
      screenId: string;
    };

export type AdminProvisioningRow = {
  id: string;
  tenantId: string | null;
  title: string;
  stepLabel: string;
  stateLabel: string;
  detail: string;
  tone: "neutral" | "good" | "pending" | "bad";
  group: ProvisioningPartyGroup;
  providerLabel: string | null;
  attemptsLabel: string;
  safeError: string | null;
  stalledLabel: string | null;
  stalled: boolean;
  /**
   * When the current step last changed state, from the tracker's `last_transition_at`
   * (20260821000002:227). It is the elapsed-days clock for every waiting row, not only the
   * carrier ones, so the Waiting column can be a real day counter instead of "Not waiting".
   */
  waitingSince: string | null;
  terminal: boolean;
  isDemo: boolean | null;
  dataClassification: "Demo" | "Real" | "Not available";
  actions: readonly ProvisioningAdminAction[];
};

export type AdminProvisioningView = {
  enabled: boolean;
  authorized: boolean;
  emptyMessage: string;
  brainMissing: boolean;
  realRowCount: number;
  demoRowCount: number;
  rows: readonly AdminProvisioningRow[];
  groups: Readonly<Record<ProvisioningPartyGroup, readonly AdminProvisioningRow[]>>;
};

export type LoggedActionReceipt = {
  auditId: string;
  actionKey: Extract<
    AuditActionKey,
    "onboarding.step_retried" | "onboarding.step_unblocked" | "onboarding.a2p_filing_confirmed"
  >;
  microcopy: string;
  ariaLabel: string;
};

const A2P_STEPS: readonly ProvisioningStep[] = ["a2p_brand", "a2p_campaign", "sms_live"];
const DAY_MS = 24 * 60 * 60 * 1000;
const STALL_MS = {
  coach: 72 * 60 * 60 * 1000,
  platform: 30 * 60 * 1000,
  system: 30 * 60 * 1000,
  provider: 3 * DAY_MS,
  // The top of the published carrier window, read from the contract rather than typed again. This
  // file carried the number 21 three times over, which is the drift `admin-provisioning.tsx`
  // documents: four surfaces agreeing on a provider window by coincidence.
  carrier: CARRIER_TYPICAL_DAYS[1] * DAY_MS,
} as const;

const STEP_LABELS: Record<ProvisioningStep, string> = {
  account: "Account",
  billing: "Billing",
  ghl_location: "Workspace",
  ghl_snapshot: "Workspace template",
  phone_number: "Phone number",
  sms_eligibility_screen: "SMS eligibility",
  business_profile: "Business profile",
  optin_artifact: "Opt-in evidence",
  a2p_brand: "A2P brand",
  a2p_campaign: "A2P campaign",
  sms_live: "Text messages (SMS)",
  meta_connect: "Meta channels",
  whatsapp_connect: "WhatsApp",
  calendar_connect: "Calendar",
  offer_layer: "Offer",
  test_pass: "Safe test",
  go_live: "Go live",
};

function groupFor(party: ProvisioningTrackerRow["blockingParty"]): ProvisioningPartyGroup {
  return party === "provider" ? "provider" : party === "coach" ? "coach" : "platform";
}

function elapsedSince(value: string | null, now: Date) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : null;
}

function carrierDay(value: string | null, now: Date) {
  const elapsed = elapsedSince(value, now);
  return elapsed === null ? 1 : Math.floor(elapsed / DAY_MS) + 1;
}

function stallThreshold(row: ProvisioningTrackerRow) {
  if (row.blockingParty === "provider") {
    return row.blockingProvider === "carrier" ? STALL_MS.carrier : STALL_MS.provider;
  }
  return STALL_MS[row.blockingParty];
}

function isStalled(row: ProvisioningTrackerRow, now: Date) {
  if (["done", "blocked"].includes(row.state)) return false;
  const elapsed = elapsedSince(row.stalledSince, now);
  return elapsed !== null && elapsed >= stallThreshold(row);
}

function safeError(errorCode: string | null) {
  if (!errorCode) return null;
  return /^[a-z0-9_.:-]{1,100}$/i.test(errorCode) ? errorCode : "Error details withheld";
}

function actionsFor(row: ProvisioningTrackerRow): readonly ProvisioningAdminAction[] {
  if (!row.tenantId || !row.currentStep) return [];
  const actions: ProvisioningAdminAction[] = [];
  if (row.state === "failed") {
    actions.push({
      kind: "retry",
      label: "Retry",
      actionKey: "onboarding.step_retried",
      tenantId: row.tenantId,
      step: row.currentStep,
    });
  }
  if (row.state === "blocked" && !A2P_STEPS.includes(row.currentStep)) {
    actions.push({
      kind: "unblock",
      label: "Unblock",
      actionKey: "onboarding.step_unblocked",
      tenantId: row.tenantId,
      step: row.currentStep,
      requiresReason: true,
    });
  }
  if (row.contentScreenId && row.contentScreenState === "awaiting_admin") {
    actions.push({
      kind: "confirm_content",
      label: "Confirm content",
      actionKey: "onboarding.a2p_filing_confirmed",
      tenantId: row.tenantId,
      screenId: row.contentScreenId,
    });
  }
  return actions;
}

function descriptor(row: ProvisioningTrackerRow, now: Date) {
  const a2p = Boolean(row.currentStep && A2P_STEPS.includes(row.currentStep));
  if (row.state === "blocked" && a2p) {
    return {
      stateLabel: "Permanently blocked",
      detail: "Carrier registration was declined and cannot be retried from this tracker.",
      tone: "bad" as const,
      terminal: true,
      stalledLabel: null,
    };
  }
  if (a2p && row.state === "awaiting_provider") {
    const day = carrierDay(row.stalledSince, now);
    return {
      stateLabel: `Registering · day ${day}`,
      detail: `Carrier review usually takes 2–3 weeks. It turns on automatically, with nothing for the coach to do.${day > CARRIER_TYPICAL_DAYS[1] ? " Platform follow-up is required because the carrier window has passed." : ""}`,
      tone: "pending" as const,
      terminal: false,
      stalledLabel: day > CARRIER_TYPICAL_DAYS[1] ? "Carrier window passed" : null,
    };
  }
  if (row.currentStep === "offer_layer" && row.state === "awaiting_platform") {
    return {
      stateLabel: "Offer held for platform review",
      detail: "The platform must clear the offer before provisioning can continue.",
      tone: "pending" as const,
      terminal: false,
      stalledLabel: isStalled(row, now) ? "Platform review stalled" : null,
    };
  }

  const states = {
    pending: ["Queued", "Waiting for an eligible provisioning worker.", "neutral"],
    running: ["Provisioning", "The current step is still running.", "pending"],
    awaiting_coach: ["Coach action required", "The coach owns the next action.", "pending"],
    awaiting_platform: ["Platform review", "The platform owns the next action.", "pending"],
    awaiting_provider: ["Provider review", "An external provider owns the current wait.", "pending"],
    done: ["Ready", "The provisioning step has persisted completion evidence.", "good"],
    failed: ["Failed", "A non-blocked failure may be retried by an authorized operator.", "bad"],
    blocked: ["Blocked", "An authorized operator must resolve the recorded block.", "bad"],
  } as const;
  const [stateLabel, detail, tone] = states[row.state];
  return {
    stateLabel,
    detail,
    tone,
    terminal: false,
    stalledLabel: isStalled(row, now) ? "Stall threshold passed" : null,
  };
}

function mapRow(row: ProvisioningTrackerRow, now: Date): AdminProvisioningRow {
  const state = descriptor(row, now);
  return {
    id: row.signupIntentId,
    tenantId: row.tenantId,
    // Every identity cell in the table is a name. A pre-tenant signup used to put the whole
    // sentence "Signup awaiting tenant creation" in the name column, which is what the Step column
    // ("Tenant creation") already says.
    title: row.businessName ?? (row.tenantId ? "Unnamed business" : "Unnamed signup"),
    stepLabel: row.currentStep ? STEP_LABELS[row.currentStep] : "Tenant creation",
    stateLabel: state.stateLabel,
    detail: state.detail,
    tone: state.tone,
    group: groupFor(row.blockingParty),
    providerLabel: row.blockingProvider,
    attemptsLabel: `${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"}`,
    safeError: safeError(row.errorCode),
    stalledLabel: state.stalledLabel,
    stalled: state.stalledLabel !== null,
    waitingSince: row.stalledSince,
    terminal: state.terminal,
    isDemo: row.isDemo,
    dataClassification: row.isDemo === true ? "Demo" : row.isDemo === false ? "Real" : "Not available",
    actions: state.terminal ? [] : actionsFor(row),
  };
}

export function deriveAdminProvisioningView(input: {
  enabled: boolean;
  authorized: boolean;
  rows?: readonly ProvisioningTrackerRow[];
  now?: Date;
}): AdminProvisioningView {
  const rows = input.enabled && input.authorized
    ? (input.rows ?? []).map((row) => mapRow(row, input.now ?? new Date()))
    : [];
  return {
    enabled: input.enabled,
    authorized: input.authorized,
    emptyMessage: !input.enabled
      ? "Self-serve onboarding is not enabled in this environment. No live state is inferred from fixtures."
      : !input.authorized
        ? "This platform role cannot view provisioning."
        : "No persisted onboarding work is waiting for review.",
    brainMissing: rows.some((row) => row.safeError === "platform_brain_publish_pending"),
    realRowCount: rows.filter((row) => row.isDemo === false).length,
    demoRowCount: rows.filter((row) => row.isDemo === true).length,
    rows,
    groups: {
      coach: rows.filter((row) => row.group === "coach"),
      platform: rows.filter((row) => row.group === "platform"),
      provider: rows.filter((row) => row.group === "provider"),
    },
  };
}

export function loggedActionReceipt(value: unknown): LoggedActionReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const auditId = typeof receipt.auditId === "string" ? receipt.auditId.trim() : "";
  const actionKey = receipt.actionKey;
  if (!auditId || ![
    "onboarding.step_retried",
    "onboarding.step_unblocked",
    "onboarding.a2p_filing_confirmed",
  ].includes(String(actionKey))) return null;
  const typedKey = actionKey as LoggedActionReceipt["actionKey"];
  return {
    auditId,
    actionKey: typedKey,
    microcopy: AUDIT_ACTIONS[typedKey].microcopy,
    ariaLabel: AUDIT_ACTIONS[typedKey].ariaLabel,
  };
}
