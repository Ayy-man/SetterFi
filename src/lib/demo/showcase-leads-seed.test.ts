/**
 * The showcase lead book, asserted on the objects rather than on a database.
 *
 * `buildShowcaseDataset` is pure so the shape can be checked without a stack, and the shape is
 * what the RPC reads: the counts these tests pin are the same ones that decide whether coach Home
 * prints a figure or an absence. Three of them restate a database CHECK constraint on purpose --
 * a violation there aborts the whole seeding transaction, and finding that out from a red test is
 * cheaper than finding it out from a rolled-back run.
 *
 * The seeder is `.mjs` and `tsc --noEmit` will not resolve such a specifier from a `.ts` file, so
 * it is imported through a variable specifier, the same way `showcase-seed-contract.test.ts` does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const NOW = Date.parse("2026-09-02T14:00:00.000Z");
const DAY = 86_400_000;
const SHOWCASE_LEADS_NAMESPACE = "8d000000-";

type Contact = {
  id: string; name: string; stage: string; createdAt: string; outcome: string | null;
};
type Conversation = {
  id: string; contactId: string; status: string; statusReason: string | null;
  needsHumanAt: string | null; keyword: string | null; createdAt: string;
};
type Message = { id: string; conversationId: string; direction: string; author: string; body: string; createdAt: string };
type Appointment = {
  id: string; contactId: string; status: string; createdAt: string; startAt: string; endAt: string;
  canceledAt: string | null; cancelSource: string | null; attendanceSource: string | null;
};
type StepEvent = {
  id: string; conversationId: string; stepKey: string; eventKind: string; occurredAt: string;
};
type Dataset = {
  contacts: Contact[]; conversations: Conversation[]; messages: Message[];
  appointments: Appointment[]; stepEvents: StepEvent[];
};

type Builder = (slot: number, nowMs: number) => Dataset;
type Projector = (dataset: Dataset, nowMs: number, days: number) => {
  leads: number; active: number; booked: number; notAFit: number; terminal: number;
};

let buildShowcaseDataset: Builder;
let projectShowcaseWindow: Projector;
let showcaseLeadId: (slot: number, kind: number, sequence: number) => string;
let isShowcaseLeadId: (id: string) => boolean;
let tenantIds: string[];
let dataset: Dataset;

beforeAll(async () => {
  const seed = await import(/* @vite-ignore */
    pathToFileURL(resolve(root, "scripts/seed-showcase-leads.mjs")).href);
  const namespace = await import(/* @vite-ignore */
    pathToFileURL(resolve(root, "scripts/fixtures/showcase-leads-namespace.mjs")).href);
  buildShowcaseDataset = seed.buildShowcaseDataset as Builder;
  projectShowcaseWindow = seed.projectShowcaseWindow as Projector;
  showcaseLeadId = seed.showcaseLeadId as typeof showcaseLeadId;
  isShowcaseLeadId = namespace.isShowcaseLeadId as typeof isShowcaseLeadId;
  tenantIds = (seed.SHOWCASE_TENANTS as { tenantId: string }[]).map((tenant) => tenant.tenantId);
  expect(namespace.SHOWCASE_LEADS_NAMESPACE).toBe(SHOWCASE_LEADS_NAMESPACE);
  dataset = buildShowcaseDataset(1, NOW);
});

