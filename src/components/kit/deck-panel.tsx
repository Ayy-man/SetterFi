import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The deck panel: the only card shape on the coach surface.
 *
 * Recovered from the round-3 build at commit 40c58b5 (`.sf-route-deck__panel` in
 * `workspace.css`), which the client preferred to the console layout that replaced it. Reading
 * that source rather than the screenshots in `docs/reference/branding/preview-shots/` is what
 * made this component possible: the pictures show a card with a big number in it, and hide the
 * fact that the card is five named parts in a fixed order. A first pass built from the pictures
 * produced a flat uniform grid, which is exactly what the layout is not.
 *
 * The five parts, all of them optional except the name:
 *
 *   eyebrow    the category, sentence case, above the name -- so the name can stay plain
 *   name       what the panel is
 *   action     one control, at the right of the header band, at a full 44px target
 *   figure     the number the coach opened the page for, mono and large
 *   sentence   one line saying what the figure means, never two
 *   footer     a widget, pushed to the bottom so a row of panels keeps its footers aligned
 *
 * Styling lives in `src/app/(workspace)/coach/coach.css` under `[data-shell-role="coach"]`
 * rather than in classnames here, because the anatomy is shared and the scale is not: the same
 * markup has to be able to render at coach size and, later, at console size. A component that
 * hard-codes `text-[62px]` cannot do that.
 */

export type DeckPanelDrench = "live" | "info";

export type DeckPanelNameSize = "hero" | "page";

/**
 * The two enlarged panel names the canvas draws, transcribed from the artboards that draw them.
 *
 * **They are two roles, not one size with two callers, and they must not be merged.** Both are
 * 26px, and "26px equals 26px" is the argument for collapsing them -- it is wrong, because the
 * size is the half they agree on. `hero` is a featured *card's* name inside a page that already
 * owns its `h1`; `page` is a panel that IS the page, so its name is the page's heading. A heading
 * that carries a page is drawn heavier and tighter than one that labels a card, and the canvas
 * draws exactly that difference. Merging them means picking one of these two artboards to render
 * wrong, and the one that lost last time was the error page -- for four rounds, at 20px.
 *
 * Held as a table rather than a ternary so that adding a third role means adding a row with a
 * citation, and so `deck-panel.test.tsx` can read both recipes out of one place and check each
 * against the artboard line named beside it -- which it does by parsing that line, not by
 * repeating the numbers below.
 */
const NAME_SIZE: Record<DeckPanelNameSize, string> = {
  /** `CoachTips.dc.html:123` -- the featured training card's name. */
  hero: "text-[26px]! font-[500]! tracking-[-0.018em]!",
  /** `CoachError.dc.html:102` -- the error panel's `h1`, which is the whole page's heading. */
  page: "text-[26px]! font-[600]! tracking-[-0.02em]!",
};

