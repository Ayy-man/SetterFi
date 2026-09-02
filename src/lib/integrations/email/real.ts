/**
 * The Resend adapter owns the only email HTTP request and returns redacted, typed outcomes.
 *
 * A successful API request is accepted rather than delivered. Provider bodies, authorization
 * headers, and recipient content never cross the adapter's result boundary.
 */

import type { EmailRealConfiguration } from "./selector";
import {
  emailHasPlaceholderCopy,
  type DeliverEmailInput,
  type EmailDeliveryOutcome,
  type EmailDriver,
} from "./types";

export const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_IDEMPOTENCY_RETENTION_HOURS = 24;
export const RESEND_DEFAULT_REQUESTS_PER_SECOND = 10;
export const RESEND_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export type RealEmailDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function terminal(errorCode: string, safeDetail: string): EmailDeliveryOutcome {
  return { kind: "terminal", errorCode, safeDetail };
}

function nonNegativeSeconds(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : null;
}

function retryAfterSeconds(headers: Headers, now: Date) {
  const retryAfter = headers.get("retry-after");
  const numericRetryAfter = nonNegativeSeconds(retryAfter);
  const datedRetryAfter = numericRetryAfter === null && retryAfter
    ? Math.max(0, Math.ceil((Date.parse(retryAfter) - now.getTime()) / 1_000))
    : null;
  const rateLimitReset = nonNegativeSeconds(headers.get("ratelimit-reset"));
  const candidates = [numericRetryAfter, datedRetryAfter, rateLimitReset].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function idempotencyKey(input: Pick<DeliverEmailInput, "deliveryId" | "attemptNumber">) {
  return `notification:${input.deliveryId}:attempt:${input.attemptNumber}`;
}

export function createRealEmailDriver(
  configuration: EmailRealConfiguration,
  dependencies: RealEmailDependencies = {},
): EmailDriver {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return {
    async deliverEmail(input) {
      // Seeded copy is deliberately inspectable in mock, but it must never reach request creation.
      if (emailHasPlaceholderCopy(input)) {
        return terminal("ALERT_COPY_UNAPPROVED", "Alert copy has not been approved for delivery.");
      }

      if (input.from !== configuration.from) {
        return terminal("RESEND_FROM_NOT_ALLOWED", "The configured sender does not match the request.");
      }

      const key = idempotencyKey(input);
      if (
        !input.deliveryId
        || !Number.isSafeInteger(input.attemptNumber)
        || input.attemptNumber < 1
        || key.length > RESEND_IDEMPOTENCY_KEY_MAX_LENGTH
      ) {
        return terminal("RESEND_IDEMPOTENCY_KEY_INVALID", "The delivery attempt identifier is invalid.");
      }

      let response: Response;
      try {
        response = await fetcher(RESEND_EMAIL_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            from: configuration.from,
            to: [input.to],
            subject: input.subject,
            text: input.text,
          }),
        });
      } catch {
        return { kind: "retry", retryAfterSeconds: null, errorCode: "RESEND_NETWORK_ERROR" };
      }

      if (response.status === 429 || response.status >= 500) {
        return {
          kind: "retry",
          retryAfterSeconds: retryAfterSeconds(response.headers, now()),
          errorCode: `RESEND_HTTP_${response.status}`,
        };
      }

      if (response.status !== 200) {
        return terminal(
          `RESEND_HTTP_${response.status}`,
          `Resend rejected the request with HTTP ${response.status}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return terminal("RESEND_RESPONSE_INVALID", "Resend returned an invalid acceptance response.");
      }
      const providerReference = object(payload)?.id;
      if (typeof providerReference !== "string" || !providerReference.trim()) {
        return terminal("RESEND_RESPONSE_INVALID", "Resend returned an invalid acceptance response.");
      }
      return { kind: "accepted", providerReference };
    },
  };
}
