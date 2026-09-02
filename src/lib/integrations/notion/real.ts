/**
 * The real Notion adapter owns only typed data-source paging and provider pressure control.
 *
 * It never decides whether content is safe to publish, and its errors retain codes and response
 * shapes rather than response bodies so source text and credentials cannot enter logs upstream.
 */

import type {
  NotionFaqPage,
  NotionFaqSourceRow,
  NotionKnowledgeDriver,
} from "./types";

const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 100;
const MIN_REQUEST_INTERVAL_MS = 334;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const FAQ_PROPERTY_NAMES = ["Category", "Inbound Message", "Response"] as const;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export type NotionRealConfiguration = {
  apiKey: string;
  rootId: string;
};

export type NotionRealDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class NotionProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "NotionProviderError";
  }
}

export class NotionSourceShapeError extends NotionProviderError {
  constructor(
    readonly sourceId: string,
    readonly field: (typeof FAQ_PROPERTY_NAMES)[number] | "page" | "response",
    readonly reason: string,
  ) {
    super(`NOTION_SOURCE_SHAPE_ERROR:${sourceId}:${field}:${reason}`);
    this.name = "NotionSourceShapeError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyShape(value: unknown) {
  const record = object(value);
  return record ? Object.keys(record).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function richText(value: unknown, sourceId: string, field: "Inbound Message" | "Response") {
  if (!Array.isArray(value)) {
    throw new NotionSourceShapeError(sourceId, field, "VALUE_NOT_ARRAY");
  }
  const fragments = value.map((fragment) => {
    const row = object(fragment);
    const plainText = typeof row?.plain_text === "string" ? row.plain_text : null;
    if (plainText === null) {
      throw new NotionSourceShapeError(sourceId, field, "PLAIN_TEXT_MISSING");
    }
    return plainText;
  });
  const flattened = fragments.join("").trim();
  if (!flattened) {
    throw new NotionSourceShapeError(sourceId, field, "VALUE_EMPTY");
  }
  return flattened;
}

function categoryNames(value: unknown, sourceId: string) {
  if (!Array.isArray(value)) {
    throw new NotionSourceShapeError(sourceId, "Category", "VALUE_NOT_ARRAY");
  }
  return value.map((category) => {
    const name = text(object(category)?.name);
    if (!name) {
      throw new NotionSourceShapeError(sourceId, "Category", "NAME_MISSING");
    }
    return name;
  });
}

function exactProperty(
  properties: JsonObject,
  sourceId: string,
  name: (typeof FAQ_PROPERTY_NAMES)[number],
  expectedType: "multi_select" | "title" | "rich_text",
) {
  const property = object(properties[name]);
  if (!property || property.type !== expectedType) {
    throw new NotionSourceShapeError(sourceId, name, `EXPECTED_${expectedType.toUpperCase()}`);
  }
  return property;
}

function parseFaqRow(value: unknown): NotionFaqSourceRow {
  const page = object(value);
  const sourceId = text(page?.id) ?? "unknown-source";
  const properties = object(page?.properties);
  if (!properties) {
    throw new NotionSourceShapeError(sourceId, "page", "PROPERTIES_MISSING");
  }
  const actualNames = Object.keys(properties).sort();
  if (actualNames.join("\u0000") !== [...FAQ_PROPERTY_NAMES].sort().join("\u0000")) {
    throw new NotionSourceShapeError(sourceId, "page", "PROPERTY_SET_INVALID");
  }
  const category = exactProperty(properties, sourceId, "Category", "multi_select");
  const inbound = exactProperty(properties, sourceId, "Inbound Message", "title");
  const response = exactProperty(properties, sourceId, "Response", "rich_text");
  const sourceEditedAt = text(page?.last_edited_time);

  return {
    sourceId,
    categories: categoryNames(category.multi_select, sourceId),
    inboundMessage: richText(inbound.title, sourceId, "Inbound Message"),
    response: richText(response.rich_text, sourceId, "Response"),
    sourceEditedAt,
  };
}

function latestEditedAt(rows: readonly NotionFaqSourceRow[]) {
  const values = rows
    .map((row) => row.sourceEditedAt)
    .filter((value): value is string => value !== null)
    .sort();
  return values.at(-1) ?? null;
}

export function parseNotionFaqPage(value: unknown): NotionFaqPage {
  const response = object(value);
  if (!response || !Array.isArray(response.results) || typeof response.has_more !== "boolean") {
    throw new NotionSourceShapeError("provider-response", "response", "ENVELOPE_INVALID");
  }
  const nextCursor = response.next_cursor === null ? null : text(response.next_cursor);
  if (response.has_more !== Boolean(nextCursor)) {
    throw new NotionSourceShapeError("provider-response", "response", "CURSOR_STATE_INVALID");
  }
  const rows = response.results.map(parseFaqRow);
  return { rows, nextCursor, sourceEditedAt: latestEditedAt(rows) };
}

function retryAfterMilliseconds(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1000)
    : Date.parse(value) - now;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
}

async function responseJson(response: Response) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new NotionProviderError("NOTION_RESPONSE_MALFORMED_JSON", response.status, "non-json");
  }
  if (!response.ok) {
    throw new NotionProviderError("NOTION_QUERY_FAILED", response.status, bodyShape(payload));
  }
  return payload;
}

export function createRealNotionDriver(
  configuration: NotionRealConfiguration,
  {
    fetch: fetcher = fetch,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }: NotionRealDependencies = {},
): NotionKnowledgeDriver {
  let lastRequestAt: number | null = null;

  async function waitForRateSlot() {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = now();
  }

  return {
    source: "notion",
    fetchFaqRows: async ({ rootId, cursor }) => {
      if (rootId !== configuration.rootId) {
        throw new NotionProviderError("NOTION_ROOT_ID_MISMATCH");
      }

      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
        await waitForRateSlot();
        const response = await fetcher(
          `${NOTION_BASE_URL}/data_sources/${encodeURIComponent(configuration.rootId)}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${configuration.apiKey}`,
              "Content-Type": "application/json",
              "Notion-Version": NOTION_VERSION,
            },
            body: JSON.stringify({
              page_size: PAGE_SIZE,
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          },
        );
        if (response.status !== 429) {
          return parseNotionFaqPage(await responseJson(response));
        }
        if (attempt === MAX_RATE_LIMIT_RETRIES) {
          throw new NotionProviderError("NOTION_RATE_LIMIT_RETRIES_EXHAUSTED", 429);
        }
        const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"), now());
        if (retryAfter === null) {
          throw new NotionProviderError("NOTION_RATE_LIMIT_RETRY_AFTER_INVALID", 429);
        }
        await sleep(retryAfter);
      }
      throw new NotionProviderError("NOTION_RATE_LIMIT_RETRIES_EXHAUSTED", 429);
    },
  };
}
