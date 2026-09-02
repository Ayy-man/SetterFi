const INTERNAL_ORIGIN = "https://setterfi.internal";
const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function containsUnsafeCharacters(value: string) {
  let candidate = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (UNSAFE_PATH_CHARACTERS.test(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  // More than eight decoding layers has no legitimate navigation use and is safer to refuse.
  return true;
}

/** Accepts an application-local absolute path and otherwise returns the caller's safe fallback. */
export function internalRedirectPath<T extends string | null>(
  value: string | null | undefined,
  fallback: T,
): string | T {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    containsUnsafeCharacters(value)
  ) return fallback;

  try {
    const resolved = new URL(value, INTERNAL_ORIGIN);
    if (resolved.origin !== INTERNAL_ORIGIN) return fallback;
    return value;
  } catch {
    return fallback;
  }
}
