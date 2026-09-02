/**
 * Provider-neutral Slack outcomes require the webhook's documented response body.
 *
 * HTTP status is insufficient because Slack returns specific permanent failures in the body, so
 * callers receive a closed outcome instead of reinterpreting provider text downstream.
 */

export const ALERT_COPY_PLACEHOLDER_PREFIX = "SETTERFI_DEMO_PLACEHOLDER_";

export type PostSlackInput = {
  deliveryId: string;
  attemptNumber: number;
  text: string;
  destinationUrl: string | null;
};

export type SlackDeliveryOutcome =
  | { kind: "delivered"; providerReference: string }
  | { kind: "retry"; retryAfterSeconds: number | null; errorCode: string }
  | { kind: "terminal"; errorCode: string; safeDetail: string };

export type SlackDriver = {
  postSlack(input: PostSlackInput): Promise<SlackDeliveryOutcome>;
};

export function slackHasPlaceholderCopy(text: string) {
  return text.startsWith(ALERT_COPY_PLACEHOLDER_PREFIX);
}
