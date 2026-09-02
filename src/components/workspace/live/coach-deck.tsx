import { DeckPanel, type DeckPanelDrench } from "@/components/kit/deck-panel";
import { Meter } from "@/components/kit/meter";
import type { MetricAvailability } from "@/components/kit/headline-stat";
import { formatMetric } from "@/lib/format/metric";

/**
 * Coach Home's figures, drawn as the round-3 deck instead of two strips of tiles.
 *
 * The page used to say its numbers twice: a bare "What came of it" strip at the top and a
 * card-faced "Performance" strip below it, which is a distinction the page's own comment had to
 * explain and which no coach ever reported understanding. The deck says them once, at a size a
 * 55-year-old can read across a room, with a sentence on every panel saying what the figure
 * actually counts.
 *
 * **The availability arms are the reason this is a new component rather than a restyled
 * `StatStrip`.** Every figure here can be absent in five different ways, and the honest-states
 * rule turns on never collapsing them: a coach who booked nothing this week and a coach whose
 * booking figure could not be computed must not see the same panel. So `no-events` prints a
 * measured `0` -- it is a real reading -- while every absent arm prints "Not yet" over the reason
 * it is not there. No arm prints a percentage or a predicted date, and none prints a day counter
 * either: the day counter belongs to provisioning, where elapsed days are the honest answer to
 * "how long", and spending it on an empty analytics window would dilute the one place it means
 * something. See `figureFor` for what that cost when it was got wrong.
 */

export type CoachDeckItem = {
  /** The category, above the name. Sentence case; this surface has no uppercase micro-type. */
  eyebrow: string;
  name: string;
  availability: MetricAvailability;
  /** One line saying what the figure counts. Never two -- `--measure-deck` will not hold them. */
  sentence: string;
  action?: { href: string; label: string };
  footer?: React.ReactNode;
  drench?: DeckPanelDrench;
  hero?: boolean;
};

/**
 * What a panel shows when there is no number.
 *
 * Deliberately not a dash. A dash in a 62px mono slot reads as a rendering failure at this size,
 * and the whole point of the arm is that we know why the figure is missing and are willing to say
 * so.
 */
function AbsentFigure({ children }: { children: React.ReactNode }) {
  return <span className="text-[color:var(--faint)]">{children}</span>;
}

function figureFor(availability: MetricAvailability) {
  switch (availability.kind) {
    case "value":
      return formatMetric(availability.value, availability.format);
    /*
     * A measured zero, and it prints as one. This arm exists because "0 booked calls" is a fact
     * the query returned and a coach needs to see it; routing it through the absent arms would
     * turn a true answer into "not yet", which is a different and false claim.
     */
    case "no-events":
      return formatMetric(0, "count");
    /*
     * Deliberately NOT a day counter.
     *
     * `dayProgress` measures the selected analytics window, not the age of the account: on the
     * default 1M window it returns day 31 of 31, because the whole window has elapsed. Rendering
     * that as the panel's headline figure produced six panels reading "Day 31" over "of about 31
     * days needed before this reads", which is both meaningless as a number and false as a
     * sentence -- nothing is waiting on 31 days of anything.
     *
     * The honest-states rule does require a real day counter, but for provisioning: A2P carrier
     * review is a process with a genuine elapsed day count and no predictable end. An analytics
     * window that has simply not accumulated a completed event is not that, and borrowing the
     * provisioning treatment for it dilutes the one place the day counter carries meaning.
     */
    case "needs-history":
      return <AbsentFigure>Not yet</AbsentFigure>;
    default:
      return <AbsentFigure>Not yet</AbsentFigure>;
  }
}

/**
 * The line under the figure. For a present reading it is the caller's sentence about what the
 * figure counts; for an absent one it is the reason, because a sentence explaining a number that
 * is not there would be answering a question nobody can ask yet.
 */
function sentenceFor(availability: MetricAvailability, sentence: string) {
  switch (availability.kind) {
    case "value":
    case "no-events":
      return sentence;
    /*
     * Says what is actually true: the window is fully elapsed and nothing in it completed. The
     * previous wording claimed the metric was waiting on more days of history, which was a
     * misreading of what `dayProgress` returns and would have told a coach to wait for something
     * that was never going to arrive on its own.
     */
    case "needs-history":
      return "Nothing has completed in this window yet.";
    case "not-connected":
      return `Waiting on ${availability.source}.`;
    case "read-failed":
      return "We could not read this just now.";
    default:
      return availability.note;
  }
}

