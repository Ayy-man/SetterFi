"use client";

/**
 * Commercial terms on the Plans and pricing page.
 *
 * A plan's price on the card above is the operational number this platform runs on. A commercial
 * term is the narrower thing: exactly what the plan could be sold for between two instants, tied
 * to the Stripe price id that would be charged. The ledger is append-and-close, so the history
 * keeps saying what was sellable when instead of being overwritten.
 *
 * This section is a RECORD, not a pricing change, which is why it stays writable while the Stripe
 * readback blocks plan edits: nothing here reaches Stripe. It follows the page's billing gate --
 * with billing off, the whole page is off and so is this.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { CurrencyInput } from "@/components/kit/currency-input";
import { DataState } from "@/components/kit/data-state";
import { DateField } from "@/components/kit/date-field";
import { Field } from "@/components/kit/field";
import { Status } from "@/components/kit/atomics";
import { MonoMeta } from "@/components/kit/atomics/type";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { TIER_OFFER_INTERVALS, type TierOfferInterval } from "@/lib/billing/tier-offers";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";

export type CommercialTermRow = {
  id: string;
  tierId: string;
  tierName: string;
  currency: string;
  amountCents: number;
  interval: TierOfferInterval;
  stripePriceId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  auditId: number | null;
};

export type TierChoice = { id: string; name: string };

export type TierCommercialTermsProps = {
  /** The plans the terms hang off, in the order the cards above already show them. */
  tiers: readonly TierChoice[];
  /** False when the page cannot read money data at all; the section says nothing rather than lying. */
  canRead: boolean;
  /** Injected by tests so "in force" is decided against a fixed instant, never the wall clock. */
  asOf?: Date;
  /** Injected by tests. Defaults to the platform route. */
  load?: () => Promise<CommercialTermRow[]>;
  submit?: (body: Record<string, unknown>) => Promise<Response>;
};

type Draft = {
  tierId: string;
  amountCents: number | null;
  currency: string;
  interval: TierOfferInterval;
  stripePriceId: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  reason: string;
};

type Receipt = { message: string; auditId: number | null; tone: "good" | "failure" };

const EMPTY_DRAFT: Draft = {
  tierId: "",
  amountCents: null,
  currency: "USD",
  interval: "month",
  stripePriceId: "",
  effectiveFrom: null,
  effectiveTo: null,
  reason: "",
};

export const TERMS_ABSENT_BODY =
  "No commercial terms are recorded. Signup shows plan names without prices until a term is recorded.";

export const STRIPE_UNVERIFIED_BODY =
  "A Stripe price id is recorded here exactly as it is typed. Nothing in this product asks Stripe whether it exists, so it stays recorded, not verified against Stripe until Stripe is connected.";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Commercial term data included an invalid row.");
  }
  return value;
}

function parseTerms(value: unknown): CommercialTermRow[] {
  if (!Array.isArray(value)) throw new Error("Commercial term data was not returned as a list.");
  return value.map((item) => {
    if (!record(item)) throw new Error("Commercial term data included an invalid row.");
    const amountCents = item.amountCents;
    const interval = item.interval;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents)) {
      throw new Error("Commercial term data included an invalid row.");
    }
    if (!TIER_OFFER_INTERVALS.includes(interval as TierOfferInterval)) {
      throw new Error("Commercial term data included an invalid row.");
    }
    return {
      id: requiredText(item, "id"),
      tierId: requiredText(item, "tierId"),
      tierName: requiredText(item, "tierName"),
      currency: requiredText(item, "currency"),
      amountCents,
      interval: interval as TierOfferInterval,
      stripePriceId: requiredText(item, "stripePriceId"),
      effectiveFrom: requiredText(item, "effectiveFrom"),
      effectiveTo: typeof item.effectiveTo === "string" ? item.effectiveTo : null,
      reason: typeof item.reason === "string" && item.reason.trim() ? item.reason : null,
      auditId: typeof item.auditId === "number" ? item.auditId : null,
    };
  });
}

async function loadTerms(): Promise<CommercialTermRow[]> {
  const response = await fetch("/api/platform/tier-offer-terms", { cache: "no-store" });
  if (!response.ok) throw new Error("Commercial terms could not be loaded.");
  const payload = (await response.json()) as unknown;
  return parseTerms(record(payload) ? payload.terms : null);
}

