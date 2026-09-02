/**
 * The page templates' vertical rhythm, as four distinct steps rather than one repeated value.
 *
 * Every template used to stack its blocks with a single `gap-[var(--s-4)]`, so the crumb, the
 * title, the stat strip, the scope row and the table all sat 16px apart and a page read as an
 * undifferentiated pile of equal-weight blocks. Nothing announced where the head ended and the
 * content began, and a page whose job was "scan two hundred rows" looked exactly like a page whose
 * job was "read four figures and one queue".
 *
 * These are the four breaks a page actually has. Each block picks the one that matches the
 * relationship it has with the block above it, so the spacing itself carries the structure and no
 * rule, tint or edge stripe has to.
 *
 * The values are written as whole literal class strings because Tailwind scans source text: a
 * class assembled at runtime from a variable never reaches the generated stylesheet.
 */
export const BREAK = {
  /**
   * 8px. The crumb and the title are one unit -- the trail labels the title rather than preceding
   * it -- so they sit closer together than any two blocks on the page.
   */
  crumb: "mb-[var(--s-2)]",
  /** 20px. The page head to the first block of content. The first real break on the page. */
  head: "mt-[var(--s-5)]",
  /**
   * 32px, from `--d-section-gap`. Between two sections that do different jobs: a summary strip and
   * the table under it, one settings card and the next. The largest break a page contains.
   */
  section: "mt-[var(--d-section-gap)]",
  /**
   * 12px. A control row to the thing it controls -- a scope switch over its table, a tab strip over
   * its panel. Deliberately tighter than a section break: the control belongs to the content.
   */
  control: "mt-[var(--s-3)]",
  /**
   * 24px. A page head to a bare text control strip. Tabs carry no border or ground of their own, so
   * they need more air above them than a bordered stat strip does to read as a separate register.
   */
  bareControl: "mt-[var(--s-6)]",
} as const;