export type DeckPanelProps = {
  /** The category, above the name. Sentence case: the 9.5px uppercase overline is not used here. */
  eyebrow?: string;
  name: string;
  /**
   * One control in the header band. A link rather than a button because every use so far is a
   * destination, and a 44px square that navigates should be an anchor for the same reasons any
   * other navigation should be.
   */
  action?: { href: string; label: string; icon?: ReactNode };
  /**
   * Static content in the header band, which `action` could not carry because `action` is a link.
   *
   * `lead` sits before the eyebrow and name, `meta` after them at the band's right edge. They are
   * one idea -- something in the band that is not pressable -- in the two positions the band has,
   * and they are two props rather than one because the artboards use both ends and the end is the
   * whole point of each: `CoachError.dc.html` opens its panel with a warning tile *before* the
   * eyebrow, and `CoachTips.dc.html` sets each training's duration hard right against the name.
   * A single slot would have made one of those two the wrong shape.
   *
   * Neither takes a target. Anything pressable is `action`, so the band keeps exactly one control
   * and a reader never has to work out which of two things in it is the button.
   */
  lead?: ReactNode;
  meta?: ReactNode;
  /**
   * The heading level the panel's name renders at. `h2` by default, because a panel is almost
   * always one region among several under a page title that already owns the `h1`.
   *
   * `h1` exists for the one shape where the panel *is* the page: the coach error boundary draws a
   * single centred panel and nothing else, so with the default it opened at level two and the
   * document had no top-level heading at all -- a screen reader's heading list started midway down
   * an outline with no top, and "jump to the main heading" reached nothing. This is semantics only:
   * `coach.css` styles `.coach-panel__name` by class, so both levels draw at exactly the same size,
   * and a caller that changes the level changes nothing a sighted reader can see. Which is the
   * point -- the alternative was a second, visually-hidden heading repeating the visible one.
   */
  nameAs?: "h1" | "h2";
  /**
   * A panel name drawn larger than the banded 20px. There are two of these on the canvas, and
   * they are two roles rather than one size with two callers.
   *
   * - `hero` -- `CoachTips.dc.html:123`: **26px/500/-0.018em**. A featured *card* inside a page
   *   that has its own page title above it, banded with an eyebrow, and larger only because it
   *   leads the six cards under it.
   * - `page` -- `CoachError.dc.html:102`: **26px/600/-0.02em**. Not a card name at all. That
   *   screen is one centred panel and nothing else, so the panel is the page and its name is the
   *   page's `h1`. It is drawn a weight heavier and a hundredth of an em tighter than the Tips
   *   card, which is what a heading that carries a page looks like next to one that labels a card.
   *
   * The prop used to be `nameSize?: "hero"`, documenting itself as the canvas's *only* banded hero
   * name and citing Tips for it. That was wrong on its own terms -- there were two, and the error
   * page's is the heavier one -- and the error page consequently passed no `nameSize` at all and
   * rendered its `h1` at the ordinary 20px/500 for four rounds. A comment that asserts a
   * uniqueness the canvas does not have is what made a 6px difference invisible, so both drawings
   * are cited here and neither is described as the only one.
   *
   * Every declaration carries `!` because `[data-shell-role="coach"] .coach-panel__name` sets
   * size, weight and tracking at two-class specificity and outranks a bare utility class, which
   * it would otherwise do silently.
   *
   * Note what neither value touches: the radius. `hero` (the boolean, a different prop) moves the
   * card to `30px 30px 17px 17px`, which is a real canvas shape -- `Login.dc.html:70`,
   * `Landing.dc.html:93` and every card on `CoachLoading.dc.html` are drawn that way. The Tips
   * featured card is not one of them, at 24px like every other card on its screen; the error
   * panel *is* one of them and passes the boolean itself. So the two stay separate props because
   * the drawing separates them.
   */
  nameSize?: DeckPanelNameSize;
  figure?: ReactNode;
  /** One sentence. The measure is capped at `--measure-deck`, so a second one will not fit well. */
  sentence?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /**
   * Saturates the panel. At most two on a screen and nothing else fills -- the accent only reads
   * as emphasis while it stays scarce, and round 3's failure mode was a deck where every panel
   * wanted to be the important one.
   */
  drench?: DeckPanelDrench;
  /** Larger top corners. One panel per screen at most, and only when it leads the deck. */
  hero?: boolean;
  /** Lifts 2px on hover. Only for a panel that is itself a link to somewhere. */
  liftable?: boolean;
  /**
   * An id for the panel's own heading, which also becomes the section's `aria-labelledby`.
   *
   * A bare `<section>` is not a landmark: without an accessible name assistive technology skips
   * it entirely, so a page built out of these would announce as one undifferentiated run of
   * content. The panels on coach Home get away with it because the deck sits inside a section
   * that is already labelled; a panel used on its own as a page region needs its own name, which
   * is what this gives it without asking the caller to render a second heading.
   */
  headingId?: string;
  /**
   * A `data-slot` hook on the panel's root, for tests and for a caller that renders several
   * panels of one kind and needs to address them. Additive and inert: the panel draws the same
   * whether or not it is passed, and nothing in either stylesheet keys on it.
   */
  dataSlot?: string;
  className?: string;
};

