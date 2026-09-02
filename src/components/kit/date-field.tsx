"use client";

import type { ChangeEvent } from "react";

import { Field } from "@/components/kit/field";
import { Input } from "@/components/ui/input";
import { workspaceDateFormat } from "@/lib/format/datetime";

export type DateFieldProps = {
  value: Date | null;
  onChange: (value: Date | null) => void;
  label: string;
  hint?: string;
  error?: string;
  min?: Date;
  max?: Date;
  disabled?: boolean;
};

type DateControlProps = Pick<
  DateFieldProps,
  "disabled" | "max" | "min" | "onChange" | "value"
> & {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

const MONTH_KEYS: Readonly<Record<string, string>> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function workspaceDateKey(value: Date) {
  const parts = workspaceDateFormat.formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const monthName = parts.find((part) => part.type === "month")?.value;
  const month = monthName ? MONTH_KEYS[monthName] : undefined;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return "";
  }

  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function dateFromWorkspaceKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));

  return workspaceDateKey(parsed) === value ? parsed : null;
}

function DateControl({
  disabled,
  id,
  max,
  min,
  onChange,
  value,
  ...accessibility
}: DateControlProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value;
    onChange(nextValue === "" ? null : dateFromWorkspaceKey(nextValue));
  }

  return (
    <Input
      {...accessibility}
      className="h-[var(--row-h-dense)] rounded-[var(--r-input)] border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-3)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-normal tracking-[var(--t-body-tr)] text-[color:var(--ink)] tabular-nums transition-none hover:not-disabled:border-[var(--muted)] focus-visible:border-[var(--accent)] focus-visible:ring-3 focus-visible:ring-[var(--focus-ring)] aria-invalid:border-[var(--ink)] aria-invalid:ring-0 aria-invalid:focus-visible:ring-3 aria-invalid:focus-visible:ring-[var(--focus-ring)] md:text-[length:var(--t-body)]"
      disabled={disabled}
      id={id}
      max={max ? workspaceDateKey(max) : undefined}
      min={min ? workspaceDateKey(min) : undefined}
      onChange={handleChange}
      title={value ? workspaceDateFormat.format(value) : undefined}
      type="date"
      value={value ? workspaceDateKey(value) : ""}
    />
  );
}

export function DateField({
  value,
  onChange,
  label,
  hint,
  error,
  min,
  max,
  disabled,
}: DateFieldProps) {
  return (
    <Field error={error} hint={hint} label={label}>
      <DateControl
        disabled={disabled}
        max={max}
        min={min}
        onChange={onChange}
        value={value}
      />
    </Field>
  );
}

export { dateFromWorkspaceKey, workspaceDateKey };
