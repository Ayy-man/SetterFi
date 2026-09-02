/**
 * Provider-neutral FAQ normalization for the Brain review queue.
 *
 * The provider boundary may hand us typed Notion property values or an offline equivalent. This
 * module preserves stable source identity, but invalid shapes still become blocked review items
 * instead of disappearing from the batch count.
 */

import type { ImportDisposition } from "@/lib/brain/contracts";
import {
  PLACEHOLDER_REGISTRY,
  normalizePlaceholderToken,
  placeholderDefinition,
  type PlaceholderDefinition,
} from "@/lib/brain/placeholders";

import {
  acceptanceFlags,
  allBlockingFlagsResolved,
  FAQ_CATEGORIES,
  flagImportRow,
  type ImportFigure,
  type ImportFlag,
  type NumberBinding,
} from "./flags";

type UnknownRecord = Record<string, unknown>;
export type PlaceholderRegistry = Readonly<Record<string, PlaceholderDefinition>>;

export type NormalizedImportPayload = {
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  matchKeywords: readonly string[];
};

export type NormalizedImportItem = NormalizedImportPayload & {
  sourceRef: string;
  sourceEditedAt: string | null;
  categories: readonly string[];
  flags: readonly ImportFlag[];
  figures: readonly ImportFigure[];
  sourceShapeValid: boolean;
};

export type ImportCounts = {
  received: number;
  normalized: number;
  flagged: number;
  unchanged: number;
};

export type AcceptancePayload = {
  sourceRef: string;
  disposition: ImportDisposition;
  numberBindings: readonly NumberBinding[];
  flags: readonly ImportFlag[];
  afterPayload: NormalizedImportPayload;
  embeddingText: string;
  platformDraftEligible: boolean;
};

export type BareXResolution = {
  offset: number;
  token: "booking_link" | `asset.${string}`;
};

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function textPart(value: unknown): string | null {
  if (typeof value === "string") return value;
  const item = record(value);
  if (!item) return null;
  if (typeof item.plain_text === "string") return item.plain_text;
  if (typeof item.plainText === "string") return item.plainText;
  const text = record(item.text);
  return typeof text?.content === "string" ? text.content : null;
}

function textParts(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return null;
  const parts = value.map(textPart);
  return parts.every((part) => part !== null) ? parts.join("").trim() : null;
}

function property(row: UnknownRecord, name: string) {
  const properties = record(row.properties);
  return record(properties?.[name]);
}

function titleValue(row: UnknownRecord) {
  if (typeof row.inboundMessage === "string") return row.inboundMessage.trim();
  const value = property(row, "Inbound Message");
  if (!value || value.type !== "title") return null;
  return textParts(value.title);
}

function responseValue(row: UnknownRecord) {
  if (typeof row.responseTemplate === "string") return row.responseTemplate.trim();
  if (typeof row.response === "string") return row.response.trim();
  const value = property(row, "Response");
  if (!value || value.type !== "rich_text") return null;
  return textParts(value.rich_text ?? value.richText);
}

function categoryValues(row: UnknownRecord) {
  if (Array.isArray(row.categories)) {
    return row.categories.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
  }
  if (typeof row.category === "string" && row.category.trim()) return [row.category.trim()];
  const value = property(row, "Category");
  if (!value || value.type !== "multi_select") return null;
  const options = value.multi_select ?? value.multiSelect;
  if (!Array.isArray(options)) return null;
  const names = options.map((option) => record(option)?.name);
  return names.every((name): name is string => typeof name === "string" && name.trim().length > 0)
    ? names.map((name) => name.trim())
    : null;
}

function sourceRef(row: UnknownRecord, index: number) {
  const value = typeof row.sourceRef === "string" ? row.sourceRef : row.id;
  return typeof value === "string" && value.trim() ? value.trim() : `invalid-row:${index + 1}`;
}

function sourceEditedAt(row: UnknownRecord) {
  const value = row.sourceEditedAt ?? row.last_edited_time ?? row.lastEditedAt;
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeTemplate(value: string, registry: PlaceholderRegistry) {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}|\[\s*([^\[\]\n]+?)\s*\]/g, (whole, braces, square) => {
    const normalized = normalizePlaceholderToken(String(braces ?? square ?? ""));
    if (!normalized) return whole;
    const definition = registry[normalized] ?? placeholderDefinition(normalized);
    return definition ? `{{${definition.token}}}` : `{{${normalized}}}`;
  });
}

