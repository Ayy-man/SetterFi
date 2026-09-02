/**
 * Shared-secret access control for the deployed demo.
 *
 * Not a user auth system, and not pretending to be one. Real per-user sessions,
 * roles, and tenant scoping land with the Supabase build in weeks 3–6. What this
 * closes is narrower and immediate: today every admin screen — margins, per-client
 * cost, the commission ledger — renders for anyone who types `/admin/tiers`, which
 * is a live problem while the demo sits on a public Vercel URL.
 *
 * The gate is opt-in by design. With `SETTERFI_ACCESS_PASSWORD` unset the app
 * behaves exactly as it does today, so setting the env var is the deliberate act
 * that locks the deployment rather than something that silently shuts the client
 * out of a review. Set it in Vercel and share the password with the client.
 */

export const ACCESS_COOKIE = "setterfi-access";

/** Edge-runtime safe: `crypto.subtle` exists in middleware, `node:crypto` does not. */
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The cookie carries a digest rather than the password itself, so a stolen cookie
 * doesn't hand over the shared secret that the whole team is using.
 */
export function accessToken(password: string) {
  return sha256Hex(`setterfi-access-v1:${password}`);
}

export function accessPassword() {
  const configured = process.env.SETTERFI_ACCESS_PASSWORD?.trim();
  return configured ? configured : null;
}

/** Length-independent comparison so the check doesn't leak the digest byte by byte. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function isAuthorized(cookieValue: string | undefined, password: string) {
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await accessToken(password));
}
