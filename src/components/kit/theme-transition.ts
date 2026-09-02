"use client";

/**
 * The theme swap, as a circle opening from wherever the reader pressed.
 *
 * The View Transition API is what makes this cheap: the browser snapshots the page before and
 * after, so the "old theme" the circle wipes away is a real picture of the page rather than a
 * second copy of the DOM we would have to build and keep in sync. Everything here degrades to a
 * plain instant swap -- no support, reduced motion, or no idea where the press came from, and the
 * callback simply runs.
 *
 * The reveal deliberately animates only the *new* snapshot, growing over a stationary old one.
 * Cross-fading both is the default and it makes the midpoint of a light/dark swap a flat grey.
 */

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

let lastPointer: { x: number; y: number } | null = null;

/**
 * The origin is the last place a pointer went down. Tracked globally rather than read off the
 * clicked control, because the control that sets the theme is a menu item that has already
 * started closing by the time the theme applies -- measuring it then gives a box that is
 * mid-animation or gone.
 */
function trackPointer() {
  if (typeof window === "undefined" || lastPointer !== null) return;
  window.addEventListener(
    "pointerdown",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
  lastPointer = { x: 0, y: 0 };
}

/** Call once on mount so the first press is already recorded when the theme changes. */
export function watchThemeTransitionOrigin(): void {
  trackPointer();
}

function millis(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed) || fallback;
  if (trimmed.endsWith("s")) return (Number.parseFloat(trimmed) || fallback / 1000) * 1000;
  return fallback;
}

export function runThemeTransition(apply: () => void): void {
  const doc = document as ViewTransitionDocument;
  const origin = lastPointer;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!doc.startViewTransition || reduced || !origin || (origin.x === 0 && origin.y === 0)) {
    apply();
    return;
  }

  const root = document.documentElement;
  const styles = getComputedStyle(root);
  // Read the timing off the tokens rather than restating it, so the reveal stays in step with
  // the rest of the kit -- and collapses with everything else when the tokens do.
  const duration = millis(styles.getPropertyValue("--duration-slow"), 400);
  const easing = styles.getPropertyValue("--ease-smooth-out").trim() || "ease-out";

  const transition = doc.startViewTransition(apply);
  void transition.ready
    .then(() => {
      // The circle has to reach the furthest corner, or a wedge of the old theme is left behind.
      const radius = Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y),
      );
      root.animate(
        {
          clipPath: [
            `circle(0px at ${origin.x}px ${origin.y}px)`,
            `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
          ],
        },
        {
          duration,
          easing,
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // A transition the browser abandoned (a second swap mid-flight) still applied the theme.
    });
}
