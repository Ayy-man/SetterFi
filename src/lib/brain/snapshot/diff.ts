/** Per-entity Brain diffs with a closed impact vocabulary; UI code never authors impact claims. */

import {
  contentHashForPayload,
  serializeCanonicalJson,
  type CanonicalBrainEntity,
  type CanonicalBrainPayload,
} from "@/lib/brain/snapshot/canonicalize";

export const BRAIN_IMPACT_KEYS = [
  "compliance_rules_changed",
  "placeholder_schema_changed",
  "placeholder_resolution_changed",
  "knowledge_mode_changed",
] as const;

export type BrainImpactKey = (typeof BRAIN_IMPACT_KEYS)[number];
export type BrainEntityChange = {
  kind: "added" | "changed" | "removed";
  entityType: string;
  entityId: string;
  before: CanonicalBrainEntity["value"] | null;
  after: CanonicalBrainEntity["value"] | null;
};

export type BrainDiff =
  | { status: "nothing_changed"; currentHash: string; draftHash: string; changes: []; impactKeys: [] }
  | {
      status: "changed";
      currentHash: string;
      draftHash: string;
      changes: BrainEntityChange[];
      impactKeys: BrainImpactKey[];
    };

function entityMap(payload: CanonicalBrainPayload) {
  return new Map(payload.entities.map((entity) => [`${entity.type}:${entity.id}`, entity]));
}

function impactKeys(
  current: CanonicalBrainPayload,
  draft: CanonicalBrainPayload,
  changes: readonly BrainEntityChange[],
) {
  const impacts = new Set<BrainImpactKey>();
  if (changes.some((change) => change.entityType === "compliance_rule")) {
    impacts.add("compliance_rules_changed");
  }
  if (changes.some((change) => change.entityType === "placeholder_definition") ||
    current.placeholderSchemaHash !== draft.placeholderSchemaHash) {
    impacts.add("placeholder_schema_changed");
  }
  if (changes.some((change) => change.entityType === "placeholder_resolution") ||
    current.placeholderResolutionHash !== draft.placeholderResolutionHash) {
    impacts.add("placeholder_resolution_changed");
  }
  if (current.knowledgeMode !== draft.knowledgeMode) impacts.add("knowledge_mode_changed");
  return BRAIN_IMPACT_KEYS.filter((key) => impacts.has(key));
}

export function diffBrainPayloads(
  current: CanonicalBrainPayload,
  draft: CanonicalBrainPayload,
): BrainDiff {
  const currentHash = contentHashForPayload(current);
  const draftHash = contentHashForPayload(draft);
  if (currentHash === draftHash) {
    return { status: "nothing_changed", currentHash, draftHash, changes: [], impactKeys: [] };
  }

  const before = entityMap(current);
  const after = entityMap(draft);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = keys.flatMap<BrainEntityChange>((key) => {
    const previous = before.get(key);
    const next = after.get(key);
    if (!previous && next) {
      return [{ kind: "added", entityType: next.type, entityId: next.id, before: null, after: next.value }];
    }
    if (previous && !next) {
      return [{ kind: "removed", entityType: previous.type, entityId: previous.id, before: previous.value, after: null }];
    }
    if (previous && next && serializeCanonicalJson(previous.value) !== serializeCanonicalJson(next.value)) {
      return [{
        kind: "changed",
        entityType: next.type,
        entityId: next.id,
        before: previous.value,
        after: next.value,
      }];
    }
    return [];
  });
  return { status: "changed", currentHash, draftHash, changes, impactKeys: impactKeys(current, draft, changes) };
}
