// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/coach/conversations",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import { RESERVED_QUERY_KEYS, useQueryState } from "@/lib/query-state";

describe("useQueryState", () => {
  beforeEach(() => {
    navigation.pathname = "/coach/conversations";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("writes repeated facet values without a scroll jump", () => {
    const { result } = renderHook(() => useQueryState());

    act(() => result.current.set("channel", ["instagram", "sms"]));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?channel=instagram&channel=sms",
      { scroll: false },
    );
  });

  it("publishes the shared reserved-key vocabulary", () => {
    expect(RESERVED_QUERY_KEYS).toEqual(["view", "q", "sort", "cols", "density"]);
  });

  it("does not lose a prior write while navigation is pending", () => {
    const { result } = renderHook(() => useQueryState());

    act(() => result.current.set("channel", "instagram"));
    act(() => result.current.set("stage", "qualifying"));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?channel=instagram&stage=qualifying",
      { scroll: false },
    );
  });

  it("toggles repeated values against pending query state", () => {
    const { result } = renderHook(() => useQueryState());

    act(() => result.current.toggle("channel", "instagram", true));
    act(() => result.current.toggle("channel", "sms", true));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?channel=instagram&channel=sms",
      { scroll: false },
    );
  });

  it("reads new search params as the source of truth on rerender", () => {
    navigation.searchParams = new URLSearchParams("objection=pricing");
    const { result, rerender } = renderHook(() => useQueryState());
    expect(result.current.get("objection")).toBe("pricing");

    navigation.searchParams = new URLSearchParams("objection=timing");
    rerender();

    expect(result.current.getAll("objection")).toEqual(["timing"]);
  });

  it("clears selected keys and preserves display options", () => {
    navigation.searchParams = new URLSearchParams(
      "view=needs-you&q=price&channel=sms&density=compact",
    );
    const { result } = renderHook(() => useQueryState());

    act(() => result.current.clear(["view", "q", "channel"]));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?density=compact",
      { scroll: false },
    );
  });

  it("can clear the entire query string", () => {
    navigation.searchParams = new URLSearchParams(
      "view=needs-you&objection=pricing&density=compact",
    );
    const { result } = renderHook(() => useQueryState());

    act(() => result.current.clear());

    expect(navigation.replace).toHaveBeenLastCalledWith("/coach/conversations", {
      scroll: false,
    });
  });
});
