/**
 * The shared case table for the disclosure-host rule.
 *
 * Its own module rather than a fixture inside one of the two test files, because both halves of
 * the rule are tested by suites that cannot run together: the TypeScript unit test runs DB-free
 * under `vitest.config.mts`, and the agreement test needs a live Postgres under
 * `vitest.rls.config.mts`. A case table copied into both would let the two sides drift silently,
 * which is the exact failure the agreement test exists to catch -- so the table is imported, not
 * duplicated.
 *
 * Add a case here and both suites pick it up.
 */

export type DisclosureCase = {
  /** The stored URL, exactly as it would sit in `onboarding_optin_artifacts.privacy_url`. */
  url: string;
  /** Whether the host can ever resolve for anybody. */
  reachable: boolean;
  /** Why this case is in the table. Read as documentation of the rule's edges. */
  because: string;
};

export const DISCLOSURE_CASES: DisclosureCase[] = [
  // --- Ordinary reachable hosts -------------------------------------------------------------
  { url: "https://coach.example-agency.com/privacy", reachable: true,
    because: "an ordinary registrable host with a hyphen before the reserved second-level name" },
  { url: "https://legacystrong.com/privacy", reachable: true,
    because: "the plain case: a real host, a real path" },
  { url: "https://www.coach-site.co.uk/legal/privacy?v=2#top", reachable: true,
    because: "query and fragment are past the host and must not affect the judgement" },
  { url: "https://coach-site.com:8443/privacy", reachable: true,
    because: "an explicit port is past the host and must not affect the judgement" },
  { url: "https://user:pw@coach-site.com/privacy", reachable: true,
    because: "userinfo precedes the host and must be skipped, not read as the host" },
  { url: "https://COACH-SITE.COM/Privacy", reachable: true,
    because: "the host is case-insensitive, so it is lowered before the reserved names are matched" },
  { url: "https://testing-grounds.com/privacy", reachable: true,
    because: "`test` inside a label is not the `.test` TLD -- the match is anchored to a dot" },
  { url: "https://example.company.com/privacy", reachable: true,
    because: "`example` as a first label of a real domain is registrable and must not be refused" },
  { url: "https://notexample.com/privacy", reachable: true,
    because: "the reserved second-level rule is anchored, so a longer label is not a subdomain of it" },

  // --- RFC 2606 reserved top-level names ------------------------------------------------------
  { url: "https://example.invalid/phase5-demo/privacy", reachable: false,
    because: "the exact placeholder found sitting in the hosted database on 2026-09-01" },
  { url: "https://coach-site.test/privacy", reachable: false,
    because: "`.test` is reserved and can never be registered" },
  { url: "https://anything.example/privacy", reachable: false,
    because: "`.example` is a reserved TLD, distinct from the `example.com` second-level names" },
  { url: "https://box.localhost/privacy", reachable: false,
    because: "`.localhost` is reserved and resolves only on the machine that asks" },
  { url: "https://localhost/privacy", reachable: false,
    because: "bare `localhost` has no dot, so the TLD rule misses it and it needs its own arm" },
  { url: "https://deep.nested.sub.example.invalid/privacy", reachable: false,
    because: "the reserved TLD rule must reach past any depth of subdomain" },

  // --- RFC 2606 reserved second-level names ---------------------------------------------------
  { url: "https://example.com/privacy", reachable: false,
    because: "reserved second-level name; the most likely placeholder a person types by hand" },
  { url: "https://example.net/privacy", reachable: false, because: "reserved second-level name" },
  { url: "https://example.org/privacy", reachable: false, because: "reserved second-level name" },
  { url: "https://www.example.com/privacy", reachable: false,
    because: "a subdomain of a reserved second-level name is equally unregistrable" },
  { url: "https://a.b.example.org/privacy", reachable: false,
    because: "the subdomain arm must reach past any depth" },

  // --- Not a URL with a host at all -----------------------------------------------------------
  // The column is `not null check (privacy_url ~ '^https://')`, so these cannot be stored today.
  // They are here because the rule must answer for them rather than throw: every caller is
  // reading a row that already exists, and a read that raises is worse than a read that says no.
  { url: "", reachable: false, because: "empty string: no host to judge" },
  { url: "/opt-in/tenant-a/privacy", reachable: false,
    because: "a relative path has no scheme, so no host can be extracted" },
  { url: "http://coach-site.com/privacy", reachable: false,
    because: "plain http does not match the anchored https scheme, so no host is extracted" },
  { url: "https://", reachable: false, because: "a scheme with nothing after it" },
  { url: "https:///privacy", reachable: false, because: "an empty host between the slashes" },
];
