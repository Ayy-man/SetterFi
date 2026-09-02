/**
 * The agent roster: screen 3a, read from the offer layer rather than from an agents table.
 *
 * The artifact draws "Agents · 14 across 8 clients" — several named agents per client, each with
 * its own draft, its own publish button and its own seven tabs. SetterFi is not that product.
 * `offer_layers` is keyed `unique (tenant_id, version)`, one lineage of versions per coach, and
 * every coach's setter inherits the same central brain. So the roster is **one agent per client**,
 * and the count is the client count rather than a larger invented one.
 *
 * What survives the reframe is everything the drawing was actually about, because each piece turns
 * out to be a column:
 *
 * - **Live / Draft** is `offer_layers.status`, the `publish_status` enum's own word. A client whose
 *   newest row is `published` is live; one that has never published is a draft, and says so with
 *   the different sentence, because "draft" after a publish and "draft" before the first one are
 *   not the same state to an admin deciding what to chase.
 * - **"12 unpublished edits"** is a count of that tenant's draft rows standing above its published
 *   version. It is a real number, not a badge: a coach with four saved drafts has four.
 * - **"9 of 14 settings come from The Brain v18"** is the inheritance strip, and it is countable
 *   too. `COACH_OWNED_SETTINGS` names the offer-layer columns a coach may set; a null column is
 *   inherited from the brain and a non-null one overrides it for that agent only. The brain's
 *   version is the published snapshot's own version, never a literal.
 *
 * What does not survive, and is absent rather than approximated:
 *
 * - **"44% booked"** per agent. There is no per-agent booking rate anywhere in the schema; the
 *   platform records booked appointments per tenant over a measurement window, which is a
 *   different figure over a different denominator. Rendering it here as a per-agent rate would be
 *   the chart-that-lies the brief warns about, so the field is `null` and the surface says which
 *   figure it is showing instead.
 * - **"312 open threads"** stays, because it is a count: conversations that are neither closed nor
 *   opted out, excluding test rows, over `conversations_tenant_status_idx`.
 * - **The seven config tabs.** Offer, Tone, Qualifying and Booking are the coach's own surface and
 *   already exist at `/coach/agent`; Channels and Escalation are their own admin screens. This
 *   screen states each answer and links to where it is owned rather than growing a second editor
 *   that would then have to agree with the first.
 *
 * Test tenants are read and kept, never silently dropped: they carry `isTest` and the surface
 * labels them, which is the segregation rule rather than an exclusion.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * The offer-layer columns a coach owns.
 *
 * This list is the denominator in "N of M settings come from The Brain": a column left null is a
 * setting the agent takes from the brain, and a column with a value is one this coach has
 * overridden. Adding a coach-writable column to `offer_layers` means adding it here, or the strip
 * quietly starts overstating how much is inherited.
 */
export const COACH_OWNED_SETTINGS = [
  "program_name",
  "program_description",
  "credit_min",
  "monthly_revenue_min_cents",
  "funding_goal_min_cents",
  "funding_goal_max_cents",
  "business_revenue_required",
  "credit_repair",
  "products",
  "booking_horizon_days",
  "booking_mode",
  "brand_voice",
  "results_timeline_min_days",
  "results_timeline_max_days",
  "refund_posture",
  "voice_style_answer",
  "voice_objection_answer",
  "voice_followup_answer",
] as const;

export type CoachOwnedSetting = (typeof COACH_OWNED_SETTINGS)[number];

/** The conversation states that are not an open thread. */
const CLOSED_CONVERSATION_STATES = ["closed", "opted_out"] as const;

/**
 * What an agent's publish state is, in the words the screen uses.
 *
 * `never-published` is deliberately separate from `draft`: an agent that has never been published
 * has never spoken to a lead, and an admin scanning the list needs to tell that apart from one
 * that is live with edits pending.
 */
export type AgentPublishState = "live" | "draft" | "never-published";

export type AgentRosterEntry = {
  tenantId: string;
  clientName: string;
  /** Seeded tenants stay in the list and are labelled, never dropped. */
  isTest: boolean;
  state: AgentPublishState;
  /** The version currently answering leads, or null when nothing has been published. */
  liveVersion: number | null;
  publishedAt: string | null;
  /** Draft rows standing above the published version. A count, not a badge. */
  unpublishedEdits: number;
  /** When the newest draft was last touched, so "pending" can say how long it has been pending. */
  latestEditAt: string | null;
  /** Conversations neither closed nor opted out. Null when the count could not be read. */
  openThreads: number | null;
  /**
   * How many of `COACH_OWNED_SETTINGS` this agent overrides. The inherited count is the
   * complement, and the surface prints the complement because that is the reassuring direction.
   */
  overrides: number;
  /**
   * The client's own account state, straight from the `tenant_status` enum.
   *
   * This is not a second publish state and must not be read as one. A paused client's agent can
   * be perfectly published and still be answering nobody, which is why the canvas draws "paused by
   * the client" beside "draft, never published" rather than folding them together: they are two
   * different reasons an agent is not working and two different people to go and talk to.
   *
   * `readTenants` has always selected this column and `buildAgentRoster` always dropped it, so
   * carrying it is plumbing rather than a new read.
   */
  accountState: string;
};

