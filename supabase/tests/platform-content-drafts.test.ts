import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OWNER = "00000000-0000-4000-8000-00000000c001";
const SUCCESS = "00000000-0000-4000-8000-00000000c002";

// Every slot the pipeline can send a lead verbatim (20261013000016): the three prompt texts, the
// scope ladder, the held reply per moderator class and the STOP/HELP/START control copy.
const DRAFT = {
  automatedExperienceDisclosure: " You are chatting with an automated assistant. ",
  platformFrame: "Frame text",
  roleBoundary: "Boundary text",
  scopeDeflection1: "Deflection one",
  scopeDeflection2: "Deflection two",
  scopeClosing: "Scope closing",
  heldReplies: { NUM: "n", CLAIM: "c", ECHO: "e", LINK: "l", SCOPE: "s", LEN: "len", JUDGE: "j", REVOKE: "r" },
  controlCopy: { STOP: " Stopped. ", HELP: "Help.", START: "Started." },
};
const DRAFT_KEYS = [
  "automatedExperienceDisclosure", "controlCopy", "heldReplies", "platformFrame", "roleBoundary",
  "scopeClosing", "scopeDeflection1", "scopeDeflection2",
];

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Platform content draft suite could not reach Postgres at ${DB_URL}. Start the local Supabase stack; this suite fails rather than skips.`, { cause });
  }
});

afterAll(async () => db?.end());
beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.users (id, email, role, tenant_id) values
      ('${OWNER}', 'owner@platform-content.test', 'owner', null),
      ('${SUCCESS}', 'success@platform-content.test', 'success', null)
  `);
});
afterEach(async () => db.query("rollback"));

async function refuses(sql: string, params: unknown[]) {
  try {
    await db.query("savepoint attempt");
    await db.query(sql, params);
  } catch (error) {
    await db.query("rollback to savepoint attempt");
    return (error as Error).message;
  }
  throw new Error("EXPECTED_REFUSAL");
}

