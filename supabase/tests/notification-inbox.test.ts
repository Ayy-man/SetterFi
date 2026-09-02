// Inbox receipts use the existing notifications table. These cases prove the self-only
// mutation boundary, idempotency, and unread count against real Postgres.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "91500000-0000-4000-8000-000000000001";
const OTHER_TENANT = "91500000-0000-4000-8000-000000000002";
const USER = "91500000-0000-4000-8000-000000000003";
const OTHER_USER = "91500000-0000-4000-8000-000000000004";
const OPERATOR = "91500000-0000-4000-8000-000000000005";
const AFFILIATE = "91500000-0000-4000-8000-000000000006";

let db: Client;
let ownNotificationId: string;
let otherNotificationId: string;
let broadcastNotificationId: string;

async function actAs(userId: string, tenantId: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, app_metadata: { role: "coach", tenant_id: tenantId } }),
  ]);
}

/** Platform roles carry no tenant claim, which is exactly why owns_tenant cannot stand in here. */
async function actAsPlatform(userId: string, role: "owner" | "admin" | "success" | "build") {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, app_metadata: { role } }),
  ]);
}

async function actAsAffiliate(userId: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, app_metadata: { role: "affiliate" } }),
  ]);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Notification inbox tests could not reach Postgres at ${DB_URL}. Start the local stack with \`supabase start\`.`, { cause });
  }
});

afterAll(async () => { await db?.end(); });

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT}', 'notification-inbox-a', 'Notification Inbox A', 'a@notification.test'),
      ('${OTHER_TENANT}', 'notification-inbox-b', 'Notification Inbox B', 'b@notification.test');
    insert into public.users (id, email, role, tenant_id) values
      ('${USER}', 'user@notification.test', 'coach', '${TENANT}'),
      ('${OTHER_USER}', 'other@notification.test', 'coach', '${OTHER_TENANT}'),
      ('${OPERATOR}', 'operator@notification.test', 'success', null),
      ('${AFFILIATE}', 'affiliate@notification.test', 'affiliate', null);
  `);
  ownNotificationId = (await db.query<{ id: string }>(`
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    values ('${TENANT}', '${USER}', 'appointment.booked', 'Synthetic inbox receipt', 'Synthetic body')
    returning id
  `)).rows[0].id;
  // Addressed to nobody in particular: the shared queue item the admin Inbox reads and offers
  // "Mark read" on. Since Phase 8 such a row must still name a recipient_email.
  broadcastNotificationId = (await db.query<{ id: string }>(`
    insert into public.notifications (tenant_id, user_id, recipient_email, kind, title, body)
    values ('${TENANT}', null, 'nobody@notification.test', 'a2p.stuck', 'Shared queue notice', 'Shared body')
    returning id
  `)).rows[0].id;
  otherNotificationId = (await db.query<{ id: string }>(`
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    values ('${OTHER_TENANT}', '${OTHER_USER}', 'appointment.booked', 'Other inbox receipt', 'Other body')
    returning id
  `)).rows[0].id;
});

afterEach(async () => { await db.query("rollback"); });

describe("notification inbox", () => {
  it("marks one self-owned receipt read idempotently", async () => {
    await actAs(USER, TENANT);
    const first = await db.query<{ notification_id: string; read_at: string }>(
      "select * from public.mark_notification_read($1)", [ownNotificationId],
    );
    const second = await db.query<{ notification_id: string; read_at: string }>(
      "select * from public.mark_notification_read($1)", [ownNotificationId],
    );
    expect(first.rows[0].notification_id).toBe(ownNotificationId);
    expect(second.rows[0]).toEqual(first.rows[0]);
    await db.query("reset role");
    expect((await db.query("select count(*)::int as count from public.audit_log where action = 'notification.inbox.read'"))
      .rows[0].count).toBe(1);
  });

  it("refuses a cross-user receipt without changing its unread state", async () => {
    await actAs(USER, TENANT);
    await db.query("savepoint cross_user_notification_read");
    await expect(db.query("select * from public.mark_notification_read($1)", [otherNotificationId]))
      .rejects.toThrow(/NOTIFICATION_NOT_FOUND_OR_FORBIDDEN/);
    await db.query("rollback to savepoint cross_user_notification_read");
    await db.query("reset role");
    expect((await db.query("select read_at from public.notifications where id = $1", [otherNotificationId]))
      .rows[0].read_at).toBeNull();
  });

  it("reports and clears only the actor's unread records", async () => {
    await actAs(USER, TENANT);
    const before = await db.query<{ count: string }>(
      "select count(*)::text as count from public.notifications where user_id = $1 and read_at is null", [USER],
    );
    expect(before.rows[0].count).toBe("1");
    expect((await db.query<{ marked_count: number }>("select * from public.mark_all_notifications_read()"))
      .rows[0].marked_count).toBe(1);
    expect((await db.query<{ marked_count: number }>("select * from public.mark_all_notifications_read()"))
      .rows[0].marked_count).toBe(0);
    await db.query("reset role");
    expect((await db.query("select read_at from public.notifications where id = $1", [otherNotificationId]))
      .rows[0].read_at).toBeNull();
  });

  it("lets a platform operator mark a nobody-in-particular notice read and read it back", async () => {
    await actAsPlatform(OPERATOR, "success");
    const marked = await db.query<{ notification_id: string; read_at: string }>(
      "select * from public.mark_notification_read($1)", [broadcastNotificationId],
    );
    expect(marked.rows[0].notification_id).toBe(broadcastNotificationId);
    expect(marked.rows[0].read_at).not.toBeNull();
    // The repository re-selects the row it just marked, so the select policy has to see it too.
    expect((await db.query("select id from public.notifications where id = $1", [broadcastNotificationId]))
      .rows).toHaveLength(1);
    await db.query("reset role");
    expect((await db.query(
      "select count(*)::int as count from public.audit_log where action = 'notification.inbox.read' and target_id = $1",
      [broadcastNotificationId],
    )).rows[0].count).toBe(1);
  });

  it("refuses a nobody-in-particular notice from a coach and from an affiliate", async () => {
    await actAs(USER, TENANT);
    await db.query("savepoint coach_broadcast_read");
    await expect(db.query("select * from public.mark_notification_read($1)", [broadcastNotificationId]))
      .rejects.toThrow(/NOTIFICATION_NOT_FOUND_OR_FORBIDDEN/);
    await db.query("rollback to savepoint coach_broadcast_read");

    await actAsAffiliate(AFFILIATE);
    await db.query("savepoint affiliate_broadcast_read");
    await expect(db.query("select * from public.mark_notification_read($1)", [broadcastNotificationId]))
      .rejects.toThrow(/NOTIFICATION_NOT_FOUND_OR_FORBIDDEN/);
    await db.query("rollback to savepoint affiliate_broadcast_read");

    await db.query("reset role");
    expect((await db.query("select read_at from public.notifications where id = $1", [broadcastNotificationId]))
      .rows[0].read_at).toBeNull();
  });

  it("leaves mark-all on the actor's own rows, never the shared queue item", async () => {
    await actAsPlatform(OPERATOR, "success");
    expect((await db.query<{ marked_count: number }>("select * from public.mark_all_notifications_read()"))
      .rows[0].marked_count).toBe(0);
    await db.query("reset role");
    expect((await db.query("select read_at from public.notifications where id = $1", [broadcastNotificationId]))
      .rows[0].read_at).toBeNull();
  });
});
