/**
 * Notion source contracts preserve typed FAQ fields without deciding review disposition.
 *
 * Category remains a list because zero and multiple selections are review evidence rather than
 * provider-shape failures; the import compiler owns the eventual single-category decision.
 */

export type NotionFaqSourceRow = {
  sourceId: string;
  categories: readonly string[];
  inboundMessage: string;
  response: string;
  sourceEditedAt: string | null;
};

export type NotionFaqPage = {
  rows: readonly NotionFaqSourceRow[];
  nextCursor: string | null;
  sourceEditedAt: string | null;
};

export type NotionFaqPageInput = {
  rootId: string;
  cursor?: string | null;
};

export interface NotionKnowledgeDriver {
  source: "mock" | "notion" | "offline";
  fetchFaqRows(input: NotionFaqPageInput): Promise<NotionFaqPage>;
}