export function DeckPanel({
  action,
  children,
  className,
  dataSlot,
  drench,
  eyebrow,
  figure,
  footer,
  headingId,
  hero,
  lead,
  liftable,
  meta,
  name,
  nameAs,
  nameSize,
  sentence,
}: DeckPanelProps) {
  const Name = nameAs ?? "h2";

  return (
    <section
      aria-labelledby={headingId}
      className={`coach-panel${className ? ` ${className}` : ""}`}
      data-drench={drench}
      data-slot={dataSlot}
      data-hero={hero ? "true" : undefined}
      data-liftable={liftable ? "true" : undefined}
    >
      <header className="coach-panel__header">
        {lead === undefined ? null : <div className="flex-none">{lead}</div>}
        <div className="min-w-0">
          {eyebrow ? <p className="coach-panel__eyebrow">{eyebrow}</p> : null}
          <Name
            className={cn(
              "coach-panel__name",
              nameSize ? NAME_SIZE[nameSize] : null,
            )}
            id={headingId}
          >
            {name}
          </Name>
        </div>
        {meta === undefined ? null : <div className="ml-auto flex-none">{meta}</div>}
        {action ? (
          <Link aria-label={action.label} className="coach-panel__action" href={action.href}>
            {action.icon ?? <DeckPanelChevron />}
          </Link>
        ) : null}
      </header>

      <div className="coach-panel__body">
        {figure === undefined ? null : <p className="coach-panel__figure">{figure}</p>}
        {sentence === undefined ? null : <p className="coach-panel__sentence">{sentence}</p>}
        {children}
        {footer === undefined ? null : <div className="coach-panel__footer">{footer}</div>}
      </div>
    </section>
  );
}

/**
 * The default header action, drawn rather than imported so the panel has no icon-set dependency.
 * `aria-hidden` because the link around it already carries the label.
 */
function DeckPanelChevron() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/*
 * ---------------------------------------------------------------------------------------------
 * The second card shape.
 *
 * The canvas draws two, and the discriminator is the header band rather than the column count or
 * the width. `.planning/design/canvas/audit/round4-coach-secondary.md` settles it mechanically
 * across all 55 artboards: every 20px/500 name sits inside a hairline-closed band (52 of 57; the
 * five exceptions are row labels and prices, not panel names), and every 22px/600 title sits on a
 * card with no band at all -- ten of ten, none of them on the 78px floor. So a size prop on
 * `DeckPanel` would have been the wrong fix: what changes between the two is the anatomy, and the
 * type scale is a consequence of it.
 *
 * The rule that reading looks like it should be -- "20px in a multi-column row, 22px full width"
 * -- is false, and it is written down here because it is plausible enough to be re-derived by the
 * next reader. `Billing.dc.html:98` and `:125` are 22px titles inside a two-column row, and
 * `CoachPlanChange.dc.html:108,129,153` are 20px banded names inside a three-column one.
 *
 * `Billing.dc.html:151` ("Did they show up?") is this shape and not a third one. Its card does
 * carry a rule under the title, but the anatomy above the rule is the title-led anatomy exactly:
 * no eyebrow, no 78px floor, a 22px/600 title as the first line with its sentence under it, at
 * `24px 30px`. The hairline is there because what follows is a list of rows that need separating
 * from the head, not because the head is a band -- which is what `divided` is.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * The title-led card's title: 22px/600, weight-and-anatomy distinct from a banded name.
 *
 * The distinction is the weight and the missing band, not the size. This docblock said "the size
 * no banded panel in the canvas ever uses" and that was false: a census of all 55 artboards parsed
 * into a DOM on 2026-09-01 found three banded panels at 22px, and they are 22px/**500** `h2`s in a
 * `22px 26px` band -- `Main.dc.html:309`, `Main.dc.html:370`, `Affiliate.dc.html:167`, all three
 * byte-identical and spanning coach and affiliate. So this title is not the canvas's only 22px
 * heading; it is the only one that is 600 and sits on a card with no band, which is what a title
 * leading a card looks like next to a name labelling a banded one.
 *
 * That correction is the second time this file has made the same mistake, and `:108-113` above
 * narrates the first: `nameSize` documented itself as the canvas's only banded hero name, there
 * were two, and the error page's `h1` rendered 6px small for four rounds because the sentence
 * asserting uniqueness was read as settled. The lesson did not carry because it was written as a
 * story about that one prop rather than about the shape of the sentence. So, stated generally: **a
 * superlative is a dated census result.** It carries its corpus, method and date -- "3 of 55
 * artboards, parsed 2026-09-01" -- or it is not written. Where the real distinction is not about
 * count at all, name the axis and drop the superlative, because the superlative was never the part
 * doing the work.
 *
 * Exported because two headings on `coach-billing.tsx` are already unbanded and were simply
 * rendering at the banded name's 20px. One definition, so the shape and the sizes that belong to
 * it cannot drift apart.
 */
