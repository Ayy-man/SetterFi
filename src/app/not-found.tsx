import Link from "next/link";

import { CoachScale } from "@/components/coach-scale";
import { kitButtonClass, Prose } from "@/components/kit/atomics";
import { ChevronRight } from "@/components/kit/icons";
import { parseAppClaims, type UserRole, workspaceForRole } from "@/lib/auth/claims";
import { authMode } from "@/lib/auth/mode";
import { recoveryLinks } from "@/lib/auth/recovery-links";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Reads the role off the session cookie so the recovery links match who is
 * actually looking. A 404 must never fail on top of a 404, so any auth trouble
 * degrades to "no role" -- which routes to login, the one destination that is
 * correct for a session we cannot read.
 */
async function sessionRole(): Promise<UserRole | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    return parseAppClaims(data.claims).role;
  } catch {
    return null;
  }
}

/**
 * The wrong-address page, drawn at the coach density rather than at shadcn's defaults.
 *
 * It was the last page in the product still made of stock shadcn semantic classes -- `bg-background`
 * on the ground, `bg-card` on the panel, `bg-primary` on the action -- which meant it was the one
 * screen a token change could not move, and it looked it: a 14px system-font card in the middle of
 * a product that is navy, Geist and 16px everywhere else. `CoachScale` is how a page outside
 * `AppShell` reaches the coach language; see that component for why the stylesheet import lives
 * there rather than here.
 *
 * The 404 itself is the deck figure role -- mono, `-0.075em`, `0.92` leading -- rather than an
 * ornament, because that is the one role in the language whose whole job is a large number that
 * still reads as designed rather than as shouting. It is `--faint` rather than `--ink` on purpose:
 * the number is the least useful thing on the page and the two ways back are the most, so the
 * hierarchy the eye gets should not be the reverse of the hierarchy the reader needs.
 *
 * The copy says nothing is wrong with the account, because the reader of a 404 in a product that
 * answers their leads while they are not looking has one real question, and it is not "what is a
 * 404". `NotFound.dc.html` on the redesign canvas is the authority for that sentence and for this
 * layout.
 *
 * No panel and no fill is spent on the page beyond the single primary action: a dead end is the
 * correct resting state for the One Fill Rule, and boxing an apology in a card was the old page
 * giving weight to the part of the screen that carries none.
 *
 * **A coach sees less of it, and that is the 2026-09-04 coach board rather than a preference.**
 * `NotFound.dc.html` draws one sentence and one button, with no code on the page at all. The two
 * things it leaves out are aimed at the reader this surface exists for: a coach over 55 who
 * mistyped a URL does not know what a 404 is, so the figure is at best furniture and at worst the
 * page's most prominent element saying nothing they can use; and a second way out on a dead end is
 * a choice to make before they can leave. Both stay for admin and affiliate, where the reader
 * reads status codes for a living and the second link goes somewhere they use. The role is read
 * once, here, so the two omissions cannot drift apart or be applied to the wrong audience.
 */
export default async function NotFound() {
  const mode = authMode();
  const role = mode === "supabase" ? await sessionRole() : null;
  const [primary, ...secondary] = recoveryLinks({ mode, role });
  const isCoach = workspaceForRole(role) === "coach";

  return (
    <CoachScale
      as="main"
      className="grid min-h-dvh place-items-center bg-[var(--canvas)] px-[var(--s-5)] py-[var(--s-10)] text-[color:var(--ink)]"
    >
      {/*
        22px, which `NotFound.dc.html:94` draws and which `InboxEmpty.dc.html:111` draws for the
        same shape. It was `--s-5`, 20px, and the two-pixel difference is not the point: the point
        is that the product has exactly two centred dead-end screens, they are drawn as one thing,
        and `coach-conversations.tsx:1005` already spells this gap `gap-[22px]`. A scale step that
        happens to sit near the drawn value is how two screens that must agree drift apart.
      */}
      <div className="flex flex-col items-center gap-[22px] text-center">
        {isCoach ? null : (
          <span
            aria-hidden="true"
            className="font-[family-name:var(--font-mono)] text-[76px] leading-[var(--coach-figure-leading)] font-[500] tracking-[var(--coach-figure-tracking)] text-[color:var(--faint)]"
          >
            404
          </span>
        )}

        {/*
          38px, not the coach page title's 46. `NotFound.dc.html` draws it smaller than a page
          title on purpose: this heading sits under a 76px figure, and two large things stacked
          read as two headings competing rather than as a number with a sentence under it. The
          page also serves admin and affiliate, where 46px is not the local page-title scale at
          all, so a literal is more honest here than borrowing the coach token.
        */}
        {/*
          Leading is 1.1, not 1.05. `NotFound.dc.html:98` and `InboxEmpty.dc.html:128` draw the
          identical four values -- 38px, 600, -0.024em, 1.1 -- and `coach-conversations.tsx:1015`
          renders three of them and the fourth at 1.05 here alone. On a single line nothing moves;
          on the two-line wrap a narrow window gives this heading, it does. Same recipe, same
          numbers, in both places.
        */}
        <h1 className="m-0 text-[38px] leading-[1.1] font-[600] tracking-[-0.024em] text-[color:var(--ink)]">
          This page is not here
        </h1>

        {/*
          `tight` rather than `prose`: this is centred empty-state copy with nothing beside it, and
          a 68ch centred paragraph makes the reader's eye travel further to find the next line than
          the sentence is worth. `src/app/measures.test.ts` is why the value is a token.
        */}
        <Prose className="text-[18px] leading-[1.55] text-[color:var(--muted)]" measure="tight">
          The link may be old, or the page moved. Nothing is wrong with your account and your agent
          is still answering leads.
        </Prose>

        <div className="mt-[var(--s-2)] flex flex-wrap items-center justify-center gap-[var(--s-3)]">
          {/*
            Both faces come from `kitButtonClass` rather than being retyped here. The fill is nine
            values -- hairline, inset highlight, accent floor shadow -- and the 2026-08-30 craft
            audit found several lanes had each written their own slightly different copy of it, so
            the only safe way to spend the page's one fill is through the kit. What is overridden
            is the *size*: the kit's three heights are the console's 26/30/34px, and a coach on a
            phone needs the 52px the canvas draws.
          */}
          <Link className={kitButtonClass({
            className: "h-[52px] gap-[12px] rounded-[12px] px-[26px] text-[18px] no-underline",
            variant: "primary",
          })} href={primary.href}>
            {primary.label}
            {/*
              The trailing chevron `NotFound.dc.html:105` draws, at the artboard's 20px and gap of
              12px. It is the same glyph, in the same position, that `InboxEmpty.dc.html:134`
              gives its one way out and that `coach-conversations.tsx:1029` already renders -- and
              on both screens it is doing the same job: this is a dead end, and the arrow says the
              button leaves it. `aria-hidden` because the label beside it already names where.
            */}
            <ChevronRight aria-hidden className="size-[20px] shrink-0" />
          </Link>
          {/*
            One button for a coach. `recoveryLinks` still returns their inbox as a second way out
            and it is deliberately not drawn: the board gives this screen one action, and the
            destination it drops is one pill away from the destination it keeps. The list is
            filtered here rather than in `recoveryLinks` because that function answers "where can
            this session go", which is a fact about the session, and this is a decision about how
            much of the answer one screen should draw.
          */}
          {(isCoach ? [] : secondary).map((link) => (
            <Link
              className={kitButtonClass({
                className: "h-[52px] rounded-[12px] bg-[var(--well)] px-[24px] text-[17px] font-[500] no-underline",
              })}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </CoachScale>
  );
}
