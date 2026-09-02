"use client";

import { useMemo, useState, type ChangeEvent } from "react";

import { Field } from "@/components/kit/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { money } from "@/lib/format/metric";

export type CurrencyInputProps = {
  valueCents: number | null;
  onChangeCents: (cents: number | null) => void;
  currency: string;
  label: string;
  hint?: string;
  error?: string;
};

type ControlProps = Pick<CurrencyInputProps, "currency" | "onChangeCents" | "valueCents"> & {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

const CURRENCY_SYMBOL = new RegExp("\\p{Sc}", "gu");

function majorUnitText(valueCents: number | null) {
  return valueCents === null ? "" : (valueCents / 100).toFixed(2);
}

function parseMajorUnits(value: string) {
  const stripped = value.replace(CURRENCY_SYMBOL, "").replace(/[\s,_'’]/g, "");

  if (stripped === "") {
    return null;
  }

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stripped)) {
    return undefined;
  }

  const major = Number(stripped);
  if (!Number.isFinite(major)) {
    return undefined;
  }

  const minorUnits = Math.round(major * 100);
  return Number.isSafeInteger(minorUnits) ? minorUnits : undefined;
}

function currencyPrefix(currency: string) {
  return money(0, currency).replace(/[\d\s.,+-]/g, "") || currency;
}

function CurrencyControl({
  currency,
  id,
  onChangeCents,
  valueCents,
  ...accessibility
}: ControlProps) {
  const [displayState, setDisplayState] = useState(() => ({
    valueCents,
    text: majorUnitText(valueCents),
  }));

  if (displayState.valueCents !== valueCents) {
    setDisplayState({
      valueCents,
      text:
        parseMajorUnits(displayState.text) === valueCents
          ? displayState.text
          : majorUnitText(valueCents),
    });
  }

  const displayValue =
    displayState.valueCents === valueCents
      ? displayState.text
      : parseMajorUnits(displayState.text) === valueCents
        ? displayState.text
        : majorUnitText(valueCents);
  const parsedValue = useMemo(() => parseMajorUnits(displayValue), [displayValue]);
  const savedValue = parsedValue === undefined ? null : parsedValue;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const nextDisplayValue = event.target.value;
    const nextValue = parseMajorUnits(nextDisplayValue);

    setDisplayState({ valueCents, text: nextDisplayValue });
    if (nextValue !== undefined) {
      onChangeCents(nextValue);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-[var(--distance-small)]">
      <InputGroup className="h-[var(--row-h-dense)] rounded-[var(--r-input)] bg-[var(--card)] transition-none focus-within:border-[var(--accent)] focus-within:ring-3 focus-within:ring-[var(--focus-ring)] has-[[data-slot=input-group-control]:focus-visible]:border-[var(--accent)] has-[[data-slot=input-group-control]:focus-visible]:ring-[var(--focus-ring)] has-[[data-slot][aria-invalid=true]]:border-[var(--ink)]">
        <InputGroupAddon
          className="h-full border-r border-[var(--line)] bg-[var(--quiet)] px-[var(--s-2)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-normal tracking-[var(--t-body-tr)] text-[color:var(--muted)]"
        >
          <span aria-hidden="true">{currencyPrefix(currency)}</span>
        </InputGroupAddon>
        <InputGroupInput
          {...accessibility}
          id={id}
          inputMode="decimal"
          className="[font-size:var(--t-row)] [font-weight:var(--t-row-w)] [line-height:var(--t-row-lh)] [letter-spacing:var(--t-row-tr)] text-[color:var(--ink)] transition-none md:[font-size:var(--t-row)]"
          onChange={handleChange}
          spellCheck={false}
          value={displayValue}
        />
      </InputGroup>

      {savedValue === null ? null : (
        <p
          aria-live="polite"
          className="text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal tracking-[var(--t-body-tr)] text-[color:var(--muted)] tabular-nums"
          data-slot="currency-echo"
        >
          Saves as {money(savedValue, currency)}
        </p>
      )}
    </div>
  );
}

export function CurrencyInput({
  valueCents,
  onChangeCents,
  currency,
  label,
  hint,
  error,
}: CurrencyInputProps) {
  return (
    <Field error={error} hint={hint} label={label}>
      <CurrencyControl
        currency={currency}
        onChangeCents={onChangeCents}
        valueCents={valueCents}
      />
    </Field>
  );
}

export { parseMajorUnits };