describe("platform agent content drafts", () => {
  it("only an owner or admin can save, and only the eight editable keys are accepted", async () => {
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [SUCCESS, JSON.stringify(DRAFT)]))
      .toBe("PLATFORM_CONTENT_ADMIN_REQUIRED");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, mission: "m" })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:keys");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, heldReplies: { ...DRAFT.heldReplies, NUM: "  " } })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:heldReplies.NUM");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, heldReplies: { NUM: "n" } })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:heldReplies.keys");
    const withoutControlCopy = Object.fromEntries(Object.entries(DRAFT).filter(([key]) => key !== "controlCopy"));
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify(withoutControlCopy)]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:keys");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, scopeClosing: " " })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:scopeClosing");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, controlCopy: { STOP: "s", HELP: "h" } })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:controlCopy.keys");
    expect(await refuses("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify({ ...DRAFT, controlCopy: { ...DRAFT.controlCopy, START: "" } })]))
      .toBe("PLATFORM_CONTENT_DRAFT_INVALID:controlCopy.START");
  });

  it("saving writes the draft lane, trims it, logs it, and leaves the approved row untouched", async () => {
    const before = await db.query<{ agent_content: Record<string, unknown>; approved: boolean }>("select agent_content, approved from public.platform_settings");
    const saved = await db.query<{ draft_hash: string; audit_id: string }>(
      "select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify(DRAFT)],
    );
    expect(saved.rows[0].draft_hash).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.query<{ draft: Record<string, unknown>; hash: string; saved_by: string; agent_content: Record<string, unknown>; approved: boolean }>(
      "select agent_content_draft draft, agent_content_draft_hash hash, agent_content_draft_saved_by saved_by, agent_content, approved from public.platform_settings",
    );
    expect(row.rows[0].draft.automatedExperienceDisclosure).toBe("You are chatting with an automated assistant.");
    expect(Object.keys(row.rows[0].draft).sort()).toEqual(DRAFT_KEYS);
    expect(row.rows[0].draft.controlCopy).toEqual({ STOP: "Stopped.", HELP: "Help.", START: "Started." });
    expect(row.rows[0].hash).toBe(saved.rows[0].draft_hash);
    expect(row.rows[0].saved_by).toBe(OWNER);
    expect(row.rows[0].agent_content).toEqual(before.rows[0].agent_content);
    expect(row.rows[0].approved).toBe(before.rows[0].approved);
    const audit = await db.query<{ action: string; target_type: string; target_id: string; payload: Record<string, unknown> }>(
      "select action, target_type, target_id, payload from public.audit_log where id = $1", [saved.rows[0].audit_id],
    );
    expect(audit.rows).toEqual([{
      action: "platform_content.draft.saved", target_type: "platform_settings", target_id: "singleton",
      payload: { draftHash: saved.rows[0].draft_hash },
    }]);
  });

  it("approval needs a matching hash, a reason, and no placeholder in any lead-facing slot", async () => {
    // A draft may still carry placeholder text in the slots the seed left unapproved; saving it is
    // allowed, approving it is not, and the refusal names every slot that blocks it.
    const placeholderDraft = {
      ...DRAFT,
      scopeDeflection1: "[DRAFT] deflection one", scopeDeflection2: "SETTERFI_DEMO_PLACEHOLDER_SCOPE_2",
      scopeClosing: "[DRAFT] closing",
      controlCopy: { STOP: "SETTERFI_DEMO_PLACEHOLDER_STOP", HELP: "[DRAFT] help", START: "[DRAFT] start" },
    };
    const saved = await db.query<{ draft_hash: string }>("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify(placeholderDraft)]);
    const hash = saved.rows[0].draft_hash;
    expect(await refuses("select * from public.approve_platform_agent_content($1, $2, $3)", [OWNER, "stale", "reason"]))
      .toBe("PLATFORM_CONTENT_DRAFT_STALE");
    expect(await refuses("select * from public.approve_platform_agent_content($1, $2, $3)", [OWNER, hash, "  "]))
      .toBe("PLATFORM_CONTENT_REASON_REQUIRED");
    expect(await refuses("select * from public.approve_platform_agent_content($1, $2, $3)", [SUCCESS, hash, "reason"]))
      .toBe("PLATFORM_CONTENT_ADMIN_REQUIRED");
    // The seed's control copy and scope ladder are still placeholders, so the flip is refused and
    // the refusal names every slot that blocks it.
    const blocked = await refuses("select * from public.approve_platform_agent_content($1, $2, $3)", [OWNER, hash, "reason"]);
    expect(blocked.startsWith("PLATFORM_CONTENT_NOT_APPROVABLE:")).toBe(true);
    const slots = blocked.split(":")[1].split(",");
    expect(slots).toEqual(expect.arrayContaining(["scopeDeflection1", "scopeDeflection2", "scopeClosing", "controlCopy.STOP", "controlCopy.HELP", "controlCopy.START"]));
    const blockers = await db.query<{ blockers: string[] }>(
      "select public.platform_agent_content_blockers(agent_content || agent_content_draft) blockers from public.platform_settings",
    );
    expect(blockers.rows[0].blockers).toEqual(slots);
    const untouched = await db.query<{ approved: boolean; has_draft: boolean }>("select approved, agent_content_draft is not null has_draft from public.platform_settings");
    expect(untouched.rows[0]).toEqual({ approved: false, has_draft: true });
  });

  it("approval merges the draft over the approved row, keeps mission and qualification, clears the draft, and logs the reason", async () => {
    const saved = await db.query<{ draft_hash: string }>("select * from public.save_platform_agent_content_draft($1, $2)", [OWNER, JSON.stringify(DRAFT)]);
    const seed = await db.query<{ placeholders: string[] }>(
      "select public.platform_agent_content_blockers(agent_content) placeholders from public.platform_settings",
    );
    expect(seed.rows[0].placeholders).toEqual(expect.arrayContaining(["scopeDeflection1", "controlCopy.STOP"]));
    const approved = await db.query<{ audit_id: string; content_hash: string }>(
      "select * from public.approve_platform_agent_content($1, $2, $3)", [OWNER, saved.rows[0].draft_hash, "Reviewed with the client"],
    );
    const row = await db.query<{ approved: boolean; draft_cleared: boolean; content: Record<string, unknown>; approved_by: string }>(
      "select approved, agent_content_draft is null draft_cleared, agent_content content, agent_content_approved_by approved_by from public.platform_settings",
    );
    expect(row.rows[0].approved).toBe(true);
    expect(row.rows[0].draft_cleared).toBe(true);
    expect(row.rows[0].approved_by).toBe(OWNER);
    expect(row.rows[0].content.platformFrame).toBe("Frame text");
    expect(row.rows[0].content.mission).toBe("[DRAFT] Mission prompt pending approval.");
    expect(row.rows[0].content.controlCopy).toEqual({ STOP: "Stopped.", HELP: "Help.", START: "Started." });
    expect(row.rows[0].content.scopeClosing).toBe("Scope closing");
    const cleared = await db.query<{ blockers: string[] }>(
      "select public.platform_agent_content_blockers(agent_content) blockers from public.platform_settings",
    );
    expect(cleared.rows[0].blockers).toEqual([]);
    const audit = await db.query<{ action: string; reason: string; payload: Record<string, unknown> }>(
      "select action, reason, payload from public.audit_log where id = $1", [approved.rows[0].audit_id],
    );
    expect(audit.rows[0].action).toBe("platform_content.approved");
    expect(audit.rows[0].reason).toBe("Reviewed with the client");
    expect(audit.rows[0].payload).toEqual({
      draftHash: saved.rows[0].draft_hash,
      contentHash: approved.rows[0].content_hash,
      previouslyApproved: false,
      fields: DRAFT_KEYS,
    });
    expect(await refuses("select * from public.approve_platform_agent_content($1, $2, $3)", [OWNER, "x", "reason"]))
      .toBe("PLATFORM_CONTENT_DRAFT_REQUIRED");
  });

  it("keeps the write functions with the service role only", async () => {
    const grants = await db.query<{ fn: string; authenticated: boolean; service: boolean }>(`
      select fn,
        has_function_privilege('authenticated', fn, 'execute') authenticated,
        has_function_privilege('service_role', fn, 'execute') service
      from unnest(array[
        'public.save_platform_agent_content_draft(uuid,jsonb)',
        'public.approve_platform_agent_content(uuid,text,text)',
        'public.platform_agent_content_blockers(jsonb)'
      ]) fn
    `);
    expect(grants.rows.every((row) => !row.authenticated && row.service)).toBe(true);
  });
});
