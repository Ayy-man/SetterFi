/**
 * The search and the filter chips that sit over the client book, as data and pure functions.
 *
 * None of this is React. The screen folds five reads into one table and the filter row has to
 * agree with all five, so the part that decides which rows survive is worth checking on its own,
 * without a render, a router or a roster. The screen's job is to project its rows into
 * `ClientFilterRow` once and hand them here; everything below is a function of that projection.
 *
 * Every filter is over the rows the page already loaded. Nothing here pages, refetches or writes
 * to the URL: a reader narrowing a book of eight clients should not wait on a round trip, and a
 * filter that changed the query would change what the server read as well as what the table draws.
 */

/** The tabs the screen draws. Structurally the same union `owner-clients.tsx` exports. */
export type ClientsFilterTab = "status" | "agent" | "performance" | "health" | "team" | "setup";

/** How far a provisioning stage has got, flattened to the four states a filter can name. */
export type StageState = "cleared" | "waiting" | "blocked" | "not_started";

/** What the agent roster says about a client, or `null` when the roster has no row for it. */
export type AgentState = "live" | "draft" | "never";

/**
 * One row, projected out of the five reads the page folds.
 *
 * Names arrive already stripped of the seeders' `(demo)` marker, because this is what a reader
 * types into the search box. Every measured figure is nullable and `null` means "not measured",
 * never zero: a threshold filter drops an unmeasured row rather than counting it as a zero that
 * nobody recorded.
 */
export type ClientFilterRow = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  /**
   * The contact address, when the projection carries one. The client-book projection does not
   * today, so the screen passes `null` and search matches on names alone; the field is here so
   * that the day the projection grows an address, search picks it up without a shape change.
   */
  email: string | null;
  plan: string;
  /** The lifecycle value as stored, lowercased. `humanize` in the screen turns it into a label. */
  billingState: string;
  /** When the row last moved. The "Since" column and the "Live since" chip both read this. */
  lastChangeIso: string;
  agentState: AgentState | null;
  unpublishedEdits: number | null;
  openThreads: number | null;
  bookedCalls: number | null;
  grossMrrCents: number | null;
  /** Instagram and Messenger, from the provisioning tracker. `null` when the client is untracked. */
  channelConnected: boolean | null;
  calendarConnected: boolean | null;
  texting: StageState | null;
  /** A stage that failed or is blocked. What "Problems first" lifts to the top of the table. */
  hasProblem: boolean;
};

export type ChipOption = { value: string; label: string };

/**
 * A chip is one of three things, and the difference matters enough to be in the type.
 *
 * `menu` is the ordinary case: a facet with a value list. `toggle` is on or off and carries no
 * menu. `note` is a chip the artboard draws over a fact nobody measures yet; it opens to say so
 * rather than being quietly dropped, because a missing chip reads as an oversight and a chip that
 * silently filters nothing reads as a bug.
 */
export type ChipDef =
  | { key: string; kind: "menu"; label: string; options: readonly ChipOption[] }
  | { key: string; kind: "toggle"; label: string }
  | { key: string; kind: "note"; label: string; note: string };

/** The chosen value per chip key. A toggle stores `"on"`; an absent key is an unset chip. */
export type ChipSelections = Readonly<Record<string, string>>;

/** What "Save view" writes: the search box and the chips, for one tab. */
export type SavedClientsView = { search: string; selections: ChipSelections };

/** The value the Owner chip uses for the clients nobody owns. Not a real owner id. */
export const UNASSIGNED_OWNER = "__unassigned";

const SINCE_OPTIONS: readonly ChipOption[] = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "older", label: "Older than 90 days" },
];

const BOOKED_OPTIONS: readonly ChipOption[] = [
  { value: "1", label: "1 or more" },
  { value: "5", label: "5 or more" },
  { value: "10", label: "10 or more" },
  { value: "25", label: "25 or more" },
];

const MRR_OPTIONS: readonly ChipOption[] = [
  { value: "100000", label: "$1,000 or more" },
  { value: "500000", label: "$5,000 or more" },
  { value: "1000000", label: "$10,000 or more" },
];

