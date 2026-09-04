import type { Metadata } from "next";

import { GoLiveStep } from "@/components/onboarding/go-live-step";

export const metadata: Metadata = {
  title: "Turn your agent on",
  description: "What is ready, what is still waiting, and the one press that starts your agent.",
  robots: { index: false, follow: false },
};

/**
 * Step 6 of setup, and the last one.
 *
 * It moved off the setup root on 2026-09-04. The root is the six-step status list now, and a page
 * that was both the map and the final action could not be either: it printed a seven-check count
 * over a four-box strip, which is the contradiction Note 3 recorded. The map counts steps and this
 * screen judges the go-live checks, which are two different questions asked in two places.
 */
export default function GoLivePage() {
  return <GoLiveStep />;
}
