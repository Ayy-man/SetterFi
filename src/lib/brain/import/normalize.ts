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
  isContentFlag,
  type ImportFigure,
  type ImportFlag,
  type ImportFlagOptions,
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
  /** Set exactly when `disposition` is `tenant_specific`. */
  tenantId: string | null;
  numberBindings: readonly NumberBinding[];
  flags: readonly ImportFlag[];
  afterPayload: NormalizedImportPayload;
  embeddingText: string;
  platformDraftEligible: boolean;
};

export type AcceptanceRefusalCode =
  | "BRAIN_IMPORT_DISPOSITION_REQUIRED"
  | "BRAIN_IMPORT_SOURCE_SHAPE_INVALID"
  | "BRAIN_IMPORT_TENANT_REQUIRED"
  | "BRAIN_IMPORT_TENANT_NOT_ALLOWED"
  | "BRAIN_IMPORT_EDIT_UNCHANGED"
  | "BRAIN_IMPORT_EDIT_CATEGORY_INVALID"
  | "BRAIN_IMPORT_CONTENT_FLAG_UNEDITED"
  | "BRAIN_IMPORT_CONTENT_FLAGS_REMAIN"
  | "BRAIN_IMPORT_BARE_X_RESOLUTION_INVALID"
  | "BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED";

/**
 * The outcome of review. A refusal is data the route can put in a response body, so the reviewer
 * learns which rule stopped the acceptance instead of a generic 409.
 */
export type AcceptanceDecision =
  | { ok: true; payload: AcceptancePayload }
  | { ok: false; code: AcceptanceRefusalCode };

/**
 * What a reviewer changed before accepting. The accepted text is the edit, never the source, and
 * the edit is re-scanned with the same detectors that flagged the source.
 */
export type AcceptanceEdit = {
  responseTemplate?: string;
  category?: string;
};