export type AgentRoster = {
  /** The published brain snapshot every agent inherits, or null when none is published. */
  brainVersion: number | null;
  entries: readonly AgentRosterEntry[];
  /** `COACH_OWNED_SETTINGS.length`, carried so the surface never hardcodes the denominator. */
  settingCount: number;
  /** True when the open-thread count could not be read, so the surface says so once. */
  threadsUnavailable: boolean;
};

export class AgentRosterError extends Error {}

/* -------------------------------------------------------------------------------------------- */
/* Raw rows                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export type RawTenant = {
  id: string;
  name: string;
  status: string;
};

export type RawOfferLayer = {
  tenant_id: string;
  version: number;
  status: string;
  published_at: string | null;
  updated_at: string | null;
} & Partial<Record<CoachOwnedSetting, unknown>>;

export type RawOpenThread = {
  tenant_id: string;
};

export type AgentRosterSource = {
  readTenants(): Promise<readonly RawTenant[]>;
  readOfferLayers(tenantIds: readonly string[]): Promise<readonly RawOfferLayer[]>;
  readOpenThreads(tenantIds: readonly string[]): Promise<readonly RawOpenThread[] | null>;
  readBrainVersion(): Promise<number | null>;
};

/* -------------------------------------------------------------------------------------------- */
/* Derivation                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * A coach-owned column counts as overridden when it holds a value.
 *
 * An empty array is not an override: `products` defaults to `'{}'`, so treating it as one would
 * report every coach on the platform as having overridden a setting they never touched.
 */
export function overrideCount(row: RawOfferLayer): number {
  let count = 0;
  for (const key of COACH_OWNED_SETTINGS) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    count += 1;
  }
  return count;
}

/**
 * The agent's state and its pending-edit count, from that tenant's whole version lineage.
 *
 * The published row is the newest one the enum calls `published`; `superseded` rows are previous
 * publishes and are history rather than state. Anything drafted above the live version is a
 * pending edit, which is why this counts rather than testing a flag.
 */
export function agentStateFrom(rows: readonly RawOfferLayer[]): {
  state: AgentPublishState;
  liveVersion: number | null;
  publishedAt: string | null;
  unpublishedEdits: number;
  latestEditAt: string | null;
  settingsRow: RawOfferLayer | null;
} {
  if (rows.length === 0) {
    return {
      state: "never-published",
      liveVersion: null,
      publishedAt: null,
      unpublishedEdits: 0,
      latestEditAt: null,
      settingsRow: null,
    };
  }

  const ordered = [...rows].sort((left, right) => right.version - left.version);
  const published = ordered.find((row) => row.status === "published") ?? null;
  const drafts = ordered.filter(
    (row) => row.status === "draft" && row.version > (published?.version ?? 0),
  );

  const latestEditAt = drafts
    .map((row) => row.updated_at)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1) ?? null;

  return {
    state: published ? "live" : "never-published",
    liveVersion: published?.version ?? null,
    publishedAt: published?.published_at ?? null,
    unpublishedEdits: drafts.length,
    latestEditAt,
    // The settings the agent is actually answering with are the published ones; before a first
    // publish there is nothing live, so the newest draft is what the screen describes.
    settingsRow: published ?? ordered[0] ?? null,
  };
}

