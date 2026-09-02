/**
 * The one place a metric's methodology sentence is turned from vocabulary into screen copy.
 *
 * `metric-definitions.ts` writes every window against the RPC parameter that anchors it, so its
 * strings say "Trailing 30 days ending at asOf". That is the right sentence in that file, written
 * for whoever has to reconcile a printed number against the query that produced it, and a leaked
 * identifier the moment it reaches a reader: `/admin/agent-performance` printed "Window: Trailing
 * 30 days ending at asOf" under its heading, and the methodology note on every KPI tile printed it
 * again.
 *
 * Substituting here rather than at a surface is the whole point. Twenty-one definitions carry the
 * token and two view models project them, so a fix applied at one renderer leaves the identifier
 * on the other and the next renderer inherits the leak. A metric cannot be projected without the
 * substitution having happened, because this function is the only constructor of the descriptor
 * both view models return.
 *
 * The instant is the snapshot's own measurement time, so the sentence names the moment the numbers
 * beside it were read at rather than a re-read of the clock, and it prints in UTC because every
 * definition carrying the token also declares `clock: "UTC."`.
 *
 * A snapshot whose instant will not parse leaves the token unsubstituted rather than printing
 * "Invalid Date" or a silently wrong moment. That is the one case where the identifier can still
 * reach a screen, and it is the right trade: an unparseable measurement instant is a fault worth
 * seeing, and inventing a date to cover it would put a wrong number under a heading that claims to
 * say what was measured when.
 */

import { metricDefinition, type MetricKey } from "@/lib/analytics/metric-definitions";

export type MetricDescriptorText = {
  denominator: string;
  window: string;
  clock: string;
  text: string;
};

/** The bare RPC parameter name as it appears inside definition prose. */
const AS_OF_TOKEN = /\basOf\b/gu;

export function withAsOfLabel(text: string, asOfLabel: string | null) {
  return asOfLabel ? text.replaceAll(AS_OF_TOKEN, asOfLabel) : text;
}

export function metricDescriptorText(
  key: MetricKey,
  asOfLabel: string | null,
): MetricDescriptorText {
  const definition = metricDefinition(key);
  const denominator = withAsOfLabel(definition.denominator, asOfLabel);
  const window = withAsOfLabel(definition.window, asOfLabel);
  const clock = withAsOfLabel(definition.clock, asOfLabel);
  return {
    denominator,
    window,
    clock,
    text: `Denominator: ${denominator} Window: ${window} Clock: ${clock}`,
  };
}