function postTerm(body: Record<string, unknown>) {
  return fetch("/api/platform/tier-offer-terms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function displayInstant(value: string | null, absent: string) {
  if (!value) return absent;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? absent : workspaceDateFormat.format(parsed);
}

export function inForce(term: CommercialTermRow, asOf: Date) {
  const from = Date.parse(term.effectiveFrom);
  if (!Number.isFinite(from) || from > asOf.valueOf()) return false;
  if (term.effectiveTo === null) return true;
  const to = Date.parse(term.effectiveTo);
  return Number.isFinite(to) && asOf.valueOf() < to;
}

function draftError(draft: Draft): string | null {
  if (!draft.tierId) return "Choose the plan this term sells.";
  if (draft.amountCents === null || draft.amountCents < 0) return "Enter the amount to charge.";
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) {
    return "Use a three-letter currency code, such as USD.";
  }
  if (!draft.stripePriceId.trim()) return "Enter the Stripe price id this term charges.";
  if (!draft.effectiveFrom) return "Choose when this term starts.";
  if (draft.effectiveTo && draft.effectiveTo <= draft.effectiveFrom) {
    return "The end must be after the start.";
  }
  if (!draft.reason.trim()) return "Enter a reason. It is retained with the record.";
  return null;
}

function TermRow({
  term,
  current,
  onClose,
  closeDisabled,
}: {
  term: CommercialTermRow;
  current: boolean;
  onClose: () => void;
  closeDisabled: boolean;
}) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-1)] border-t border-[var(--line)] py-[var(--s-3)] first:border-t-0">
      <span className="text-body text-[color:var(--ink)]">
        {money(term.amountCents, term.currency)} / {term.interval}
      </span>
      <span className="text-body text-[color:var(--muted)]">
        {displayInstant(term.effectiveFrom, "Start not recorded")} to{" "}
        {displayInstant(term.effectiveTo, "no end date")}
      </span>
      {current ? <Status label="In force" tone="good" treatment="bare" /> : null}
      <MonoMeta className="ml-auto">{term.stripePriceId}</MonoMeta>
      {term.effectiveTo === null ? (
        <Button disabled={closeDisabled} onClick={onClose} size="sm" variant="outline">
          Close window
        </Button>
      ) : null}
    </li>
  );
}

