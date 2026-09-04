/**
 * The demo setup override: a per viewer, ten minute, presentation only stamp.
 *
 * The coach Overview greets a first run tenant with a setup rail whose every rung is honestly
 * incomplete, which is correct for a real coach and useless on a demo call. This module holds the
 * one piece of state that lets a demo present those rungs as done, and it is deliberately the
 * smallest possible thing: a timestamp in the viewer's own browser.
 *
 * ## What it may never become
 *
 * `README.md` carries the release boundary: nothing may present a provider, message, booking,
 * deletion or integration as complete unless a provider receipt or an authoritative read back
 * supports it. A stamp that wrote `provisioning_steps`, or an audit row, or anything else a second
 * reader could load, would be exactly the claim that boundary forbids, because the next person to
 * open the tenant would find a completed setup with no receipt behind it.
 *
 * So the stamp lives in `localStorage` and nowhere else. It changes what one browser draws for ten
 * minutes. It changes no row, no export, no audit trail, and nothing another viewer of the same
 * tenant sees. There is no server half of this module and there must never be one.
 *
 * ## Why an expiry rather than a session flag
 *
 * A flag cleared on unload is cleared by whatever the demo does next, and a flag with no clock at
 * all outlives the call it was switched on for. An absolute expiry needs no cleanup path, no
 * unload handler and no server sweep: the stamp stops being an answer the moment the clock passes
 * it, in every tab, including one that was never touched again.
 *
 * The cap in `readDemoSetupOverride` is the other half of that argument. A stamp is only honoured
 * when it expires within the window it was allowed to claim, so a hand edited value in devtools
 * buys a longer demo the same way it buys a longer one now: not at all. A stamp outside the window
 * is treated exactly like a corrupt one and dropped.
 *
 * ## Why every accessor is wrapped
 *
 * Reading `window.localStorage` is not a safe expression. A private window, a browser set to block
 * site data, and an embedded webview all throw on the property access itself, before any `getItem`
 * runs, so a bare read here would take the whole dashboard down for the readers least likely to be
 * running a demo. Every path through this module answers "no override" instead.
 */

/**
 * The storage key.
 *
 * Namespaced because a coach's browser holds this alongside the theme preference and whatever else
 * the app keeps per viewer, and an un-prefixed "demo" would be a collision waiting to happen.
 */
export const DEMO_SETUP_OVERRIDE_KEY = "setterfi.coach-setup-demo-override";

/** Ten minutes, which is the duration the product owner asked for. */
export const DEMO_SETUP_OVERRIDE_MS = 10 * 60 * 1000;

export type DemoSetupOverride = {
  /** Epoch milliseconds. The stamp is an answer strictly before this instant and never after. */
  expiresAt: number;
};

/**
 * The storage this module reads, or null.
 *
 * `undefined` means "resolve the ambient one", which is what the app passes; an explicit `null`
 * means "there is none", which is what a test passes to exercise the no-storage arm. The property
 * access is inside the try for the reason the module header gives.
 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Best effort removal. A storage that throws on write is a storage that has nothing to remove. */
function drop(storage: Storage): null {
  try {
    storage.removeItem(DEMO_SETUP_OVERRIDE_KEY);
  } catch {
    // Nothing to do and nothing to report: the caller is already being told there is no override.
  }
  return null;
}

/**
 * The override this viewer currently holds, or null.
 *
 * Null covers every failure and every doubt: no storage, no stamp, unparseable JSON, a shape that
 * is not an object, a non-finite number, an expiry that has passed, and an expiry further out than
 * a stamp was ever allowed to claim. The caller renders real state for all of them, which is the
 * behaviour a corrupt value has to fall back to.
 */
export function readDemoSetupOverride(
  now: number,
  storage?: Storage | null,
): DemoSetupOverride | null {
  const store = resolveStorage(storage);
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(DEMO_SETUP_OVERRIDE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drop(store);
  }
  if (typeof parsed !== "object" || parsed === null) return drop(store);

  const expiresAt = (parsed as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return drop(store);
  // Expired, and the read is the sweep. Nothing else ever has to clean this key up.
  if (expiresAt <= now) return drop(store);
  // Further out than switching it on could ever have produced, so it was edited or written by a
  // build with a different window. Either way it is not a stamp this code issued.
  if (expiresAt > now + DEMO_SETUP_OVERRIDE_MS) return drop(store);

  return { expiresAt };
}

/**
 * Switches the override on and returns the window it runs for.
 *
 * The return value does not depend on the write succeeding, and that is the point: a browser that
 * refuses storage still gets the ten minutes, held in the component's own state, and simply loses
 * it on reload. Failing the demo outright because a value could not be persisted would be the
 * wrong trade for a control whose entire lifetime is one call.
 */
export function startDemoSetupOverride(now: number, storage?: Storage | null): DemoSetupOverride {
  const override: DemoSetupOverride = { expiresAt: now + DEMO_SETUP_OVERRIDE_MS };
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.setItem(DEMO_SETUP_OVERRIDE_KEY, JSON.stringify(override));
    } catch {
      // Held in memory for this page instead. See the note above.
    }
  }
  return override;
}

/** Switches the override off. Safe to call when there is nothing stored and when storage throws. */
export function clearDemoSetupOverride(storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (store) drop(store);
}
