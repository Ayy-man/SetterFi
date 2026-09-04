/**
 * Authenticated Meet Your Agent session and turn boundary.
 *
 * Client bodies carry only a server-issued session id and a new message. Tenant, actor, history,
 * test state, content versions, driver selection, and every persisted identifier stay server-owned.
 */

import { hasImpersonationMarker, parseAppClaims } from "@/lib/auth/claims";
import {
  DriverConfigurationError,
  phase7MeetAgentLive,
} from "@/lib/env-contract";
import {
  createTestAgentSession,
  resolveTestAgentTenant,
  runTestAgentTurn,
  type TestAgentActor,
  type TestAgentTurnReceipt,
} from "@/lib/repositories/test-agent";
import { sharedCallerKey, sharedRateLimit } from "@/lib/shared-rate-limit";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const LIMIT = { limit: 30, windowMs: 60_000 };
const TURN_KEYS = ["message", "sessionId"] as const;

type LiveAgentDependencies = {
  enabled(): boolean;
  session(): Promise<TestAgentActor | null>;
  resolveTenant(actor: TestAgentActor): Promise<string>;
  createSession(input: { expectedTenant: string; actorId: string }): Promise<string>;
  consume(request: Request, tenantId: string): Promise<{ allowed: boolean; retryAfter: number }>;
  execute(input: {
    expectedTenant: string;
    actorId: string;
    sessionId: string;
    message: string;
  }): Promise<TestAgentTurnReceipt>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function configurationResponse(error: DriverConfigurationError) {
  return Response.json({
    error: "The selected agent driver is not configured.",
    code: error.code,
    requiredNames: error.variableNames,
  }, { status: 503, headers: NO_STORE_HEADERS });
}

export function createTestAgentSessionHandler(dependencies: LiveAgentDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE_HEADERS });
    }
    try {
      const expectedTenant = await dependencies.resolveTenant(actor);
      const sessionId = await dependencies.createSession({
        expectedTenant,
        actorId: actor.userId,
      });
      return Response.json({ sessionId }, { headers: NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { error: "A test-agent session could not be created.", code: "TEST_AGENT_SESSION_REFUSED" },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
  };
}

export function createLiveAgentHandler(dependencies: LiveAgentDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE_HEADERS });
    }
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !exactKeys(body, TURN_KEYS)) {
        throw new Error("TEST_AGENT_BODY_INVALID");
      }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!message || message.length > 800 || !sessionId) {
        throw new Error("TEST_AGENT_BODY_INVALID");
      }
      const expectedTenant = await dependencies.resolveTenant(actor);
      const limit = await dependencies.consume(request, expectedTenant);
      if (!limit.allowed) {
        return Response.json(
          { error: "The test agent is temporarily rate limited." },
          {
            status: 429,
            headers: { ...NO_STORE_HEADERS, "Retry-After": String(limit.retryAfter) },
          },
        );
      }
      return Response.json(await dependencies.execute({
        expectedTenant,
        actorId: actor.userId,
        sessionId,
        message,
      }), { headers: NO_STORE_HEADERS });
    } catch (error) {
      if (error instanceof DriverConfigurationError) return configurationResponse(error);
      // The coach sees one sentence; the cause goes to the server log, because a refusal with no
      // recorded reason is undiagnosable from the outside.
      console.error("[test-agent] turn refused", error instanceof Error ? error.message : error);
      return Response.json(
        { error: "The test agent refused that turn.", code: "TEST_AGENT_TURN_REFUSED" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
  };
}

export async function loadTestAgentActor(): Promise<TestAgentActor | null> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = parseAppClaims(data.claims);
  if (!claims.userId || !claims.role || hasImpersonationMarker(claims) ||
    !["owner", "admin", "success", "coach", "coach_member"].includes(claims.role)) {
    return null;
  }
  return {
    userId: claims.userId,
    role: claims.role as TestAgentActor["role"],
    tenantId: claims.tenantId,
  };
}

const dependencies: LiveAgentDependencies = {
  enabled: phase7MeetAgentLive,
  session: loadTestAgentActor,
  resolveTenant: resolveTestAgentTenant,
  createSession: createTestAgentSession,
  consume: async (request, tenantId) => {
    const client = createSupabaseServiceClient();
    return sharedRateLimit(
      sharedCallerKey(request, { tenantId, route: "test-agent" }),
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
  execute: runTestAgentTurn,
};

export const GET = createTestAgentSessionHandler(dependencies);
export const POST = createLiveAgentHandler(dependencies);
