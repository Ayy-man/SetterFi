"use client";

import { useEffect, useRef, useState } from "react";

import { ConsumerExperience, type HumanReplyWindow } from "@/components/consumer-experience";

/*
 * `programName` is widened in here rather than being added to the wire, because it was already on
 * the wire: `startConsumerSession` reads `program_name` off the session RPC into `brand`, and this
 * type narrowed it back out on arrival, so the booked screen had no subject to state. The RPC
 * coalesces an unpublished offer to an empty string, so it is typed as present-and-possibly-blank
 * and the screen treats blank as "not published".
 *
 * It is deliberately NOT part of `isStartedSession`. The guard is what decides whether a lead gets
 * a conversation at all, and failing a whole session shut because a cosmetic panel's field went
 * missing would trade the surface's actual job for one card.
 */
type StartedSession = {
  brand: { name: string; privacyUrl: string; programName?: string };
  sessionReference: string;
};

type ConsumerEntryProps = {
  bookingConfirmEnabled: boolean;
  consentToken: string;
  humanReplyWindow: HumanReplyWindow | null;
  tenantSlug: string;
};

function isStartedSession(value: unknown): value is StartedSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StartedSession>;
  return typeof candidate.sessionReference === "string" && candidate.sessionReference.length > 0 &&
    Boolean(candidate.brand) && typeof candidate.brand?.name === "string" &&
    typeof candidate.brand?.privacyUrl === "string";
}

export function ConsumerEntry({
  bookingConfirmEnabled,
  consentToken,
  humanReplyWindow,
  tenantSlug,
}: ConsumerEntryProps) {
  const [session, setSession] = useState<StartedSession | null>(null);
  const [error, setError] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/consumer-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", consentToken, tenantSlug }),
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok || !isStartedSession(payload)) {
          const message = payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "This conversation could not be started.";
          throw new Error(message);
        }
        setSession(payload);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "This conversation could not be started.");
      }
    })();

    return () => controller.abort();
  }, [consentToken, tenantSlug]);

  if (session) {
    return (
      <ConsumerExperience
        bookingConfirmEnabled={bookingConfirmEnabled}
        businessName={session.brand.name}
        humanReplyWindow={humanReplyWindow}
        privacyHref={session.brand.privacyUrl || null}
        programName={session.brand.programName || null}
        sessionReference={session.sessionReference}
      />
    );
  }

  return (
    <main className="consumer-shell">
      <div className="consumer-stage">
        <section className="consumer-chat-body" role={error ? "alert" : "status"}>
          <div className="consumer-closed-state" tabIndex={-1}>
            <div>
              <strong>{error ? "Conversation unavailable" : "Starting your conversation"}</strong>
              <span>{error || "Checking your consent and opening a secure session…"}</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
