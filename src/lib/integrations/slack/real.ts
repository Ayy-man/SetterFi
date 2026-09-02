/**
 * The Slack adapter owns destination resolution and the only outgoing webhook request.
 *
 * Tenant destinations outrank the platform fallback, but neither URL is retained or reflected in
 * outcomes. Delivery requires both HTTP 200 and the exact documented `ok` response body.
 */

import type { SlackRealConfiguration } from "./selector";
import {
  slackHasPlaceholderCopy,
  type PostSlackInput,
  type SlackDeliveryOutcome,
  type SlackDriver,
} from "./types";

export const SLACK_TEXT_LIMIT_EXCLUSIVE = 3_000;

export type RealSlackDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
};

const DOCUMENTED_TERMINAL_BODIES = {
  invalid_payload: ["SLACK_INVALID_PAYLOAD", "Slack rejected the webhook payload."],
  invalid_token: ["SLACK_INVALID_TOKEN", "Slack rejected the webhook credential."],
  no_service: ["SLACK_NO_SERVICE", "Slack could not find the webhook service."],
  no_service_id: ["SLACK_NO_SERVICE_ID", "Slack could not find the webhook service."],
  no_team: ["SLACK_NO_TEAM", "Slack could not find the webhook workspace."],
  team_disabled: ["SLACK_TEAM_DISABLED", "The Slack workspace is disabled."],
  channel_not_found: ["SLACK_CHANNEL_NOT_FOUND", "Slack could not find the destination channel."],
  channel_is_archived: ["SLACK_CHANNEL_ARCHIVED", "The Slack destination channel is archived."],
  user_not_found: ["SLACK_USER_NOT_FOUND", "Slack could not resolve the webhook owner."],
  action_prohibited: ["SLACK_ACTION_PROHIBITED", "Slack policy prohibits this webhook action."],
  posting_to_general_channel_denied: [
    "SLACK_GENERAL_CHANNEL_DENIED",
    "Slack policy prohibits posting to the general channel.",
  ],
  too_many_attachments: ["SLACK_TOO_MANY_ATTACHMENTS", "Slack rejected the message attachments."],
} as const satisfies Record<string, readonly [string, string]>;

function terminal(errorCode: string, safeDetail: string): SlackDeliveryOutcome {
  return { kind: "terminal", errorCode, safeDetail };
}

function retryAfterSeconds(headers: Headers, now: Date) {
  const value = headers.get("retry-after");
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - now.getTime()) / 1_000))
    : null;
}

function validDestination(value: string) {
  try {
    const destination = new URL(value);
    return destination.protocol === "https:"
      && (destination.hostname === "hooks.slack.com"
        || destination.hostname === "hooks.slack-gov.com")
      && destination.port === ""
      && destination.username === ""
      && destination.password === ""
      && destination.search === ""
      && destination.hash === ""
      && /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
        destination.pathname,
      );
  } catch {
    return false;
  }
}

function destinationFor(input: PostSlackInput, configuration: SlackRealConfiguration) {
  const tenantDestination = typeof input.destinationUrl === "string"
    ? input.destinationUrl.trim()
    : "";
  return tenantDestination || configuration.platformFallbackUrl.trim();
}

function deliveredReference(input: Pick<PostSlackInput, "deliveryId" | "attemptNumber">) {
  return `slack-webhook:${input.deliveryId}:attempt:${input.attemptNumber}`;
}

export function createRealSlackDriver(
  configuration: SlackRealConfiguration,
  dependencies: RealSlackDependencies = {},
): SlackDriver {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return {
    async postSlack(input) {
      // Seeded copy is deliberately inspectable in mock, but it must never reach request creation.
      if (slackHasPlaceholderCopy(input.text)) {
        return terminal("ALERT_COPY_UNAPPROVED", "Alert copy has not been approved for delivery.");
      }

      const characterCount = Array.from(input.text).length;
      if (!input.text.trim() || characterCount >= SLACK_TEXT_LIMIT_EXCLUSIVE) {
        return terminal(
          "SLACK_TEXT_INVALID",
          "Slack text must contain fewer than 3000 characters.",
        );
      }

      const destinationUrl = destinationFor(input, configuration);
      if (!destinationUrl || !validDestination(destinationUrl)) {
        return terminal("SLACK_DESTINATION_MISSING", "A valid Slack destination is required.");
      }

      let response: Response;
      try {
        response = await fetcher(destinationUrl, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input.text }),
        });
      } catch {
        return { kind: "retry", retryAfterSeconds: null, errorCode: "SLACK_NETWORK_ERROR" };
      }

      if (response.status === 429 || response.status >= 500) {
        return {
          kind: "retry",
          retryAfterSeconds: retryAfterSeconds(response.headers, now()),
          errorCode: `SLACK_HTTP_${response.status}`,
        };
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        return terminal("SLACK_RESPONSE_INVALID", "Slack returned an unreadable response.");
      }

      if (response.status === 200 && body === "ok") {
        return { kind: "delivered", providerReference: deliveredReference(input) };
      }

      const documented = DOCUMENTED_TERMINAL_BODIES[
        body as keyof typeof DOCUMENTED_TERMINAL_BODIES
      ];
      if (documented) return terminal(documented[0], documented[1]);

      if (response.status === 200) {
        return terminal("SLACK_RESPONSE_INVALID", "Slack returned an unrecognized success response.");
      }
      return terminal(
        `SLACK_HTTP_${response.status}`,
        `Slack rejected the request with HTTP ${response.status}.`,
      );
    },
  };
}