const CHANNEL_OPTIONS: readonly ChipOption[] = [
  { value: "connected", label: "Instagram and Messenger connected" },
  { value: "not_connected", label: "Not connected yet" },
];

const TEXTING_OPTIONS: readonly ChipOption[] = [
  { value: "cleared", label: "Cleared" },
  { value: "waiting", label: "With the carrier" },
  { value: "blocked", label: "Blocked" },
  { value: "not_started", label: "Not started" },
];

const CALENDAR_OPTIONS: readonly ChipOption[] = [
  { value: "cleared", label: "Connected" },
  { value: "not_cleared", label: "Not connected yet" },
];

const AGENT_STATE_OPTIONS: readonly ChipOption[] = [
  { value: "live", label: "Live" },
  { value: "draft", label: "Draft above the published version" },
  { value: "never", label: "Never published" },
  { value: "none", label: "No agent row" },
];

const COUNT_OPTIONS: readonly ChipOption[] = [
  { value: "any", label: "1 or more" },
  { value: "none", label: "None" },
];

/**
 * The margin and the period the Performance artboard draws.
 *
 * Neither is measured per client: the measurement snapshot carries booked appointments and gross
 * MRR, and nothing on it records cost or a per-period breakdown per tenant. A chip that filtered
 * on a number this page invented would be worse than no chip at all, so the chip stays and says
 * what is missing.
 */
const MARGIN_NOTE = "Margin is not measured per client yet. Gross MRR is the only money figure the "
  + "measurement snapshot carries, so there is no cost to take it away from.";
const PERIOD_NOTE = "Booked calls come from one measurement window, the same one for every client. "
  + "Per-client figures are not broken out per period, so there is no period to choose between.";

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function humanizeState(value: string) {
  const words = value.replaceAll("_", " ").trim().toLocaleLowerCase();
  return words ? `${words[0].toLocaleUpperCase()}${words.slice(1)}` : "Not recorded";
}

function planChip(rows: readonly ClientFilterRow[]): ChipDef {
  return {
    key: "plan",
    kind: "menu",
    label: "Plan",
    options: distinct(rows.map((row) => row.plan)).map((plan) => ({ value: plan, label: plan })),
  };
}

function billingChip(rows: readonly ClientFilterRow[]): ChipDef {
  return {
    key: "billing",
    kind: "menu",
    label: "Billing state",
    options: distinct(rows.map((row) => row.billingState))
      .map((state) => ({ value: state, label: humanizeState(state) })),
  };
}

