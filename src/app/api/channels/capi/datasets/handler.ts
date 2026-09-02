import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { CapiDatasetError, provisionCapiDataset } from "@/lib/capi/datasets";
import { phase4Live } from "@/lib/env-contract";
import type { CapiDatasetChannel } from "@/lib/repositories/capi-datasets";

const noStoreHeaders = { "Cache-Control": "no-store" };
const channels = ["messenger", "instagram", "whatsapp"] as const;

export type CapiDatasetRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  provision(input: {
    tenantId: string;
    actorId: string;
    channel: CapiDatasetChannel;
  }): ReturnType<typeof provisionCapiDataset>;
};

function exactChannelBody(value: unknown): value is { channel: CapiDatasetChannel } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 &&
    channels.includes(body.channel as CapiDatasetChannel);
}

export function createCapiDatasetHandler(dependencies: CapiDatasetRouteDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (actor.role !== "coach" || hasImpersonationMarker(actor)) {
      return Response.json(
        { error: "Conversion tracking setup is unavailable in this session." },
        { status: 403, headers: noStoreHeaders },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    if (!exactChannelBody(body)) {
      return Response.json(
        { error: "Choose one supported messaging channel.", code: "CAPI_DATASET_BODY_INVALID" },
        { status: 400, headers: noStoreHeaders },
      );
    }
    try {
      const result = await dependencies.provision({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        channel: body.channel,
      });
      return Response.json({
        dataset: {
          channel: result.dataset.channel,
          status: result.dataset.status,
          isMock: result.dataset.isMock,
          provisionedAt: result.dataset.provisionedAt,
        },
        audit: result.audit,
      }, { headers: noStoreHeaders });
    } catch (error) {
      const code = error instanceof CapiDatasetError ? error.code : "CAPI_DATASET_SETUP_FAILED";
      return Response.json({
        error: "Conversion tracking is not set up.",
        code,
      }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createCapiDatasetHandler({
  enabled: phase4Live,
  session: loadRouteActor,
  provision: ({ tenantId, actorId, channel }) =>
    provisionCapiDataset(tenantId, { actorId, channel }),
});