export function buildAgentRoster(input: {
  tenants: readonly RawTenant[];
  offerLayers: readonly RawOfferLayer[];
  openThreads: readonly RawOpenThread[] | null;
  brainVersion: number | null;
  testTenantIds?: ReadonlySet<string>;
}): AgentRoster {
  const testTenantIds = input.testTenantIds ?? new Set<string>();

  const layersByTenant = new Map<string, RawOfferLayer[]>();
  for (const row of input.offerLayers) {
    const bucket = layersByTenant.get(row.tenant_id);
    if (bucket) bucket.push(row);
    else layersByTenant.set(row.tenant_id, [row]);
  }

  const threadsByTenant = new Map<string, number>();
  for (const row of input.openThreads ?? []) {
    threadsByTenant.set(row.tenant_id, (threadsByTenant.get(row.tenant_id) ?? 0) + 1);
  }

  const entries = input.tenants.map((tenant) => {
    const rows = layersByTenant.get(tenant.id) ?? [];
    const derived = agentStateFrom(rows);
    // A tenant with drafts but nothing published reads as a draft agent rather than as one that
    // has never been set up, which is a different thing to chase.
    const state: AgentPublishState = derived.state === "live"
      ? "live"
      : derived.unpublishedEdits > 0 || rows.length > 0
        ? "draft"
        : "never-published";

    return {
      tenantId: tenant.id,
      clientName: tenant.name,
      isTest: testTenantIds.has(tenant.id),
      state,
      liveVersion: derived.liveVersion,
      publishedAt: derived.publishedAt,
      unpublishedEdits: derived.unpublishedEdits,
      latestEditAt: derived.latestEditAt,
      openThreads: input.openThreads === null ? null : threadsByTenant.get(tenant.id) ?? 0,
      overrides: derived.settingsRow ? overrideCount(derived.settingsRow) : 0,
      accountState: tenant.status,
    } satisfies AgentRosterEntry;
  });

  /*
   * Whatever needs a person sorts above whatever does not, the same argument the client book
   * makes: an agent with pending edits or no publish at all is work, and a live one that is
   * settled is not. Inside each group the busiest agent leads, because that is the one whose
   * pending edit costs the most.
   */
  const rank = (entry: AgentRosterEntry) => {
    if (entry.state === "never-published") return 0;
    if (entry.unpublishedEdits > 0) return 1;
    if (entry.state === "draft") return 2;
    return 3;
  };
  const sorted = [...entries].sort((left, right) => {
    const gap = rank(left) - rank(right);
    if (gap !== 0) return gap;
    const threads = (right.openThreads ?? 0) - (left.openThreads ?? 0);
    return threads !== 0 ? threads : left.clientName.localeCompare(right.clientName);
  });

  return {
    brainVersion: input.brainVersion,
    entries: sorted,
    settingCount: COACH_OWNED_SETTINGS.length,
    threadsUnavailable: input.openThreads === null,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The live source                                                                                */
/* -------------------------------------------------------------------------------------------- */

export function createLiveAgentRosterSource(): AgentRosterSource {
  return {
    readTenants: async () => {
      const { data, error } = await createSupabaseServiceClient()
        .from("tenants")
        .select("id,name,status")
        .order("name", { ascending: true });
      if (error) throw new AgentRosterError("UNAVAILABLE");
      return (data ?? []) as RawTenant[];
    },

    readOfferLayers: async (tenantIds) => {
      if (tenantIds.length === 0) return [];
      const { data, error } = await createSupabaseServiceClient()
        .from("offer_layers")
        .select(
          ["tenant_id", "version", "status", "published_at", "updated_at", ...COACH_OWNED_SETTINGS]
            .join(","),
        )
        .in("tenant_id", [...tenantIds]);
      if (error) throw new AgentRosterError("UNAVAILABLE");
      return (data ?? []) as unknown as RawOfferLayer[];
    },

    /*
     * The thread count is the one read allowed to fail without taking the page down: an admin can
     * still publish and still see who is on which version without it. Null travels through to the
     * surface, which says the count is unavailable rather than drawing a zero.
     */
    readOpenThreads: async (tenantIds) => {
      if (tenantIds.length === 0) return [];
      const { data, error } = await createSupabaseServiceClient()
        .from("conversations")
        .select("tenant_id")
        .in("tenant_id", [...tenantIds])
        .not("status", "in", `(${CLOSED_CONVERSATION_STATES.join(",")})`)
        .eq("is_test", false);
      if (error) return null;
      return (data ?? []) as RawOpenThread[];
    },

    readBrainVersion: async () => {
      const { loadCurrentBrainSnapshot } = await import("@/lib/repositories/brain-publish");
      const snapshot = await loadCurrentBrainSnapshot();
      return snapshot?.version ?? null;
    },
  };
}

export async function loadAgentRoster(
  source: AgentRosterSource = createLiveAgentRosterSource(),
): Promise<AgentRoster> {
  const tenants = await source.readTenants();
  const tenantIds = tenants.map((tenant) => tenant.id);

  const [offerLayers, openThreads, brainVersion] = await Promise.all([
    source.readOfferLayers(tenantIds),
    source.readOpenThreads(tenantIds),
    // The brain version is a label, not a gate: a snapshot read that fails leaves the strip
    // saying which version is unknown rather than refusing the whole page.
    source.readBrainVersion().catch(() => null),
  ]);

  return buildAgentRoster({ tenants, offerLayers, openThreads, brainVersion });
}
