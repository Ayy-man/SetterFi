"use client";

import { useId, useState } from "react";

import { KitInput } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";

/**
 * A password box with a way to see what you typed.
 *
 * Both entry surfaces asked for a password and gave the reader no way to check it. On a phone
 * keyboard, with autocorrect off and a password manager not involved, a mistyped character is
 * invisible until the form comes back refused, and on /signup that refusal costs the whole form.
 * The canvas draws an eye glyph inside the field on both screens.
 *
 * **The control says "Show" and "Hide" rather than drawing an eye.** Same reasoning as the
 * affiliate's copy button: this side of the product is built for readers who found the console's
 * iconography confusing, and the eye is a convention rather than a picture of anything. It is also
 * the one glyph whose two states look alike at a glance, since the difference is a small slash.
 *
 * The button carries the state in its own label, so nothing here depends on colour or on an
 * `aria-pressed` a reader has to interpret, and a live region says what changed for anyone who is
 * not looking at the button they just pressed.
 *
 * The field never starts revealed and the state is local to the render, so a password is not left
 * on screen by a navigation or restored by the browser's back-forward cache.
 */
export function PasswordField({
  autoComplete,
  hint,
  htmlFor,
  label = "Password",
  minLength,
  name = "password",
}: {
  autoComplete: "current-password" | "new-password";
  hint?: string;
  /** Pin the id when the enclosing page is a server component; see `kit/field.tsx`. */
  htmlFor?: string;
  label?: string;
  minLength?: number;
  name?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const statusId = useId();

  return (
    <Field hint={hint} htmlFor={htmlFor} label={label} required>
      <KitInput
        autoComplete={autoComplete}
        minLength={minLength}
        name={name}
        required
        trailing={
          <>
            <button
              aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
              className="inline-flex min-h-[var(--coach-target)] items-center rounded-[8px] px-[10px] text-[15px] font-[500] text-[color:var(--accent-text)] hover:underline"
              data-slot="password-reveal"
              onClick={() => setRevealed((current) => !current)}
              type="button"
            >
              {revealed ? "Hide" : "Show"}
            </button>
            <span aria-live="polite" className="sr-only" id={statusId}>
              {revealed ? `${label} is showing` : `${label} is hidden`}
            </span>
          </>
        }
        type={revealed ? "text" : "password"}
      />
    </Field>
  );
}
