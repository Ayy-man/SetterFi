"use client";

import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { Label } from "@/components/ui/label";

export type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /**
   * Pins the id this field wires the label and messages to, instead of letting `useId` mint one.
   * Pass it whenever something outside the field needs to name the control -- an `aria-controls`
   * elsewhere on the page, a `document.getElementById` in a handler, a test that queries by id.
   * The control's own `id` attribute is NOT consulted for this (see the note in `Field`), so a
   * caller that puts `id="x"` on the child and nothing on the field would have that id quietly
   * replaced; in dev that mismatch is reported rather than tolerated.
   */
  htmlFor?: string;
  children: ReactNode;
};

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

/*
 * Why a context at all, when cloning the child is simpler.
 *
 * `Field` is a client component, and a *server* component is allowed to hand it JSX as children
 * (`src/app/login/page.tsx` does, and so do /access and /auth/reset-password). Those children do
 * not arrive as React elements. They cross the RSC boundary as an unresolved Flight node -- a
 * lazy wrapper the renderer unwraps on its way down the tree -- so `children.props` is `undefined`
 * and `isValidElement(children)` is false. The previous implementation cast children to an element
 * and read `.props.id` off it, which threw `Cannot read properties of undefined` on every server
 * render of /login. React caught it and silently fell back to client rendering, so the page still
 * returned 200 while losing SSR entirely.
 *
 * You cannot `cloneElement` a node you cannot recognise as an element, so for that case the wiring
 * has to travel down the tree instead of being stamped onto the child from above. The control
 * reads it out of this context (see `useFieldControl` in kit/atomics/field.tsx). Cloning is kept
 * for the ordinary in-client case because it reaches controls that know nothing about this
 * component at all -- a bare `<input>`, `ui/Input`, `ui/Select`.
 *
 * The context is deliberately provided ONLY on the branch where cloning was impossible. If both
 * paths were live, a field whose child subtree happens to contain two inputs would hand the same
 * id to both and produce duplicate ids; scoping the context to the branch that has exactly one
 * known caller shape keeps that impossible today, and the dev-time audit below catches it if a
 * second control ever shows up under one.
 */
type FieldControlContextValue = {
  props: FieldControlProps;
  /**
   * Called by the control that takes the wiring. It is a callback rather than a counter the
   * consumer increments because the consumer is not allowed to mutate a context value; the
   * bookkeeping it does lives in `Field`'s own scope and never reaches the rendered output.
   *
   * It takes the claimant's identity rather than being a bare tally. The audit's question is "how
   * many controls are on this id", and a count of calls is a different number: in dev, StrictMode
   * invokes a child twice inside a single parent pass, so one control claiming once produced two
   * calls and a duplicate-id warning about a page that had no duplicate. A `useId` is stable across
   * those invocations for the same component instance and differs between instances, so counting
   * distinct claimants asks the question the warning is actually about.
   */
  claim: (claimant: string) => void;
};

const FieldControlContext = createContext<FieldControlContextValue | null>(null);

/**
 * Called by a control that wants to be wired by an enclosing `Field` across an RSC boundary.
 * Returns the id / aria props to merge, with the control's own props taking precedence, or
 * `undefined` when there is nothing to merge (no field, or a field that already cloned).
 */
export function useFieldControl(): FieldControlProps | undefined {
  // Unconditional, and before the early return: it is a hook, and it is the claimant's identity.
  const claimant = useId();
  const context = useContext(FieldControlContext);
  if (!context) return undefined;
  context.claim(claimant);
  return context.props;
}

/**
 * A per-instance scratchpad for the dev-time audit below, and nothing else -- it is never read
 * while deciding what to render, so it deliberately sits outside React's data flow. It has to
 * survive across renders because React can bail out of re-rendering an unchanged child subtree,
 * and a child that simply did not re-render would otherwise be indistinguishable from a child
 * that never wired itself up. `useState`'s initialiser gives a stable object; the mutation is
 * fenced in here so the component body never writes to a hook's return value.
 */
type AuditLedger = {
  claimed: boolean;
  warned: boolean;
  markClaimed: () => void;
  markWarned: () => void;
};

function useAuditLedger(): AuditLedger {
  const [ledger] = useState<AuditLedger>(() => ({
    claimed: false,
    markClaimed() {
      this.claimed = true;
    },
    markWarned() {
      this.warned = true;
    },
    warned: false,
  }));
  return ledger;
}

