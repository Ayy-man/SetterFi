/**
 * The email mock is an inspectable sink for demo and credentialless operation.
 *
 * It retains unapproved placeholder copy with an explicit flag because demos need evidence of
 * what would have been attempted while remaining unable to contact a provider.
 */

import {
  emailHasPlaceholderCopy,
  type DeliverEmailInput,
  type EmailDriver,
} from "./types";

export type MockEmailRecord = DeliverEmailInput & {
  placeholderCopy: boolean;
  providerReference: string;
};

export type MockEmailDriver = EmailDriver & {
  readonly records: readonly MockEmailRecord[];
};

export function createMockEmailDriver(): MockEmailDriver {
  const records: MockEmailRecord[] = [];
  return {
    records,
    async deliverEmail(input) {
      const providerReference = `mock-email:${input.deliveryId}:${input.attemptNumber}`;
      records.push({
        ...input,
        placeholderCopy: emailHasPlaceholderCopy(input),
        providerReference,
      });
      return { kind: "accepted", providerReference };
    },
  };
}