export function normalizeImport(
  rows: readonly unknown[],
  registry: PlaceholderRegistry = PLACEHOLDER_REGISTRY,
): { items: NormalizedImportItem[]; counts: ImportCounts } {
  const items = rows.map((value, index) => {
    const row = record(value) ?? {};
    const inboundMessage = titleValue(row);
    const response = responseValue(row);
    const categories = categoryValues(row);
    const validRef = typeof (row.sourceRef ?? row.id) === "string" && String(row.sourceRef ?? row.id).trim().length > 0;
    const knownCategories = categories !== null && categories.every((category) =>
      FAQ_CATEGORIES.includes(category as (typeof FAQ_CATEGORIES)[number]),
    );
    const sourceShapeValid = validRef && inboundMessage !== null && inboundMessage.length > 0
      && response !== null && response.length > 0 && categories !== null && categories.length > 0
      && knownCategories;
    const draft = {
      sourceRef: sourceRef(row, index),
      sourceEditedAt: sourceEditedAt(row),
      categories: categories ?? [],
      category: categories?.[0] ?? "",
      inboundMessage: inboundMessage ?? "",
      responseTemplate: normalizeTemplate(response ?? "", registry),
      matchKeywords: [] as readonly string[],
      sourceShapeValid,
      proseShape: row.kind === "prose" || (!row.properties && typeof row.content === "string"),
    };
    const { flags, figures } = flagImportRow(draft);
    return { ...draft, flags, figures } satisfies NormalizedImportItem;
  });
  return {
    items,
    counts: {
      received: rows.length,
      normalized: items.filter((item) => item.sourceShapeValid).length,
      flagged: items.filter((item) => item.flags.length > 0).length,
      unchanged: 0,
    },
  };
}

export function embeddingRequests(items: readonly NormalizedImportItem[]) {
  return items
    .filter((item) => item.sourceShapeValid)
    .map((item) => ({ id: item.sourceRef, text: item.inboundMessage }));
}

export function buildAcceptancePayload(
  item: NormalizedImportItem,
  input: {
    disposition?: ImportDisposition | null;
    numberBindings?: readonly NumberBinding[];
    resolvedFlagIds?: readonly string[];
    bareXResolutions?: readonly BareXResolution[];
  },
): AcceptancePayload | null {
  if (!input.disposition || !item.sourceShapeValid) return null;
  const numberBindings = input.numberBindings ?? [];
  if (input.disposition === "shared" && item.figures.some((figure) =>
    !numberBindings.some((binding) => binding.kind === figure.kind && binding.value === figure.value
      && binding.field === figure.field && binding.offset === figure.offset),
  )) return null;
  const bareXResolutions = input.bareXResolutions ?? [];
  const bareFlags = item.flags.filter((candidate) => candidate.code === "bare_x");
  if (bareFlags.some((candidate) => !bareXResolutions.some((resolution) =>
    resolution.offset === candidate.offset && placeholderDefinition(resolution.token),
  ))) return null;
  const resolvedBareIds = bareFlags.map((candidate) => candidate.id);
  const reviewableIds = new Set(item.flags
    .filter((candidate) => !["unknown_placeholder", "unbound_figure", "bare_x"].includes(candidate.code))
    .map((candidate) => candidate.id));
  const flags = acceptanceFlags({
    flags: item.flags,
    disposition: input.disposition,
    numberBindings,
    resolvedFlagIds: [
      ...(input.resolvedFlagIds ?? []).filter((id) => reviewableIds.has(id)),
      ...resolvedBareIds,
    ],
  });
  if (!allBlockingFlagsResolved(flags)) return null;
  let responseTemplate = item.responseTemplate;
  for (const resolution of [...bareXResolutions].sort((left, right) => right.offset - left.offset)) {
    if (responseTemplate.slice(resolution.offset, resolution.offset + 1) !== "X") return null;
    responseTemplate = `${responseTemplate.slice(0, resolution.offset)}{{${resolution.token}}}${responseTemplate.slice(resolution.offset + 1)}`;
  }
  return {
    sourceRef: item.sourceRef,
    disposition: input.disposition,
    numberBindings,
    flags,
    afterPayload: {
      category: item.category,
      inboundMessage: item.inboundMessage,
      responseTemplate,
      matchKeywords: item.matchKeywords,
    },
    embeddingText: item.inboundMessage,
    platformDraftEligible: input.disposition === "shared",
  };
}
