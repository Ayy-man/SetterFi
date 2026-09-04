"use client";

import { Eye } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * The context eye: one per rehaul screen, and the only place explanatory prose is allowed to live.
 *
 * The rehaul rule is that no screen carries an explainer sentence under a heading -- a heading, a
 * figure, a table, a control, nothing else. That rule only works if the sentences have somewhere
 * to go, and this is it. A page passes the sentences it used to print as `copy` and they become a
 * thing a reviewer opens on purpose rather than a thing every reader scrolls past forever.
 *
 * Hiding is deliberately weak, and the artboard says how weak: hide keeps it closed for this
 * visit, a refresh brings it back. So the hide lives in this module and nowhere else -- it
 * survives a client-side navigation between screens, and a reload throws it away with the module.
 * Persisting it would outlive the review pass it exists for.
 */

export type ContextEyeProps = {
  /** Stable screen id. Scopes the hide, so hiding on one screen leaves the others alone. */
  screen: string;
  /** The sentences the screen no longer prints. Plain prose, no markup. */
  copy: string;
  /**
   * `absolute` (the default) pins the eye to the nearest positioned ancestor, which is the page
   * container every rehaul screen already sets `relative` on. Pages without such a container pass
   * `fixed` so the eye still lands bottom-right of the viewport instead of the document.
   */
  position?: "absolute" | "fixed";
  /**
   * Where the eye lives. Unset, it takes the surrounding surface's default (see
   * `ContextEyeSurface`): `header` under the coach and onboarding shells, `floating` elsewhere.
   *
   * `floating` is the bottom-right button every screen shipped with. It has one defect the canvas
   * review named: an absolute bottom-right corner is also where a pane's action row ends, and on
   * the Inbox the eye sat on the Reply button. `header` is the fix. The eye becomes a control in
   * the page header's trailing slot, beside Export, where nothing can be underneath it, and the
   * popover opens downward from there.
   */
  placement?: "floating" | "header";
  /**
   * Control density for `placement="header"`. Unset, it takes the surrounding surface's default.
   *
   * The rule the artboard draws is "same height as its neighbours", and the two apps disagree on
   * what that height is: the owner console runs a 32px control row, the coach app a 46px one. A
   * scale rather than a caller-supplied className keeps that pair of numbers in one file, so the
   * eye cannot drift away from the Export button standing next to it.
   */
  scale?: "owner" | "coach";
  /**
   * An extra block inside the panel, under the copy and above the hide row.
   *
   * The eye is already the console's home for things a reviewer opens on purpose rather than
   * things a user acts on, and it carries "review only" in its own corner, so a demo affordance
   * belongs here rather than beside a coach's real controls. The slot stays anonymous on purpose:
   * this component knows nothing about demos, and the one screen that has such a control passes
   * it, so no other screen grows one by inheriting a prop it did not ask for.
   */
  action?: ReactNode;
  className?: string;
};

/**
 * The placement and scale a surface gives every eye mounted inside it.
 *
 * The 2026-09-04 coach visual audit measured four behaviours for one component: header at coach
 * scale on home, agent, contacts, billing, integrations and tips; header at *owner* scale on
 * conversations; floating on help and on all five onboarding sub-routes; and absent on the
 * onboarding root. Every one of those is a per-callsite prop, so the drift was not a bug anybody
 * introduced -- it is what a per-callsite prop with a single global default does over eleven
 * screens and three lanes.
 *
 * A surface default rather than a prop sweep, for the reason the sibling type-floor rule exists:
 * a rule each caller has to remember is a rule the next screen breaks. The coach shell and the
 * onboarding shell declare their density once, and an eye mounted anywhere under them inherits
 * it. A caller that genuinely wants the other behaviour still passes the prop and still wins.
 *
 * `owner`/`floating` stays the module default, so nothing on the console moves: the console's
 * eleven callsites either pass `placement="header"` explicitly or want the floating corner, and
 * no console surface renders this provider.
 */
export type ContextEyeSurfaceValue = {
  placement: "floating" | "header";
  scale: "owner" | "coach";
};

const CONTEXT_EYE_SURFACE: ContextEyeSurfaceValue = { placement: "floating", scale: "owner" };
const ContextEyeSurfaceContext = createContext<ContextEyeSurfaceValue>(CONTEXT_EYE_SURFACE);

