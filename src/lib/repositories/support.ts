/**
 * Separate support projections for coaches and platform operators.
 *
 * Coach messages come only from the security-invoker view and their public type has no internal
 * field. The service client bypasses RLS, so every tenant-scoped read and RPC carries an explicit
 * expected tenant and every mutation is accepted only after a persisted read-back.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const SUPPORT_STATUSES = ["open", "waiting_on_coach", "resolved"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportBook = "mine" | "all";

export type CoachSupportMessageRead = {
  id: string;
  authorId: string;
  authorName: string | null;
  body: string;
  isTest: boolean;
  createdAt: string;
};

export type CoachSupportThreadRead = {
  id: string;
  tenantId: string;
  subject: string;
  status: SupportStatus;
  assignedTo: string | null;
  relatedContactId?: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
  messages: CoachSupportMessageRead[];
};

export type PlatformSupportMessageRead = CoachSupportMessageRead & { internal: boolean };

export type PlatformSupportThreadRead = {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantIsDemo: boolean;
  subject: string;
  status: SupportStatus;
  assignedTo: { id: string; name: string | null } | null;
  successOwner: { id: string; name: string | null } | null;
  relatedContactId?: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
  messages: PlatformSupportMessageRead[];
};

export type SuccessClientBookRead = {
  client: { id: string; name: string; isDemo: boolean };
  status: string;
  successOwner: { id: string; name: string | null } | null;
  supportStatus: SupportStatus | null;
  planId: string | null;
  planLabel: string | null;
  updatedAt: string;
};

type RawCoachMessage = {
  id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  is_test: boolean;
  created_at: string;
};

type RawCoachThread = {
  id: string;
  tenant_id: string;
  subject: string;
  status: SupportStatus;
  assigned_to: string | null;
  related_contact_id: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
  messages: RawCoachMessage[];
};

type RawPlatformMessage = RawCoachMessage & { internal: boolean };

type RawPlatformThread = Omit<RawCoachThread, "messages"> & {
  tenant_name: string;
  tenant_is_demo: boolean;
  assigned_to_name: string | null;
  success_owner_id: string | null;
  success_owner_name: string | null;
  messages: RawPlatformMessage[];
};

type RawClientBook = {
  client: { id: string; name: string; is_demo: boolean };
  status: string;
  success_owner: { id: string; name: string | null } | null;
  support_status: SupportStatus | null;
  plan_id: string | null;
  plan_label: string | null;
  updated_at: string;
};

export type SupportRepositoryDependencies = {
  projectCoachThreads(input: {
    expectedTenant: string;
    userId: string;
    threadId?: string;
  }): Promise<unknown>;
  projectPlatformThreads(input: {
    actorId: string;
    book: SupportBook;
    status?: SupportStatus;
    threadId?: string;
  }): Promise<unknown>;
  projectClientBook(input: { actorId: string; book: SupportBook }): Promise<unknown>;
  callCreateThread(args: Record<string, unknown>): Promise<unknown>;
  callAppendMessage(args: Record<string, unknown>): Promise<unknown>;
  callReassign(args: Record<string, unknown>): Promise<unknown>;
  readReassignment(input: {
    expectedTenant: string;
    assigneeId: string;
    auditId: number;
  }): Promise<unknown>;
};

export type SupportRepository = ReturnType<typeof createSupportRepository>;

export class SupportRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SupportRepositoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new SupportRepositoryError(code);
  return value;
}

function nullableString(value: unknown, code: string) {
  if (value !== null && typeof value !== "string") throw new SupportRepositoryError(code);
  return value as string | null;
}

function parseCoachMessage(value: unknown): CoachSupportMessageRead {
  const code = "COACH_SUPPORT_PROJECTION_INVALID";
  if (!isRecord(value) || !exactKeys(value, [
    "id", "author_id", "author_name", "body", "is_test", "created_at",
  ])) throw new SupportRepositoryError(code);
  if (typeof value.is_test !== "boolean") throw new SupportRepositoryError(code);
  return {
    id: requiredString(value.id, code),
    authorId: requiredString(value.author_id, code),
    authorName: nullableString(value.author_name, code),
    body: requiredString(value.body, code),
    isTest: value.is_test,
    createdAt: requiredString(value.created_at, code),
  };
}

function parseCoachThread(value: unknown): CoachSupportThreadRead {
  const code = "COACH_SUPPORT_PROJECTION_INVALID";
  if (!isRecord(value) || !exactKeys(value, [
    "id", "tenant_id", "subject", "status", "assigned_to", "related_contact_id", "is_test",
    "created_at", "updated_at", "messages",
  ]) || !SUPPORT_STATUSES.includes(value.status as SupportStatus)
    || typeof value.is_test !== "boolean" || !Array.isArray(value.messages)) {
    throw new SupportRepositoryError(code);
  }
  return {
    id: requiredString(value.id, code),
    tenantId: requiredString(value.tenant_id, code),
    subject: requiredString(value.subject, code),
    status: value.status as SupportStatus,
    assignedTo: nullableString(value.assigned_to, code),
    relatedContactId: nullableString(value.related_contact_id, code),
    isTest: value.is_test,
    createdAt: requiredString(value.created_at, code),
    updatedAt: requiredString(value.updated_at, code),
    messages: value.messages.map(parseCoachMessage),
  };
}

function parsePlatformMessage(value: unknown): PlatformSupportMessageRead {
  const code = "PLATFORM_SUPPORT_PROJECTION_INVALID";
  if (!isRecord(value) || !exactKeys(value, [
    "id", "author_id", "author_name", "body", "is_test", "created_at", "internal",
  ]) || typeof value.internal !== "boolean" || typeof value.is_test !== "boolean") {
    throw new SupportRepositoryError(code);
  }
  const coachShape = {
    id: value.id,
    author_id: value.author_id,
    author_name: value.author_name,
    body: value.body,
    is_test: value.is_test,
    created_at: value.created_at,
  };
  try {
    return { ...parseCoachMessage(coachShape), internal: value.internal };
  } catch {
    throw new SupportRepositoryError(code);
  }
}

function parsePlatformThread(value: unknown): PlatformSupportThreadRead {
  const code = "PLATFORM_SUPPORT_PROJECTION_INVALID";
  if (!isRecord(value) || !exactKeys(value, [
    "id", "tenant_id", "tenant_name", "tenant_is_demo", "subject", "status",
    "assigned_to", "assigned_to_name", "success_owner_id", "success_owner_name",
    "related_contact_id", "is_test", "created_at", "updated_at", "messages",
  ]) || !SUPPORT_STATUSES.includes(value.status as SupportStatus)
    || typeof value.tenant_is_demo !== "boolean" || typeof value.is_test !== "boolean"
    || !Array.isArray(value.messages)) throw new SupportRepositoryError(code);
  const assignedTo = nullableString(value.assigned_to, code);
  const successOwnerId = nullableString(value.success_owner_id, code);
  return {
    id: requiredString(value.id, code),
    tenantId: requiredString(value.tenant_id, code),
    tenantName: requiredString(value.tenant_name, code),
    tenantIsDemo: value.tenant_is_demo,
    subject: requiredString(value.subject, code),
    status: value.status as SupportStatus,
    assignedTo: assignedTo
      ? { id: assignedTo, name: nullableString(value.assigned_to_name, code) }
      : null,
    successOwner: successOwnerId
      ? { id: successOwnerId, name: nullableString(value.success_owner_name, code) }
      : null,
    relatedContactId: nullableString(value.related_contact_id, code),
    isTest: value.is_test,
    createdAt: requiredString(value.created_at, code),
    updatedAt: requiredString(value.updated_at, code),
    messages: value.messages.map(parsePlatformMessage),
  };
}

function parseClientBook(value: unknown): SuccessClientBookRead {
  const code = "SUCCESS_CLIENT_BOOK_PROJECTION_INVALID";
  if (!isRecord(value) || !exactKeys(value, [
    "client", "status", "success_owner", "support_status", "plan_id", "plan_label", "updated_at",
  ]) || !isRecord(value.client)
    || !exactKeys(value.client, ["id", "name", "is_demo"])
    || typeof value.client.is_demo !== "boolean"
    || (value.support_status !== null
      && !SUPPORT_STATUSES.includes(value.support_status as SupportStatus))
    || (value.plan_id === null) !== (value.plan_label === null)) {
    throw new SupportRepositoryError(code);
  }
  let successOwner: SuccessClientBookRead["successOwner"] = null;
  if (value.success_owner !== null) {
    if (!isRecord(value.success_owner) || !exactKeys(value.success_owner, ["id", "name"])) {
      throw new SupportRepositoryError(code);
    }
    successOwner = {
      id: requiredString(value.success_owner.id, code),
      name: nullableString(value.success_owner.name, code),
    };
  }
  return {
    client: {
      id: requiredString(value.client.id, code),
      name: requiredString(value.client.name, code),
      isDemo: value.client.is_demo,
    },
    status: requiredString(value.status, code),
    successOwner,
    supportStatus: value.support_status as SupportStatus | null,
    planId: nullableString(value.plan_id, code),
    planLabel: nullableString(value.plan_label, code),
    updatedAt: requiredString(value.updated_at, code),
  };
}

function rows(value: unknown, code: string) {
  if (!Array.isArray(value)) throw new SupportRepositoryError(code);
  return value;
}

function oneRow(value: unknown, code: string) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!isRecord(row)) throw new SupportRepositoryError(code);
  return row;
}

async function loadUsers(client: ReturnType<typeof createSupabaseServiceClient>, ids: string[]) {
  if (ids.length === 0) return new Map<string, string | null>();
  const { data, error } = await client.from("users").select("id,full_name").in("id", ids);
  if (error) throw new SupportRepositoryError("SUPPORT_USER_READ_FAILED");
  return new Map((data ?? []).map((row) => [String(row.id), row.full_name]));
}

async function loadTierNames(client: ReturnType<typeof createSupabaseServiceClient>, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const { data, error } = await client.from("tiers").select("id,name").in("id", ids);
  if (error) throw new SupportRepositoryError("SUCCESS_CLIENT_BOOK_READ_FAILED");
  return new Map((data ?? []).map((row) => [String(row.id), String(row.name)]));
}

async function liveDependencies(): Promise<SupportRepositoryDependencies> {
  const client = createSupabaseServiceClient();

  async function supportRows(input: {
    expectedTenant?: string;
    actorId?: string;
    book?: SupportBook;
    status?: SupportStatus;
    threadId?: string;
    coach: boolean;
  }) {
    let tenantIds: string[] | null = null;
    if (input.book === "mine") {
      const { data, error } = await client.from("tenants")
        .select("id").eq("success_owner", input.actorId as string);
      if (error) throw new SupportRepositoryError("SUPPORT_TENANT_READ_FAILED");
      tenantIds = (data ?? []).map((row) => String(row.id));
      if (tenantIds.length === 0) return [];
    }

    let query = client.from("support_threads")
      .select("id,tenant_id,subject,status,assigned_to,related_contact_id,is_test,created_at,updated_at")
      .order("updated_at", { ascending: false }).order("id", { ascending: false });
    if (input.expectedTenant) query = query.eq("tenant_id", input.expectedTenant);
    if (tenantIds) query = query.in("tenant_id", tenantIds);
    if (input.status) query = query.eq("status", input.status);
    if (input.threadId) query = query.eq("id", input.threadId);
    const { data: threads, error } = await query;
    if (error) throw new SupportRepositoryError("SUPPORT_THREAD_READ_FAILED");
    const threadRows = threads ?? [];
    const threadIds = threadRows.map((row) => String(row.id));
    const tenantRowIds = [...new Set(threadRows.map((row) => String(row.tenant_id)))];

    const messageTable = input.coach ? "coach_support_messages" : "support_messages";
    const messageSelect = input.coach
      ? "id,thread_id,author_id,body,is_test,created_at"
      : "id,thread_id,author_id,body,internal,is_test,created_at";
    const messageResult = threadIds.length === 0
      ? { data: [], error: null }
      : await client.from(messageTable).select(messageSelect)
        .in("thread_id", threadIds).order("created_at", { ascending: true }).order("id");
    if (messageResult.error) throw new SupportRepositoryError("SUPPORT_MESSAGE_READ_FAILED");
    const messages = (messageResult.data ?? []) as unknown as Array<Record<string, unknown>>;

    const tenantResult = tenantRowIds.length === 0
      ? { data: [], error: null }
      : await client.from("tenants").select("id,name,is_demo,success_owner").in("id", tenantRowIds);
    if (tenantResult.error) throw new SupportRepositoryError("SUPPORT_TENANT_READ_FAILED");
    const tenants = new Map((tenantResult.data ?? []).map((row) => [String(row.id), row]));
    const userIds = [...new Set([
      ...threadRows.flatMap((row) => row.assigned_to ? [String(row.assigned_to)] : []),
      ...messages.map((row) => String(row.author_id)),
      ...(tenantResult.data ?? []).flatMap((row) => row.success_owner
        ? [String(row.success_owner)] : []),
    ])];
    const users = await loadUsers(client, userIds);

    return threadRows.map((thread) => {
      const tenant = tenants.get(String(thread.tenant_id));
      if (!tenant) throw new SupportRepositoryError("SUPPORT_TENANT_READ_FAILED");
      const projectedMessages = messages
        .filter((message) => message.thread_id === thread.id)
        .map((message) => ({
          id: message.id,
          author_id: message.author_id,
          author_name: users.get(String(message.author_id)) ?? null,
          body: message.body,
          ...(input.coach ? {} : { internal: message.internal }),
          is_test: message.is_test,
          created_at: message.created_at,
        }));
      const base: RawCoachThread = {
        id: String(thread.id),
        tenant_id: String(thread.tenant_id),
        subject: String(thread.subject),
        status: thread.status as SupportStatus,
        assigned_to: thread.assigned_to ? String(thread.assigned_to) : null,
        related_contact_id: thread.related_contact_id ? String(thread.related_contact_id) : null,
        is_test: Boolean(thread.is_test),
        created_at: String(thread.created_at),
        updated_at: String(thread.updated_at),
        messages: projectedMessages as RawCoachMessage[],
      };
      if (input.coach) return base;
      return {
        ...base,
        tenant_name: String(tenant.name),
        tenant_is_demo: Boolean(tenant.is_demo),
        assigned_to_name: base.assigned_to ? users.get(base.assigned_to) ?? null : null,
        success_owner_id: tenant.success_owner ? String(tenant.success_owner) : null,
        success_owner_name: tenant.success_owner
          ? users.get(String(tenant.success_owner)) ?? null : null,
        messages: projectedMessages as RawPlatformMessage[],
      } satisfies RawPlatformThread;
    });
  }

  return {
    projectCoachThreads: ({ expectedTenant, threadId }) => supportRows({
      expectedTenant,
      threadId,
      coach: true,
    }),
    projectPlatformThreads: ({ actorId, book, status, threadId }) => supportRows({
      actorId,
      book,
      status,
      threadId,
      coach: false,
    }),
    projectClientBook: async ({ actorId, book }) => {
      let query = client.from("tenants")
        .select("id,name,status,success_owner,is_demo,tier_id,updated_at")
        .order("updated_at", { ascending: false }).order("id", { ascending: false });
      if (book === "mine") query = query.eq("success_owner", actorId);
      const { data: tenants, error } = await query;
      if (error) throw new SupportRepositoryError("SUCCESS_CLIENT_BOOK_READ_FAILED");
      const tenantIds = (tenants ?? []).map((row) => String(row.id));
      const ownerIds = [...new Set((tenants ?? []).flatMap((row) => row.success_owner
        ? [String(row.success_owner)] : []))];
      const users = await loadUsers(client, ownerIds);
      const tierIds = [...new Set((tenants ?? []).flatMap((row) => row.tier_id
        ? [String(row.tier_id)] : []))];
      const tiers = await loadTierNames(client, tierIds);
      const threadResult = tenantIds.length === 0
        ? { data: [], error: null }
        : await client.from("support_threads").select("tenant_id,status,updated_at")
          .in("tenant_id", tenantIds).order("updated_at", { ascending: false });
      if (threadResult.error) throw new SupportRepositoryError("SUCCESS_CLIENT_BOOK_READ_FAILED");
      const supportByTenant = new Map<string, SupportStatus>();
      for (const thread of threadResult.data ?? []) {
        const tenantId = String(thread.tenant_id);
        const prior = supportByTenant.get(tenantId);
        if (!prior || (thread.status === "open")
          || (thread.status === "waiting_on_coach" && prior === "resolved")) {
          supportByTenant.set(tenantId, thread.status as SupportStatus);
        }
      }
      return (tenants ?? []).map((tenant): RawClientBook => ({
        client: { id: String(tenant.id), name: String(tenant.name), is_demo: Boolean(tenant.is_demo) },
        status: String(tenant.status),
        success_owner: tenant.success_owner ? {
          id: String(tenant.success_owner),
          name: users.get(String(tenant.success_owner)) ?? null,
        } : null,
        support_status: supportByTenant.get(String(tenant.id)) ?? null,
        plan_id: tenant.tier_id && tiers.has(String(tenant.tier_id)) ? String(tenant.tier_id) : null,
        plan_label: tenant.tier_id ? tiers.get(String(tenant.tier_id)) ?? null : null,
        updated_at: String(tenant.updated_at),
      }));
    },
    callCreateThread: async (args) => {
      const { data, error } = await client.rpc("create_support_thread", args);
      if (error) throw new SupportRepositoryError("SUPPORT_THREAD_CREATE_FAILED");
      return data;
    },
    callAppendMessage: async (args) => {
      const { data, error } = await client.rpc("append_support_message", args);
      if (error) throw new SupportRepositoryError("SUPPORT_MESSAGE_APPEND_FAILED");
      return data;
    },
    callReassign: async (args) => {
      const { data, error } = await client.rpc("reassign_success_owner", args);
      if (error) throw new SupportRepositoryError("SUCCESS_OWNER_REASSIGN_FAILED");
      return data;
    },
    readReassignment: async ({ expectedTenant, assigneeId, auditId }) => {
      const [tenantResult, auditResult] = await Promise.all([
        client.from("tenants").select("id,success_owner").eq("id", expectedTenant).maybeSingle(),
        client.from("audit_log")
          .select("id,tenant_id,actor_id,subject_user_id,action,target_type,target_id,reason")
          .eq("id", auditId).eq("tenant_id", expectedTenant)
          .eq("action", "tenant.success_owner.reassigned").maybeSingle(),
      ]);
      if (tenantResult.error || auditResult.error || !tenantResult.data || !auditResult.data) {
        return null;
      }
      return {
        tenant_id: tenantResult.data.id,
        success_owner: tenantResult.data.success_owner,
        audit_id: auditResult.data.id,
        audit_actor_id: auditResult.data.actor_id,
        audit_assignee_id: auditResult.data.subject_user_id,
        audit_action: auditResult.data.action,
        audit_target_type: auditResult.data.target_type,
        audit_target_id: auditResult.data.target_id,
        audit_reason: auditResult.data.reason,
        expected_assignee: assigneeId,
      };
    },
  };
}

export function createSupportRepository(dependencies?: SupportRepositoryDependencies) {
  async function deps() {
    return dependencies ?? liveDependencies();
  }

  async function listCoachSupportThreads(expectedTenant: string, userId: string) {
    const source = await deps();
    return rows(
      await source.projectCoachThreads({ expectedTenant, userId }),
      "COACH_SUPPORT_PROJECTION_INVALID",
    ).map(parseCoachThread);
  }

  async function getCoachSupportThread(
    expectedTenant: string,
    userId: string,
    threadId: string,
  ) {
    const source = await deps();
    const projected = rows(
      await source.projectCoachThreads({ expectedTenant, userId, threadId }),
      "COACH_SUPPORT_PROJECTION_INVALID",
    ).map(parseCoachThread);
    if (projected.length !== 1 || projected[0].tenantId !== expectedTenant) {
      throw new SupportRepositoryError("COACH_SUPPORT_THREAD_NOT_FOUND");
    }
    return projected[0];
  }

  async function listPlatformSupportThreads(input: {
    actorId: string;
    book: SupportBook;
    status?: SupportStatus;
  }) {
    const source = await deps();
    return rows(
      await source.projectPlatformThreads(input),
      "PLATFORM_SUPPORT_PROJECTION_INVALID",
    ).map(parsePlatformThread);
  }

  async function getPlatformSupportThread(actorId: string, threadId: string) {
    const source = await deps();
    const projected = rows(
      await source.projectPlatformThreads({ actorId, book: "all", threadId }),
      "PLATFORM_SUPPORT_PROJECTION_INVALID",
    ).map(parsePlatformThread);
    if (projected.length !== 1) {
      throw new SupportRepositoryError("PLATFORM_SUPPORT_THREAD_NOT_FOUND");
    }
    return projected[0];
  }

  async function listSuccessClientBook(input: { actorId: string; book: SupportBook }) {
    const source = await deps();
    return rows(
      await source.projectClientBook(input),
      "SUCCESS_CLIENT_BOOK_PROJECTION_INVALID",
    ).map(parseClientBook);
  }

  async function createCoachSupportThread(input: {
    expectedTenant: string;
    userId: string;
    subject: string;
    body: string;
    relatedContactId?: string | null;
  }) {
    const source = await deps();
    const relatedContactId = input.relatedContactId ?? null;
    const receipt = oneRow(await source.callCreateThread({
      p_expected_tenant: input.expectedTenant,
      p_actor_id: input.userId,
      p_subject: input.subject,
      p_body: input.body,
      p_related_contact_id: relatedContactId,
    }), "SUPPORT_THREAD_CREATE_RECEIPT_INVALID");
    const threadId = requiredString(receipt.thread_id, "SUPPORT_THREAD_CREATE_RECEIPT_INVALID");
    const messageId = requiredString(receipt.message_id, "SUPPORT_THREAD_CREATE_RECEIPT_INVALID");
    const thread = await getCoachSupportThread(input.expectedTenant, input.userId, threadId);
    if (!thread.messages.some((message) => message.id === messageId)
      || thread.relatedContactId !== relatedContactId) {
      throw new SupportRepositoryError("SUPPORT_THREAD_CREATE_READBACK_MISMATCH");
    }
    return thread;
  }

  async function appendCoachSupportMessage(input: {
    expectedTenant: string;
    userId: string;
    threadId: string;
    body: string;
  }) {
    const source = await deps();
    const receipt = oneRow(await source.callAppendMessage({
      p_expected_tenant: input.expectedTenant,
      p_thread_id: input.threadId,
      p_actor_id: input.userId,
      p_body: input.body,
      p_internal: false,
    }), "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const messageId = requiredString(receipt.message_id, "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const createdAt = requiredString(receipt.created_at, "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const thread = await getCoachSupportThread(input.expectedTenant, input.userId, input.threadId);
    if (!thread.messages.some((message) =>
      message.id === messageId && message.createdAt === createdAt)) {
      throw new SupportRepositoryError("SUPPORT_MESSAGE_APPEND_READBACK_MISMATCH");
    }
    return thread;
  }

  async function appendPlatformSupportMessage(input: {
    actorId: string;
    threadId: string;
    body: string;
    internal: boolean;
  }) {
    const before = await getPlatformSupportThread(input.actorId, input.threadId);
    const source = await deps();
    const receipt = oneRow(await source.callAppendMessage({
      p_expected_tenant: before.tenantId,
      p_thread_id: input.threadId,
      p_actor_id: input.actorId,
      p_body: input.body,
      p_internal: input.internal,
    }), "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const messageId = requiredString(receipt.message_id, "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const createdAt = requiredString(receipt.created_at, "SUPPORT_MESSAGE_APPEND_RECEIPT_INVALID");
    const thread = await getPlatformSupportThread(input.actorId, input.threadId);
    if (!thread.messages.some((message) =>
      message.id === messageId && message.createdAt === createdAt
      && message.internal === input.internal)) {
      throw new SupportRepositoryError("SUPPORT_MESSAGE_APPEND_READBACK_MISMATCH");
    }
    return thread;
  }

  async function reassignSuccessOwner(input: {
    expectedTenant: string;
    actorId: string;
    assigneeId: string;
    reason: string;
  }) {
    const source = await deps();
    const receipt = oneRow(await source.callReassign({
      p_expected_tenant: input.expectedTenant,
      p_actor_id: input.actorId,
      p_assignee_id: input.assigneeId,
      p_reason: input.reason,
    }), "SUCCESS_OWNER_REASSIGN_RECEIPT_INVALID");
    const tenantId = requiredString(receipt.tenant_id, "SUCCESS_OWNER_REASSIGN_RECEIPT_INVALID");
    const successOwner = requiredString(
      receipt.success_owner,
      "SUCCESS_OWNER_REASSIGN_RECEIPT_INVALID",
    );
    const auditId = Number(receipt.audit_id);
    if (tenantId !== input.expectedTenant || successOwner !== input.assigneeId
      || !Number.isSafeInteger(auditId) || auditId <= 0) {
      throw new SupportRepositoryError("SUCCESS_OWNER_REASSIGN_RECEIPT_INVALID");
    }
    const readback = await source.readReassignment({
      expectedTenant: input.expectedTenant,
      assigneeId: input.assigneeId,
      auditId,
    });
    if (!isRecord(readback)
      || readback.tenant_id !== input.expectedTenant
      || readback.success_owner !== input.assigneeId
      || Number(readback.audit_id) !== auditId
      || readback.audit_actor_id !== input.actorId
      || readback.audit_assignee_id !== input.assigneeId
      || readback.audit_action !== "tenant.success_owner.reassigned"
      || readback.audit_target_type !== "tenant"
      || readback.audit_target_id !== input.expectedTenant
      || readback.audit_reason !== input.reason
      || readback.expected_assignee !== input.assigneeId) {
      throw new SupportRepositoryError("SUCCESS_OWNER_REASSIGN_READBACK_MISMATCH");
    }
    return { tenantId, successOwner, auditId, state: "Reassigned" as const };
  }

  return {
    listCoachSupportThreads,
    getCoachSupportThread,
    listPlatformSupportThreads,
    getPlatformSupportThread,
    listSuccessClientBook,
    createCoachSupportThread,
    appendCoachSupportMessage,
    appendPlatformSupportMessage,
    reassignSuccessOwner,
  };
}

export function listCoachSupportThreads(expectedTenant: string, userId: string) {
  return createSupportRepository().listCoachSupportThreads(expectedTenant, userId);
}

export function getCoachSupportThread(expectedTenant: string, userId: string, threadId: string) {
  return createSupportRepository().getCoachSupportThread(expectedTenant, userId, threadId);
}

export function listPlatformSupportThreads(input: {
  actorId: string;
  book: SupportBook;
  status?: SupportStatus;
}) {
  return createSupportRepository().listPlatformSupportThreads(input);
}

export function getPlatformSupportThread(actorId: string, threadId: string) {
  return createSupportRepository().getPlatformSupportThread(actorId, threadId);
}

export function listSuccessClientBook(input: { actorId: string; book: SupportBook }) {
  return createSupportRepository().listSuccessClientBook(input);
}
