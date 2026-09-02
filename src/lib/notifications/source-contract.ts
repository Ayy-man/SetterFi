import {
  buildEmittedAlertRuleBindings,
  PHASE8_OWNER_ARRAYS,
  PREBUILT_ALERT_RULES_WITHOUT_EMITTER,
} from "./phase8-contracts";
import { SCHEDULED_ALERT_EVENT_KEYS } from "./scheduled-checks";

export const EMITTED_ALERT_RULE_BINDINGS = [
  ...buildEmittedAlertRuleBindings(PHASE8_OWNER_ARRAYS),
  ...SCHEDULED_ALERT_EVENT_KEYS.map((key) => {
    const separator = key.lastIndexOf(":");
    return {
      eventKey: key.slice(0, separator),
      scope: key.slice(separator + 1) as "tenant" | "platform",
    };
  }),
].sort((left, right) => {
  const leftKey = `${left.eventKey}:${left.scope}`;
  const rightKey = `${right.eventKey}:${right.scope}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
});

export const EMITTED_ALERT_RULE_KEYS = EMITTED_ALERT_RULE_BINDINGS.map(
  ({ eventKey, scope }) => `${eventKey}:${scope}`,
);

export const EMITTED_ALERT_RULE_BINDING_COUNT = EMITTED_ALERT_RULE_BINDINGS.length;

/** Product-requested alert rules intentionally left unbound until their owners emit a durable fact. */
export const ALERT_RULES_WITHOUT_EMITTER = PREBUILT_ALERT_RULES_WITHOUT_EMITTER;
