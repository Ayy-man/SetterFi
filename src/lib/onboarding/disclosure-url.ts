/**
 * Is a disclosure URL's host one that can ever resolve for anybody?
 *
 * This is the TypeScript half of a rule that also exists in SQL, as
 * `app.disclosure_host_is_reachable(text)` in
 * `supabase/migrations/20261005000003_consumer_disclosure_privacy_link.sql`. The SQL side is the
 * enforcement point: it decides whether `start_consumer_conversation_session` hands the consumer
 * page a link at all, so a lead never sees an anchor to a host that cannot be reached. This side
 * enforces nothing. It exists so that admin evidence and export reads can *say* a stored URL is
 * unusable without changing what they return.
 *
 * Two implementations of one rule in two runtimes is the pair that drifts, so
 * `supabase/tests/disclosure-url-agreement.test.ts` runs a shared case table through both and
 * asserts they agree. Change this file and you must change the migration, or that test goes red --
 * which is the point of it.
 *
 * RFC 2606 reserves `.test`, `.example`, `.invalid` and `.localhost`, plus the `example.com`,
 * `example.net` and `example.org` second-level names, precisely so they can never be registered.
 * A URL on one of them is a placeholder that survived into production rather than a policy a
 * person can read.
 */

/** Host only: after the scheme, past any userinfo, stopping at port, path, query or fragment. */
const HOST = /^https:\/\/(?:[^@/]*@)?([^/:?#]+)/;

/** RFC 2606 reserved top-level names. A host ending in one of these is unregistrable. */
const RESERVED_TLD = /\.(test|example|invalid|localhost)$/;

/** RFC 2606 reserved second-level names, including any subdomain of them. */
const RESERVED_SLD = /^(?:.+\.)?example\.(com|net|org)$/;

/**
 * The host of a disclosure URL, lowercased, or null when the string is not an `https://` URL with
 * a host. Exported because the reachability answer alone is not enough to explain itself: an
 * operator looking at a flagged row wants to see which host was judged.
 */
export function disclosureHost(url: string): string | null {
  const match = HOST.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/**
 * False for a URL whose host can never resolve for anyone -- a reserved name, `localhost`, or a
 * string that is not an `https://` URL at all. Never throws: an unparseable input is unreachable,
 * not an error, because every caller here is a read of a row that already exists.
 */
export function disclosureHostIsReachable(url: string): boolean {
  const host = disclosureHost(url);
  if (host === null || host === "" || host === "localhost") return false;
  return !RESERVED_TLD.test(host) && !RESERVED_SLD.test(host);
}
