/**
 * One source of truth for "how far is this coach through setup".
 *
 * The shell instrument and the coach-home "Finish setup" card both read the same onboarding
 * preview state, so the two meters can never disagree. Honest-states rule applies: a channel
 * that is still provisioning adds a slot it cannot fill, so the meter never reads full while
 * anything is amber.
 */

import { phase5Live, type EnvironmentSource } from "@/lib/env-contract";
import { readScopedJson, removeScoped, STORAGE_NAMES, writeScopedJson } from "@/lib/tenant-storage";

export type OnboardingChannelId = "facebook" | "instagram" | "whatsapp" | "sms";
export type OnboardingChannelState = "off" | "ready" | "pending";

export type OnboardingPreviewHandoff = {
  step?: string;
  channels?: Partial<Record<OnboardingChannelId, OnboardingChannelState>>;
  calendar?: string | null;
  offerIncludes?: string[];
  /** True once the coach has actually worked the offer step; the default picks don't count. */
  offerTouched?: boolean;
  cadence?: number;
  tested?: boolean;
  handoff?: boolean;
};

/**
 * The state the rest of the coach demo already asserts: Meta connected (Instagram and Messenger
 * live), Google Calendar connected, offer described, a safe test run — with WhatsApp verifying
 * and SMS still in carrier registration. Without this baseline a clean browser would read
 * "0 of 4" on the same page that shows a live agent, a populated inbox, and real funnel
 * analytics. The pending channels still add slots the meter cannot fill, so it never reads full.
 */
export const DEMO_COACH_SETUP_BASELINE: OnboardingPreviewHandoff = {
  channels: { instagram: "ready", facebook: "ready", whatsapp: "pending", sms: "pending" },
  calendar: "google",
  offerIncludes: ["Business funding", "Credit strategy"],
  offerTouched: true,
  tested: true,
};

export type SetupStepState = "done" | "pending" | "todo";

export type SetupStep = {
  id: "channel" | "calendar" | "offer" | "test" | "sms" | "whatsapp";
  label: string;
  detail: string;
  state: SetupStepState;
};

export type SetupProgress = {
  steps: readonly SetupStep[];
  done: number;
  total: number;
  completed: boolean;
  smsPending: boolean;
  whatsappPending: boolean;
  readyChannels: readonly string[];
  /** The first step still outstanding, used for the shell's one-line prompt. */
  next: SetupStep | null;
};

/** Reads the onboarding preview without throwing on corrupted or absent local state. */
export function readOnboardingPreview(
  environment: EnvironmentSource = process.env,
): OnboardingPreviewHandoff | null {
  // Phase 5: the live provisioning route owns progress, so browser storage is never consulted.
  if (phase5Live(environment)) return null;
  return readScopedJson<OnboardingPreviewHandoff>("tenant", STORAGE_NAMES.onboarding);
}

export function writeOnboardingPreview(value: OnboardingPreviewHandoff) {
  writeScopedJson("tenant", STORAGE_NAMES.onboarding, value);
}

export function clearOnboardingPreview() {
  removeScoped("tenant", STORAGE_NAMES.onboarding);
}

export function deriveSetupProgress(preview: OnboardingPreviewHandoff | null): SetupProgress {
  // No walked-through onboarding means we're reading the seeded demo coach, whose channels,
  // calendar, and inbox are already populated everywhere else on the screen.
  const source = preview ?? DEMO_COACH_SETUP_BASELINE;
  const channels = source.channels ?? {};
  const readyChannels = [
    channels.instagram === "ready" ? "Instagram" : null,
    channels.facebook === "ready" ? "Messenger" : null,
    channels.whatsapp === "ready" ? "WhatsApp" : null,
  ].filter((channel): channel is string => Boolean(channel));
  const smsPending = channels.sms === "pending";
  const whatsappPending = channels.whatsapp === "pending";
  const anyReady = Object.values(channels).some((state) => state === "ready");

  const steps: SetupStep[] = [
    {
      // Only a channel that can actually receive a lead ticks this. A channel still in review gets
      // its own outstanding slot below, so one pending channel never burns two slots here.
      id: "channel",
      label: "Connect a lead channel",
      detail: "Instagram, Messenger, WhatsApp, or text messages.",
      state: anyReady ? "done" : "todo",
    },
    {
      id: "calendar",
      label: "Connect your calendar",
      detail: "Booked calls need somewhere to land.",
      state: source.calendar ? "done" : "todo",
    },
    {
      id: "offer",
      label: "Describe your offer",
      detail: "What you sell, and who qualifies for it.",
      state: source.offerTouched && (source.offerIncludes?.length ?? 0) > 0 ? "done" : "todo",
    },
    {
      id: "test",
      label: "Run a safe test",
      detail: "Talk to your agent before a real lead does.",
      state: source.tested ? "done" : "todo",
    },
  ];

  // A channel still in review is a real outstanding slot, not a finished one. Each pending channel
  // adds exactly one, so the meter reads the same way whichever channel is waiting.
  if (whatsappPending) {
    steps.push({
      id: "whatsapp",
      label: "WhatsApp verification",
      detail: "Meta verification is usually minutes, up to 1–2 days, and flips on automatically.",
      state: "pending",
    });
  }

  if (smsPending) {
    steps.push({
      id: "sms",
      label: "SMS registration",
      detail: "Carrier review usually takes 2–3 weeks and flips on automatically.",
      state: "pending",
    });
  }

  const done = steps.filter((step) => step.state === "done").length;

  return {
    steps,
    done,
    total: steps.length,
    completed: Boolean(source.handoff),
    smsPending,
    whatsappPending,
    readyChannels,
    next: steps.find((step) => step.state !== "done") ?? null,
  };
}

// Phase 5
export function deriveLegacySetupProgress(
  preview: OnboardingPreviewHandoff | null,
  environment: EnvironmentSource = process.env,
): SetupProgress | null {
  return phase5Live(environment) ? null : deriveSetupProgress(preview);
}