/**
 * One small reading in a panel's footer, and the reason it is a shape rather than a string.
 *
 * The artboard draws every deck panel with a pair of supporting counts under the figure -- an
 * outcome broken into two halves, a funnel step and its predecessor. Some of those pairs exist in
 * our data and some do not, and the honest-states rule turns on the difference being visible
 * rather than papered over: a footer whose value is `null` keeps its label, prints the absent
 * phrase in body type instead of a number, and the panel says in `note` which reading is missing
 * and why. A stat with no source is never quietly dropped, because a footer that renders one
 * count where the design draws two reads as a design with one count in it, and the next person
 * to open the file has no way to tell that the second was refused on purpose.
 */
export type DeckStat = {
  label: string;
  /** The formatted reading, or null when nothing in the read produces this figure. */
  value: string | null;
  /**
   * The dot's colour in the `rows` layout, and nothing else. `Main.dc.html` leads each footer row
   * with an 8px dot -- amber for the leads still worth keeping warm, `--faint` for the ones the
   * agent ended politely, green for what the agent is handling, amber for what is waiting on the
   * coach -- so the two rows under a figure read as two different kinds of thing before either
   * label is read. Absent in the `pair` layout, which has no dot to colour.
   */
  tone?: "good" | "waiting" | "quiet";
};

const STAT_DOT_CLASS: Record<NonNullable<DeckStat["tone"]>, string> = {
  good: "bg-[var(--good)]",
  waiting: "bg-[var(--waiting)]",
  quiet: "bg-[var(--faint)]",
};

/**
 * The footer widget: a row of labelled readings, with an optional line saying what population
 * they were counted over.
 *
 * `note` is not decoration. Two of these pairs are counted over something other than the figure
 * above them -- open conversations under an active-contacts figure, a billing period under an
 * analytics window -- and a reader who assumes the footer is a slice of the headline has been
 * misled by the layout rather than by any sentence. The note is where the layout is corrected.
 */
