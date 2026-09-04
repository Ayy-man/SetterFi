import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const ENTITY_TYPES = ["sole_proprietor", "llc", "corporation", "partnership", "other"] as const;
const BUSINESS_PROFILE_SELECT = [
  "id",
  "legal_name",
  "entity_type",
  "has_ein",
  "website_url",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country_code",
  "updated_at",
].join(",");

type BusinessProfile = {
  id: string;
  legalName: string;
  entityType: typeof ENTITY_TYPES[number];
  hasEin: boolean;
  websiteUrl: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  updatedAt: string;
};

type SaveInput = Omit<BusinessProfile, "id" | "updatedAt">;
type SaveReceipt = { profile: BusinessProfile; audit: { id: string; actionKey: "onboarding.business_profile.saved" } };

export type BusinessProfileDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<BusinessProfile | null>;
  save(input: SaveInput & { tenantId: string; actorId: string }): Promise<SaveReceipt>;
};

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

const REQUIRED = ["legalName", "websiteUrl", "addressLine1", "city", "region", "postalCode", "countryCode"] as const;
/** The read-only keys a loaded profile carries; a form that edits what it loaded sends them back. */
const READ_ONLY = ["id", "updatedAt"];

/**
 * Either the input, or the field names that stopped it. The names are the client's own keys so a
 * form can put the refusal on the field rather than under the panel.
 */
function parseBody(value: unknown): { input: SaveInput } | { fields: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { fields: ["body"] };
  const body = value as Record<string, unknown>;
  const allowed: readonly string[] = [
    ...REQUIRED, "entityType", "hasEin", "addressLine2", ...READ_ONLY,
  ];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return { fields: unknown };
  const fields: string[] = [];
  const entityType = string(body.entityType)?.toLowerCase();
  if (!entityType || !ENTITY_TYPES.includes(entityType as typeof ENTITY_TYPES[number])) fields.push("entityType");
  if (typeof body.hasEin !== "boolean") fields.push("hasEin");
  const required = REQUIRED.map((key) => string(body[key]));
  REQUIRED.forEach((key, index) => { if (!required[index]) fields.push(key); });
  if (required[1] && !/^https?:\/\/\S+\.\S+$/u.test(required[1])) fields.push("websiteUrl");
  if (required[6] && !/^[A-Za-z]{2}$/u.test(required[6])) fields.push("countryCode");
  const addressLine2 = body.addressLine2 === null || body.addressLine2 === undefined ? null : string(body.addressLine2);
  if (body.addressLine2 !== null && body.addressLine2 !== undefined && addressLine2 === null) fields.push("addressLine2");
  const order: readonly string[] = [
    "legalName", "entityType", "hasEin", "websiteUrl", "addressLine1", "addressLine2",
    "city", "region", "postalCode", "countryCode",
  ];
  if (fields.length > 0) return { fields: order.filter((key) => fields.includes(key)) };
  return { input: {
    legalName: required[0]!,
    entityType: entityType as typeof ENTITY_TYPES[number],
    hasEin: body.hasEin as boolean,
    websiteUrl: required[1]!,
    addressLine1: required[2]!,
    addressLine2: addressLine2 || null,
    city: required[3]!,
    region: required[4]!,
    postalCode: required[5]!,
    countryCode: required[6]!.toUpperCase(),
  } };
}

function refuse(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) {
    return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  }
  if (actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createBusinessProfileHandlers(dependencies: BusinessProfileDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      try {
        return Response.json({ profile: await dependencies.load(actor.tenantId) }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/onboarding/business-profile failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Business profile is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      const parsed = parseBody(await request.json().catch(() => null));
      if ("fields" in parsed) {
        return Response.json({ error: "Invalid business profile.", fields: parsed.fields }, { status: 400, headers: NO_STORE });
      }
      try {
        return Response.json(await dependencies.save({ ...parsed.input, tenantId: actor.tenantId, actorId: actor.userId }), {
          headers: NO_STORE,
        });
      } catch {
        return Response.json({ error: "Business profile was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

function mapProfile(row: Record<string, unknown>): BusinessProfile {
  return {
    id: String(row.id), legalName: String(row.legal_name), entityType: row.entity_type as BusinessProfile["entityType"],
    hasEin: Boolean(row.has_ein), websiteUrl: String(row.website_url), addressLine1: String(row.address_line1),
    addressLine2: typeof row.address_line2 === "string" ? row.address_line2 : null, city: String(row.city),
    region: String(row.region), postalCode: String(row.postal_code), countryCode: String(row.country_code),
    updatedAt: String(row.updated_at),
  };
}

const handlers = createBusinessProfileHandlers({
  enabled: phase5Live,
  session: loadRouteActor,
  load: async (tenantId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("business_profiles").select(BUSINESS_PROFILE_SELECT).eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new Error("BUSINESS_PROFILE_READ_FAILED");
    return data ? mapProfile(data as unknown as Record<string, unknown>) : null;
  },
  save: async (input) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.rpc("save_onboarding_business_profile", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId, p_legal_name: input.legalName,
      p_entity_type: input.entityType, p_has_ein: input.hasEin, p_website_url: input.websiteUrl,
      p_address_line1: input.addressLine1, p_address_line2: input.addressLine2, p_city: input.city,
      p_region: input.region, p_postal_code: input.postalCode, p_country_code: input.countryCode,
    });
    const result = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    if (error || !result || typeof result.profile_id !== "string" || !result.audit_id) {
      throw new Error("BUSINESS_PROFILE_WRITE_FAILED");
    }
    const { data: row, error: readError } = await client.from("business_profiles").select(BUSINESS_PROFILE_SELECT)
      .eq("tenant_id", input.tenantId).eq("id", result.profile_id).single();
    if (readError || !row) throw new Error("BUSINESS_PROFILE_READBACK_FAILED");
    return { profile: mapProfile(row as unknown as Record<string, unknown>), audit: {
      id: String(result.audit_id), actionKey: "onboarding.business_profile.saved",
    } };
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
