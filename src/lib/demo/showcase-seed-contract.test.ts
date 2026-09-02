import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const seed = readFileSync(resolve(root, "scripts/seed-demo-complete.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const SHOWCASE_NAMESPACE = "8f000000-0000-4000-8000-";

/**
 * The seeders are `.mjs` and `tsc --noEmit` will not resolve such a specifier from a `.ts` file,
 * so both modules are imported through a variable specifier. That keeps the type checker out of
 * the way while the assertions still run against the real fixture objects rather than a copy.
 */
type Message = {
  direction: "in" | "out" | "system";
  author: string;
  body: string;
  providerMessageId: string | null;
  offsetMinutes: number;
  id: string;
  createdAt: string;
};
type Thread = {
  conversationId: string;
  contactId: string;
  channel: string;
  messages: Message[];
  lastMessageAt: string;
  currentStep: string | null;
  currentStepAsks: number;
  unreadByCoach: boolean;
};
type Appointment = { id: string; conversationId: string; contactId: string; status: string };

let threads: Thread[];
let appointments: Appointment[];
let contacts: Record<string, unknown>[];
let knownConversationIds: Set<string>;

beforeAll(async () => {
  const specifier = pathToFileURL(resolve(root, "scripts/seed-demo-complete.mjs")).href;
  const showcase = await import(/* @vite-ignore */ specifier);
  const phase1Specifier = pathToFileURL(resolve(root, "scripts/seed-phase1-demo.mjs")).href;
  const phase1 = await import(/* @vite-ignore */ phase1Specifier);
  threads = showcase.SHOWCASE_THREADS as Thread[];
  appointments = showcase.SHOWCASE_APPOINTMENTS as Appointment[];
  contacts = showcase.SHOWCASE_CONTACTS as Record<string, unknown>[];
  knownConversationIds = new Set<string>([
    ...(phase1.DEMO_PHASE3_IDS.conversations as string[]),
    ...(phase1.DEMO_PHASE4_IDS.conversations as string[]),
  ]);
});

describe("Showcase demo seed contract", () => {
  it("attaches every thread to a conversation the earlier seeders already created", () => {
    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) {
      expect(knownConversationIds.has(thread.conversationId)).toBe(true);
    }
    expect(new Set(threads.map((thread) => thread.conversationId)).size).toBe(threads.length);
  });

  it("orders every thread forward in time and ends it on its own last message", () => {
    for (const thread of threads) {
      const times = thread.messages.map((message) => Date.parse(message.createdAt));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]).toBeGreaterThan(times[index - 1]);
      }
      // The Inbox orders by `conversations.last_message_at`, so it has to be the thread's own
      // final message rather than a value that floats free of the messages the coach reads.
      for (const time of times) expect(time).toBeLessThanOrEqual(Date.parse(thread.lastMessageAt));
      expect(times.at(-1)).toBe(Date.parse(thread.lastMessageAt));
    }
  });

  it("carries a readable two-sided thread on at least eight of the eleven conversations", () => {
    expect(threads.length).toBeGreaterThanOrEqual(8);
    for (const thread of threads) {
      expect(thread.messages.length).toBeGreaterThanOrEqual(4);
      const directions = new Set(thread.messages.map((message) => message.direction));
      expect(directions.has("in")).toBe(true);
      expect(directions.has("out")).toBe(true);
      expect(thread.currentStepAsks).toBeGreaterThanOrEqual(0);
      expect(thread.currentStepAsks).toBeLessThanOrEqual(3);
    }
  });

  it("invents no reachable phone number and no deliverable email address", () => {
    const serialized = JSON.stringify({ threads, appointments, contacts });
    for (const candidate of serialized.match(/\+\d[\d\s().-]{6,}\d/g) ?? []) {
      expect(candidate.replace(/[\s().-]/g, "")).toMatch(/^\+1555\d{7}$/);
    }
    for (const candidate of serialized.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      expect(candidate.endsWith("example.invalid")).toBe(true);
    }
  });

  it("keeps every row it creates inside the unclaimed 8f000000 namespace", () => {
    for (const thread of threads) {
      for (const message of thread.messages) expect(message.id.startsWith(SHOWCASE_NAMESPACE)).toBe(true);
    }
    for (const appointment of appointments) {
      expect(appointment.id.startsWith(SHOWCASE_NAMESPACE)).toBe(true);
      expect(knownConversationIds.has(appointment.conversationId)).toBe(true);
    }
    const ids = [
      ...threads.flatMap((thread) => thread.messages.map((message) => message.id)),
      ...appointments.map((appointment) => appointment.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never writes the tables that a gate script counts", () => {
    for (const table of ["billable_events", "notifications", "provisioning_steps"]) {
      expect(seed).not.toMatch(
        new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.\\s*(insert|upsert|update|delete)`),
      );
    }
    // The Phase 5 contract requires the tenant-targeted audit set to be empty after its reset,
    // so this seeder writes no audit row at all rather than one aimed at a safe target.
    expect(seed).not.toMatch(/from\(\s*["'`]audit_log["'`]\s*\)\s*\.\s*(insert|upsert)/);
  });

  it("registers the seventh seeder as an npm script", () => {
    expect(packageJson.scripts["demo:seed-complete"]).toBe("node scripts/seed-demo-complete.mjs");
  });
});