function ownerChip(rows: readonly ClientFilterRow[]): ChipDef {
  const named = new Map<string, string>();
  let unassigned = false;
  for (const row of rows) {
    if (row.ownerId) named.set(row.ownerId, row.ownerName?.trim() || "Owner not named");
    else unassigned = true;
  }
  const options = [...named.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return {
    key: "owner",
    kind: "menu",
    label: "Owner",
    options: unassigned
      ? [...options, { value: UNASSIGNED_OWNER, label: "Nobody owns this" }]
      : options,
  };
}

/**
 * The chips a tab carries, with their value lists read off the rows the page loaded.
 *
 * Options come from the rows rather than from a fixed vocabulary because the lifecycle values and
 * the plan names are the store's, not ours; a hard-coded list would quietly stop offering a plan
 * the day somebody adds one. Thresholds are the exception: they are our buckets, not the data's.
 */
export function chipsForTab(
  tab: ClientsFilterTab,
  rows: readonly ClientFilterRow[],
): readonly ChipDef[] {
  switch (tab) {
    case "status":
      return [planChip(rows), billingChip(rows), {
        key: "since", kind: "menu", label: "Live since", options: SINCE_OPTIONS,
      }, ownerChip(rows)];
    case "performance":
      return [
        { key: "booked", kind: "menu", label: "Booked calls", options: BOOKED_OPTIONS },
        { key: "mrr", kind: "menu", label: "Gross MRR", options: MRR_OPTIONS },
        { key: "margin", kind: "note", label: "Margin", note: MARGIN_NOTE },
        { key: "period", kind: "note", label: "Period", note: PERIOD_NOTE },
      ];
    case "health":
      return [
        { key: "channel", kind: "menu", label: "Channel", options: CHANNEL_OPTIONS },
        { key: "problems", kind: "toggle", label: "Problems first" },
        { key: "texting", kind: "menu", label: "Texting registration", options: TEXTING_OPTIONS },
        { key: "calendar", kind: "menu", label: "Calendar", options: CALENDAR_OPTIONS },
      ];
    case "agent":
      return [
        { key: "agentState", kind: "menu", label: "Agent", options: AGENT_STATE_OPTIONS },
        { key: "edits", kind: "menu", label: "Unpublished edits", options: COUNT_OPTIONS },
        { key: "threads", kind: "menu", label: "Open threads", options: COUNT_OPTIONS },
        planChip(rows),
      ];
    case "team":
      return [planChip(rows), billingChip(rows), ownerChip(rows)];
    case "setup":
      // Setup is the marketplace install surface, not a table of clients. Nothing to narrow.
      return [];
  }
}

/** Case-insensitive, over the three things a reader knows a client by. Blank matches everything. */
export function matchesSearch(row: ClientFilterRow, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.name, row.ownerName, row.email]
    .some((value) => (value ?? "").toLocaleLowerCase().includes(needle));
}

function daysBetween(fromIso: string, now: Date): number | null {
  const date = new Date(fromIso);
  if (Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / 86_400_000;
}

function atLeast(value: number | null, threshold: string): boolean {
  // An unmeasured figure is not a zero, so it fails every threshold rather than passing the low ones.
  if (value === null) return false;
  const floor = Number(threshold);
  return Number.isFinite(floor) && value >= floor;
}

function countMatches(value: number | null, choice: string): boolean {
  if (value === null) return false;
  return choice === "any" ? value > 0 : value === 0;
}

/** One chip against one row. An unknown key matches, so a stale saved view cannot empty a table. */
function matchesChip(row: ClientFilterRow, key: string, choice: string, now: Date): boolean {
  switch (key) {
    case "plan":
      return row.plan === choice;
    case "billing":
      return row.billingState === choice;
    case "owner":
      return choice === UNASSIGNED_OWNER ? row.ownerId === null : row.ownerId === choice;
    case "since": {
      const days = daysBetween(row.lastChangeIso, now);
      if (days === null) return false;
      return choice === "older" ? days > 90 : days <= Number(choice);
    }
    case "booked":
      return atLeast(row.bookedCalls, choice);
    case "mrr":
      return atLeast(row.grossMrrCents, choice);
    case "channel":
      return row.channelConnected === (choice === "connected");
    case "calendar":
      return row.calendarConnected === (choice === "cleared");
    case "texting":
      return row.texting === choice;
    case "agentState":
      return choice === "none" ? row.agentState === null : row.agentState === choice;
    case "edits":
      return countMatches(row.unpublishedEdits, choice);
    case "threads":
      return countMatches(row.openThreads, choice);
    case "problems":
      // A sort, not a filter: "Problems first" lifts rows, it never hides the rest.
      return true;
    default:
      return true;
  }
}

export type ApplyFiltersInput = {
  rows: readonly ClientFilterRow[];
  search: string;
  selections: ChipSelections;
  nowIso: string;
};

/**
 * The visible rows, in order.
 *
 * Chips are combined with AND, which is the only reading of a row of chips that a reader can
 * predict. The incoming order is the book order the page already computed, and it survives:
 * "Problems first" is a stable partition over it rather than a re-sort, so two rows that both have
 * a blocked stage stay in the order the book put them in.
 */
export function applyClientFilters(input: ApplyFiltersInput): ClientFilterRow[] {
  const now = new Date(input.nowIso);
  const entries = Object.entries(input.selections).filter(([, choice]) => choice);
  const visible = input.rows.filter((row) =>
    matchesSearch(row, input.search)
    && entries.every(([key, choice]) => matchesChip(row, key, choice, now)));

  if (input.selections.problems !== "on") return visible;
  return [
    ...visible.filter((row) => row.hasProblem),
    ...visible.filter((row) => !row.hasProblem),
  ];
}

/* --------------------------------------------------------------------------------------------
 * The saved view
 * ------------------------------------------------------------------------------------------ */

/**
 * One key per tab, because the chips differ per tab and a single shared view would restore the
 * Health chips onto Performance where none of them mean anything.
 */
export function savedViewKey(tab: ClientsFilterTab): string {
  return `setterfi.owner-clients.view.${tab}`;
}

/** Anything that is not a string-to-string record is not a view, whoever wrote it. */
function parseView(raw: string): SavedClientsView | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const search = typeof record.search === "string" ? record.search : "";
  const selections: Record<string, string> = {};
  if (typeof record.selections === "object" && record.selections !== null) {
    for (const [key, choice] of Object.entries(record.selections as Record<string, unknown>)) {
      if (typeof choice === "string" && choice) selections[key] = choice;
    }
  }
  return { search, selections };
}

