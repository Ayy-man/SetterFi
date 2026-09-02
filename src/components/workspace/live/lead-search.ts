import type { ContactRead } from "@/lib/repositories/contacts";

/*
 * The stage names a coach reads, which are the artboard's words wherever the artboard has one.
 *
 * `Leads.dc.html` and `LeadsBoard.dc.html` draw five stages -- New, Talking / Still talking,
 * Qualified, Call booked, Not a fit -- and this build stores seven. The two lists are not the
 * same list, and collapsing seven into five is the one change not made here: "No show" and
 * "Disqualified" both land under the artboard's "Not a fit", and a coach who cannot tell the
 * lead who never turned up from the lead who was turned away has lost the distinction they
 * would act on. The extra stages keep their own names.
 *
 * What did change is the two that were jargon. "Qualification active" describes a process the
 * system is running; "Still talking" describes what the coach would say the lead is doing, and
 * it is the artboard's own phrasing for that column. "Booked (won)" carried a parenthesis whose
 * job -- marking which stages count as won and which as lost -- is already done in a sentence
 * on the board itself ("Won is Booked. Lost is Qualified, no buy and Disqualified."), so the
 * parenthesis was the same fact twice and the shorter "Call booked" says the thing a coach is
 * scanning the column for.
 *
 * The artboard's "Qualified" has no stage behind it and is deliberately not invented. Nothing in
 * `pipeline/transitions.ts` stores qualified-but-not-yet-booked as a stage; what the build
 * records is a decision on the lead, and "Ready to book" in `OUTCOME_LABELS` is that value. A
 * stage column headed Qualified would be a column nothing could ever move a lead into.
 */
export const STAGE_LABELS: Record<string, string> = {
  new_lead: "New lead",
  qualifying: "Still talking",
  booked: "Call booked",
  qualified_no_buy: "Qualified, no buy (lost)",
  long_term_followup: "Long-term follow-up",
  no_show: "No show",
  disqualified: "Disqualified or bad fit (lost)",
};

export const OUTCOME_LABELS: Record<string, string> = {
  BOOK: "Ready to book",
  SOFT_DQ: "Not a fit yet",
  HARD_DQ: "Not a fit",
};

/**
 * Every field the lead search reads, paired with the words the page uses to name it.
 *
 * The list is the search rather than a description of one: `filterLeads` builds its haystack by
 * mapping over it, and `leadSearchScope` prints its sentence from the same labels, so a field
 * cannot join the search without the sentence naming it, and a label cannot be edited into a
 * promise the search does not keep.
 *
 * Round 3's artifact titles this screen "search by anything a lead ever said", and nothing in the
 * product can honour that. `ContactRead` carries no message text, the leads page loads none, and
 * there is no index over `messages` to search: no full-text query against a message body exists
 * anywhere in `src` or `supabase`. What a lead said that is stored on the lead is the answers the
 * agent captured, so those are searched, and the sentence says so. The alternative is a coach
 * typing a phrase they remember from a thread and reading the empty result as proof the lead
 * never said it.
 */
export const LEAD_SEARCH_FIELDS: readonly {
  label: string;
  of: (contact: ContactRead) => string | null | undefined;
}[] = [
  { label: "name", of: (contact) => contact.name },
  {
    label: "handle or number",
    of: (contact) => contact.channels
      .flatMap((channel) => [channel.channel, channel.address])
      .join(" "),
  },
  { label: "credit range", of: (contact) => contact.credit },
  { label: "funding goal", of: (contact) => contact.goal },
  { label: "timeline", of: (contact) => contact.timeline },
  { label: "pipeline stage", of: (contact) => STAGE_LABELS[contact.pipelineStage] },
  {
    label: "decision",
    of: (contact) => contact.outcome ? OUTCOME_LABELS[contact.outcome] : "Decision pending",
  },
];

/** The words in the search box, listing what it reads rather than inviting a phrase it cannot find. */
export const LEAD_SEARCH_PLACEHOLDER = "Search names, handles and captured answers";

/** The scope sentence, printed from the same list the search reads. */
export function leadSearchScope() {
  const labels = LEAD_SEARCH_FIELDS.map((field) => field.label);
  return `Search reads ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}. The conversation is not searched: a lead's messages are not part of this record, so a phrase they typed in a thread will not match here.`;
}

export function filterLeads(
  contacts: readonly ContactRead[],
  input: {
    query: string;
    channels: readonly string[];
    stages: readonly string[];
    outcomes: readonly string[];
  },
) {
  const query = input.query.trim().toLocaleLowerCase();
  return contacts.filter((contact) => {
    const channelValues = contact.channels.map((channel) => channel.channel);
    if (input.channels.length && !input.channels.some((channel) => channelValues.includes(
      channel as ContactRead["channels"][number]["channel"],
    ))) return false;
    if (input.stages.length && !input.stages.includes(contact.pipelineStage)) return false;
    if (input.outcomes.length && !input.outcomes.includes(contact.outcome ?? "pending")) return false;
    if (!query) return true;

    const searchable = LEAD_SEARCH_FIELDS
      .map((field) => field.of(contact))
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(query);
  });
}
