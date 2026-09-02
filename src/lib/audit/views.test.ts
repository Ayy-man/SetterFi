// @vitest-environment node

import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "./actions";
import {
  AUDIT_VIEWS,
  PAUSE_ACTIONS,
  PUBLISH_ACTIONS,
  PUBLISH_SUFFIX,
  TAKEOVER_ACTIONS,
  auditCategoryOf,
  auditViewFilter,
  isAuditViewKey,
  type AuditViewKey,
} from "./views";

/**
 * A tiny reader for the two PostgREST shapes `auditViewFilter` produces, so a test can ask the
 * expression the loader actually sends which action keys it would select.
 *
 * The point of the whole file is that the query and the screen cannot disagree about what a view
 * contains. Asserting the expression's text would pin the spelling and prove nothing about that;
 * asserting what it selects is the claim worth holding.
 */
function selects(filter: string, action: string) {
  return filter.split(/,(?![^(]*\))/u).some((clause) => {
    const like = /^action\.like\.\*(.+)$/u.exec(clause);
    if (like) return action.endsWith(like[1]);
    const list = /^action\.in\.\((.*)\)$/u.exec(clause);
    if (list) {
      return list[1].split(",")
        .map((value) => value.replaceAll('"', ""))
        .includes(action);
    }
    throw new Error(`Unreadable audit view clause: ${clause}`);
  });
}

/**
 * Every action key the log can hold, or as near as this repo can name: the frozen registry, plus
 * the keys the three views are defined by, which is where a key added after the registry froze
 * would show up.
 */
const EVERY_ACTION = [...new Set([
  ...Object.keys(AUDIT_ACTIONS),
  ...PUBLISH_ACTIONS,
  ...TAKEOVER_ACTIONS,
  ...PAUSE_ACTIONS,
])];

describe("the saved audit views", () => {
  it("selects on the server exactly what the screen would classify into the view", () => {
    for (const view of AUDIT_VIEWS) {
      const filter = auditViewFilter(view.key);
      if (view.category === null) {
        // Everything takes no clause at all: a list of every key would drop the ones the frozen
        // registry does not carry.
        expect(filter).toBeNull();
        continue;
      }
      expect(filter, `${view.key} has no server-side filter`).not.toBeNull();
      for (const action of EVERY_ACTION) {
        expect(
          selects(filter!, action),
          `${action} is ${auditCategoryOf(action)} on screen but the ${view.key} query disagrees`,
        ).toBe(auditCategoryOf(action) === view.category);
      }
    }
  });

  it("keeps a publish a publish when the key is not in the frozen registry", () => {
    // The registry is closed and migrations still add keys, so publishes are matched on the suffix
    // rather than enumerated. A list would silently drop this one.
    const later = `offer.variant${PUBLISH_SUFFIX}`;
    expect(Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, later)).toBe(false);
    expect(auditCategoryOf(later)).toBe("publish");
    expect(selects(auditViewFilter("publish")!, later)).toBe(true);
  });

  it("puts no action in two views at once", () => {
    for (const action of EVERY_ACTION) {
      const matched = AUDIT_VIEWS
        .filter((view) => view.category !== null && selects(auditViewFilter(view.key)!, action));
      expect(matched.length, `${action} is in ${matched.map((view) => view.key).join(" and ")}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("falls back to Everything for a view key the URL made up", () => {
    expect(isAuditViewKey("publish")).toBe(true);
    expect(isAuditViewKey("takeovers")).toBe(false);
    expect(isAuditViewKey(null)).toBe(false);
    expect(AUDIT_VIEWS.map((view) => view.key))
      .toEqual(["all", "publish", "takeover", "pause"] satisfies AuditViewKey[]);
  });
});
