import type { Metadata } from "next";

import {
  ConsumerExperience,
  type HumanReplyWindow,
} from "@/components/consumer-experience";
import { ConsumerEntry } from "@/components/consumer-entry";
import { bookingConfirmLive } from "@/lib/env-contract";

import "./consumer.css";

/*
 * The tab title cannot name the business, so it names the surface.
 *
 * This one file serves both branches below: a synthetic preview and a real lead's live
 * conversation with whichever tenant the link carries. Static metadata is resolved before that is
 * known, so titling it "Reid Funding Group" put one coach's brand on every other coach's lead
 * conversation. Naming the surface is true in both cases; the business's own name is on the
 * screen itself, where the session can supply it.
 */
export const metadata: Metadata = {
  title: { absolute: "Appointment assistant" },
  description: "Chat with a business's appointment assistant.",
  robots: {
    index: false,
    follow: false,
  },
};

type ConsumerPageProps = {
  searchParams: Promise<{ consent?: string; tenant?: string }>;
};

export default async function ConsumerPage({ searchParams }: ConsumerPageProps) {
  // No persisted human-hours field exists in the current offer or tenant schema. Passing the
  // absence explicitly keeps the consumer copy honest instead of reusing lead quiet hours.
  const humanReplyWindow: HumanReplyWindow | null = null;
  const { consent, tenant } = await searchParams;
  const liveEntry = typeof tenant === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tenant) &&
    typeof consent === "string" && consent.length > 0 && consent.length <= 2_048;

  if (liveEntry) {
    return (
      <ConsumerEntry
        bookingConfirmEnabled={bookingConfirmLive()}
        consentToken={consent}
        humanReplyWindow={humanReplyWindow}
        tenantSlug={tenant}
      />
    );
  }

  return (
    <ConsumerExperience
      bookingConfirmEnabled={bookingConfirmLive()}
      humanReplyWindow={humanReplyWindow}
    />
  );
}
