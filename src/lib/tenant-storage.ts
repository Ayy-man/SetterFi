/**
 * One enforcement point for everything the demo persists in the browser.
 *
 * Two problems this solves. First, tenant isolation: CLAUDE.md names it as a hard
 * technical bar, and until now every key was globally scoped with no tenant id
 * anywhere in the codebase — two coaches signed into the same browser would read
 * and overwrite each other's offer layer. Second, scope confusion: a coach's offer
 * layer, the platform's Brain draft, and a per-device theme preference are three
 * different lifetimes, and storing them all as flat `setterfi-*` keys made that
 * invisible.
 *
 * Keys are namespaced by scope, so switching tenants partitions storage by
 * construction rather than by everyone remembering to add a prefix:
 *
 *   setterfi:t:<tenantId>:<name>   tenant data — a coach's own configuration
 *   setterfi:platform:<name>       platform data — the shared Brain, admin-owned
 *   setterfi:device:<name>         device preference — theme, sidebar state
 *
 * The browser is not the security boundary and this does not pretend otherwise;
 * real isolation is row-level security in Postgres, in the backend build. What
 * this gives that build is the seam: swap the bodies here and every call site
 * follows.
 */

const NAMESPACE = "setterfi";

/**
 * The demo runs as a single coach tenant. The id exists as a real value rather
 * than an implicit assumption so that the day a second tenant appears, nothing
 * has to be found and re-keyed.
 */
export const DEMO_TENANT_ID = "reid-funding-group";

const ACTIVE_TENANT_KEY = `${NAMESPACE}:device:active-tenant`;

function storage(): Storage | null {
  try {
    // Server render, or a browser with storage disabled (Safari private mode
    // throws on access rather than returning null).
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function activeTenantId(): string {
  const store = storage();
  if (!store) return DEMO_TENANT_ID;
  try {
    return store.getItem(ACTIVE_TENANT_KEY)?.trim() || DEMO_TENANT_ID;
  } catch {
    return DEMO_TENANT_ID;
  }
}

export function setActiveTenant(tenantId: string) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(ACTIVE_TENANT_KEY, tenantId);
  } catch {
    // A full or disabled store is not worth breaking a render over.
  }
}

export type StorageScope = "tenant" | "platform" | "device";

export function scopedKey(scope: StorageScope, name: string) {
  if (scope === "tenant") return `${NAMESPACE}:t:${activeTenantId()}:${name}`;
  return `${NAMESPACE}:${scope}:${name}`;
}

export function readScoped(scope: StorageScope, name: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(scopedKey(scope, name));
  } catch {
    return null;
  }
}

export function writeScoped(scope: StorageScope, name: string, value: string) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(scopedKey(scope, name), value);
  } catch {
    // Quota or private-mode failure. Losing a demo preference is acceptable;
    // throwing out of a render handler is not.
  }
}

export function removeScoped(scope: StorageScope, name: string) {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(scopedKey(scope, name));
  } catch {
    // Same reasoning as writeScoped.
  }
}

/**
 * Read and parse in one step, dropping the entry when it fails to parse. Every
 * caller was hand-rolling this try/catch, and several of them silently kept a
 * corrupt entry around forever.
 */
export function readScopedJson<T>(scope: StorageScope, name: string): T | null {
  const raw = readScoped(scope, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    removeScoped(scope, name);
    return null;
  }
}

export function writeScopedJson(scope: StorageScope, name: string, value: unknown) {
  try {
    writeScoped(scope, name, JSON.stringify(value));
  } catch {
    // Circular or non-serializable input — nothing useful to persist.
  }
}

/** Storage names, kept together so the scope of each one is reviewable at a glance. */
export const STORAGE_NAMES = {
  /** A coach's saved offer layer: fields, question order, proof, follow-up assets. */
  coachOffer: "coach-offer-preview",
  /** A coach's notification rule toggles. */
  coachNotifications: "coach-notification-rules",
  /** Which optional integrations a coach has connected. */
  coachIntegrations: "coach-connected-integrations",
  /** A coach's setup-companion progress. */
  onboarding: "onboarding-preview",
  /** Admin Brain draft outcome overrides — platform logic, never tenant data. */
  brainPreview: "brain-preview-outcomes",
} as const;
