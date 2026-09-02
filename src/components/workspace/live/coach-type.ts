/**
 * The coach surface's type sizes, as classes the leads screens can share.
 *
 * The reason this file exists rather than `text-body` and friends: the `--t-*` scale in
 * `tokens.css` is the owner console's, and it is fixed at the console's sizes -- `--t-body` is
 * 13px, `--t-row` 14px, `--t-over` an 11px uppercase label. `coach.css` raises the coach shell's
 * root `font-size` to 16px, but that does nothing for a class whose size is an absolute px value,
 * so a coach screen built out of `text-body` renders at the console's density however loud the
 * root says the surface is. The canvas draws the coach side at 16px body, a 17px row name and a
 * 15px caption, and those are the numbers below.
 *
 * They are classes rather than tokens on purpose. Redefining `--t-body` under
 * `[data-shell-role="coach"]` would move every coach surface in the product at once, including
 * the ones other people are porting in parallel, and a shared stylesheet is the worst place to
 * land a change whose blast radius nobody can see from the diff. A class each screen opts into
 * moves exactly the screens that opted in.
 *
 * There is deliberately no uppercase micro-label here. The 9.5px mono `Overline` is the worst
 * legibility case in the product and coach Home carried thirteen of them; on this side the
 * category above a name is `COACH_EYEBROW_CLASS`, sentence case, which is the same role
 * `.coach-panel__eyebrow` plays inside a deck panel. The one uppercase survivor the canvas keeps
 * is a table's own column header, and that is set where the table sets it.
 */

/**
 * The category line above a name or a section. Sentence case, never uppercase, never mono.
 *
 * **The size is the token, not a number retyped here.** This shipped as a `text-[12px]` literal
 * while `coach.css` declared `--coach-eyebrow: 14px` beside it, so ten callers rendered two pixels
 * under a floor `SIMPLIFICATION-SPEC` §5 calls absolute -- and the drift was invisible because two
 * places held one number and only one of them was ever read. Referencing the token makes a repeat
 * structurally impossible rather than merely noticed later.
 *
 * No fallback value, deliberately. `token-references.test.ts` skips any `var()` carrying a
 * fallback, so a fallback would buy a safety net at the price of the guard that checks the token
 * resolves at all. What makes that safe is the scope: `--coach-eyebrow` is declared under
 * `[data-shell-role="coach"]`, and every caller was walked to confirm it renders inside that root
 * -- through `AppShell role="coach"`, through `CoachScale`, or through `OnboardingStage`, which
 * wraps `CoachScale` itself. A caller outside it would get an undefined property, the browser
 * would drop the declaration, and the text would silently fall back to inherited size, which is
 * exactly how `--r-pill` squared a chip on sixteen surfaces. A portalled caller is the same bug:
 * Radix mounts to `document.body`, outside the role, so anything rendered through `DialogContent`
 * or a dropdown needs its own `CoachScale` inside the portal.
 */
export const COACH_EYEBROW_CLASS =
  "text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";

/**
 * Body copy: the sentence a coach actually reads. 16px is the whole point of the coach side.
 *
 * Bound to `--coach-body`, the third of these to move off a literal. The value does not change --
 * the class was 16px and the token is 16px -- so nothing rendered moves; what changes is that the
 * number now lives once. The two before it were not so lucky: the eyebrow sat at 12 against a
 * token of 14 for a whole redesign pass, and the row name at a literal 17 against a token of 17,
 * which is the same bug in its silent phase.
 */
export const COACH_READING_CLASS = "text-[length:var(--coach-body)] leading-[1.55]";

/**
 * The sentence under a page title, one step up from body so the head reads as a head.
 *
 * **Deliberately not bound, and the reason is the general rule for this file.** 17px is also what
 * `--coach-row-name` holds, so a sweep matching literals against token *values* would bind this to
 * it. That would be wrong: a page's lead sentence and the name a lead row is about are two roles
 * that happen to agree today, and binding them means the next person who resizes row names in a
 * table silently resizes the sentence under every page title. Bind on role, never on value.
 *
 * It gets a token the day the coach scale names this role -- `--coach-lead` -- and not before.
 * `coach-type-floor.test.ts` records it in `DELIBERATELY_UNBOUND` so the decision is checked
 * rather than merely written here.
 */
export const COACH_LEAD_CLASS = "text-[17px] leading-[1.5] text-[color:var(--muted)]";

/**
 * A method note or a caveat under a block. Still 15px: the console prints these at 12px, which is
 * the size the round-1 demo feedback was about, and a footnote a coach cannot read is a footnote
 * that may as well say nothing.
 */
export const COACH_FOOTNOTE_CLASS = "text-[15px] leading-[1.5] text-[color:var(--muted)]";

/**
 * The name a row is about: a lead, a card, a stage column.
 *
 * Bound to `--coach-row-name` for the same reason `COACH_EYEBROW_CLASS` is bound to its token: the
 * sheet grew the token when `DayCounter`'s `Day N` figure needed this size in CSS, and a literal
 * `17` here beside a `17px` there is precisely the two-places-one-number condition that put the
 * eyebrow two pixels under the floor for a whole redesign pass. Binding it before the two can
 * disagree is cheaper than noticing later that they have.
 *
 * No fallback, so `token-references.test.ts` keeps checking it -- that test skips any `var()`
 * carrying one. All six callers were walked to confirm they render inside `[data-shell-role="coach"]`,
 * where the token is declared: `coach-support.tsx`, `coach-contacts.tsx`, `coach-conversations.tsx`
 * and `leads-surface.tsx` sit under `AppShell role="coach"`, and `get-started-checklist.tsx` does
 * too. Containment was checked rather than presence -- every usage is outside its file's dialog
 * ranges, and the one dialog that renders a helper of its own renders `KeyValueList`, which does
 * not use this class. A portalled caller would get an undefined property and silently fall back to
 * inherited size.
 */
