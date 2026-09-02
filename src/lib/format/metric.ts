export type MetricFormat = "count" | "money" | "percent" | "duration";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
});

const SECOND_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  style: "unit",
  unit: "second",
  unitDisplay: "short",
});

const MINUTE_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "unit",
  unit: "minute",
  unitDisplay: "short",
});

const HOUR_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "unit",
  unit: "hour",
  unitDisplay: "short",
});

export function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function formatMetric(value: number, format: MetricFormat) {
  if (format === "count") return COUNT_FORMATTER.format(value);
  if (format === "money") return money(value, "USD");
  if (format === "percent") return PERCENT_FORMATTER.format(value / 100);

  const magnitude = Math.abs(value);
  if (magnitude < 60) return SECOND_FORMATTER.format(value);
  if (magnitude < 3_600) return MINUTE_FORMATTER.format(value / 60);
  return HOUR_FORMATTER.format(value / 3_600);
}
