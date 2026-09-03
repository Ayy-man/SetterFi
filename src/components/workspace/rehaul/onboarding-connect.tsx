import Link from "next/link";
import { Camera, MessageSquare, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

import { StatusDot, kitButtonClass } from "@/components/kit/atomics";
import type { Tone } from "@/components/kit/atomics";
import { DayCounter } from "@/components/kit/day-counter";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Figure } from "@/components/workspace/rehaul/_primitives";
import {
  ONBOARDING_MONO_CLASS,
  OnboardingFooter,
  OnboardingReadback,
  OnboardingShell,
  type OnboardingStatusItem,
} from "@/components/workspace/rehaul/onboarding-shell";
import type { ConnectCard, ConnectCardKey } from "@/components/onboarding/connect-view-models";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

/*
 * Step 2 of setup, drawn from `OnboardingConnect.body.html`.
 *
 * The three cards are `connectCards(...)` unchanged -- the same view models, the same honest-state
 * rules, the same destinations. What the artboard adds is the shape: a status word, the account
 * the provider actually gave us, and the carrier clock as a day count with no finish date.
 *
 * The card body and the card note are the two sentences this screen used to print under each
 * heading. They go to the eye, so a card carries a state, a value and at most one control.
 */

const CHANNEL_ICON: Record<ConnectCardKey, ReactNode> = {
  instagram: <Camera aria-hidden className="size-[21px]" />,
  messenger: <MessagesSquare aria-hidden className="size-[21px]" />,
  sms: <MessageSquare aria-hidden className="size-[21px]" />,
};

const ACCOUNT_LABEL: Record<ConnectCardKey, string> = {
  instagram: "Account",
  messenger: "Page",
  sms: "Business number",
};

const ACCOUNT_ABSENT: Record<ConnectCardKey, string> = {
  instagram: "No account connected yet",
  messenger: "No page chosen yet",
  sms: "No number recorded yet",
};

/** The status a card with no `status` is in: connected to nothing, and saying so. */
const UNCONNECTED: { label: string; tone: Tone } = { label: "Not connected", tone: "neutral" };

export function connectEyeCopy(cards: readonly ConnectCard[]) {
  return cards.map((card) => `${card.name}: ${card.body} ${card.note}`).join(" ");
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-[44px] place-items-center rounded-[12px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]">
      {children}
    </span>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--line-soft)] py-[12px] text-[15px]">
      <span className="text-[color:var(--body)]">{label}</span>
      <span className={`${ONBOARDING_MONO_CLASS} text-[color:var(--ink)]`}>{value}</span>
    </div>
  );
}

/**
 * The carrier clock on the SMS card.
 *
 * Filed, and it counts from the filing date through the counter five surfaces share. Not filed,
 * and it says day 0 against the same typical range -- a zero that is true, because no review has
 * started -- and never a percentage, a finish date or a green anything.
 */
function CarrierWell({ since }: { since: string | null }) {
  return (
    <div className="rounded-[12px] border border-[var(--warning-line)] bg-[var(--warning-wash)] p-[16px]">
      {since ? (
        <DayCounter since={since} typicalDays={CARRIER_TYPICAL_DAYS} />
      ) : (
        <>
          <Figure className="text-[color:var(--warning-text)]" size="lg">day 0</Figure>
          <p className={`m-0 mt-[6px] text-[14px] text-[color:var(--warning-text)] ${ONBOARDING_MONO_CLASS}`}>
            {`typically ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days once filed`}
          </p>
        </>
      )}
    </div>
  );
}

export function OnboardingConnectRehaul({
  cards,
  nextEnabled,
}: {
  cards: readonly ConnectCard[];
  /** Whether any channel is genuinely answering. Gates the forward action's fill, never the link. */
  nextEnabled: boolean;
}) {
  const status: OnboardingStatusItem[] = cards.map((card) => ({
    label: `${card.name} ${(card.status?.label ?? UNCONNECTED.label).toLowerCase()}`,
    tone: card.status?.tone ?? UNCONNECTED.tone,
  }));

  return (
    <OnboardingShell status={status} step={2} title="Where your leads message you">
      <div className="grid grid-cols-1 items-start gap-[20px] @min-[900px]:grid-cols-3">
        {cards.map((card) => {
          const state = card.status ?? UNCONNECTED;
          return (
            <DeckPanel
              className="flex flex-col"
              dataSlot={`rehaul-connect-${card.key}`}
              eyebrow={card.eyebrow}
              headingId={`rehaul-connect-${card.key}`}
              key={card.key}
              lead={<IconTile>{CHANNEL_ICON[card.key]}</IconTile>}
              name={card.name}
            >
              <div className="flex h-full flex-col gap-[16px]">
                <p className="m-0 flex items-center gap-[10px] text-[16px] font-medium text-[color:var(--ink)]">
                  <StatusDot size={6} tone={state.tone} />
                  {state.label}
                </p>

                <div>
                  <p className="mb-[6px] text-[14px] font-medium text-[color:var(--muted)]">
                    {ACCOUNT_LABEL[card.key]}
                  </p>
                  <OnboardingReadback absent={!card.detail} mono={Boolean(card.detail)}>
                    {card.detail ?? ACCOUNT_ABSENT[card.key]}
                  </OnboardingReadback>
                </div>

                {card.key === "sms" ? (
                  <>
                    <CarrierWell since={card.wait?.since ?? null} />
                    <div className="flex flex-col">
                      <MetaRow label="Decided by" value="The carriers" />
                      <MetaRow label="Starts at" value="Step 5" />
                    </div>
                  </>
                ) : null}

                {card.action ? (
                  <Link
                    className={kitButtonClass({
                      className: "mt-auto h-[48px] w-full justify-center text-[16px] no-underline",
                      variant: "secondary",
                    })}
                    href={card.action.href}
                  >
                    {card.action.label}
                  </Link>
                ) : null}
              </div>
            </DeckPanel>
          );
        })}
      </div>

      <OnboardingFooter
        actions={
          <>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[22px] text-[16px] no-underline",
                variant: "secondary",
              })}
              href="/onboarding"
            >
              Do this later
            </Link>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[28px] text-[17px] no-underline",
                variant: nextEnabled ? "primary" : "secondary",
              })}
              href="/onboarding/offer"
            >
              Continue
            </Link>
          </>
        }
        sentence="Connect at least one channel to carry on; the others can be added later from your setup screen."
      />

      <ContextEye copy={connectEyeCopy(cards)} screen="onboarding-connect" />
    </OnboardingShell>
  );
}
