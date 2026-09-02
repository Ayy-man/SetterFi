import { describe, expect, it } from "vitest";

import { METRIC_KEYS, metricDefinition, type MetricKey } from "@/lib/analytics/metric-definitions";
import { metricDescriptorText, withAsOfLabel } from "@/lib/analytics/metric-descriptor";

const AS_OF_LABEL = "Sep 2, 2026, 9:30 AM UTC";

function definitionCarriesToken(key: MetricKey) {
  const definition = metricDefinition(key);
  return /\basOf\b/u.test(
    `${definition.denominator} ${definition.window} ${definition.clock}`,
  );
}

/**
 * The single point where measurement vocabulary becomes screen copy.
 *
 * Twenty-one definitions write their window against the RPC parameter that anchors it, and two
 * view models project them. A check that lives in one view model's test file proves nothing about
 * the other, and a check on one metric proves nothing about the twenty that were added beside it,
 * so the guard sits on the function both projections call and sweeps every key.
 */
describe("metric descriptor projection", () => {
  it("substitutes the parameter name out of every definition it appears in", () => {
    const carriers = METRIC_KEYS.filter(definitionCarriesToken);

    expect(carriers.length).toBeGreaterThan(0);
    for (const key of carriers) {
      const descriptor = metricDescriptorText(key, AS_OF_LABEL);
      expect(descriptor.text).not.toContain("asOf");
      expect(descriptor.denominator).not.toContain("asOf");
      expect(descriptor.window).not.toContain("asOf");
      expect(descriptor.clock).not.toContain("asOf");
      expect(descriptor.text).toContain(AS_OF_LABEL);
    }
  });

  it("leaves no definition carrying the token anywhere a reader can reach it", () => {
    for (const key of METRIC_KEYS) {
      expect(metricDescriptorText(key, AS_OF_LABEL).text).not.toContain("asOf");
    }
  });

  /*
   * An unparseable measurement instant is a fault worth seeing. Printing "Invalid Date" under a
   * heading that claims to say what was measured when would be a wrong number rather than a
   * missing one, so the token survives instead.
   */
  it("keeps the token rather than inventing a date when there is no instant", () => {
    const key = METRIC_KEYS.find(definitionCarriesToken);
    expect(key).toBeDefined();

    const descriptor = metricDescriptorText(key as MetricKey, null);
    expect(descriptor.text).toContain("asOf");
    expect(descriptor.text).not.toContain("Invalid Date");
  });

  it("rebuilds the summary line out of the substituted parts", () => {
    const key = METRIC_KEYS.find(definitionCarriesToken) as MetricKey;
    const descriptor = metricDescriptorText(key, AS_OF_LABEL);

    expect(descriptor.text).toBe(
      `Denominator: ${descriptor.denominator} Window: ${descriptor.window} Clock: ${descriptor.clock}`,
    );
  });

  it("replaces the token wherever it repeats in one sentence", () => {
    expect(withAsOfLabel("from asOf to asOf", AS_OF_LABEL))
      .toBe(`from ${AS_OF_LABEL} to ${AS_OF_LABEL}`);
    expect(withAsOfLabel("from asOf to asOf", null)).toBe("from asOf to asOf");
  });
});
