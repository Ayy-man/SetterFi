/**
 * Coach-visible channel labels for the live Integrations surface.
 *
 * This module owns product language only. Provider identity and registration timing stay in their
 * live receipt projections so this inventory cannot expose backend plumbing or invent lifecycle.
 */

export const COACH_INTEGRATION_LABELS = [
  { channel: "instagram", label: "Instagram" },
  { channel: "messenger", label: "Facebook Messenger" },
  { channel: "whatsapp", label: "WhatsApp" },
  { channel: "sms", label: "Text messages (SMS)" },
] as const;

export type CoachIntegrationChannel = (typeof COACH_INTEGRATION_LABELS)[number]["channel"];

export function coachIntegrationLabel(channel: CoachIntegrationChannel) {
  return COACH_INTEGRATION_LABELS.find((entry) => entry.channel === channel)!.label;
}
