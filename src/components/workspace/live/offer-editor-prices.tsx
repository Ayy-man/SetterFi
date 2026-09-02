"use client";

import type { ReactNode } from "react";

import { money } from "@/lib/format/metric";
import type { CoachOfferPriceInput } from "@/lib/offer/types";

import {
  EditorRegion,
  EditorStatedRow,
  SampleExchange,
} from "./offer-editor-chrome";

/**
 * Screen 3f, inline: the numbers, and the sentence they produce.
 *
 * The point of the screen is the preview under the fields: a coach types a figure and reads back
 * what a lead will hear before a lead hears it. That only works if the preview quotes the figures
 * exactly, which is also the platform rule -- pricing is hard-gated, the agent cannot invent or
 * round a number -- so the sentence is a fixed template filled with the saved cents and never a
 * paraphrase of them.
 *
 * The row controls stay with the page, passed in as `children`: they carry the stable row ids,
 * the in-flight currency text and the remove confirmation, all of which are the page's state.
 * What this owns is everything the artifact added around them.
 */

/** The mono aside beside a figure: what this number is, in two words. */
const BILLING_ASIDE: Record<string, string> = {
  one_time: "one time",
  monthly: "recurring",
  annual: "each year",
};

const LEAD_QUESTION = "how much is it";

/**
 * The one sentence the agent may build out of these rows, as a template rather than as prose.
 *
 * Every figure in it comes from `money()` over the stored cents, so the preview cannot drift from
 * the value the runtime will quote. When nothing is saved the template does not guess a number:
 * it states the behaviour the ungated path actually takes, which is to qualify first and hand the
 * figure back to the coach.
 */
export function priceSampleReply(prices: readonly CoachOfferPriceInput[]): string {
  const named = prices.filter((row) => row.amountCents > 0);
  if (!named.length) {
    return "I'll get you the exact number. First, how many leads are you handling right now?";
  }

  const setup = named.find((row) => row.billingPeriod === "one_time");
  const monthly = named.find((row) => row.billingPeriod === "monthly");
  const annual = named.find((row) => row.billingPeriod === "annual");

  const clauses: string[] = [];
  if (setup) clauses.push(`${money(setup.amountCents, "USD")} to get set up`);
  if (monthly) clauses.push(`${money(monthly.amountCents, "USD")} a month`);
  if (annual) clauses.push(`${money(annual.amountCents, "USD")} a year`);

  if (!clauses.length) {
    const first = named[0];
    clauses.push(`${money(first.amountCents, "USD")} for ${first.label.trim() || "the program"}`);
  }

  const figures =
    clauses.length > 1 ? `${clauses[0]}, then ${clauses.slice(1).join(", then ")}` : clauses[0];

  return `${figures}. Before I get into what's included, how many leads are you handling right now?`;
}

export type PricesPanelProps = {
  /** The page's own row editor: labels, amounts, billing periods, add and remove. */
  children: ReactNode;
  prices: readonly CoachOfferPriceInput[];
};

export function PricesPanel({ children, prices }: PricesPanelProps) {
  const priced = prices.filter((row) => row.amountCents > 0);

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
      {children}

      {priced.length ? (
        <EditorRegion label="The figures it may quote">
          <ul className="flex list-none flex-wrap gap-[10px] p-0">
            {priced.map((row, index) => (
              <li
                className="min-w-[min(100%,200px)] flex-1 rounded-[11px] border border-[var(--line-input)] bg-[rgba(255,255,255,0.04)] px-[16px] py-[14px]"
                key={`figure-${index}-${row.label}`}
              >
                <span className="flex items-baseline gap-[8px]">
                  <span className="font-[family-name:var(--font-mono)] text-[18px] leading-none text-[color:var(--muted)]">
                    $
                  </span>
                  <span className="font-[family-name:var(--font-mono)] text-[24px] leading-[1.1] font-medium tracking-[-0.02em] text-[color:var(--ink)]">
                    {money(row.amountCents, "USD").replace("$", "")}
                  </span>
                  <span className="ml-auto text-[length:var(--coach-eyebrow)] leading-none text-[color:var(--muted)]">
                    {row.billingPeriod ? BILLING_ASIDE[row.billingPeriod] : "no period set"}
                  </span>
                </span>
                <span className="mt-[8px] block truncate text-[length:var(--coach-body)] leading-[1.4] text-[color:var(--muted)]">
                  {row.label.trim() || "Unnamed price"}
                </span>
              </li>
            ))}
          </ul>
        </EditorRegion>
      ) : null}

      {/*
        The artifact drew these three as switches. Two are not settings at all -- the compliance
        gate refuses a range and refuses an invented figure on every reply, for every tenant -- and
        the third has no coach-writable column behind it. A switch that discards a coach's pricing
        preference is worse than a sentence saying SetterFi decides it, so they print.
      */}
      <EditorRegion label="What SetterFi decides here">
        <div className="border-t border-[var(--line-soft)]">
          <EditorStatedRow
            detail="Off means it says the exact number, every time. The compliance gate enforces this before every reply."
            title="May quote a range"
            value="no"
          />
          <EditorStatedRow
            detail="Prices, guarantees and outcomes are checked before every reply. Your setter cannot state a figure you have not saved here."
            title="May invent a figure"
            value="no"
          />
          <EditorStatedRow
            detail="It qualifies first and then quotes, so the number lands on a lead who has already told you what they need."
            title="Quotes before qualifying"
            value="no"
          />
        </div>
      </EditorRegion>

      <SampleExchange
        caption="A fixed template, filled with the figures above. It regenerates as you change them, and it quotes them exactly."
        label="What it will say"
        lead={LEAD_QUESTION}
        replies={[priceSampleReply(prices)]}
      />
    </div>
  );
}