describe("showcase lead book", () => {
  it("writes two hundred contacts with more than sixty inside the trailing month", () => {
    expect(dataset.contacts).toHaveLength(200);
    const recent = dataset.contacts.filter(
      (contact) => Date.parse(contact.createdAt) >= NOW - 30 * DAY,
    );
    expect(recent.length).toBeGreaterThanOrEqual(60);
  });

  it("spreads the book over six months so the trend panel has two full calendar months", () => {
    const ages = dataset.contacts.map((contact) => (NOW - Date.parse(contact.createdAt)) / DAY);
    expect(Math.min(...ages)).toBeLessThan(3);
    expect(Math.max(...ages)).toBeGreaterThan(170);
  });

  it("fills every pipeline stage, which is what the board and the composition chart read", () => {
    const stages = new Set(dataset.contacts.map((contact) => contact.stage));
    expect([...stages].sort()).toEqual([
      "booked", "disqualified", "long_term_followup", "new_lead", "no_show", "qualified_no_buy",
      "qualifying",
    ]);
  });

  /*
   * The six cards the task exists for. Each is computed here the way the RPC computes it, so a
   * plan edit that empties one -- say by moving every disqualified contact outside the month --
   * fails here rather than on the screen.
   */
  it("gives every home card a positive reading in the one-month window", () => {
    const month = projectShowcaseWindow(dataset, NOW, 30);
    expect(month.leads).toBeGreaterThan(50);
    expect(month.active).toBeGreaterThan(0);
    expect(month.booked).toBeGreaterThan(0);
    expect(month.notAFit).toBeGreaterThan(0);
    // Conversion and pipeline win rate both need a positive denominator, and terminal is the
    // second one's.
    expect(month.terminal).toBeGreaterThan(0);
  });

  it("keeps the week and quarter windows populated too", () => {
    expect(projectShowcaseWindow(dataset, NOW, 7).leads).toBeGreaterThan(0);
    expect(projectShowcaseWindow(dataset, NOW, 90).booked).toBeGreaterThan(0);
  });

  it("books every appointment after its lead arrived, so average time to book is positive", () => {
    const created = new Map(dataset.contacts.map((contact) => [contact.id, Date.parse(contact.createdAt)]));
    for (const appointment of dataset.appointments) {
      expect(Date.parse(appointment.createdAt)).toBeGreaterThan(created.get(appointment.contactId)!);
      expect(Date.parse(appointment.startAt)).toBeGreaterThan(Date.parse(appointment.createdAt));
      expect(Date.parse(appointment.endAt)).toBeGreaterThan(Date.parse(appointment.startAt));
    }
  });

  it("never claims an appointment completed or missed before it has happened", () => {
    for (const appointment of dataset.appointments) {
      if (appointment.status === "completed" || appointment.status === "no_show") {
        expect(Date.parse(appointment.startAt)).toBeLessThan(NOW);
      }
    }
  });

  it("gives show rate both of the statuses its denominator is built from", () => {
    const past = dataset.appointments.filter(
      (appointment) => Date.parse(appointment.endAt) < NOW && appointment.status !== "canceled",
    );
    expect(past.filter((appointment) => appointment.status === "completed").length).toBeGreaterThan(0);
    expect(past.filter((appointment) => appointment.status === "no_show").length).toBeGreaterThan(0);
  });

  /** `appointments_cancel_shape_chk`: canceled iff canceled_at and cancel_source are both set. */
  it("matches the appointment cancel-shape check constraint", () => {
    for (const appointment of dataset.appointments) {
      const canceled = appointment.status === "canceled";
      expect(canceled).toBe(appointment.canceledAt !== null && appointment.cancelSource !== null);
    }
  });

  /** `conversations_status_reason_chk`: status = 'agent' iff status_reason is null. */
  it("matches the conversation status-reason check constraint", () => {
    for (const conversation of dataset.conversations) {
      expect(conversation.status === "agent").toBe(conversation.statusReason === null);
    }
  });

  it("leaves a needs-you queue: escalated threads and leads to call back", () => {
    const escalated = dataset.conversations.filter(
      (conversation) => conversation.status === "needs_human" && conversation.needsHumanAt !== null,
    );
    expect(escalated.length).toBeGreaterThan(0);
    const callback = dataset.contacts.filter(
      (contact) => contact.stage === "no_show" || contact.stage === "long_term_followup",
    );
    expect(callback.length).toBeGreaterThan(10);
  });

  /*
   * `analytics_conversation_step_events` only surfaces an `answered` row when an `asked` row on
   * the same conversation precedes it by under seven days. An answered row without one is not a
   * wrong number on the screen, it is a row that silently never counts.
   */
  it("pairs every answered step event to an earlier ask on the same conversation", () => {
    const asked = dataset.stepEvents.filter((event) => event.eventKind === "asked");
    for (const answer of dataset.stepEvents.filter((event) => event.eventKind === "answered")) {
      const match = asked.find(
        (ask) => ask.conversationId === answer.conversationId
          && Date.parse(ask.occurredAt) < Date.parse(answer.occurredAt)
          && Date.parse(answer.occurredAt) - Date.parse(ask.occurredAt) < 7 * DAY,
      );
      expect(match).toBeDefined();
    }
    expect(asked.length).toBeGreaterThan(0);
  });

  it("spreads at least five keywords with visibly different booking rates, plus untagged leads", () => {
    const bookedContacts = new Set(dataset.appointments
      .filter((appointment) => appointment.status !== "canceled")
      .map((appointment) => appointment.contactId));
    const rates = new Map<string, { total: number; booked: number }>();
    for (const conversation of dataset.conversations) {
      if (conversation.keyword === null) continue;
      const row = rates.get(conversation.keyword) ?? { total: 0, booked: 0 };
      row.total += 1;
      if (bookedContacts.has(conversation.contactId)) row.booked += 1;
      rates.set(conversation.keyword, row);
    }
    expect(rates.size).toBeGreaterThanOrEqual(5);
    expect(dataset.conversations.some((conversation) => conversation.keyword === null)).toBe(true);
    const percents = [...rates.values()].map((row) => (row.booked * 100) / row.total);
    expect(Math.max(...percents) - Math.min(...percents)).toBeGreaterThan(20);
  });

  /*
   * The grounding rule, as a string check. The agent may name the review session; it may not quote
   * a fee, an approval amount or a guarantee, because neither demo tenant's Brain is consulted
   * when this fixture is written and a number invented here reads on screen as a product claim.
   */
  it("never lets an agent turn quote money or promise an outcome", () => {
    const agentTurns = dataset.messages.filter((message) => message.author === "agent");
    expect(agentTurns.length).toBeGreaterThan(0);
    for (const turn of agentTurns) {
      expect(turn.body).not.toMatch(/\$|\bguarantee|\bapproved\b|\bpercent\b|\d\s*%/i);
    }
  });

  it("names every lead plausibly and never after a system state", () => {
    const names = dataset.contacts.map((contact) => contact.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(name).not.toMatch(/^(demo|test|synthetic|setterfi)\b/i);
    }
  });

  it("keeps every id inside the namespace, unique, and disjoint between the two tenants", () => {
    const ids = [
      ...dataset.contacts, ...dataset.conversations, ...dataset.messages,
      ...dataset.appointments, ...dataset.stepEvents,
    ].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith(SHOWCASE_LEADS_NAMESPACE)).toBe(true);
      expect(isShowcaseLeadId(id)).toBe(true);
    }
    const other = buildShowcaseDataset(2, NOW) as Dataset;
    const otherIds = new Set(other.contacts.map((contact) => contact.id));
    expect(dataset.contacts.some((contact) => otherIds.has(contact.id))).toBe(false);
  });

  it("targets exactly the two demo tenants, and nothing else", () => {
    expect(tenantIds).toEqual([
      "81000000-0000-4000-8000-000000000001",
      "87000000-0000-4000-8000-000000000001",
    ]);
    expect(showcaseLeadId(1, 1, 7)).toBe("8d000000-1100-4000-8000-000000000007");
  });

  /*
   * The seeder is only reachable if it is wired, and it is only correct if it runs after
   * `demo:seed-complete` -- `demo:reset` deletes the Phase 1 fixture and `demo:seed` re-upserts
   * it, so an earlier position would leave the book behind a reset that never cleans it.
   */
  it("is wired as demo:seed-showcase", () => {
    expect(packageJson.scripts["demo:seed-showcase"]).toBe("node scripts/seed-showcase-leads.mjs");
  });

  it("re-runs to the same rows for the same clock", () => {
    expect(buildShowcaseDataset(1, NOW)).toEqual(dataset);
  });
});
