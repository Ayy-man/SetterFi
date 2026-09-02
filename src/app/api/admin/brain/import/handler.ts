/**
 * Platform Brain import boundary.
 *
 * The request selects the configured source and nothing else. Provider identity, paths, content,
 * actor identity, and the shared limiter all remain server-owned before any provider can run.
 */

import { environmentValue, phase2Live } from "@/lib/env-contract";
import { runBrainImport, type BrainImportResult } from "@/lib/brain/import/pipeline";
import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import { resolveNotionDriver } from "@/lib/integrations/notion/selector";
import { createBrainImportRepository } from "@/lib/repositories/brain-import";
import { sharedCallerKey, sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";

export const runtime = "nodejs";
export const maxDuration = 300;

export const PHASE2_NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const IMPORT_LIMIT = { limit: 3, windowMs: 60 * 60_000 };

export function isRouteRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function isBrainAdmin(actor: PlatformActor | null): actor is PlatformActor {
  return actor?.role === "owner" || actor?.role === "admin";
}

export function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type ImportDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  consume(request: Request): Promise<{ allowed: boolean; retryAfter: number }>;
  run(actorId: string): Promise<BrainImportResult>;
};

export function createBrainImportHandler(dependencies: ImportDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const body: unknown = await request.json();
      if (!isRouteRecord(body) || !hasExactKeys(body, ["source"]) || body.source !== "configured") {
        throw new Error("BRAIN_IMPORT_BODY_INVALID");
      }
      const limit = await dependencies.consume(request);
      if (!limit.allowed) {
        return Response.json(
          { error: "Brain import is temporarily rate limited.", code: "BRAIN_IMPORT_RATE_LIMITED" },
          {
            status: 429,
            headers: { ...PHASE2_NO_STORE_HEADERS, "Retry-After": String(limit.retryAfter) },
          },
        );
      }
      const result = await dependencies.run(actor.userId);
      return Response.json(result, {
        status: result.status === "complete" ? 200 : 502,
        headers: PHASE2_NO_STORE_HEADERS,
      });
    } catch {
      return Response.json(
        { error: "Brain import was refused.", code: "BRAIN_IMPORT_REQUEST_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

async function runConfiguredImport(actorId: string) {
  const source = resolveNotionDriver();
  const embeddings = resolveEmbeddingsDriver();
  const collectionRef = source.source === "notion"
    ? environmentValue("NOTION_KB_ROOT_ID") ?? ""
    : `configured:${source.source}`;
  if (!collectionRef) throw new Error("NOTION_KB_ROOT_ID_REQUIRED");
  return runBrainImport(
    { collectionRef, actorId },
    { source, embeddings, repository: createBrainImportRepository() },
  );
}

export const POST = createBrainImportHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  consume: async (request) => {
    const client = createSupabaseServiceClient();
    return sharedRateLimit(
      sharedCallerKey(request, { tenantId: "platform", route: "brain-import" }),
      IMPORT_LIMIT,
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
  run: runConfiguredImport,
});
