/**
 * Admin test turn against a chosen coach and Brain revision.
 *
 * Unlike `/api/agent`, which takes the tenant from the session, this route lets an owner or admin
 * name the coach whose published offer the turn should run against and whether the live snapshot
 * or the current draft supplies the Brain. Nothing is sent and no conversation row is written; the
 * engine's decisions come back as evidence. Rate limited per coach the way `/api/agent` is.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { DriverConfigurationError, phase2Live } from "@/lib/env-contract";
import { BRAIN_REVISIONS, type BrainRevision } from "@/lib/repositories/brain-revision-runtime";
import { BrainRuntimeReadinessError } from "@/lib/repositories/brain-runtime";
import {
  runBrainTestTurn,
  TEST_TURN_CHANNELS,
  TEST_TURN_HISTORY_MAX,
  TEST_TURN_MESSAGE_MAX,
  type BrainTestTurnInput,
  type BrainTestTurnResult,
  type TestTurnChannel,
  type TestTurnHistoryEntry,
} from "@/lib/repositories/brain-test-turn";
import { sharedCallerKey, sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  hasExactKeys,
  isBrainAdmin,
  isRouteRecord,
  nonBlank,
  PHASE2_NO_STORE_HEADERS,
} from "../import/handler";

export const runtime = "nodejs";
export const maxDuration = 60;

const LIMIT = { limit: 30, windowMs: 60_000 };
const BODY_KEYS = ["coachTenantId", "revision", "channel", "message", "history"] as const;
const HISTORY_CONTENT_MAX = 2_000;

/** Readiness failures the owner can act on; anything else is logged and refused generically. */
export const TEST_TURN_NOT_READY_CODES = new Set([
  "APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED",
  "PLATFORM_AGENT_CONTENT_UNAPPROVED_NON_DEMO",
  "TENANT_CONTENT_SCOPE_REQUIRED",
  "BRAIN_DRAFT_NOT_FOUND",
  "BRAIN_RETRIEVAL_NO_RENDERABLE_CANDIDATES",
  "SETTERFI_TAG_SECRET_REQUIRED",
  "MODEL_CONFIG_READ_FAILED",
]);

type TestTurnDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  consume(request: Request, tenantId: string): Promise<{ allowed: boolean; retryAfter: number }>;
  run(input: BrainTestTurnInput): Promise<BrainTestTurnResult>;
};

function historyEntry(value: unknown): TestTurnHistoryEntry | null {
  if (!isRouteRecord(value) || !hasExactKeys(value, ["role", "content"])) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (!nonBlank(value.content) || value.content.length > HISTORY_CONTENT_MAX) return null;
  return { role: value.role, content: value.content };
}

export function parseTestTurnBody(raw: unknown): BrainTestTurnInput | null {
  if (!isRouteRecord(raw) || !hasExactKeys(raw, BODY_KEYS)) return null;
  if (!nonBlank(raw.coachTenantId)) return null;
  if (!(BRAIN_REVISIONS as readonly unknown[]).includes(raw.revision)) return null;
  if (!(TEST_TURN_CHANNELS as readonly unknown[]).includes(raw.channel)) return null;
  if (!nonBlank(raw.message) || raw.message.trim().length > TEST_TURN_MESSAGE_MAX) return null;
  if (!Array.isArray(raw.history) || raw.history.length > TEST_TURN_HISTORY_MAX) return null;
  const history: TestTurnHistoryEntry[] = [];
  for (const entry of raw.history) {
    const parsed = historyEntry(entry);
    if (!parsed) return null;
    history.push(parsed);
  }
  return {
    coachTenantId: raw.coachTenantId.trim(),
    revision: raw.revision as BrainRevision,
    channel: raw.channel as TestTurnChannel,
    message: raw.message.trim(),
    history,
  };
}

export function notReadyCode(error: unknown) {
  if (error instanceof BrainRuntimeReadinessError) return error.code;
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
  return TEST_TURN_NOT_READY_CODES.has(code) ? code : null;
}

export function createBrainTestTurnHandler(dependencies: TestTurnDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    let input: BrainTestTurnInput | null;
    try {
      input = parseTestTurnBody(await request.json());
    } catch {
      input = null;
    }
    if (!input) {
      return Response.json(
        { state: "refused", code: "BRAIN_TEST_TURN_BODY_INVALID" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
    const limit = await dependencies.consume(request, input.coachTenantId);
    if (!limit.allowed) {
      return Response.json(
        { state: "refused", code: "BRAIN_TEST_TURN_RATE_LIMITED", error: "The test turn is temporarily rate limited." },
        { status: 429, headers: { ...PHASE2_NO_STORE_HEADERS, "Retry-After": String(limit.retryAfter) } },
      );
    }
    try {
      const result = await dependencies.run(input);
      return Response.json({ state: "completed", ...result }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      if (error instanceof DriverConfigurationError) {
        return Response.json({
          state: "not_ready",
          code: error.code,
          error: "The selected agent driver is not configured.",
          requiredNames: error.variableNames,
        }, { status: 503, headers: PHASE2_NO_STORE_HEADERS });
      }
      const code = notReadyCode(error);
      if (code) {
        return Response.json({ state: "not_ready", code }, { status: 409, headers: PHASE2_NO_STORE_HEADERS });
      }
      // The owner sees one sentence; the cause goes to the server log, because a refusal with no
      // recorded reason is undiagnosable from the outside.
      console.error("[brain-test-turn] turn refused", error instanceof Error ? error.message : error);
      return Response.json(
        { state: "refused", code: "BRAIN_TEST_TURN_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainTestTurnHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  consume: async (request, tenantId) => {
    const client = createSupabaseServiceClient();
    return sharedRateLimit(
      sharedCallerKey(request, { tenantId, route: "admin-brain-test-turn" }),
      LIMIT,
      {
        client: {
          rpc: async (name, args) => {
            const { data, error } = await client.rpc(name, args);
            return { data, error };
          },
        },
      },
    );
  },
  run: (input) => runBrainTestTurn(input),
});
