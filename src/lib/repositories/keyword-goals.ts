import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type KeywordGoalMode = "resource" | "book";

export type KeywordGoal = {
  id: string;
  keyword: string;
  normalizedKeyword: string;
  goal: KeywordGoalMode;
  resourceUrl: string | null;
  resourceMessage: string | null;
  postBookingUrl: string | null;
  postBookingMessage: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type KeywordGoalWrite = {
  tenantId: string;
  actorId: string;
  id: string | null;
  keyword: string;
  goal: KeywordGoalMode;
  resourceUrl: string | null;
  resourceMessage: string | null;
  postBookingUrl: string | null;
  postBookingMessage: string | null;
};

export type KeywordGoalRepository = {
  list(tenantId: string): Promise<readonly KeywordGoal[]>;
  save(input: KeywordGoalWrite): Promise<{ goal: KeywordGoal; auditId: string }>;
  deactivate(input: Pick<KeywordGoalWrite, "tenantId" | "actorId" | "id"> & { id: string }):
    Promise<{ goal: KeywordGoal; auditId: string }>;
};

const GOAL_SELECT = [
  "id", "tenant_id", "keyword", "normalized_keyword", "goal", "resource_url",
  "resource_message", "post_booking_url", "post_booking_message", "active", "created_at",
  "updated_at",
].join(",");

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function rows(value: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((value) => record(value, code));
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function parseGoal(value: unknown, expectedTenant: string): KeywordGoal {
  const row = record(value, "KEYWORD_GOAL_READBACK_INVALID");
  if (
    row.tenant_id !== expectedTenant || typeof row.id !== "string" ||
    typeof row.keyword !== "string" || typeof row.normalized_keyword !== "string" ||
    (row.goal !== "resource" && row.goal !== "book") || typeof row.active !== "boolean" ||
    typeof row.created_at !== "string" || typeof row.updated_at !== "string"
  ) throw new Error("KEYWORD_GOAL_READBACK_INVALID");
  return {
    id: row.id,
    keyword: row.keyword,
    normalizedKeyword: row.normalized_keyword,
    goal: row.goal,
    resourceUrl: nullableText(row.resource_url, "KEYWORD_GOAL_READBACK_INVALID"),
    resourceMessage: nullableText(row.resource_message, "KEYWORD_GOAL_READBACK_INVALID"),
    postBookingUrl: nullableText(row.post_booking_url, "KEYWORD_GOAL_READBACK_INVALID"),
    postBookingMessage: nullableText(row.post_booking_message, "KEYWORD_GOAL_READBACK_INVALID"),
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

async function readGoal(client: ServiceClient, tenantId: string, id: string) {
  const { data, error } = await client.from("keyword_goals").select(GOAL_SELECT)
    .eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (error || !data) throw new Error("KEYWORD_GOAL_READBACK_FAILED");
  return parseGoal(data, tenantId);
}

async function verifyAudit(client: ServiceClient, input: {
  tenantId: string;
  actorId: string;
  goalId: string;
  auditId: string;
  action: "keyword_goal.saved" | "keyword_goal.deactivated";
}) {
  const { data, error } = await client.from("audit_log")
    .select("id,tenant_id,actor_id,action,target_type,target_id")
    .eq("id", input.auditId).maybeSingle();
  if (
    error || !data || String(data.id) !== input.auditId || data.tenant_id !== input.tenantId ||
    data.actor_id !== input.actorId || data.action !== input.action ||
    data.target_type !== "keyword_goal" || data.target_id !== input.goalId
  ) throw new Error("KEYWORD_GOAL_AUDIT_READBACK_FAILED");
}

/** All mutations use tenant-asserting RPCs, then verify both the row and its audit receipt. */
export function createKeywordGoalRepository(): KeywordGoalRepository {
  const client = createSupabaseServiceClient();
  return {
    list: async (tenantId) => {
      const { data, error } = await client.from("keyword_goals").select(GOAL_SELECT)
        .eq("tenant_id", tenantId).order("active", { ascending: false })
        .order("normalized_keyword", { ascending: true }).order("id", { ascending: true });
      if (error) throw new Error("KEYWORD_GOALS_READ_FAILED");
      return rows(data, "KEYWORD_GOALS_READ_FAILED").map((row) => parseGoal(row, tenantId));
    },
    save: async (input) => {
      const { data, error } = await client.rpc("save_keyword_goal", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_goal_id: input.id,
        p_keyword: input.keyword,
        p_goal: input.goal,
        p_resource_url: input.resourceUrl,
        p_resource_message: input.resourceMessage,
        p_post_booking_url: input.postBookingUrl,
        p_post_booking_message: input.postBookingMessage,
      });
      if (error) throw new Error(`KEYWORD_GOAL_SAVE_FAILED:${error.message}`);
      const receipt = rows(data, "KEYWORD_GOAL_SAVE_RECEIPT_INVALID")[0];
      if (!receipt || typeof receipt.keyword_goal_id !== "string" ||
        (typeof receipt.audit_id !== "string" && typeof receipt.audit_id !== "number")) {
        throw new Error("KEYWORD_GOAL_SAVE_RECEIPT_INVALID");
      }
      const goal = await readGoal(client, input.tenantId, receipt.keyword_goal_id);
      const auditId = String(receipt.audit_id);
      await verifyAudit(client, {
        tenantId: input.tenantId, actorId: input.actorId, goalId: goal.id, auditId,
        action: "keyword_goal.saved",
      });
      return { goal, auditId };
    },
    deactivate: async (input) => {
      const { data, error } = await client.rpc("deactivate_keyword_goal", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_goal_id: input.id,
      });
      if (error) throw new Error(`KEYWORD_GOAL_DEACTIVATE_FAILED:${error.message}`);
      const receipt = rows(data, "KEYWORD_GOAL_DEACTIVATE_RECEIPT_INVALID")[0];
      if (!receipt || receipt.keyword_goal_id !== input.id ||
        (typeof receipt.audit_id !== "string" && typeof receipt.audit_id !== "number")) {
        throw new Error("KEYWORD_GOAL_DEACTIVATE_RECEIPT_INVALID");
      }
      const goal = await readGoal(client, input.tenantId, input.id);
      if (goal.active) throw new Error("KEYWORD_GOAL_DEACTIVATE_READBACK_INVALID");
      const auditId = String(receipt.audit_id);
      await verifyAudit(client, {
        tenantId: input.tenantId, actorId: input.actorId, goalId: goal.id, auditId,
        action: "keyword_goal.deactivated",
      });
      return { goal, auditId };
    },
  };
}
