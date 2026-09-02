import Link from "next/link";

import { CoachScale } from "@/components/coach-scale";
import { kitButtonClass, Prose } from "@/components/kit/atomics";

/**
 * The public page, and the only surface in the product written for someone who has not bought
 * anything yet.
 *
 * `Landing.dc.html` on the redesign canvas is the authority for every word and every measurement
 * here. What it is arguing is worth naming, because it is unusual for a SaaS marketing page and
 * the restraint is deliberate: the hero shows a real exchange rather than a product screenshot,
 * the proof band is one coach's month rather than a platform-wide total, and the A2P answer says
 * three weeks out loud instead of hiding behind "fast setup". A coach over 55 who has been sold
 * an AI tool before is reading this, and the thing that makes the page credible is that it keeps
 * declining to overclaim in exactly the places a worse page would.
 *
 * ONE DRENCHED PANEL, the proof band. `docs/REDESIGN-CANVAS.md` sets the ceiling at two per
 * screen and this page spends one of them: the middle pricing card used to take the second, and
 * `docs/DECISIONS.md` DEC12 names picking the middle row as manufacturing a recommendation nobody
 * made, so the three plans are three plain cards. Everything else on the page is a plain deck panel,
 * and there is exactly one accent fill face -- "Start your setup" -- repeated as the same action
 * rather than as three competing ones.
 *
 * EVERY FIGURE HAS A READ BEHIND IT. The prices and allowances are projected from the signup tier
 * catalogue by `src/app/page.tsx`, not typed here; see `LandingPlan` below for what that fixed.
 *
 * NO COST OR MARGIN ANYWHERE. The money on this page is subscription prices, which is what a
 * coach is buying; model spend and cost-per-call are owner-console figures and appear nowhere a
 * coach or a lead can reach.
 *
 * The proof band's figures carry a "Demo workspace data" marker on the band itself, because they
 * are seeded records rather than a live tenant's month and the hard rule is that test data is
 * labelled where it is shown, not in a footnote.
 */