export function TierCommercialTerms({
  tiers,
  canRead,
  asOf,
  load = loadTerms,
  submit = postTerm,
}: TierCommercialTermsProps) {
  const [terms, setTerms] = useState<CommercialTermRow[]>([]);
  const [loading, setLoading] = useState(canRead);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [closing, setClosing] = useState<CommercialTermRow | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const [closeAt, setCloseAt] = useState<Date | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sending, setSending] = useState(false);

  // One instant for the whole render, so two rows can never disagree about which is in force.
  const [defaultAsOf] = useState(() => new Date());
  const now = asOf ?? defaultAsOf;

  /** Used by the retry control and after a write, both of which are events rather than renders. */
  const refresh = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setLoadError(null);
    try {
      setTerms(await load());
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "Commercial terms could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [canRead, load]);

  // The first read runs inside the effect rather than through `refresh`, so no state is set on the
  // same tick the effect fires; the initial loading state is already the one `useState` holds.
  useEffect(() => {
    if (!canRead) return;
    let abandoned = false;
    void (async () => {
      try {
        const rows = await load();
        if (!abandoned) setTerms(rows);
      } catch (cause) {
        if (!abandoned) {
          setLoadError(
            cause instanceof Error ? cause.message : "Commercial terms could not be loaded.",
          );
        }
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [canRead, load]);

  const byTier = useMemo(() => {
    const groups = new Map<string, CommercialTermRow[]>();
    for (const term of terms) {
      groups.set(term.tierId, [...(groups.get(term.tierId) ?? []), term]);
    }
    for (const rows of groups.values()) {
      rows.sort((left, right) => Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom));
    }
    return groups;
  }, [terms]);

  if (!canRead) return null;

  async function send(body: Record<string, unknown>, success: string) {
    setSending(true);
    try {
      const response = await submit(body);
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message = record(payload) && typeof payload.error === "string"
          ? payload.error
          : "The commercial term could not be recorded.";
        setReceipt({ message, auditId: null, tone: "failure" });
        return false;
      }
      const result = record(payload) && record(payload.result) ? payload.result : null;
      const auditId = typeof result?.auditId === "number" ? result.auditId : null;
      if (auditId === null) {
        setReceipt({
          message: "The receipt could not be verified, so this record is not confirmed.",
          auditId: null,
          tone: "failure",
        });
        return false;
      }
      setReceipt({ message: success, auditId, tone: "good" });
      await refresh();
      return true;
    } finally {
      setSending(false);
    }
  }

  async function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftError(draft) || sending) return;
    const done = await send({
      action: "record_term",
      tierId: draft.tierId,
      currency: draft.currency.trim().toUpperCase(),
      amountCents: draft.amountCents,
      interval: draft.interval,
      stripePriceId: draft.stripePriceId.trim(),
      effectiveFrom: draft.effectiveFrom?.toISOString(),
      effectiveTo: draft.effectiveTo?.toISOString() ?? null,
      reason: draft.reason.trim(),
    }, "Commercial term logged");
    if (done) {
      setEditorOpen(false);
      setDraft(EMPTY_DRAFT);
    }
  }

  async function submitClose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!closing || !closeAt || !closeReason.trim() || sending) return;
    const done = await send({
      action: "close_term",
      termId: closing.id,
      effectiveTo: closeAt.toISOString(),
      reason: closeReason.trim(),
    }, "Term close logged");
    if (done) {
      setClosing(null);
      setCloseReason("");
      setCloseAt(null);
    }
  }

  const closeInvalid = closing && closeAt && closeAt <= new Date(closing.effectiveFrom)
    ? "Choose an end after the start of the window."
    : null;

  return (
    <section aria-labelledby="commercial-terms" className="flex min-w-0 flex-col gap-[var(--s-3)]">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-[var(--s-3)]">
        <div className="min-w-0">
          <h2 className="m-0 text-section text-[color:var(--ink)]" id="commercial-terms">
            Commercial terms
          </h2>
          <p className="m-0 mt-[var(--s-1)] max-w-[var(--measure-wide)] text-[length:var(--t-body)] text-[color:var(--muted)]">
            What each plan can be sold for, between two dates, against the Stripe price that would
            be charged. A term is never edited: the standing window is closed and the next one is
            recorded, so the history keeps saying what was sellable when.
          </p>
        </div>
        <Button
          disabled={tiers.length === 0}
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT, tierId: tiers[0]?.id ?? "" });
            setEditorOpen(true);
          }}
          size="sm"
          variant="outline"
        >
          Record term
        </Button>
      </div>

      <p className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-body)] text-[color:var(--faint)]">
        {STRIPE_UNVERIFIED_BODY}
      </p>

      {loading ? (
        <DataState kind="loading" rows={3} />
      ) : loadError ? (
        <DataState
          body={`${loadError} No commercial term was recorded.`}
          kind="unavailable"
          retry={() => void refresh()}
          title="Commercial terms could not be loaded"
        />
      ) : terms.length === 0 ? (
        <DataState body={TERMS_ABSENT_BODY} kind="empty" title="No commercial terms" />
      ) : (
        <div className="flex flex-col gap-[var(--s-4)]">
          {tiers
            .filter((tier) => (byTier.get(tier.id) ?? []).length > 0)
            .map((tier) => (
              <div
                className="rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-4)]"
                key={tier.id}
              >
                <h3 className="m-0 text-body font-[var(--t-body-w)] text-[color:var(--ink)]">
                  {tier.name}
                </h3>
                <ul className="m-0 mt-[var(--s-2)] list-none p-0">
                  {(byTier.get(tier.id) ?? []).map((term) => (
                    <TermRow
                      closeDisabled={sending}
                      current={inForce(term, now)}
                      key={term.id}
                      onClose={() => {
                        setClosing(term);
                        setCloseReason("");
                        setCloseAt(null);
                        setReceipt(null);
                      }}
                      term={term}
                    />
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}

      {receipt ? (
        <div role={receipt.tone === "failure" ? "alert" : "status"}>
          <Status label={receipt.message} tone={receipt.tone} treatment="bare" />
          {receipt.auditId === null ? null : (
            <MonoMeta className="mt-[var(--s-1)] block">Audit receipt #{receipt.auditId}</MonoMeta>
          )}
        </div>
      ) : null}

      <Sheet onOpenChange={setEditorOpen} open={editorOpen}>
        <SheetContent className="w-full max-w-[var(--drawer-w)] gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-[var(--shadow-drawer)] sm:max-w-[var(--drawer-w)]">
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submitDraft}>
            <SheetHeader className="gap-[var(--s-1)] border-b border-[var(--line)] p-[var(--s-5)]">
              <SheetTitle className="text-section text-[color:var(--ink)]">
                Record a commercial term
              </SheetTitle>
              <SheetDescription className="text-body text-[color:var(--muted)]">
                This records what the plan sells for. It does not create anything in Stripe.
              </SheetDescription>
            </SheetHeader>
            <div className="relative flex min-h-0 flex-1 flex-col gap-[var(--s-4)] overflow-y-auto p-[var(--s-5)]">
              <Select
                label="Plan"
                onValueChange={(tierId) => setDraft({ ...draft, tierId })}
                options={tiers.map((tier) => ({ value: tier.id, label: tier.name }))}
                required
                value={draft.tierId || null}
              />
              <CurrencyInput
                currency={draft.currency.trim().toUpperCase() || "USD"}
                label="Amount"
                onChangeCents={(amountCents) => setDraft({ ...draft, amountCents })}
                valueCents={draft.amountCents}
              />
              <Field hint="Three-letter code, such as USD." label="Currency" required>
                <Input
                  maxLength={3}
                  onChange={(event) => setDraft({ ...draft, currency: event.currentTarget.value })}
                  value={draft.currency}
                />
              </Field>
              <Select
                label="Billing interval"
                onValueChange={(interval) => setDraft({ ...draft, interval })}
                options={TIER_OFFER_INTERVALS.map((option) => ({ value: option, label: option }))}
                required
                value={draft.interval}
              />
              <Field
                hint="Recorded as given. It is not verified against Stripe until Stripe is connected."
                label="Stripe price id"
                required
              >
                <Input
                  onChange={(event) =>
                    setDraft({ ...draft, stripePriceId: event.currentTarget.value })
                  }
                  value={draft.stripePriceId}
                />
              </Field>
              <DateField
                label="Effective from"
                onChange={(effectiveFrom) => setDraft({ ...draft, effectiveFrom })}
                value={draft.effectiveFrom}
              />
              <DateField
                label="Effective to"
                min={draft.effectiveFrom ?? undefined}
                onChange={(effectiveTo) => setDraft({ ...draft, effectiveTo })}
                value={draft.effectiveTo}
              />
              <Field hint="Retained with the record." label="Reason" required>
                <Textarea
                  onChange={(event) => setDraft({ ...draft, reason: event.currentTarget.value })}
                  value={draft.reason}
                />
              </Field>
              {draftError(draft) ? (
                <p className="text-body text-[color:var(--critical)]" role="alert">
                  {draftError(draft)}
                </p>
              ) : null}
            </div>
            <SheetFooter className="flex-row items-center justify-end gap-[var(--s-2)] border-t border-[var(--line)] p-[var(--s-4)]">
              <MonoMeta className="mr-auto">Audit receipt required</MonoMeta>
              <Button onClick={() => setEditorOpen(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={Boolean(draftError(draft)) || sending} type="submit">
                {sending ? "Recording…" : "Record term"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={(open) => (open ? null : setClosing(null))} open={Boolean(closing)}>
        <SheetContent className="w-full max-w-[var(--drawer-w)] gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-[var(--shadow-drawer)] sm:max-w-[var(--drawer-w)]">
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submitClose}>
            <SheetHeader className="gap-[var(--s-1)] border-b border-[var(--line)] p-[var(--s-5)]">
              <SheetTitle className="text-section text-[color:var(--ink)]">
                Close the open window
              </SheetTitle>
              <SheetDescription className="text-body text-[color:var(--muted)]">
                {closing
                  ? `${closing.tierName} stops being sellable at this price from the date you choose. Nothing already sold changes.`
                  : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="relative flex min-h-0 flex-1 flex-col gap-[var(--s-4)] overflow-y-auto p-[var(--s-5)]">
              <DateField
                error={closeInvalid ?? undefined}
                label="Effective to"
                min={closing ? new Date(closing.effectiveFrom) : undefined}
                onChange={setCloseAt}
                value={closeAt}
              />
              <Field hint="Retained with the record." label="Reason" required>
                <Textarea
                  onChange={(event) => setCloseReason(event.currentTarget.value)}
                  value={closeReason}
                />
              </Field>
            </div>
            <SheetFooter className="flex-row items-center justify-end gap-[var(--s-2)] border-t border-[var(--line)] p-[var(--s-4)]">
              <MonoMeta className="mr-auto">Audit receipt required</MonoMeta>
              <Button onClick={() => setClosing(null)} type="button" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={!closeAt || Boolean(closeInvalid) || !closeReason.trim() || sending}
                type="submit"
              >
                {sending ? "Closing…" : "Close window"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </section>
  );
}