export function ContextEyeSurface({
  children,
  value,
}: {
  children: ReactNode;
  value: ContextEyeSurfaceValue;
}) {
  return (
    <ContextEyeSurfaceContext.Provider value={value}>{children}</ContextEyeSurfaceContext.Provider>
  );
}

/** The surface's defaults, for a test or a sibling control that has to match the eye's height. */
export function useContextEyeSurface(): ContextEyeSurfaceValue {
  return useContext(ContextEyeSurfaceContext);
}

/**
 * The coach density, as a component rather than as an exported value.
 *
 * Both mount sites are server-reachable -- `CoachScale` has no directive and is rendered from
 * onboarding's server pages -- and `docs/ENGINEERING-BRIEF.md` records that importing a *value*
 * from a `"use client"` module into a server component replaces it with a client reference that
 * throws in production. That has happened four times in this repo. A component crosses the
 * boundary safely; the object it supplies never leaves this module.
 *
 * 46px and header, because that is the height of the Export button the eye stands beside on a
 * coach surface and the corner it must not sit in is the one the support bubble owns.
 */
export function CoachContextEyeSurface({ children }: { children: ReactNode }) {
  return (
    <ContextEyeSurface value={{ placement: "header", scale: "coach" }}>{children}</ContextEyeSurface>
  );
}

/**
 * Left empty on purpose. Screens pass their own `screen` string today; if a shared list of ids
 * turns out to be worth keeping, this is where it goes and nothing has to move to get it.
 */
export const CONTEXT_EYE_SCREENS: readonly string[] = [];

/**
 * Hidden screens for this visit.
 *
 * A module-level set rather than browser storage: it is scoped per screen so hiding one leaves the
 * others alone, it survives every client-side navigation the module stays loaded across, and a
 * reload clears it. Nothing here can throw, so a browser set to block site data behaves the same
 * as every other one.
 */
const hiddenThisVisit = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isHidden(screen: string): boolean {
  return hiddenThisVisit.has(screen);
}

/** Test seam: drops every hide, so one spec's dismissal cannot leak into the next. */
export function resetContextEyeHides() {
  hiddenThisVisit.clear();
  for (const listener of listeners) listener();
}

function hide(screen: string) {
  hiddenThisVisit.add(screen);

  for (const listener of listeners) {
    listener();
  }
}