export const COACH_ROW_NAME_CLASS =
  "text-[length:var(--coach-row-name)] leading-[1.35] font-[500] text-[color:var(--ink)]";

/**
 * The name at the top of a card or a section, where a `DeckPanel` is not what is being built.
 *
 * This is `.coach-panel__name`'s recipe exactly -- `--coach-panel-name`, weight 500, `-0.015em`,
 * 1.25, `--ink` -- and that is the point rather than a coincidence: the role is the same role, so
 * a hand-rolled heading over a sentence should not be able to drift away from the one a deck panel
 * renders. It arrived here as `CARD_TITLE_CLASS`, declared twice in byte-identical form in
 * `coach-integrations.tsx` and `get-started-checklist.tsx`, which is one constant written in two
 * files under one name; a third copy was the only thing stopping it from being three.
 *
 * Named for the role and not for the container it happened to sit in. `CARD_TITLE_CLASS` still
 * exists elsewhere in the lane meaning 15px in two files and something else again in a third, so
 * the name carries no size with it, and the name that does is the token's.
 */
export const COACH_PANEL_NAME_CLASS =
  "text-[length:var(--coach-panel-name)] leading-[1.25] font-[500] tracking-[-0.015em] "
    + "text-[color:var(--ink)]";

/**
 * The heading that opens a self-contained surface which is not a banded card: 20px at 600.
 *
 * A third attested role, not a drift between the two card shapes. The canvas draws it in exactly
 * two places and both are reproduced here property for property:
 * `CoachSupportBubble.dc.html:203` -- `font-size: 20px; font-weight: 600; letter-spacing:
 * -0.015em` in the header band of a 380px floating popover -- and `Agent.dc.html:211`, the first
 * line of a bandless well at `padding: 24px 28px`, over a 16px paragraph.
 *
 * **The discriminator is the eyebrow, not the band**, and it is worth being exact because the
 * obvious rule is wrong: the bubble's line sits at `padding: 20px 22px` closed by `border-bottom:
 * 1px solid var(--line)`, so this role appears in a banded context and a bandless one, and the
 * band cannot be what separates it from `COACH_PANEL_NAME_CLASS`. What separates them is the line
 * above. A banded card name at 500 is the second line of a two-line stack, under an eyebrow naming
 * the card's category -- that stack is what the 78px header floor reserves room for. Where there
 * is no eyebrow the title is the first thing in the band and carries its own category as well as
 * its name, and the extra hundred of weight is what pays for that.
 *
 * `escalation-panel.tsx` is the third caller and is an instance of the shape rather than a
 * drawing of its own: `SurfaceHeader` renders the same band, the same absent eyebrow, a title and
 * a `--muted` sub-line under it, matching `CoachSupportBubble.dc.html:203` structurally. Its own
 * comment records dropping the ESCALATIONS overline because "the title under it already says what
 * the panel is", which is exactly the case the heavier weight exists for.
 *
 * **Two sizes are spelled on that one element, and this one wins.** `SurfaceHeader`'s title
 * wrapper (`surface.tsx:121`) is `--t-section-title`, 14px at 600 -- the owner console's section
 * title, which is the density this component was built at. The class here rides on the child and
 * overrides size, leading and tracking. Anyone "simplifying" the span away drops the heading to
 * 14px on a coach surface, which is under the floor, so the span is load-bearing rather than
 * redundant.
 *
 * `Agent.dc.html` sets no `letter-spacing` while the bubble's line does. Both carry `-0.015em`
 * here deliberately: the canvas attests it on one of the two, and omitting it at 20px reads as an
 * oversight in the drawing rather than a second variant of the role.
 *
 * **Its size stays a literal, and there are two reasons, either of which is sufficient.** The
 * first is the ordinary one -- 20px is also what `--coach-panel-name` holds, and this role and the
 * banded panel name agree today without being the same thing, so binding them would mean moving
 * every card name in the product the next time a popover header changes. `coach-offer.tsx` was in
 * fact reading `var(--coach-panel-name)` to get its 20, which is that trap already sprung. The
 * second is harder: `coach-support-bubble.tsx` documents itself as mountable outside
 * `[data-shell-role="coach"]`, where a `--coach-*` token resolves to nothing at all and the
 * browser drops the whole declaration. A token here would not merely couple two roles, it would
 * fail open on one of the two callers.
 */
export const COACH_SURFACE_TITLE_CLASS =
  "m-0 text-[20px] leading-[1.25] font-semibold tracking-[-0.015em] text-[color:var(--ink)]";

/**
 * What the coach surface calls the four things the agent captures about a lead.
 *
 * One constant rather than two sets of literals because these appear twice, in two panes a coach
 * moves between constantly: the Inbox's lead rail reads them down as a stacked list, and the Leads
 * table reads three of them across as columns. They were "Credit range / Funding goal / Timeline /
 * Outcome" on both, and the artboards write "Credit / Wants / Timeline / Your agent decided" on
 * both. The rename is only an improvement if it lands on both -- a coach who sees "Wants" in a
 * thread and "Funding goal" in the table has been given two names for one number, which is a
 * worse screen than either version was.
 *
 * They are the plainer words on purpose. "Funding goal" and "Outcome" are the column names of a
 * CRM; "Wants" and "Your agent decided" are what the coach would say out loud, and the second of
 * those also names the actor, which the export header deliberately does not -- see
 * `leadExportRows`, where the machine-readable keys stay stable regardless of what the screen
 * calls them.
 */
export const LEAD_FACT_LABELS = {
  credit: "Credit",
  goal: "Wants",
  outcome: "Your agent decided",
  timeline: "Timeline",
} as const;
