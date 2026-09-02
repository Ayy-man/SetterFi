"use client";

import { useState } from "react";

import { KitButton, KitInput, Prose, Surface } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { COACH_READING_CLASS } from "@/components/workspace/live/coach-type";

/**
 * Every outcome that is not an outright refusal shows the same sentence the route returns, because
 * telling the reader whether that address has an account is exactly the disclosure the endpoint is
 * built to avoid. The submit button stays disabled while a request is in flight so a second press
 * cannot spend another of the throttle's attempts.
 *
 * The readout below the button is deliberately untoned for the same reason. Clay for "no such
 * account" and neutral for "sent" would leak the answer through colour that the sentence is
 * careful not to give, so every outcome reads the same way as well as saying the same thing.
 */
export function ForgotPasswordForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : null;

      if (response.status === 429) {
        setStatus("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      if (response.status === 503) {
        setStatus("Password reset is unavailable right now. Try again shortly.");
        return;
      }
      setStatus(message ?? "If an eligible account matches that email address, we have sent instructions.");
    } catch {
      setStatus("The request could not be sent. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface>
      <form className="flex flex-col gap-[var(--s-4)]" onSubmit={submit}>
        <Field htmlFor="forgot-password-email" label="Email address" required>
          <KitInput
            autoComplete="email"
            id="forgot-password-email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </Field>
        {/* Sending the link is the only thing this page does, so it carries the page's one fill. */}
        <div className="flex flex-wrap items-center justify-between gap-[var(--s-3)]">
          <a className={`link-inline font-[500] ${COACH_READING_CLASS}`} href="/login">
            Back to sign in
          </a>
          <KitButton disabled={submitting} size="lg" type="submit" variant="primary">
            {submitting ? "Sending…" : "Send reset link"}
          </KitButton>
        </div>
        {status ? (
          <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`} role="status">
            {status}
          </Prose>
        ) : null}
      </form>
    </Surface>
  );
}
