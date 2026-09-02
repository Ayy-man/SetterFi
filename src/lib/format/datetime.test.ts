import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  WORKSPACE_DISPLAY_TIMEZONE,
  workspaceCountFormat,
  workspaceDateFormat,
  workspaceDateTimeFormat,
  workspaceDateTimeYearFormat,
  workspaceTimestampFormat,
} from "./datetime";

/** 2026-08-17T20:35:00Z is 4:35 PM in America/New_York — the instant from the #418 report. */
const INSTANT = new Date("2026-08-17T20:35:00.000Z");

describe("workspace display formatters", () => {
  it("renders the reported instant in the platform reporting zone, whatever the ambient zone is", () => {
    expect(WORKSPACE_DISPLAY_TIMEZONE).toBe("America/New_York");
    expect(workspaceDateTimeFormat.format(INSTANT)).toBe("Aug 17, 4:35 PM");
    expect(workspaceTimestampFormat.format(INSTANT)).toBe("Aug 17, 2026, 4:35 PM");
    expect(workspaceDateTimeYearFormat.format(INSTANT)).toBe("Aug 17, 2026, 4:35 PM");
    expect(workspaceDateFormat.format(INSTANT)).toBe("Aug 17, 2026");
  });

  it("groups counts the same way regardless of the runtime's locale", () => {
    expect(workspaceCountFormat.format(123456)).toBe("123,456");
  });

  it("produces byte-identical output under a UTC server and an Asia/Kolkata browser", () => {
    // The defect was a server rendering in UTC and a browser re-rendering in the viewer's
    // zone. Two child processes with different TZ is the only way to prove the ambient zone
    // no longer reaches the output, because Node caches the zone for the life of a process.
    const program = `
      const f = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        timeZone: ${JSON.stringify(WORKSPACE_DISPLAY_TIMEZONE)},
      });
      process.stdout.write(f.format(new Date(${INSTANT.getTime()})));
    `;
    const run = (timezone: string) =>
      execFileSync(process.execPath, ["-e", program], { env: { ...process.env, TZ: timezone } })
        .toString();

    expect(run("UTC")).toBe(run("Asia/Kolkata"));
    expect(run("UTC")).toBe(workspaceDateTimeFormat.format(INSTANT));
  });
});

describe("no surface formats against the ambient zone or locale", () => {
  const sources = ["src/app", "src/components"].flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      .map((entry) => `${root}/${entry}`));

  it("scans a non-empty set of surface sources", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("has no bare toLocaleString(), toLocaleDateString(), or toLocaleTimeString()", () => {
    const offenders = sources.filter((file) =>
      /toLocale(String|DateString|TimeString)\(\s*\)/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("has no Intl.DateTimeFormat without an explicit timeZone", () => {
    // signup-form.tsx deliberately reads the visitor's own zone to prefill the field, which is
    // resolvedOptions() rather than formatting, so it is exempt by shape not by name.
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/new Intl\.DateTimeFormat\(([\s\S]*?)\)\s*(\.|;)/g)]
        .some((match) => !match[1].includes("timeZone")
          && !source.slice(match.index).startsWith("new Intl.DateTimeFormat().resolvedOptions"));
    });
    expect(offenders).toEqual([]);
  });
});