export function DeckStats({
  layout = "pair",
  meter,
  note,
  stats,
}: {
  /**
   * `pair` is two labelled readings side by side, which is what the conversion and leads panels
   * draw: a funnel step and the step before it, read across. `rows` is the canvas's dot-led list,
   * one reading per line with a hairline between them, which is what the not-a-fit and active
   * panels draw: two named halves of the figure above, read down. They are different shapes
   * because they are different claims, and the pair read as a stacked list made a coach scan for
   * a third row that was never coming.
   *
   * `caption` is the third, and it is the one reading that is a caption for the bar under it
   * rather than a stat in its own right. `Main.dc.html:156-159` draws the Booked panel's footer
   * as `18 / 25` hard left at 19px mono with "Monthly plan progress" hard right at 14px, both on
   * one baseline, 14px above the meter. The other two layouts lead with the label because the
   * label is what tells you which figure you are about to read; this one leads with the value,
   * because the bar immediately below has already said what it measures and the number is the
   * part the bar cannot state precisely. Rendering it as a `pair` stacked the label over the
   * value in a footer whose whole job was to annotate a horizontal bar.
   */
  layout?: "pair" | "rows" | "caption";
  /**
   * A share, 0 to 1, drawn as the bar the Booked panel carries under its allowance reading. It
   * takes `currentColor` rather than the accent so it works on a drenched panel and a plain one
   * without asking which it is on, and it is `aria-hidden`: the figures beside it already say the
   * same ratio in words, so a reader who cannot see the bar has lost nothing.
   */
  meter?: number | null;
  note?: string;
  stats: readonly DeckStat[];
}) {
  if (layout === "caption") {
    return (
      <>
        {stats.map((stat) => (
          <div
            className="flex flex-wrap items-baseline justify-between gap-[10px]"
            data-slot="deck-stat"
            key={stat.label}
          >
            <span
              className="coach-panel__stat-value coach-panel__stat-value--caption"
              data-absent={stat.value === null ? "true" : undefined}
              data-slot="deck-stat-value"
            >
              {stat.value ?? "Not counted"}
            </span>
            <span className="coach-panel__stat-label" data-slot="deck-stat-label">
              {stat.label}
            </span>
          </div>
        ))}
        {typeof meter === "number" ? (
          <Meter className="mt-[14px]" tone="current" value={meter} />
        ) : null}
        {note ? <p className="coach-panel__stat-note">{note}</p> : null}
      </>
    );
  }

  if (layout === "rows") {
    return (
      <>
        <div className="flex min-w-0 flex-col">
          {stats.map((stat) => (
            <div
              className="grid min-h-[46px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[8px] border-t border-[var(--line-soft)]"
              data-slot="deck-stat"
              key={stat.label}
            >
              <span
                aria-hidden
                className={`size-[8px] shrink-0 rounded-full ${STAT_DOT_CLASS[stat.tone ?? "quiet"]}`}
              />
              <span
                className="min-w-0 truncate text-[length:var(--coach-body)] leading-[1.4] text-[color:var(--body)]"
                data-slot="deck-stat-label"
              >
                {stat.label}
              </span>
              <span
                className="mono shrink-0 text-[17px] leading-[1.2] font-medium text-[color:var(--ink)] tabular-nums"
                data-absent={stat.value === null ? "true" : undefined}
                data-slot="deck-stat-value"
              >
                {stat.value ?? (
                  <span className="text-[length:var(--coach-eyebrow)] font-normal text-[color:var(--faint)] [font-family:inherit]">
                    Not counted
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
        {note ? <p className="coach-panel__stat-note">{note}</p> : null}
      </>
    );
  }

  return (
    <>
      <div className="coach-panel__stats">
        {stats.map((stat) => (
          <div className="coach-panel__stat" data-slot="deck-stat" key={stat.label}>
            <span className="coach-panel__stat-label" data-slot="deck-stat-label">
              {stat.label}
            </span>
            <span
              className="coach-panel__stat-value"
              data-absent={stat.value === null ? "true" : undefined}
              data-slot="deck-stat-value"
            >
              {stat.value ?? "Not counted"}
            </span>
          </div>
        ))}
      </div>
      {typeof meter === "number" ? (
        <Meter className="mt-[14px]" tone="current" value={meter} />
      ) : null}
      {note ? <p className="coach-panel__stat-note">{note}</p> : null}
    </>
  );
}

/*
 * There is no column stagger. `Main.dc.html` drops the first column 34px and the third 14px so
 * the six panels do not land on one hard top line, and it did not survive contact with the built
 * page: Ayman read it as broken alignment in two separate screenshots before asking for it gone.
 * That is the only test an ornament has to pass -- a reader cannot tell a deliberate offset from
 * a mistake, and the artboard is not there to tell them. The mechanism is deleted rather than
 * zeroed so there is no empty triple for the next pass to refill.
 */

export function CoachDeck({ items }: { items: readonly CoachDeckItem[] }) {
  /*
   * Column-major, which is why this chunks rather than distributing round-robin. The deck's order
   * is the artboard's reading order down each column -- Booked then Not a fit, Active then
   * Conversion, Leads then Avg time to book -- and the two drenched panels sit in different
   * columns because of it. Dealing the items across the columns instead would put both accents in
   * column one on a six-item deck and stack the two absent-figure panels together.
   */
  const perColumn = Math.max(1, Math.ceil(items.length / 3));
  const columns: CoachDeckItem[][] = [[], [], []];
  items.forEach((item, index) => {
    columns[Math.min(2, Math.floor(index / perColumn))].push(item);
  });
  /*
   * A deck of four panels is two columns of two, not two columns and an empty third: an empty
   * `flex: 1 1 0` column is invisible and still takes a third of the row, so the panels beside it
   * would be sized for a deck that is not there. `CoachDeck` is used with six panels on Home and
   * with fewer on the affiliate surface.
   */
  const dealt = columns.filter((column) => column.length > 0);

  return (
    /*
     * Three columns, not `auto-fit`. The old grid sized every panel identically off a 210px floor,
     * which is what made the deck read as a table; these columns are `flex: 1 1 0` and each panel
     * takes the height its own content needs, so the not-a-fit panel's two footer rows do not
     * stretch the panel beside it. Below `md` the columns stack, which puts the deck back into one
     * column of six on a phone -- the same degradation the `auto-fit` grid gave, arrived at with a
     * breakpoint instead of a floor.
     *
     * `--coach-figure` is `clamp(40px, 4vw, 62px)` and `4vw` is a viewport measure rather than a
     * container one, so on a 390px phone every panel collapses to the 40px floor. Both artboards
     * keep the figure at a flat 62px. `--coach-panel-radius` is redeclared for the same reason the
     * figure is: `Main.dc.html` gives all six panels the hero's 30px top corners, and the token
     * that carries that lives in `coach.css`, which this pass does not own. Both are custom
     * properties on a descendant of the shell root, so proximity settles them and the override
     * moves this deck only rather than every coach surface at once.
     */
    <div className="flex flex-col items-start gap-[14px] [--coach-figure:62px] [--coach-panel-radius:30px_30px_17px_17px] md:flex-row">
      {dealt.map((column, index) => (
        <div
          className={`flex min-w-0 flex-1 flex-col gap-[14px] self-stretch md:self-auto`}
          data-deck-column={index}
          key={column[0]?.name ?? index}
        >
          {column.map((item) => (
            <DeckPanel
              action={item.action}
              drench={item.drench}
              eyebrow={item.eyebrow}
              figure={figureFor(item.availability)}
              footer={item.footer}
              hero={item.hero}
              key={item.name}
              name={item.name}
              sentence={sentenceFor(item.availability, item.sentence)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
