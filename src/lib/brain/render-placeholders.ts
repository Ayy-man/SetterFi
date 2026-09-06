/**
 * Render immutable Brain templates against one published tenant offer.
 *
 * Tenant values are resolved only after retrieval. Missing required data drops the candidate;
 * optional slots use registry-owned grammatical fallbacks and source templates stay untouched.
 */

import type {
  PublishedCoachOffer,
  PublishedRuntimeBundle,
  RenderCandidates,
} from "@/lib/brain/contracts";
import {
  PLACEHOLDER_REGISTRY,
  normalizePlaceholderToken,
  placeholderDefinition,
  resolvePlaceholder,
  type PlaceholderDefinition,
} from "@/lib/brain/placeholders";

type PlaceholderRegistry = Readonly<Record<string, PlaceholderDefinition>>;

function currency(cents: number) {
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(cents / 100)}`;
}

function fundingRange(offer: PublishedCoachOffer) {
  if (offer.fundingGoalMinCents === null) return null;
  if (offer.fundingGoalMaxCents === null) return `${currency(offer.fundingGoalMinCents)}+`;
  return `${currency(offer.fundingGoalMinCents)}–${currency(offer.fundingGoalMaxCents)}`;
}

function placeholderValue(
  token: string,
  offer: PublishedCoachOffer,
  renderSources: PublishedRuntimeBundle["renderSources"],
) {
  if (token === "niche") return offer.programName;
  if (token === "target_funding_amount") return fundingRange(offer);
  if (token === "booking_link") return renderSources.bookingUrl;
  if (token === "requirements") return renderSources.qualificationSummary;
  if (token === "qualifying_questions") return renderSources.qualificationInputs;
  if (token === "dream_outcome") return null;
  if (token === "income_qualifiers") {
    if (offer.monthlyRevenueMinCents !== null) {
      return `already generating at least ${currency(offer.monthlyRevenueMinCents)} per month`;
    }
    return offer.businessRevenueRequired ? "already generating revenue" : null;
  }
  const asset = token.match(/^asset\.([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  return asset ? renderSources.assetUrlsBySlug[asset[1]] ?? null : null;
}

function runtimeDefinition(token: string, registry: PlaceholderRegistry) {
  return registry[token] ?? placeholderDefinition(token);
}

export type RenderedTemplate =
  | { status: "rendered"; content: string }
  | { status: "dropped"; reason: string };

/**
 * Resolves one immutable template against one tenant. Shared by retrieval candidates and the
 * inline knowledge block so the two paths cannot disagree on what a slot renders to or when an
 * entry is withheld from a tenant.
 */
export function renderTemplate(
  responseTemplate: string,
  offer: PublishedCoachOffer,
  renderSources: PublishedRuntimeBundle["renderSources"],
  registry: unknown = PLACEHOLDER_REGISTRY,
): RenderedTemplate {
  const definitions = registry && typeof registry === "object"
    ? registry as PlaceholderRegistry
    : PLACEHOLDER_REGISTRY;
  if (/\bX\b/.test(responseTemplate)) {
    return { status: "dropped", reason: "unresolved bare placeholder: X" };
  }
  let reason: string | null = null;
  const content = responseTemplate.replace(
    /\{\{\s*([^{}]+?)\s*\}\}|\[\s*([^\[\]\n]+?)\s*\]/g,
    (whole, braces, square) => {
      const token = normalizePlaceholderToken(String(braces ?? square ?? ""));
      if (!token || !runtimeDefinition(token, definitions)) {
        reason = `unknown placeholder: ${token ?? whole}`;
        return whole;
      }
      const resolution = resolvePlaceholder(token, placeholderValue(token, offer, renderSources));
      if (resolution.status === "drop") {
        reason = resolution.reason;
        return whole;
      }
      return resolution.value;
    },
  );
  return reason ? { status: "dropped", reason } : { status: "rendered", content };
}

export const renderCandidates: RenderCandidates = ({ candidates, offer, registry, renderSources }) => {
  const included = [];
  const dropped = [];

  for (const candidate of candidates) {
    const rendered = renderTemplate(candidate.responseTemplate, offer, renderSources, registry);
    if (rendered.status === "dropped") {
      dropped.push({ entryId: candidate.entryId, dropped: true as const, reason: rendered.reason });
      continue;
    }
    included.push({ ...candidate, content: rendered.content, dropped: false as const });
  }

  return { included, dropped };
};