export function ContextEye({
  action,
  className,
  copy,
  position = "absolute",
  placement: placementProp,
  scale: scaleProp,
  screen,
}: ContextEyeProps) {
  /*
   * The surface decides, the caller overrides. Read before the early return on `hidden` because
   * hooks may not be conditional, which is also why this is a context read rather than a DOM
   * probe for `[data-shell-role="coach"]`: a probe would have to happen after mount and would
   * render the wrong density for one frame on every coach screen.
   */
  const surface = useContextEyeSurface();
  const placement = placementProp ?? surface.placement;
  const scale = scaleProp ?? surface.scale;
  /**
   * `useSyncExternalStore` rather than state seeded in an effect. The server snapshot is always
   * "visible" and React re-renders with the real one after hydration -- the same one-frame flash a
   * state-in-effect version would give, without the cascading render the lint rule is right to
   * flag.
   */
  const hidden = useSyncExternalStore(subscribe, () => isHidden(screen), () => false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    }

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        close(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [close, open]);

  if (hidden) {
    return null;
  }

  return (
    <div
      className={cn(
        placement === "header"
          ? "relative inline-flex"
          : cn("z-40 right-6 bottom-6", position === "fixed" ? "fixed" : "absolute"),
        className,
      )}
      data-placement={placement}
      data-screen={screen}
      data-scale={placement === "header" ? scale : undefined}
      data-slot="context-eye"
      ref={rootRef}
    >
      {open ? (
        <div
          aria-labelledby={`${panelId}-heading`}
          className={cn(
            placement === "header"
              ? "absolute top-full right-0 z-40 mt-2 w-[340px] rounded-[14px]"
              : "absolute right-2 bottom-[68px] w-[340px] rounded-[14px]",
            "bg-[oklch(0.2325_0.023_262)] px-[18px] py-4 text-[14px] leading-[1.5]",
            "text-[oklch(0.97_0.004_262)]",
            "shadow-[0_18px_40px_-18px_rgba(28,42,82,0.6)]",
            // The enter animation is `@starting-style`, not a state flag: the panel mounts already
            // transitioning, so there is no second render and nothing to get out of sync.
            placement === "header" ? "origin-top-right" : "origin-bottom-right",
            "translate-y-0 opacity-100",
            "transition-[opacity,translate] duration-150 ease-out",
            placement === "header" ? "starting:-translate-y-1 starting:opacity-0" : "starting:translate-y-1 starting:opacity-0",
            "motion-reduce:transition-none motion-reduce:transform-none",
          )}
          data-slot="context-eye-panel"
          id={panelId}
          role="dialog"
        >
          <div
            className="mb-1.5 flex items-center gap-2 font-semibold"
            id={`${panelId}-heading`}
          >
            <Eye
              aria-hidden="true"
              className="size-4 text-[oklch(0.8_0.1_71)]"
              strokeWidth={1.75}
            />
            About this screen
          </div>
          <p className="m-0 text-[oklch(0.85_0.01_262)]">{copy}</p>
          {action ? (
            <div className="mt-3 border-t border-white/12 pt-3" data-slot="context-eye-action">
              {action}
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              className={cn(
                "inline-flex min-h-8 items-center rounded-lg bg-white/12 px-3 py-1.5",
                "text-[14px] font-medium text-[oklch(0.97_0.004_262)]",
                "transition-colors duration-150 hover:bg-white/20",
                "motion-reduce:transition-none",
              )}
              onClick={() => {
                setOpen(false);
                hide(screen);
              }}
              type="button"
            >
              Hide for now
            </button>
            {/*
              Sentence, not mono, and at the panel's own size rather than 11px.
              `SIMPLIFICATION-SPEC` §5 puts mono on numbers in tables and nowhere else, and this
              is a two-word label; the 2026-09-04 audit counted the same misuse on eight coach
              surfaces. The eye renders on both densities, so the coach's 14px floor governs.
            */}
            <span className="ml-auto text-[14px] text-[oklch(0.7_0.02_262)]">
              review only
            </span>
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "absolute right-5 size-4 rotate-45 rounded-[2px] bg-[oklch(0.2325_0.023_262)]",
              placement === "header" ? "-top-2" : "-bottom-2",
            )}
          />
        </div>
      ) : null}

      <button
        aria-expanded={open}
        aria-label="About this screen"
        className={cn(
          placement === "header"
            ? cn(
                // The same control as the Export button beside it, so the header row reads as one
                // row of controls rather than a row with a floating thing docked to it. The owner
                // console's row is 32px, the coach app's is 46px, and the scale picks between them.
                "relative inline-flex items-center justify-center border bg-transparent",
                "text-[var(--muted)] transition-colors duration-150",
                "hover:text-[var(--ink)] hover:border-[var(--accent-edge)]",
                scale === "coach"
                  ? "size-[46px] rounded-[12px] border-[var(--line-input)]"
                  : "size-8 rounded-lg border-[var(--line)]",
              )
            : cn(
                "relative flex size-11 items-center justify-center rounded-full",
                "bg-[oklch(0.2325_0.023_262)] text-[oklch(0.96_0.004_262)]",
                "shadow-[0_10px_26px_-10px_rgba(28,42,82,0.5),0_0_0_3px_rgba(176,116,32,0.25)]",
                "transition-transform duration-150 hover:scale-105",
                "motion-reduce:transition-none motion-reduce:hover:scale-100",
              ),
        )}
        onClick={() => (open ? close(false) : setOpen(true))}
        ref={buttonRef}
        type="button"
        {...(open ? { "aria-controls": panelId } : {})}
      >
        <Eye
          aria-hidden="true"
          className={placement === "header" && scale === "owner" ? "size-4" : "size-5"}
          strokeWidth={1.75}
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute rounded-full border-2 border-[var(--pane)] bg-[var(--warning)]",
            placement === "header" ? "-top-1 -right-1 size-2.5" : "top-0.5 right-0.5 size-2.5",
          )}
        />
      </button>
    </div>
  );
}
