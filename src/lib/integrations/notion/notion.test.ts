import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DriverConfigurationError,
  environmentValue,
} from "@/lib/env-contract";

import { MOCK_NOTION_FAQ_ROWS, createMockNotionDriver } from "./mock";
import { createOfflineNotionDriver } from "./offline";
import {
  NotionSourceShapeError,
  createRealNotionDriver,
  parseNotionFaqPage,
} from "./real";
import { resolveNotionDriver } from "./selector";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function notionRow({
  id,
  categories = ["Synthetic"],
  inboundMessage = "What is the synthetic program?",
  response = "This is a synthetic response.",
  editedAt = "2026-01-01T00:00:00.000Z",
}: {
  id: string;
  categories?: readonly string[];
  inboundMessage?: string;
  response?: string;
  editedAt?: string;
}) {
  return {
    object: "page",
    id,
    last_edited_time: editedAt,
    properties: {
      Category: {
        type: "multi_select",
        multi_select: categories.map((name) => ({ name })),
      },
      "Inbound Message": {
        type: "title",
        title: [{ plain_text: inboundMessage }],
      },
      Response: {
        type: "rich_text",
        rich_text: [{ plain_text: response }],
      },
    },
  };
}

function notionPage(
  results: readonly ReturnType<typeof notionRow>[],
  nextCursor: string | null = null,
) {
  return {
    object: "list",
    results,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

describe("Notion driver selection", () => {
  it("chooses the synthetic mock when explicitly selected", () => {
    expect(resolveNotionDriver({ SETTERFI_NOTION_DRIVER: "mock" }).source).toBe("mock");
  });

  it("fails explicit real selection with both required names before constructing network work", () => {
    expect(() => resolveNotionDriver({ SETTERFI_NOTION_DRIVER: "real" })).toThrowError(
      DriverConfigurationError,
    );
    try {
      resolveNotionDriver({ SETTERFI_NOTION_DRIVER: "real" });
    } catch (error) {
      expect(error).toMatchObject({
        variableNames: ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"],
      });
    }
  });

  it("fails offline selection by the path variable name without rendering its configured value", () => {
    const configuredPath = "/synthetic/private/export.json";
    try {
      resolveNotionDriver({
        SETTERFI_NOTION_DRIVER: "offline",
        NOTION_EXPORT_PATH: configuredPath,
      });
    } catch {
      // Selection itself is allowed; file access remains lazy so callers can construct the driver.
    }
    expect(resolveNotionDriver({ SETTERFI_NOTION_DRIVER: "offline", NOTION_EXPORT_PATH: configuredPath }).source)
      .toBe("offline");
    expect(() => resolveNotionDriver({ SETTERFI_NOTION_DRIVER: "offline" })).toThrow(
      /NOTION_EXPORT_PATH/,
    );
  });

  it("rejects invalid selector values without copying them into the error", () => {
    const invalid = "synthetic-invalid-selection";
    try {
      resolveNotionDriver({ SETTERFI_NOTION_DRIVER: invalid });
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(String(error)).not.toContain(invalid);
    }
  });
});

describe("synthetic Notion source", () => {
  it("pages stable ids while covering all registry tokens and review-hazard shapes", async () => {
    const driver = createMockNotionDriver();
    const rows = [];
    let cursor: string | null | undefined;
    do {
      const page = await driver.fetchFaqRows({ rootId: "synthetic-root", cursor });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);

    expect(rows.map((row) => row.sourceId)).toEqual(MOCK_NOTION_FAQ_ROWS.map((row) => row.sourceId));
    expect(new Set(rows.flatMap((row) => row.categories))).toEqual(
      new Set(["Program", "Eligibility", "Outcomes", "Scheduling", "Funding", "Trust"]),
    );
    const responseText = rows.map((row) => row.response).join("\n");
    for (const token of [
      "niche",
      "target_funding_amount",
      "booking_link",
      "requirements",
      "qualifying_questions",
      "dream_outcome",
      "income_qualifiers",
      "asset.synthetic-guide",
    ]) {
      expect(responseText).toContain(token);
    }
    expect(rows.some((row) => row.categories.length === 0)).toBe(true);
    expect(rows.some((row) => row.categories.length > 1)).toBe(true);
    expect(responseText).toContain("$12,345");
    expect(responseText).toContain("example.invalid");
    expect(responseText).toMatch(/\bX\b/);
    expect(responseText).toContain("unregistered_detail");
  });
});

describe("real Notion paging", () => {
  it("returns two mocked pages in stable order and honors Retry-After plus three-per-second spacing", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "Retry-After": "0.5" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(notionPage([
        notionRow({ id: "source-a", editedAt: "2026-01-01T00:00:00.000Z" }),
      ], "cursor-two"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(notionPage([
        notionRow({ id: "source-b", editedAt: "2026-01-02T00:00:00.000Z" }),
      ]))));
    const driver = createRealNotionDriver(
      { apiKey: "synthetic-test-key", rootId: "synthetic-root" },
      {
        fetch: fetcher,
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      },
    );

    const first = await driver.fetchFaqRows({ rootId: "synthetic-root" });
    const second = await driver.fetchFaqRows({
      rootId: "synthetic-root",
      cursor: first.nextCursor,
    });

    expect([...first.rows, ...second.rows].map((row) => row.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(first.nextCursor).toBe("cursor-two");
    expect(second.nextCursor).toBeNull();
    expect(second.sourceEditedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(sleeps).toEqual([500, 334]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests).toEqual([
      { page_size: 100 },
      { page_size: 100 },
      { page_size: 100, start_cursor: "cursor-two" },
    ]);
    const headerNames = Object.keys(fetcher.mock.calls[0][1]?.headers ?? {}).sort();
    expect(headerNames).toEqual(["Authorization", "Content-Type", "Notion-Version"]);
  });

  it("rejects a wrong or missing FAQ property type with a named source-shape error", () => {
    const wrong = notionRow({ id: "source-invalid" });
    wrong.properties.Response = { type: "title", title: [{ plain_text: "wrong" }] } as never;
    expect(() => parseNotionFaqPage(notionPage([wrong]))).toThrowError(NotionSourceShapeError);
    expect(() => parseNotionFaqPage(notionPage([wrong]))).toThrow(
      /NOTION_SOURCE_SHAPE_ERROR:source-invalid:Response:EXPECTED_RICH_TEXT/,
    );

    const missing = notionRow({ id: "source-missing" });
    delete (missing.properties as Partial<typeof missing.properties>).Category;
    expect(() => parseNotionFaqPage(notionPage([missing]))).toThrow(
      /NOTION_SOURCE_SHAPE_ERROR:source-missing:page:PROPERTY_SET_INVALID/,
    );
  });

  it("bounds rate-limit retries and refuses a missing Retry-After header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "rate_limited" }), { status: 429 }),
    );
    const driver = createRealNotionDriver(
      { apiKey: "synthetic-test-key", rootId: "synthetic-root" },
      { fetch: fetcher, sleep: async () => undefined },
    );
    await expect(driver.fetchFaqRows({ rootId: "synthetic-root" })).rejects.toThrow(
      /NOTION_RATE_LIMIT_RETRY_AFTER_INVALID/,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("offline Notion export", () => {
  it("reads a configured external JSON export and never accepts an in-repository file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "setterfi-notion-"));
    temporaryDirectories.push(directory);
    const exportPath = join(directory, "faq.json");
    await writeFile(exportPath, JSON.stringify([
      {
        sourceId: "offline-source-001",
        categories: ["Synthetic"],
        inboundMessage: "Can this come from an offline export?",
        response: "Yes, through a configured server path.",
        sourceEditedAt: null,
      },
    ]));

    const page = await createOfflineNotionDriver(exportPath).fetchFaqRows({
      rootId: "offline-root",
    });
    expect(page).toMatchObject({
      nextCursor: null,
      sourceEditedAt: null,
      rows: [{ sourceId: "offline-source-001" }],
    });
    await expect(
      createOfflineNotionDriver(resolve(process.cwd(), "package.json")).fetchFaqRows({
        rootId: "offline-root",
      }),
    ).rejects.toThrow(/NOTION_OFFLINE_PATH_MUST_BE_EXTERNAL/);
  });
});

const notionRequiredNames = ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"] as const;
const notionMissingNames = notionRequiredNames.filter((name) => !environmentValue(name));
const notionRealSkipReason = environmentValue("SETTERFI_NOTION_DRIVER") !== "real"
  ? `SETTERFI_NOTION_DRIVER=real is required; ${notionRequiredNames.join(", ")} are required`
  : notionMissingNames.length > 0
    ? `${notionMissingNames.join(", ")} are missing`
    : null;

describe.skipIf(Boolean(notionRealSkipReason))(
  `Notion real arm — SKIPPED: ${notionRealSkipReason ?? "configured"}`,
  () => {
    it("reaches the configured typed data source without treating a mock as provider evidence", async () => {
      const driver = resolveNotionDriver(process.env);
      const page = await driver.fetchFaqRows({ rootId: environmentValue("NOTION_KB_ROOT_ID")! });
      expect(driver.source).toBe("notion");
      expect(page.rows.every((row) => row.sourceId.length > 0)).toBe(true);
    });
  },
);