/* --------------------------------------------------------------------------------------------
 * The saved view as a store
 *
 * `useSyncExternalStore` rather than a read in an effect, for the reason the context eye gives:
 * the server renders the book unfiltered and React re-renders with the remembered view after
 * hydration, which is the same single frame a state-in-effect version would cost without the
 * cascading render. That needs a snapshot with a stable identity, so the parse is cached against
 * the raw string and only re-runs when the stored text actually changes.
 * ------------------------------------------------------------------------------------------ */

const cached = new Map<string, { raw: string | null; view: SavedClientsView | null }>();
const savedViewListeners = new Set<() => void>();

/**
 * Notified on our own writes, and on another tab's: two console tabs open on the same screen
 * should not disagree about what "Save view" saved.
 */
export function subscribeSavedViews(listener: () => void): () => void {
  savedViewListeners.add(listener);
  const onStorage = () => listener();
  try {
    globalThis.addEventListener?.("storage", onStorage);
  } catch {
    // A host without an event target still gets our own writes, which is the common case.
  }
  return () => {
    savedViewListeners.delete(listener);
    try {
      globalThis.removeEventListener?.("storage", onStorage);
    } catch {
      // Nothing to undo: the listener was never attached.
    }
  };
}

/**
 * The saved view for a tab, or `null`.
 *
 * Every path through browser storage is guarded: a private window throws on read, a browser set to
 * block site data throws on the property access itself, and a half-written entry parses to
 * nothing. None of those are worth a broken screen over a remembered filter, so all three answer
 * `null` and the tab opens unfiltered.
 *
 * The result is identity-stable while the stored text is unchanged, which is what
 * `useSyncExternalStore` requires of a snapshot. A caller that hands in its own storage is a test
 * rather than the store, so it skips the cache and reads every time.
 */
export function savedViewSnapshot(
  tab: ClientsFilterTab,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): SavedClientsView | null {
  const key = savedViewKey(tab);
  let raw: string | null = null;
  try {
    raw = (storage ?? globalThis.localStorage)?.getItem(key) ?? null;
  } catch {
    return null;
  }

  const held = storage ? undefined : cached.get(key);
  if (held && held.raw === raw) return held.view;

  let view: SavedClientsView | null = null;
  try {
    view = raw ? parseView(raw) : null;
  } catch {
    view = null;
  }
  if (!storage) cached.set(key, { raw, view });
  return view;
}

/** Writes the view, and answers whether it landed, so the screen can say so honestly. */
export function writeSavedView(
  tab: ClientsFilterTab,
  view: SavedClientsView,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): boolean {
  try {
    const store = storage ?? globalThis.localStorage;
    if (!store) return false;
    store.setItem(savedViewKey(tab), JSON.stringify(view));
    return true;
  } catch {
    return false;
  } finally {
    for (const listener of savedViewListeners) listener();
  }
}
