import { afterEach, describe, expect, it } from "vitest";

import { installLog, installLogLine, setInstallLogSink } from "./install-log";

afterEach(() => setInstallLogSink(null));

describe("installLogLine", () => {
  it("keeps only allow-listed keys and never a raw state, code, or token", () => {
    const line = installLogLine("callback.received", {
      app: "agent",
      state_ref: "abcdef012345",
      has_code: true,
      // Not in the allow-list: must not appear even though they were passed.
      ...({ state: "raw-state-value", authorization_code: "raw-code", access_token: "tok" } as object),
    });
    expect(line.startsWith("[ghl-install] {")).toBe(true);
    const parsed = JSON.parse(line.slice("[ghl-install] ".length));
    expect(parsed.step).toBe("callback.received");
    expect(parsed.app).toBe("agent");
    expect(parsed.state_ref).toBe("abcdef012345");
    expect(parsed.has_code).toBe(true);
    expect(line).not.toContain("raw-state-value");
    expect(line).not.toContain("raw-code");
    expect(line).not.toContain("tok\"");
    expect(typeof parsed.at).toBe("string");
  });

  it("drops an allowed key whose value is long enough to be a token or prose", () => {
    const line = installLogLine("x", { body_shape: "a".repeat(200), code: "GHL_OAUTH_STATE_EXPIRED" });
    expect(line).not.toContain("aaaa");
    expect(line).toContain("GHL_OAUTH_STATE_EXPIRED");
  });

  it("omits undefined fields and keeps null tenant as null", () => {
    const parsed = JSON.parse(installLogLine("x", { tenant_id: null, code: undefined }).slice(14));
    expect(parsed.tenant_id).toBeNull();
    expect("code" in parsed).toBe(false);
  });
});

describe("installLog", () => {
  it("routes error level to the error sink and never throws when the sink does", () => {
    const seen: string[] = [];
    setInstallLogSink((level, line) => { seen.push(`${level}:${line}`); });
    installLog("callback.redirect", { outcome: "error" }, "error");
    installLog("start.issued", { app: "agent" });
    expect(seen[0].startsWith("error:[ghl-install]")).toBe(true);
    expect(seen[1].startsWith("info:[ghl-install]")).toBe(true);
    setInstallLogSink(() => { throw new Error("sink down"); });
    expect(() => installLog("x", {})).not.toThrow();
  });
});
