/**
 * The Slack mock retains message evidence without retaining a webhook destination.
 *
 * Webhook URLs are bearer secrets, so even the in-memory demo sink deliberately omits the field
 * while keeping the delivery identity and placeholder flag inspectable.
 */

import {
  slackHasPlaceholderCopy,
  type PostSlackInput,
  type SlackDriver,
} from "./types";

export type MockSlackRecord = Omit<PostSlackInput, "destinationUrl"> & {
  placeholderCopy: boolean;
  providerReference: string;
};

export type MockSlackDriver = SlackDriver & {
  readonly records: readonly MockSlackRecord[];
};

export function createMockSlackDriver(): MockSlackDriver {
  const records: MockSlackRecord[] = [];
  return {
    records,
    async postSlack(input) {
      const providerReference = `mock-slack:${input.deliveryId}:${input.attemptNumber}`;
      records.push({
        deliveryId: input.deliveryId,
        attemptNumber: input.attemptNumber,
        text: input.text,
        placeholderCopy: slackHasPlaceholderCopy(input.text),
        providerReference,
      });
      return { kind: "delivered", providerReference };
    },
  };
}