export const TITLE_PANEL_TITLE_CLASS =
  "m-0 text-[22px] leading-[1.25] font-semibold tracking-[-0.015em]";

export type TitlePanelProps = {
  title: string;
  /**
   * `h2` by default, for the same reason `DeckPanel` names itself at level two: a title-led card
   * is one region among several under a page title that owns the `h1`.
   */
  titleAs?: "h2" | "h3";
  /** One line under the title. The card's first two lines are the title and this. */
  sentence?: ReactNode;
  /**
   * Content held to the right of the title and its sentence, vertically centred against them.
   *
   * `MeetYourAgent.dc.html:213` is the shape that needs it: a flat drenched row whose two
   * decisions sit beside the sentence rather than under it, which is what makes the panel read as
   * the decision it exists for instead of as a card with buttons at the bottom.
   */
  aside?: ReactNode;
  /**
   * How the aside sits against the title block. `start` by default, because that is what the
   * canvas draws five times out of six: `Agent.dc.html:107` and its three siblings set a state
   * pill hard right and hard *top*, level with the title rather than with the block.
   *
   * `center` is the go-live row alone (`MeetYourAgent.dc.html:213`, `align-items: center`), where
   * the aside is two 56px controls that would hang off the top of a two-line head if they started
   * with it. The default was `center` for one commit, inferred from that single artboard before
   * the other five had been read.
   */
  asideAlign?: "start" | "center";
  /**
   * Closes the head with a hairline and drops the card's own padding, for a card whose body is a
   * list of rows that carry their own. Still the title-led shape -- see the note above.
   */
  divided?: boolean;
  drench?: DeckPanelDrench;
  headingId?: string;
  dataSlot?: string;
  className?: string;
  children?: ReactNode;
};

/**
 * The title-led card: no header band, a 22px/600 title as the body's first line.
 *
 * It reuses `.coach-panel` for the card face -- the border, the asymmetric radius, the gradient
 * and the two drench grounds all live there and are shared between the shapes -- and renders none
 * of the band's parts. The type and the padding are Tailwind rather than `coach.css` because this
 * lane does not own that stylesheet; `coach-offer.tsx`'s `OfferCard` already writes the same shape
 * the same way, and collapsing the two is a follow-up that needs that file's owner.
 *
 * The drench colours are branched in JS rather than written as `group-data-` variants so that what
 * a drenched title is coloured with is readable at the point the class is chosen.
 */
export function TitlePanel({
  aside,
  asideAlign,
  children,
  className,
  dataSlot,
  divided,
  drench,
  headingId,
  sentence,
  title,
  titleAs,
}: TitlePanelProps) {
  const Title = titleAs ?? "h2";

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "coach-panel min-w-0",
        divided ? null : "px-[30px] py-[28px]",
        className,
      )}
      data-drench={drench}
      data-slot={dataSlot}
      data-title-led="true"
    >
      <div
        className={cn(
          /*
            Wrapping, and the basis is what makes it wrap rather than crush. `aside` is `flex-none`
            -- two 56px controls on the go-live row -- so on a phone the title would otherwise be
            squeezed to a few characters a line beside them. With a basis the text block claims a
            full row of its own the moment it cannot hold 32 characters, and the aside drops under
            it, which is what `CoachHomeMobile.dc.html` does with every side-by-side pair.
          */
          "flex flex-wrap gap-[20px]",
          asideAlign === "center" ? "items-center" : "items-start",
          divided
            ? "border-b border-[var(--line-soft)] px-[30px] py-[24px]"
            : children === undefined
              ? null
              : "mb-[26px]",
        )}
      >
        <div className="min-w-0 flex-1 basis-[min(100%,32ch)]">
          <Title
            className={cn(
              TITLE_PANEL_TITLE_CLASS,
              drench ? "text-[color:var(--on-accent)]" : "text-[color:var(--ink)]",
            )}
            id={headingId}
          >
            {title}
          </Title>
          {sentence === undefined ? null : (
            <p
              className={cn(
                "m-0 mt-[6px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5]",
                drench
                  ? "text-[color:var(--coach-on-drench-sub)]"
                  : "text-[color:var(--muted)]",
              )}
            >
              {sentence}
            </p>
          )}
        </div>
        {aside === undefined ? null : <div className="flex-none">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
