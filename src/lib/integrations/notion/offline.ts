/**
 * Offline import reads one server-configured export outside the repository.
 *
 * The HTTP layer never supplies a path, and realpath containment checks prevent an in-repo copy or
 * symlink target from becoming a committed source of client content.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative } from "node:path";

import { parseNotionFaqPage } from "./real";
import type { NotionFaqSourceRow, NotionKnowledgeDriver } from "./types";

type JsonObject = Record<string, unknown>;

export class NotionOfflineExportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NotionOfflineExportError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function optionalEditedAt(value: unknown) {
  return value === null || value === undefined
    ? null
    : typeof value === "string" && value.trim()
      ? value.trim()
      : undefined;
}

function parseNormalizedRow(value: unknown, index: number): NotionFaqSourceRow {
  const row = object(value);
  const sourceId = typeof row?.sourceId === "string" && row.sourceId.trim()
    ? row.sourceId.trim()
    : null;
  const categories = Array.isArray(row?.categories) && row.categories.every(
    (category) => typeof category === "string" && category.trim(),
  )
    ? row.categories.map((category) => (category as string).trim())
    : null;
  const inboundMessage = typeof row?.inboundMessage === "string" && row.inboundMessage.trim()
    ? row.inboundMessage.trim()
    : null;
  const response = typeof row?.response === "string" && row.response.trim()
    ? row.response.trim()
    : null;
  const sourceEditedAt = optionalEditedAt(row?.sourceEditedAt);
  if (!sourceId || !categories || !inboundMessage || !response || sourceEditedAt === undefined) {
    throw new NotionOfflineExportError(`NOTION_OFFLINE_ROW_INVALID:${index + 1}`);
  }
  return { sourceId, categories, inboundMessage, response, sourceEditedAt };
}

function splitMarkdownRow(line: string) {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.trim().replace(/^\||\|$/g, "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseMarkdown(value: string) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) throw new NotionOfflineExportError("NOTION_OFFLINE_MARKDOWN_EMPTY");
  const header = splitMarkdownRow(lines[0]);
  if (header.join("\u0000") !== "Category\u0000Inbound Message\u0000Response") {
    throw new NotionOfflineExportError("NOTION_OFFLINE_MARKDOWN_HEADER_INVALID");
  }
  if (!splitMarkdownRow(lines[1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
    throw new NotionOfflineExportError("NOTION_OFFLINE_MARKDOWN_SEPARATOR_INVALID");
  }
  return lines.slice(2).map((line, index) => {
    const cells = splitMarkdownRow(line);
    if (cells.length !== 3 || !cells[1] || !cells[2]) {
      throw new NotionOfflineExportError(`NOTION_OFFLINE_ROW_INVALID:${index + 1}`);
    }
    return {
      sourceId: `offline-markdown-${String(index + 1).padStart(4, "0")}`,
      categories: cells[0] ? cells[0].split(",").map((category) => category.trim()).filter(Boolean) : [],
      inboundMessage: cells[1],
      response: cells[2],
      sourceEditedAt: null,
    } satisfies NotionFaqSourceRow;
  });
}

function parseJson(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new NotionOfflineExportError("NOTION_OFFLINE_JSON_INVALID");
  }
  if (Array.isArray(parsed)) return parsed.map(parseNormalizedRow);
  if (object(parsed)?.results) return [...parseNotionFaqPage(parsed).rows];
  const rows = object(parsed)?.rows;
  if (Array.isArray(rows)) return rows.map(parseNormalizedRow);
  throw new NotionOfflineExportError("NOTION_OFFLINE_JSON_SHAPE_INVALID");
}

async function configuredExternalFile(configuredPath: string) {
  let workspacePath: string;
  let exportPath: string;
  try {
    [workspacePath, exportPath] = await Promise.all([realpath(process.cwd()), realpath(configuredPath)]);
    if (!(await stat(exportPath)).isFile()) throw new Error("not-file");
  } catch {
    throw new NotionOfflineExportError("NOTION_OFFLINE_PATH_UNREADABLE");
  }
  const fromWorkspace = relative(workspacePath, exportPath);
  if (fromWorkspace === "" || (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))) {
    throw new NotionOfflineExportError("NOTION_OFFLINE_PATH_MUST_BE_EXTERNAL");
  }
  return exportPath;
}

export function createOfflineNotionDriver(configuredPath: string): NotionKnowledgeDriver {
  return {
    source: "offline",
    fetchFaqRows: async ({ cursor }) => {
      if (cursor) throw new NotionOfflineExportError("NOTION_OFFLINE_CURSOR_UNSUPPORTED");
      const exportPath = await configuredExternalFile(configuredPath);
      let value: string;
      try {
        value = await readFile(exportPath, "utf8");
      } catch {
        throw new NotionOfflineExportError("NOTION_OFFLINE_PATH_UNREADABLE");
      }
      const extension = extname(exportPath).toLowerCase();
      const rows = extension === ".json"
        ? parseJson(value)
        : extension === ".md" || extension === ".markdown"
          ? parseMarkdown(value)
          : (() => { throw new NotionOfflineExportError("NOTION_OFFLINE_FORMAT_UNSUPPORTED"); })();
      const edited = rows
        .map((row) => row.sourceEditedAt)
        .filter((item): item is string => item !== null)
        .sort()
        .at(-1) ?? null;
      return { rows, nextCursor: null, sourceEditedAt: edited };
    },
  };
}
