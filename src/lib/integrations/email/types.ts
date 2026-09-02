/**
 * Provider-neutral email delivery outcomes stop at API acceptance.
 *
 * Delivery is intentionally absent here: only a signed Resend receipt can promote an accepted
 * email to delivered, so callers cannot turn a successful POST into a false delivery claim.
 */

export const ALERT_COPY_PLACEHOLDER_PREFIX = "SETTERFI_DEMO_PLACEHOLDER_";

export type DeliverEmailInput = {
  deliveryId: string;
  attemptNumber: number;
  to: string;
  from: string;
  subject: string;
  text: string;
};

export type EmailDeliveryOutcome =
  | { kind: "accepted"; providerReference: string }
  | { kind: "retry"; retryAfterSeconds: number | null; errorCode: string }
  | { kind: "terminal"; errorCode: string; safeDetail: string };

export type EmailDriver = {
  deliverEmail(input: DeliverEmailInput): Promise<EmailDeliveryOutcome>;
};

export function emailHasPlaceholderCopy(input: Pick<DeliverEmailInput, "subject" | "text">) {
  return input.subject.startsWith(ALERT_COPY_PLACEHOLDER_PREFIX)
    || input.text.startsWith(ALERT_COPY_PLACEHOLDER_PREFIX);
}
