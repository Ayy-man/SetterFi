/**
 * The mock Notion source supplies synthetic review hazards without copying client content.
 *
 * It pages like the provider arm so cursor accounting is exercised before credentials arrive;
 * its prose and figures are deliberately artificial and exist only to drive import flags.
 */

import type { NotionFaqSourceRow, NotionKnowledgeDriver } from "./types";

const MOCK_EDITED_AT = "2026-01-01T00:00:00.000Z";
const MOCK_PAGE_SIZE = 4;

export const MOCK_NOTION_FAQ_ROWS = [
  {
    sourceId: "synthetic-faq-001",
    categories: ["Program"],
    inboundMessage: "What kind of program is this?",
    response: "It is designed for {{niche}} teams seeking {{target_funding_amount}}.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-002",
    categories: ["Eligibility"],
    inboundMessage: "What should I prepare before applying?",
    response: "Start with {{requirements}}, then answer {{qualifying_questions}}.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-003",
    categories: ["Outcomes"],
    inboundMessage: "What can this process help me do?",
    response: "The aim is to {{dream_outcome}} when you are {{income_qualifiers}}.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-004",
    categories: ["Scheduling"],
    inboundMessage: "Where can I choose a time or read the guide?",
    response: "Choose a time at {{booking_link}} or read {{asset.synthetic-guide}}.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-005",
    categories: ["Funding"],
    inboundMessage: "How much should I plan for?",
    response: "We will discuss [target funding] after the initial review.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-006",
    categories: ["Trust"],
    inboundMessage: "Who will answer my questions?",
    response: "I am Jordan Example, and my direct email is jordan@example.invalid.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-007",
    categories: ["Funding"],
    inboundMessage: "Is there a fixed amount?",
    response: "A synthetic example amount is $12,345 before any source binding is reviewed.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-008",
    categories: ["Scheduling", "Eligibility"],
    inboundMessage: "Which documents determine eligibility?",
    response: "The qualification checklist decides that; scheduling is intentionally misfiled.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-009",
    categories: [],
    inboundMessage: "Which category should this use?",
    response: "This synthetic row intentionally has no category.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-010",
    categories: ["Program"],
    inboundMessage: "Can I see the next resource?",
    response: "Open X after resolving {{unregistered_detail}} in review.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
  {
    sourceId: "synthetic-faq-011",
    categories: ["Trust"],
    inboundMessage:
      "This is a deliberately long prose-shaped source paragraph with several connected ideas, " +
      "background clauses, and more context than a concise inbound FAQ question should contain.",
    response: "The review compiler should classify the source shape before acceptance.",
    sourceEditedAt: MOCK_EDITED_AT,
  },
] as const satisfies readonly NotionFaqSourceRow[];

function cursorOffset(cursor: string | null | undefined) {
  if (!cursor) return 0;
  const match = cursor.match(/^mock:(\d+)$/);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MOCK_NOTION_FAQ_ROWS.length) {
    throw new Error("MOCK_NOTION_CURSOR_INVALID");
  }
  return offset;
}

export function createMockNotionDriver(): NotionKnowledgeDriver {
  return {
    source: "mock",
    fetchFaqRows: async ({ cursor }) => {
      const offset = cursorOffset(cursor);
      const rows = MOCK_NOTION_FAQ_ROWS.slice(offset, offset + MOCK_PAGE_SIZE);
      const nextOffset = offset + rows.length;
      return {
        rows,
        nextCursor:
          nextOffset < MOCK_NOTION_FAQ_ROWS.length ? `mock:${nextOffset}` : null,
        sourceEditedAt: MOCK_EDITED_AT,
      };
    },
  };
}
