import { describe, expect, it } from "vitest";

import {
  loadLegacyOfferEngineInput,
  type OfferEngineInputClient,
  type OfferEngineInputQuery,
} from "./offer-engine-input";

type QueryFixture = { data: unknown; error?: { message: string } | null };

function offerInputClient(fixtures: Record<string, QueryFixture>) {
  const selections: Record<string, string[]> = {};
  const queries: Record<string, OfferEngineInputQuery> = {};

  for (const [table, fixture] of Object.entries(fixtures)) {
    const result = Promise.resolve({ data: fixture.data, error: fixture.error ?? null });
    const query = Object.assign(result, {
      select(columns: string) {
        (selections[table] ??= []).push(columns);
        return query;
      },
      eq() {
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      maybeSingle() {
        return result;
      },
    }) as OfferEngineInputQuery;
    queries[table] = query;
  }

  return {
    client: {
      from(table) {
        const query = queries[table];
        if (!query) throw new Error(`Unexpected table: ${table}`);
        return query;
      },
    } satisfies OfferEngineInputClient,
    selections,
  };
}

describe("loadLegacyOfferEngineInput", () => {
  it("loads normalized coach content with explicit, current source columns", async () => {
    const { client, selections } = offerInputClient({
      offer_layers: {
        data: {
          id: "offer-1",
          tenant_id: "tenant-1",
          version: 7,
          program_name: "Funding Sprint",
          products: ["biz CC"],
          brand_voice: "Direct and warm",
          voice_style_answer: "Keep it concise.",
          voice_objection_answer: "Answer objections with proof.",
          voice_followup_answer: "Follow up tomorrow.",
          credit_min: 680,
          funding_goal_min_cents: 250000,
          booking_horizon_days: 21,
        },
      },
      offer_prices: { data: [{ id: "price-1", label: "Core program", amount_cents: 297000 }] },
      offer_proof_entries: { data: [{ id: "proof-1", title: "Client result", detail: "Approved in 30 days" }] },
      offer_assets: { data: [{ id: "asset-1", slug: "guide", label: "Funding guide", url: "https://cdn.example/guide" }] },
    });

    await expect(loadLegacyOfferEngineInput(client, "tenant-1", () => true)).resolves.toEqual({
      tenantId: "tenant-1",
      version: 7,
      programName: "Funding Sprint",
      products: ["biz CC"],
      brandVoice: "Direct and warm",
      voiceAnswers: ["Keep it concise.", "Answer objections with proof.", "Follow up tomorrow."],
      proof: ["Client result: Approved in 30 days"],
      assets: [{ slug: "guide", url: "https://cdn.example/guide" }],
      offerPrices: [{ id: "price-1", label: "Core program", amountCents: 297000 }],
      creditMin: null,
      fundingGoalMinCents: 250000,
      bookingHorizonDays: 21,
    });

    expect(selections).toEqual({
      offer_layers: [
        "id, tenant_id, version, program_name, products, brand_voice, voice_style_answer, voice_objection_answer, voice_followup_answer, credit_min, funding_goal_min_cents, booking_horizon_days",
      ],
      offer_prices: ["id, label, amount_cents"],
      offer_proof_entries: ["id, title, detail"],
      offer_assets: ["id, slug, label, url"],
    });
  });

  it("keeps an empty child table distinct from a failed child read", async () => {
    const parent = {
      id: "offer-1",
      tenant_id: "tenant-1",
      version: 1,
      program_name: null,
      products: [],
      brand_voice: null,
      voice_style_answer: null,
      voice_objection_answer: null,
      voice_followup_answer: null,
      credit_min: null,
      funding_goal_min_cents: null,
      booking_horizon_days: 21,
    };
    const emptyChildren = {
      offer_prices: { data: [] },
      offer_proof_entries: { data: [] },
      offer_assets: { data: [] },
    };

    await expect(loadLegacyOfferEngineInput(offerInputClient({
      offer_layers: { data: parent },
      ...emptyChildren,
    }).client, "tenant-1")).resolves.toMatchObject({
      voiceAnswers: [],
      proof: [],
      assets: [],
      offerPrices: [],
    });

    await expect(loadLegacyOfferEngineInput(offerInputClient({
      offer_layers: { data: parent },
      offer_prices: { data: [], error: { message: "permission denied" } },
      offer_proof_entries: { data: [] },
      offer_assets: { data: [] },
    }).client, "tenant-1")).rejects.toThrow(
      "PUBLISHED_OFFER_CHILD_READ_FAILED:offer_prices:permission denied",
    );
  });

  it("refuses an absent selected scalar instead of treating it as an unconfigured value", async () => {
    await expect(loadLegacyOfferEngineInput(offerInputClient({
      offer_layers: {
        data: {
          id: "offer-1",
          tenant_id: "tenant-1",
          version: 1,
          program_name: null,
          products: [],
          brand_voice: null,
          voice_style_answer: null,
          voice_objection_answer: null,
          voice_followup_answer: null,
          funding_goal_min_cents: null,
          booking_horizon_days: 21,
        },
      },
      offer_prices: { data: [] },
      offer_proof_entries: { data: [] },
      offer_assets: { data: [] },
    }).client, "tenant-1")).rejects.toThrow("PUBLISHED_OFFER_INPUT_INVALID");
  });
});

describe("the offer-layer rollout gate", () => {
  function loadedClient() {
    return offerInputClient({
      offer_layers: {
        data: {
          id: "offer-1",
          tenant_id: "tenant-1",
          version: 7,
          program_name: "Funding Sprint",
          products: ["biz CC"],
          brand_voice: "Direct and warm",
          voice_style_answer: "Keep it concise.",
          voice_objection_answer: "Answer objections with proof.",
          voice_followup_answer: "Follow up tomorrow.",
          credit_min: 680,
          funding_goal_min_cents: 250000,
          booking_horizon_days: 21,
        },
      },
      offer_prices: { data: [{ id: "price-1", label: "Core program", amount_cents: 297000 }] },
      offer_proof_entries: { data: [{ id: "proof-1", title: "Client result", detail: "Approved in 30 days" }] },
      offer_assets: { data: [{ id: "asset-1", slug: "guide", label: "Funding guide", url: "https://cdn.example/guide" }] },
    });
  }

  it("withholds the repaired fields while the gate is off", async () => {
    const offer = await loadLegacyOfferEngineInput(loadedClient().client, "tenant-1", () => false);
    // Exactly what the engine has been receiving since the columns were dropped, now on purpose.
    expect(offer.voiceAnswers).toEqual([]);
    expect(offer.proof).toEqual([]);
    expect(offer.assets).toEqual([]);
  });

  it("keeps every field the gate does not cover identical in both states", async () => {
    const off = await loadLegacyOfferEngineInput(loadedClient().client, "tenant-1", () => false);
    const on = await loadLegacyOfferEngineInput(loadedClient().client, "tenant-1", () => true);
    // The gate must move three fields and nothing else; a rollout that quietly changed pricing or
    // the booking horizon would be a different change wearing this one's name.
    expect({ ...off, voiceAnswers: [], proof: [], assets: [] })
      .toEqual({ ...on, voiceAnswers: [], proof: [], assets: [] });
    expect(on.voiceAnswers.length).toBe(3);
    expect(on.proof.length).toBe(1);
    expect(on.assets.length).toBe(1);
  });

  it("still validates a malformed offer with the gate off", async () => {
    const { client } = offerInputClient({
      offer_layers: { data: { id: "offer-1", tenant_id: "tenant-1", version: 7, program_name: "x", products: [], brand_voice: "",
        voice_style_answer: null, voice_objection_answer: null, voice_followup_answer: null,
        credit_min: null, funding_goal_min_cents: null, booking_horizon_days: 21 } },
      offer_prices: { data: [{ id: "price-1", label: "Core", amount_cents: 1 }] },
      offer_proof_entries: { data: null, error: { message: "boom" } },
      offer_assets: { data: [] },
    });
    // Withholding the values must not also withhold the read, or the gate would hide a real fault.
    await expect(loadLegacyOfferEngineInput(client, "tenant-1", () => false)).rejects.toThrow(
      /PUBLISHED_OFFER_CHILD_READ_FAILED/,
    );
  });
});
