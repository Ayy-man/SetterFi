import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * How long `findBy*` and `waitFor` are allowed to keep looking.
 *
 * Testing Library's default is 1000ms and it is independent of Vitest's own timeout, so a test
 * carrying `{ timeout: 15_000 }` still gave a query one second to succeed. Under fleet load that
 * is not enough for a component whose first paint is behind a couple of effects, and the failure
 * does not read as a timeout -- the query gives up and reports "Unable to find role ...", which
 * looks exactly like a real assertion failure and cost this pass several false triage rounds.
 *
 * Five seconds is well inside the 15s per-test budget, so a genuinely stuck query still fails the
 * test rather than hanging the suite; it only stops a slow render from being reported as a
 * missing element.
 */
configure({ asyncUtilTimeout: 5_000 });

afterEach(cleanup);

const matchMedia: typeof window.matchMedia = vi.fn(() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
}));

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: matchMedia,
  writable: true,
});

class IntersectionObserverStub implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  disconnect() {}
  observe() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve() {}
}

class ResizeObserverStub implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

/*
 * Defined rather than stubbed, which is the same choice `matchMedia` above already makes and for
 * the same reason.
 *
 * `vi.stubGlobal` registers the value in the stub registry, so the first suite that calls
 * `vi.unstubAllGlobals()` in an `afterEach` -- several do, to drop a `fetch` mock -- deletes these
 * two along with its own stub, for every test in that file after the first. The failure that
 * produces is a bare "ReferenceError: IntersectionObserver is not defined" thrown out of
 * `next/link`'s prefetch effect, which looks nothing like the thing that caused it: it appears the
 * moment a component starts rendering a `<Link>` unconditionally, and it blames the component.
 *
 * These are environment fixtures, not per-test stubs. Nothing should be able to remove them.
 */
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  value: IntersectionObserverStub,
  writable: true,
});

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverStub,
  writable: true,
});