function fieldId(reactId: string) {
  return `field-${reactId.replaceAll(":", "")}`;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  htmlFor,
  children,
}: FieldProps) {
  const generatedId = fieldId(useId());
  /*
   * The id is decided without ever looking at the child. That is not just defensiveness about the
   * crash: `useId` produces the same value in the server pass and the client pass, whereas the
   * child's readability does not -- an RSC child is opaque on the server and an element in the
   * browser. Deriving the id from something that is only legible on one side would have traded a
   * thrown TypeError for a hydration mismatch, where the label points at `field-abc` server-side
   * and at `password` client-side.
   */
  const controlId = htmlFor ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const descriptionId = error ? errorId : hint ? hintId : undefined;

  const controlProps: FieldControlProps = {
    id: controlId,
    "aria-describedby": descriptionId,
    "aria-invalid": Boolean(error),
    "aria-required": required || undefined,
  };

  const seen = useAuditLedger();
  /*
   * The distinct controls that claimed the wiring, rebuilt every render.
   *
   * A set of identities rather than a tally of calls. The two are not the same number: React
   * invokes a child twice inside one parent pass under dev StrictMode, so a tally counted a single
   * control as two and `/login` warned about a duplicate id on a page whose served HTML has exactly
   * one. Rebuilding per render is still right -- a child that did not re-render must not look like
   * a child that never wired itself up -- but "this pass" was standing in for "this mount", and the
   * identity is what actually distinguishes one control from two.
   */
  const claims = new Set<string>();
  const claim = (claimant: string) => {
    claims.add(claimant);
    seen.markClaimed();
  };

  const cloneable = isValidElement(children);

  if (process.env.NODE_ENV !== "production" && cloneable && !htmlFor && !seen.warned) {
    const declared = (children as ReactElement<FieldControlProps>).props.id;
    if (declared && declared !== controlId) {
      // Once per field instance -- a form that re-renders on every keystroke would otherwise bury
      // the console under the same line.
      seen.markWarned();
      // Cloning is about to overwrite it, which would break anything naming that id from outside.
      console.error(
        `Field ("${label}"): the control declares id="${declared}" but the field generated ` +
          `"${controlId}" and will overwrite it. Pass htmlFor="${declared}" on the Field instead, ` +
          `so the label, the hint and the error all agree with the id you chose.`,
      );
    }
  }

  const control = cloneable
    ? cloneElement(children as ReactElement<FieldControlProps>, controlProps)
    : (
        <FieldControlContext.Provider value={{ claim, props: controlProps }}>
          {children}
        </FieldControlContext.Provider>
      );

  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--distance-small)]"
      data-invalid={error ? "true" : undefined}
      data-slot="kit-field"
    >
      <Label
        className="gap-[var(--s-1)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-medium tracking-[var(--t-body-tr)] text-[color:var(--ink)]"
        data-slot="kit-field-label"
        htmlFor={controlId}
      >
        {label}
        {required ? (
          <span aria-hidden="true" className="text-[var(--critical)]">
            *
          </span>
        ) : null}
      </Label>

      {hint ? (
        <FieldMessage id={hintId} slot="kit-field-hint">
          {hint}
        </FieldMessage>
      ) : null}

      {control}

      {process.env.NODE_ENV !== "production" && !cloneable ? (
        <FieldWiringAudit claims={claims} controlId={controlId} label={label} seen={seen} />
      ) : null}

      {error ? (
        <FieldMessage id={errorId} role="alert" slot="kit-field-error" tone="error">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}

/**
 * Renders nothing. It exists to be rendered *after* the control, which is the only moment a parent
 * can tell whether anything downstream actually picked the wiring up -- children render after the
 * parent, so `Field` itself cannot know. Without this, a field whose child is opaque and whose
 * control ignores the context would render a label pointing at an id that exists nowhere on the
 * page: an accessibility hole that looks perfectly fine on screen. Dev builds only.
 */
function FieldWiringAudit({
  claims,
  controlId,
  label,
  seen,
}: {
  claims: ReadonlySet<string>;
  controlId: string;
  label: string;
  seen: AuditLedger;
}) {
  if (!seen.warned) {
    if (!seen.claimed) {
      seen.markWarned();
      console.error(
        `Field ("${label}"): its child crossed a server/client boundary, so the field could not ` +
          `attach id="${controlId}" to it directly, and no control claimed it via useFieldControl. ` +
          `The label now points at an id that is not on the page. Either render the control from a ` +
          `client component, or use a kit control that calls useFieldControl.`,
      );
    } else if (claims.size > 1) {
      seen.markWarned();
      console.error(
        `Field ("${label}"): ${claims.size} controls claimed id="${controlId}", which puts the ` +
          `same id on the page more than once. A field wraps one control.`,
      );
    }
  }
  return null;
}

function FieldMessage({
  children,
  id,
  role,
  slot,
  tone = "muted",
}: {
  children: ReactNode;
  id: string;
  role?: "alert";
  slot: string;
  tone?: "muted" | "error";
}) {
  return (
    <p
      className={
        tone === "error"
          ? "text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal tracking-[var(--t-body-tr)] text-[color:var(--critical)]"
          : "text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal tracking-[var(--t-body-tr)] text-[color:var(--muted)]"
      }
      data-slot={slot}
      id={id}
      role={role}
    >
      {children}
    </p>
  );
}
