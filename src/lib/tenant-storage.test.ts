import { beforeEach, describe, expect, it } from "vitest";

import {
  DEMO_TENANT_ID,
  activeTenantId,
  readScoped,
  readScopedJson,
  removeScoped,
  scopedKey,
  setActiveTenant,
  writeScoped,
  writeScopedJson,
} from "@/lib/tenant-storage";

/** Minimal localStorage stand-in; the module only needs get/set/remove. */
function installStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: store },
  });
  return map;
}

describe("tenant-scoped storage", () => {
  let map: Map<string, string>;

  beforeEach(() => {
    map = installStorage();
  });

  it("namespaces tenant, platform, and device data into separate key spaces", () => {
    expect(scopedKey("tenant", "offer")).toBe(`setterfi:t:${DEMO_TENANT_ID}:offer`);
    expect(scopedKey("platform", "brain")).toBe("setterfi:platform:brain");
    expect(scopedKey("device", "theme")).toBe("setterfi:device:theme");
  });

  it("keeps one tenant from reading another tenant's data", () => {
    writeScoped("tenant", "offer", "first-coach-offer");

    setActiveTenant("second-coach");
    expect(activeTenantId()).toBe("second-coach");
    // The whole point: switching tenant must not surface the previous tenant's value.
    expect(readScoped("tenant", "offer")).toBeNull();

    writeScoped("tenant", "offer", "second-coach-offer");
    setActiveTenant(DEMO_TENANT_ID);
    expect(readScoped("tenant", "offer")).toBe("first-coach-offer");
  });

  it("shares platform and device data across tenants, because they are not tenant data", () => {
    writeScoped("platform", "brain", "matrix-v14");
    writeScoped("device", "theme", "dark");

    setActiveTenant("second-coach");
    expect(readScoped("platform", "brain")).toBe("matrix-v14");
    expect(readScoped("device", "theme")).toBe("dark");
  });

  it("round-trips JSON", () => {
    writeScopedJson("tenant", "offer", { creditMinimum: 640, products: ["biz CC"] });
    expect(readScopedJson("tenant", "offer")).toEqual({
      creditMinimum: 640,
      products: ["biz CC"],
    });
  });

  it("drops a corrupt entry instead of keeping it around forever", () => {
    map.set(scopedKey("tenant", "offer"), "{not json");
    expect(readScopedJson("tenant", "offer")).toBeNull();
    expect(map.has(scopedKey("tenant", "offer"))).toBe(false);
  });

  it("removes only the scoped key", () => {
    writeScoped("tenant", "offer", "value");
    writeScoped("platform", "offer", "other");
    removeScoped("tenant", "offer");
    expect(readScoped("tenant", "offer")).toBeNull();
    expect(readScoped("platform", "offer")).toBe("other");
  });

  it("degrades to defaults when storage is unavailable rather than throwing", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    expect(activeTenantId()).toBe(DEMO_TENANT_ID);
    expect(readScoped("tenant", "offer")).toBeNull();
    expect(() => writeScoped("tenant", "offer", "x")).not.toThrow();
    expect(() => removeScoped("tenant", "offer")).not.toThrow();
  });
});