export type BareXResolution = {
  offset: number;
  token: "booking_link" | `asset.${string}`;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  flagOptions: ImportFlagOptions = {},
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
    const { flags, figures } = flagImportRow(draft, flagOptions);
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

function refuse(code: AcceptanceRefusalCode): AcceptanceDecision {
  return { ok: false, code };
}

/**
 * Apply a reviewer's edit to the source row and re-run the detectors on the result.
 *
 * Returns the edited row with fresh flags and figures, or a refusal when the edit is not an edit
 * (identical to the source) or picks a category the source never carried.
 */
function applyEdit(
  item: NormalizedImportItem,
  edit: AcceptanceEdit,
  registry: PlaceholderRegistry,
  flagOptions: ImportFlagOptions,
): { ok: true; row: NormalizedImportItem } | { ok: false; code: AcceptanceRefusalCode } {
  const responseTemplate = edit.responseTemplate !== undefined
    ? normalizeTemplate(edit.responseTemplate.trim(), registry)
    : item.responseTemplate;
  const category = edit.category !== undefined ? edit.category.trim() : item.category;
  if (edit.category !== undefined && !item.categories.includes(category)) {
    return { ok: false, code: "BRAIN_IMPORT_EDIT_CATEGORY_INVALID" };
  }
  const categories = edit.category !== undefined ? [category] : item.categories;
  if (responseTemplate === item.responseTemplate && categories.length === item.categories.length
    && category === item.category) {
    return { ok: false, code: "BRAIN_IMPORT_EDIT_UNCHANGED" };
  }
  const row = {
    ...item,
    responseTemplate,
    category,
    categories,
    sourceShapeValid: item.sourceShapeValid && responseTemplate.length > 0,
  };
  // An edit is typed structured copy; the prose-shape flag describes the provider row, which the
  // source-shape gate above has already accepted.
  const { flags, figures } = flagImportRow({ ...row, proseShape: false }, flagOptions);
  return { ok: true, row: { ...row, flags, figures } };
}

/**
 * Decide whether a reviewed import row may become a knowledge entry, and in what shape.
 *
 * A content flag (first-person wording, PII, a handle, a brand name, a proof claim, or two
 * categories) describes the copy itself. For the shared Brain a reviewer cannot resolve one by
 * ticking it: the row has to be edited, and the edit has to re-scan clean. The quarantine
 * dispositions may keep the source text because nothing shared is ever built from them.
 */
export function buildAcceptancePayload(
  item: NormalizedImportItem,
  input: {
    disposition?: ImportDisposition | null;
    tenantId?: string | null;
    edit?: AcceptanceEdit | null;
    numberBindings?: readonly NumberBinding[];
    resolvedFlagIds?: readonly string[];
    bareXResolutions?: readonly BareXResolution[];
  },
  options: { registry?: PlaceholderRegistry; flagOptions?: ImportFlagOptions } = {},
): AcceptanceDecision {
  if (!input.disposition) return refuse("BRAIN_IMPORT_DISPOSITION_REQUIRED");
  if (!item.sourceShapeValid) return refuse("BRAIN_IMPORT_SOURCE_SHAPE_INVALID");
  const tenantId = typeof input.tenantId === "string" && UUID_PATTERN.test(input.tenantId.trim())
    ? input.tenantId.trim().toLowerCase()
    : null;
  if (input.disposition === "tenant_specific" && tenantId === null) return refuse("BRAIN_IMPORT_TENANT_REQUIRED");
  if (input.disposition !== "tenant_specific" && input.tenantId) return refuse("BRAIN_IMPORT_TENANT_NOT_ALLOWED");

  const registry = options.registry ?? PLACEHOLDER_REGISTRY;
  const flagOptions = options.flagOptions ?? {};
  const edit = input.edit && (input.edit.responseTemplate !== undefined || input.edit.category !== undefined)
    ? input.edit
    : null;
  let working = item;
  if (edit) {
    const edited = applyEdit(item, edit, registry, flagOptions);
    if (!edited.ok) return refuse(edited.code);
    working = edited.row;
  }
  if (input.disposition === "shared") {
    if (!edit && item.flags.some(isContentFlag)) return refuse("BRAIN_IMPORT_CONTENT_FLAG_UNEDITED");
    if (working.flags.some(isContentFlag)) return refuse("BRAIN_IMPORT_CONTENT_FLAGS_REMAIN");
  }

  const numberBindings = input.numberBindings ?? [];
  if (input.disposition === "shared" && working.figures.some((figure) =>
    !numberBindings.some((binding) => binding.kind === figure.kind && binding.value === figure.value
      && binding.field === figure.field && binding.offset === figure.offset),
  )) return refuse("BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");
  const bareXResolutions = input.bareXResolutions ?? [];
  const bareFlags = working.flags.filter((candidate) => candidate.code === "bare_x");
  if (bareFlags.some((candidate) => !bareXResolutions.some((resolution) =>
    resolution.offset === candidate.offset && placeholderDefinition(resolution.token),
  ))) return refuse("BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");
  const resolvedBareIds = bareFlags.map((candidate) => candidate.id);
  const reviewableIds = new Set(working.flags
    .filter((candidate) => !["unknown_placeholder", "unbound_figure", "bare_x"].includes(candidate.code))
    // Under `shared`, a content flag is never reviewable by tick; the re-scan above already
    // guarantees there are none left on the working row, so this only matters for quarantine.
    .map((candidate) => candidate.id));
  const workingFlags = acceptanceFlags({
    flags: working.flags,
    disposition: input.disposition,
    numberBindings,
    resolvedFlagIds: [
      ...(input.resolvedFlagIds ?? []).filter((id) => reviewableIds.has(id)),
      ...resolvedBareIds,
    ],
  });
  if (!allBlockingFlagsResolved(workingFlags)) return refuse("BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");

  // Source flags the edit made disappear are kept on the record as resolved by that edit, so the
  // audit row still says what was wrong with the source and how it was fixed.
  const workingIds = new Set(workingFlags.map((candidate) => candidate.id));
  const editedAway = edit
    ? item.flags
      .filter((candidate) => !workingIds.has(candidate.id))
      .map((candidate) => ({ ...candidate, resolved: true, resolution: { kind: "edited", value: null } }))
    : [];
  const flags = [...editedAway, ...workingFlags];

  let responseTemplate = working.responseTemplate;
  for (const resolution of [...bareXResolutions].sort((left, right) => right.offset - left.offset)) {
    if (responseTemplate.slice(resolution.offset, resolution.offset + 1) !== "X") {
      return refuse("BRAIN_IMPORT_BARE_X_RESOLUTION_INVALID");
    }
    responseTemplate = `${responseTemplate.slice(0, resolution.offset)}{{${resolution.token}}}${responseTemplate.slice(resolution.offset + 1)}`;
  }
  return {
    ok: true,
    payload: {
      sourceRef: item.sourceRef,
      disposition: input.disposition,
      tenantId: input.disposition === "tenant_specific" ? tenantId : null,
      numberBindings,
      flags,
      afterPayload: {
        category: working.category,
        inboundMessage: item.inboundMessage,
        responseTemplate,
        matchKeywords: item.matchKeywords,
      },
      embeddingText: item.inboundMessage,
      platformDraftEligible: input.disposition === "shared",
    },
  };
}
