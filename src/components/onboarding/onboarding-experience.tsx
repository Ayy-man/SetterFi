"use client";

import { CoachOnboarding } from "@/components/onboarding/coach-onboarding";
import { MeetYourAgent } from "@/components/meet-your-agent";

export function OnboardingExperience({
  meetAgentEnabled = false,
}: {
  meetAgentEnabled?: boolean;
}) {
  return (
    <>
      <CoachOnboarding enabled={false} />
      {meetAgentEnabled ? (
        <MeetYourAgent
          canPromote={false}
          enabled={meetAgentEnabled}
          embedded
          initialContext="onboarding"
          lockedContext
        />
      ) : null}
    </>
  );
}
