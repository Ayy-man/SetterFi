import { describe, expect, it } from "vitest";

import {
  clearDemoSetupOverride,
  DEMO_SETUP_OVERRIDE_KEY,
  DEMO_SETUP_OVERRIDE_MS,
  readDemoSetupOverride,
  startDemoSetupOverride,
} from "./demo-setup-override";

const NOW = 1_780_000_000_000;

/** A storage that behaves, so the happy path is exercised without a DOM. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/**
 * The browser a private window gives you. Every accessor throws, which is the failure mode a bare
 * `localStorage.getItem` would turn into a blank dashboard.
 */
function hostileStorage(): Storage {
  const throws = () => {
    throw new Error("The operation is insecure.");
  };
  return {
    get length(): number {
      return throws();
    },
    clear: throws,
    getItem: throws,
    key: throws,
    removeItem: throws,
    setItem: throws,
  };
}

describe("demo setup override", () => {
  it("stores an expiry ten minutes out and reads it back until it lapses", () => {
    const storage = memoryStorage();

    const started = startDemoSetupOverride(NOW, storage);
    expect(started.expiresAt).toBe(NOW + DEMO_SETUP_OVERRIDE_MS);
    expect(storage.getItem(DEMO_SETUP_OVERRIDE_KEY)).toBeTruthy();

    expect(readDemoSetupOverride(NOW, storage)).toEqual({ expiresAt: started.expiresAt });
    expect(readDemoSetupOverride(NOW + DEMO_SETUP_OVERRIDE_MS - 1, storage)).toEqual({
      expiresAt: started.expiresAt,
    });
  });

  it("expires on its own, and the read that finds it expired is also the sweep", () => {
    const storage = memoryStorage();
    startDemoSetupOverride(NOW, storage);

    expect(readDemoSetupOverride(NOW + DEMO_SETUP_OVERRIDE_MS, storage)).toBeNull();
    // Nothing else ever has to clean this key up, so a lapsed stamp does not sit in the browser
    // waiting to be honoured by a clock that later disagrees.
    expect(storage.getItem(DEMO_SETUP_OVERRIDE_KEY)).toBeNull();
  });

  it("falls back to real state for every corrupt shape, and drops the value", () => {
    const corrupt = [
      "not json at all",
      "null",
      '"a string"',
      "[]",
      "{}",
      '{"expiresAt":"soon"}',
      '{"expiresAt":null}',
      // Not a finite number, so not a time.
      '{"expiresAt":1e999}',
    ];

    for (const raw of corrupt) {
      const storage = memoryStorage({ [DEMO_SETUP_OVERRIDE_KEY]: raw });
      expect(readDemoSetupOverride(NOW, storage), raw).toBeNull();
      expect(storage.getItem(DEMO_SETUP_OVERRIDE_KEY), raw).toBeNull();
    }
  });

  it("refuses a stamp claiming longer than the window it was allowed to claim", () => {
    // What a hand edit in devtools looks like: a valid shape, an expiry a year out.
    const storage = memoryStorage({
      [DEMO_SETUP_OVERRIDE_KEY]: JSON.stringify({ expiresAt: NOW + 365 * 24 * 60 * 60 * 1000 }),
    });

    expect(readDemoSetupOverride(NOW, storage)).toBeNull();
    expect(storage.getItem(DEMO_SETUP_OVERRIDE_KEY)).toBeNull();
  });

  it("answers no override when there is no storage at all", () => {
    expect(readDemoSetupOverride(NOW, null)).toBeNull();
    expect(() => clearDemoSetupOverride(null)).not.toThrow();
  });

  it("survives a storage whose every accessor throws", () => {
    const storage = hostileStorage();

    expect(() => readDemoSetupOverride(NOW, storage)).not.toThrow();
    expect(readDemoSetupOverride(NOW, storage)).toBeNull();
    expect(() => clearDemoSetupOverride(storage)).not.toThrow();
    // The demo still gets its ten minutes, held by the caller. It just will not survive a reload.
    expect(() => startDemoSetupOverride(NOW, storage)).not.toThrow();
    expect(startDemoSetupOverride(NOW, storage).expiresAt).toBe(NOW + DEMO_SETUP_OVERRIDE_MS);
  });

  it("clears on request", () => {
    const storage = memoryStorage();
    startDemoSetupOverride(NOW, storage);

    clearDemoSetupOverride(storage);

    expect(readDemoSetupOverride(NOW, storage)).toBeNull();
  });
});