/** The one action the page is asking for, drawn once so the three placements cannot drift apart. */
function StartSetup({ className }: { className?: string }) {
  return (
    <Link
      className={kitButtonClass({
        className: `h-[62px] rounded-[13px] px-[32px] text-[19px] no-underline ${className ?? ""}`,
        variant: "primary",
      })}
      href="/signup"
    >
      Start your setup
      <Chevron />
    </Link>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" className="size-[20px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/* The deck panel's anatomy, written once. Larger radius on top, header band closed by a hairline. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[var(--coach-panel-radius)] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]";
const PANEL_HERO =
  "flex flex-col overflow-hidden rounded-[var(--coach-panel-radius-hero)] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]";
const PANEL_HEAD = "border-b border-[var(--line)] px-[22px] py-[15px]";
/* Sentence case at 12px, per `coach.css`. This page carries no uppercase overline anywhere. */
const EYEBROW = "m-0 mb-[3px] block text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";
const PANEL_NAME =
  "m-0 text-[length:var(--coach-panel-name)] font-[500] leading-[1.25] tracking-[-0.015em] text-[color:var(--ink)]";
/* Mono, tight in both directions. The one role in the language whose job is a large number. */
const FIGURE =
  "font-[family-name:var(--font-mono)] font-[500] tabular-nums leading-[var(--coach-figure-leading)] tracking-[var(--coach-figure-tracking)]";
const SECTION_TITLE =
  "m-0 text-[40px] font-[600] leading-[1.08] tracking-[-0.026em] text-[color:var(--ink)]";

const CONVERSATION = [
  { author: "lead", text: "Saw your reel. I need about 50k to buy equipment for my shop." },
  {
    author: "agent",
    text: "Happy to help. Two quick things and I’ll know if we can: what’s your personal credit score sitting at right now, and how long has the shop been open?",
  },
  { author: "lead", text: "Around 690, and we opened in early 2024." },
  {
    author: "agent",
    text: "That’s the range Marcus works with. He has Tuesday 2:00pm or Wednesday 10:30am open. Which suits you?",
  },
] as const;

const PROOF = [
  {
    figure: "214",
    good: false,
    sentence: "Leads answered. Every one got a reply, including the ones who wrote at midnight.",
  },
  {
    figure: "18",
    good: true,
    sentence: "Calls booked with people who cleared his own credit and revenue floor.",
  },
  {
    figure: "5.2h",
    good: false,
    sentence: "Average from a lead’s first message to a call sitting on his calendar.",
  },
] as const;

const STEPS = [
  {
    eyebrow: "Wherever they message you",
    name: "A lead sends a DM",
    body: "A comment reply, a story reply, a message to your Facebook page. Your agent picks it up in seconds, at two in the morning or in the middle of your own client call.",
  },
  {
    eyebrow: "Against your own criteria",
    name: "It qualifies them",
    body: "Credit score, time in business, monthly revenue, what the money is for. It knows how funding actually works, and it knows the floors you set, so a 540 with no entity gets a straight answer instead of your Tuesday.",
  },
  {
    eyebrow: "On your real calendar",
    name: "The good ones book",
    body: "It offers the slots you have open and confirms the one they pick. You open your phone to a booked call and the whole conversation that led to it, in order.",
  },
] as const;

const QUESTIONS = [
  {
    eyebrow: "Voice",
    name: "Will it sound like me?",
    body: "You pick the tone in setup, paste in a few messages you have actually sent, and read the first draft before anyone else does. If a reply reads wrong, you change the wording and it stays changed.",
  },
  {
    eyebrow: "Promises",
    name: "Will it promise things I can’t deliver?",
    body: "It cannot. Prices, guarantees and outcomes are locked to what you typed in yourself. Asked for a number it does not have, it says it will not guess and hands the conversation to you, flagged.",
  },
  {
    eyebrow: "Your existing list",
    name: "What happens to the leads I already have?",
    body: "They come with you and nothing goes out on day one. Your agent starts on new messages only. When you are ready, you choose a group of old leads and approve the opener before a single one is sent.",
  },
] as const;

/**
 * One plan as this page draws it, projected from the signup tier catalogue rather than typed here.
 *
 * Every figure on the card -- the monthly price and the booked-call allowance -- comes from
 * `public.list_signup_tier_catalog`, the same read `/signup` uses, resolved server-side in
 * `src/app/page.tsx`. This page used to hard-code `$297` / `$497` / `$997` and three allowances as
 * string literals, which is the grounding rule broken on the most externally visible surface in
 * the product: a stranger was quoted three prices no read stood behind, and an operator editing a
 * tier moved `/signup` and left this page saying the old number with nothing to catch it.
 *
 * The catalogue is reached without widening anything public. `/` is already the one exact path
 * `src/proxy.ts` lets a signed-out request through to, the page is `force-dynamic`, and the RPC is
 * granted to `anon` -- so the read happens on the server during that request and no new route or
 * public endpoint exists.
 *
 * `price` is nullable because the catalogue genuinely may not state one: the priced read is
 * `list_signup_tier_offer_catalog` and it only serves the catalogue while `tierOfferTermsLive()`
 * is on. A card with no price says nothing about money rather than falling back to a figure.
 */
export type LandingPlan = {
  id: string;
  name: string;
  /** Booked calls included, from `tiers.call_allowance`. */
  callAllowance: number;
  price: { amount: string; period: string } | null;
};

/**
 * What a plan is *for*, keyed by the operator's own tier name. This is copy rather than data --
 * no figure lives here, and a tier the catalogue returns that nobody has written copy for renders
 * as its name, its price and its allowance, which is a complete true card rather than one wearing
 * another plan's promises.
 *
 * Two things the artboard draws are deliberately not here, both `docs/DECISIONS.md`: the per-call
 * overage rate ("then $34 each"), which no column, contract field or env value in this product
 * records, and the "Most coaches start here" recommendation, which the catalogue has no
 * recommended flag to support. Keying either off a plan's name would be the page manufacturing it.
 */
const PLAN_COPY: Record<string, { eyebrow: string; features: readonly string[] }> = {
  starter: {
    eyebrow: "One account, one calendar",
    features: ["Instagram, Messenger and texting", "Your own prices and qualifying rules", "Booking straight onto your calendar"],
  },
  growth: {
    eyebrow: "One account, your existing list",
    features: ["Everything in Starter", "Reactivate the leads already on your list", "Someone from the team who knows your account"],
  },
  scale: {
    eyebrow: "A team taking the calls",
    features: ["Everything in Growth", "Several closers sharing one inbox", "Calls routed by who has room"],
  },
};

function planCopy(name: string) {
  return PLAN_COPY[name.trim().toLocaleLowerCase()] ?? null;
}

export function LandingPage({ plans }: { plans: readonly LandingPlan[] }) {
  return (
    <CoachScale
      as="main"
      className="min-h-dvh bg-[var(--canvas)] text-[color:var(--body)]"
      style={{ backgroundImage: "var(--pane-bloom)" }}
    >
      <header className="flex flex-wrap items-center justify-between gap-[var(--s-4)] border-b border-[var(--line)] px-[var(--s-5)] py-[var(--s-3)] sm:px-[48px]">
        <p className="m-0 flex items-center gap-[var(--s-3)]">
          <span className="grid size-[38px] place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]">
            <svg aria-hidden="true" className="size-[20px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </span>
          <span className="text-[20px] font-[600] tracking-[-0.014em] text-[color:var(--ink)]">
            Setter<span className="text-[color:var(--accent-text)]">Fi</span>
          </span>
        </p>
        <nav aria-label="Site" className="flex flex-wrap items-center gap-[var(--s-6)]">
          <a className="text-[16px] font-[500] text-[color:var(--muted)] no-underline hover:text-[color:var(--ink)]" href="#how-it-works">
            How it works
          </a>
          <a className="text-[16px] font-[500] text-[color:var(--muted)] no-underline hover:text-[color:var(--ink)]" href="#pricing">
            Pricing
          </a>
          <Link className="text-[16px] font-[500] text-[color:var(--muted)] no-underline hover:text-[color:var(--ink)]" href="/login">
            Sign in
          </Link>
          <Link
            className={kitButtonClass({ className: "h-[48px] rounded-[11px] px-[24px] text-[16px] no-underline", variant: "primary" })}
            href="/signup"
          >
            Start your setup
          </Link>
        </nav>
      </header>

      {/* Hero. One sentence about the offer, one button, and a real exchange beside it. */}
      <section className="flex flex-col items-start gap-[40px] px-[var(--s-5)] pt-[56px] pb-[64px] sm:px-[48px] lg:flex-row lg:items-center lg:gap-[56px] lg:pt-[76px]">
        <div className="min-w-0 flex-1">
          <span className="mb-[22px] inline-block rounded-[var(--r-full)] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[12px] py-[6px] font-[family-name:var(--font-mono)] text-[length:var(--coach-eyebrow)] tracking-[0.03em] text-[color:var(--accent-text)]">
            For credit and business-funding coaches
          </span>
          {/*
            The measure comes from `--measure-deck` rather than the canvas's literal `17ch`.
            `src/app/measures.test.ts` refuses a hand-rolled `ch` value and it is right to -- the
            Line Length rule had already drifted across eleven of them -- and naming the token here
            means a headline this size moves when the measure does.
          */}
          <h1 className="m-0 mb-[22px] max-w-[var(--measure-deck)] text-[clamp(40px,5vw,62px)] font-[600] leading-[1.04] tracking-[-0.03em] text-[color:var(--ink)]">
            Every funding DM answered, qualified and booked, without you.
          </h1>
          <Prose className="m-0 mb-[32px] text-[20px] leading-[1.55] text-[color:var(--muted)]" measure="tight">
            Your agent replies to Instagram and Facebook messages in your voice, asks the
            credit-score, revenue and time-in-business questions you would ask, and puts the people
            who actually qualify on your calendar. The rest it turns down politely, with the reason
            written on the record.
          </Prose>
          <div className="flex flex-wrap items-center gap-[var(--s-5)]">
            <StartSetup />
            <Prose className="text-[16px] leading-[1.45] text-[color:var(--faint)]" measure="caption">
              Answering your DMs the same day. No contract, cancel from your billing page.
            </Prose>
          </div>
        </div>

        <div className={`${PANEL_HERO} w-full lg:w-[512px] lg:flex-none`}>
          <div className={`${PANEL_HEAD} flex items-start justify-between gap-[var(--s-3)]`}>
            <div>
              <span className={EYEBROW}>Instagram, 7:41pm on a Sunday</span>
              <h2 className={PANEL_NAME}>A real qualification</h2>
            </div>
            <span className="flex h-[34px] flex-none items-center gap-[9px] rounded-[var(--r-full)] border border-[var(--good-line)] bg-[var(--good-wash)] px-[14px] text-[15px] text-[color:var(--good-text)]">
              <span aria-hidden="true" className="size-[8px] rounded-[var(--r-full)] bg-[var(--good)]" />
              Booked
            </span>
          </div>
          <div className="flex flex-col gap-[var(--s-3)] p-[22px]">
            {CONVERSATION.map((turn) => (
              <p
                className={
                  turn.author === "lead"
                    ? "m-0 max-w-[82%] self-start rounded-[16px_16px_16px_6px] border border-[var(--line)] bg-[var(--well)] px-[17px] py-[13px] text-[16px] leading-[1.45] text-[color:var(--body)]"
                    : "m-0 max-w-[82%] self-end rounded-[16px_16px_6px_16px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[17px] py-[13px] text-[16px] leading-[1.45] text-[color:var(--ink)]"
                }
                key={turn.text}
              >
                {turn.text}
              </p>
            ))}
          </div>
          <p className="m-0 mt-auto flex items-center gap-[10px] border-t border-[var(--line-soft)] px-[22px] py-[var(--s-4)] text-[15px] text-[color:var(--faint)]">
            <ShieldIcon className="size-[17px] flex-none" />
            Your agent quotes only the numbers you gave it. It cannot invent a price, a rate or a
            promise.
          </p>
        </div>
      </section>

      {/* Proof band. The one drenched panel this page spends -- see the docblock; DEC12 is why
          there is no second. */}
      <section className="px-[var(--s-5)] pb-[64px] sm:px-[48px]">
        <div
          className="overflow-hidden rounded-[var(--coach-panel-radius-hero)] border border-transparent text-[color:var(--on-accent)]"
          style={{ background: "var(--coach-drench-live)" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-[var(--s-6)] border-b border-[var(--coach-on-drench-line)] px-[26px] py-[19px]">
            <div>
              <span className="m-0 mb-[4px] block text-[14px] leading-[1.4] text-[color:var(--coach-on-drench-sub)]">
                One coach, one month, one Instagram account
              </span>
              <h2 className="m-0 text-[length:var(--coach-panel-name)] font-[500] leading-[1.25] tracking-[-0.015em]">
                What August looked like at Reid Funding Group
              </h2>
            </div>
            {/*
              The seeded-data marker, on the band that carries the numbers rather than in a
              footnote. These three figures come from the demo tenant, which is excluded from
              analytics, and the rule is that test data says so where it is read.
            */}
            <span className="flex-none rounded-[8px] border border-[rgba(255,255,255,0.22)] bg-[rgba(255,255,255,0.1)] px-[11px] py-[5px] font-[family-name:var(--font-mono)] text-[length:var(--coach-eyebrow)] tracking-[0.04em] text-[color:var(--coach-on-drench-sub)]">
              Demo workspace data
            </span>
          </div>
          <div className="grid gap-[40px] px-[26px] pt-[30px] pb-[32px] sm:grid-cols-3">
            {PROOF.map((item) => (
              <div key={item.figure}>
                <p className={`m-0 text-[length:var(--coach-figure)] ${FIGURE} ${item.good ? "text-[color:var(--good-text)]" : ""}`}>
                  {item.figure}
                </p>
                <Prose className="mt-[var(--s-3)] text-[16px] leading-[1.5] text-[color:var(--coach-on-drench-sub)]" measure="caption">
                  {item.sentence}
                </Prose>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works, in three beats. */}
      <section className="px-[var(--s-5)] pb-[64px] sm:px-[48px]" id="how-it-works">
        <div className="mb-[26px]">
          <span className="mb-[var(--s-2)] block text-[15px] text-[color:var(--muted)]">How it works</span>
          <h2 className={SECTION_TITLE}>Three things happen. You only turn up for the third.</h2>
        </div>
        <div className="grid gap-[18px] sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <article className={PANEL} key={step.name}>
              <div className={`${PANEL_HEAD} flex items-center gap-[14px]`}>
                <span
                  aria-hidden="true"
                  className="grid size-[38px] flex-none place-items-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--well)] font-[family-name:var(--font-mono)] text-[16px] text-[color:var(--muted)]"
                >
                  {index + 1}
                </span>
                <div>
                  <span className={EYEBROW}>{step.eyebrow}</span>
                  <h3 className={PANEL_NAME}>{step.name}</h3>
                </div>
              </div>
              <p className="m-0 p-[22px] text-[17px] leading-[1.55] text-[color:var(--body)]">{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* The four fair questions. The fourth is the honest one, so it carries its own note. */}
      <section className="px-[var(--s-5)] pb-[64px] sm:px-[48px]">
        <div className="mb-[26px]">
          <span className="mb-[var(--s-2)] block text-[15px] text-[color:var(--muted)]">
            The things coaches ask before they sign up
          </span>
          <h2 className={SECTION_TITLE}>The four fair questions</h2>
        </div>
        <div className="grid gap-[18px] sm:grid-cols-2">
          {QUESTIONS.map((question) => (
            <article className={PANEL} key={question.name}>
              <div className={PANEL_HEAD}>
                <span className={EYEBROW}>{question.eyebrow}</span>
                <h3 className={PANEL_NAME}>{question.name}</h3>
              </div>
              <p className="m-0 p-[22px] text-[17px] leading-[1.55] text-[color:var(--body)]">{question.body}</p>
            </article>
          ))}

          {/*
            The A2P answer, and the reason it is drawn apart from the other three.
            Carrier vetting genuinely takes two to three weeks per coach and nobody on either side
            of this page controls it, so the page says the number out loud and then says what it
            will show instead of a finish date. Promising a date here is the exact claim the
            product's honest-states rule exists to stop, and a marketing page is where that
            promise would be most tempting to make.
          */}
          <article className={PANEL}>
            <div className={PANEL_HEAD}>
              <span className={EYEBROW}>Time to live</span>
              <h3 className={PANEL_NAME}>How long before it is working?</h3>
            </div>
            <div className="flex flex-col gap-[14px] p-[22px]">
              <p className="m-0 text-[17px] leading-[1.55] text-[color:var(--body)]">
                Instagram and Messenger answer within a day of you connecting them. Text messaging
                is slower and we will not pretend otherwise: US carriers vet every business that
                wants to send texts, and that takes about three weeks.
              </p>
              <p className="m-0 flex items-start gap-[var(--s-3)] rounded-[11px] border border-[var(--waiting-line)] bg-[var(--waiting-wash)] px-[var(--s-4)] py-[14px] text-[16px] leading-[1.5] text-[color:var(--waiting-text)]">
                <ClockIcon className="mt-[2px] size-[20px] flex-none" />
                While it runs we show you the day count and nothing else. Nobody can give you a
                finish date, so we do not invent one.
              </p>
            </div>
          </article>
        </div>
      </section>

      {/* Pricing. Priced by booked calls, because that is what a coach is buying. */}
      <section className="px-[var(--s-5)] pb-[64px] sm:px-[48px]" id="pricing">
        <div className="mb-[26px]">
          <span className="mb-[var(--s-2)] block text-[15px] text-[color:var(--muted)]">Pricing</span>
          <h2 className={`${SECTION_TITLE} mb-[10px]`}>Pick the number of booked calls you want a month</h2>
          <Prose className="text-[18px] leading-[1.5] text-[color:var(--muted)]" measure="wide">
            Every plan is the same agent on the same channels. The only difference is how many
            booked calls are included before extra ones are billed.
          </Prose>
        </div>
        {plans.length === 0 ? (
          /*
           * The catalogue could not be read, or it holds no active tier. A marketing page cannot
           * fall back to remembered prices here -- that is exactly the invented figure this
           * section stopped printing -- so it says the plans are not loading and sends the reader
           * to the one surface that quotes them from the same read.
           */
          <div className={`${PANEL} px-[22px] py-[var(--s-6)]`}>
            <p className="m-0 text-[18px] leading-[1.5] text-[color:var(--muted)]">
              Plans are not loading right now, so there is no price on this page to read. The
              current plans and what each one includes are on the setup page.
            </p>
          </div>
        ) : (
        <div className="grid gap-[18px] sm:grid-cols-3">
          {plans.map((plan) => {
            /*
             * No plan is singled out, by a pill or by a fill.
             *
             * This card was `plan.name === "Growth"` wearing a "Most picked" pill, which is
             * `docs/DECISIONS.md` DEC12's recommendation under another name: the catalogue returns
             * operator-chosen labels with no recommended flag, so nothing in this product knows
             * which plan most coaches pick. The pill went, and the fill moved to the middle
             * position on the reasoning that a position asserts nothing -- but DEC12 names that
             * move specifically, alongside matching `/growth/i`, as the page manufacturing a
             * recommendation nobody made. A filled middle card in a row of three is the standard
             * way a pricing page says "this one", which is exactly why the artboard drenched
             * Growth; the reader takes the claim whether or not the code writes a word.
             *
             * So the ceiling of two drenched panels is spent on the proof band alone here, and
             * three plain cards is the honest shape until a `recommended` flag exists to render
             * from. Alec flips this by naming a tier, per DEC12. It is also why no pricing card
             * carries an accent-filled button: three buttons competing here would be three live
             * actions on a page that has one.
             */
            const copy = planCopy(plan.name);
            return (
              <article
                className={PANEL}
                key={plan.id}
              >
                <div
                  className="flex items-start justify-between gap-[var(--s-3)] border-b border-[var(--line)] px-[22px] py-[15px]"
                >
                  <div>
                    {copy ? (
                      <span className={EYEBROW}>
                        {copy.eyebrow}
                      </span>
                    ) : null}
                    <h3 className={PANEL_NAME}>
                      {plan.name}
                    </h3>
                  </div>
                </div>
                <div className="px-[22px] py-[var(--s-6)]">
                  {/*
                    The price, or nothing at all where the catalogue did not state one. Never a
                    remembered figure and never a zero: "$0 a month" is a claim somebody would be
                    owed at, and a card that stays quiet about money while still naming what the
                    plan includes is a complete true card.
                  */}
                  {plan.price ? (
                    <p className="m-0 flex items-baseline gap-[10px]">
                      <span className={`text-[52px] ${FIGURE}`}>{plan.price.amount}</span>
                      <span className="text-[17px] text-[color:var(--muted)]">
                        {plan.price.period}
                      </span>
                    </p>
                  ) : (
                    <p className="m-0 text-[17px] leading-[1.5] text-[color:var(--muted)]">
                      The current price is shown when you start your setup.
                    </p>
                  )}
                  {/*
                    What the money buys, which is the number the plans actually differ on. The
                    artboard's line is "10 booked calls included, then $34 each" and only the first
                    half is here: no column, contract field or env value in this product records a
                    per-call overage price, so the second half would be a public page inventing a
                    number a customer is then owed at. `/signup` stops in the same place.
                  */}
                  <p
                    className="m-0 mt-[var(--s-3)] max-w-[var(--measure-deck)] text-[16px] leading-[1.5] text-[color:var(--muted)]"
                  >
                    <span className="text-[color:var(--ink)]">{plan.callAllowance}</span>
                    {plan.callAllowance === 1 ? " booked call included a month." : " booked calls included a month."}
                  </p>
                </div>
                {copy ? (
                  <ul
                    className="m-0 mt-auto flex list-none flex-col gap-[var(--s-3)] border-t border-[var(--line-soft)] p-[22px] text-[16px] text-[color:var(--body)]"
                  >
                    {copy.features.map((feature) => <li key={feature}>{feature}</li>)}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>
        )}
      </section>

      {/* The same action, one last time. */}
      <section className="px-[var(--s-5)] pb-[60px] sm:px-[48px]">
        <div className={`${PANEL} flex-row flex-wrap items-center justify-between gap-[40px] px-[44px] py-[40px]`}>
          <div className="min-w-0">
            <h2 className="m-0 mb-[10px] text-[34px] font-[600] leading-[1.12] tracking-[-0.024em] text-[color:var(--ink)]">
              Connect one account and watch the first one come in.
            </h2>
            <Prose className="text-[18px] leading-[1.5] text-[color:var(--muted)]" measure="prose">
              Setup is four steps and most coaches finish in under twenty minutes. You read every
              answer your agent drafts before it ever goes live.
            </Prose>
          </div>
          <StartSetup />
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-[var(--s-8)] border-t border-[var(--line)] px-[var(--s-5)] py-[var(--s-6)] sm:px-[48px]">
        <span className="text-[15px] text-[color:var(--faint)]">
          SetterFi · Built for credit and business-funding coaches
        </span>
        {/*
          The canvas draws Terms and Privacy beside the partner link, and they are not here,
          because the documents have no public *route* -- not because they do not exist. They do:
          `src/lib/account/terms.ts` loads the platform's own `termsBody` and `privacyBody` from
          `account_terms`, and `/signup` renders both inline at `signup-form.tsx:400` and `:408`
          when `accountTermsLive()` is on. What is missing is a `/terms` and a `/privacy` a
          stranger can open without starting a signup, and a server-side loader behind a feature
          flag is not something a marketing footer can link at. (The per-tenant documents under
          `/opt-in/[tenantSlug]` are a different pair again -- the *coach's* documents shown to
          their leads -- and were never candidates for this footer.) Linking two routes that 404
          is the failure mode `f8d0381` had to be written to undo on the coach rail, so the links
          wait for the routes rather than the other way round.
        */}
        {/*
          The partner link is gone for the same reason, one step further on. It pointed at
          `/affiliate`, which is the signed-in partner portal and is not in `PUBLIC_PREFIXES`
          (`src/lib/auth/claims.ts:130`), so a stranger following it off the one page whose whole
          job is converting strangers was bounced to `/login` with no partner page to come back to.
          A 200 that answers a different question is a worse dead end than a 404, because the
          reader blames themselves for it. `/partners` is the page that belongs here and it is
          blocked on approved commission terms and an enrolment endpoint (`docs/GAPS.md`), so the
          footer states the product and stops rather than sending anyone somewhere it cannot serve.
        */}
      </footer>
    </CoachScale>
  );
}
