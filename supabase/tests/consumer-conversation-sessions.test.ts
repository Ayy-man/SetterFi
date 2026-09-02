import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try { await db.connect(); } catch (cause) {
    throw new Error(`Consumer-session suite could not reach Postgres at ${DB_URL}. Start the local stack with supabase start.`, { cause });
  }
});
afterAll(async () => db?.end());

describe("consumer conversation sessions", () => {
  it("keeps opaque session references under forced RLS and service-role-only RPC custody", async () => {
    expect((await db.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.consumer_conversation_sessions'::regclass`)).rows[0])
      .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await db.query(`select has_function_privilege('anon', 'public.load_consumer_conversation_session(text)', 'EXECUTE') as anon_exec, has_function_privilege('service_role', 'public.load_consumer_conversation_session(text)', 'EXECUTE') as service_exec`)).rows[0])
      .toEqual({ anon_exec: false, service_exec: true });
  });

  it("refuses an unknown tenant slug before it can create a conversation", async () => {
    await expect(db.query(`select * from public.start_consumer_conversation_session('missing-tenant', '00000000-0000-4000-8000-000000000099', repeat('a', 64), now() + interval '1 hour')`))
      .rejects.toThrow(/CONSUMER_TENANT_UNAVAILABLE/u);
  });
  /**
   * The disclosure link, which is the one anchor a lead sees on the most externally visible
   * surface in the product.
   *
   * `start_consumer_conversation_session` used to return `privacy_url` on two conditions --
   * `is_current` and `confirmed_at is not null` -- while `read_hosted_onboarding_artifact`, reading
   * the same rows for the page that link points at, uses six. `privacy_url` is `not null check
   * (~ '^https://')` and `privacy_body` is nullable, so a row with a URL and no body is legal and
   * the link resolved to "Privacy policy not published." Each case below is one of the conditions
   * that disagreed.
   */
  describe("the disclosure privacy link", () => {
    const hex = (seed: string) => seed.repeat(64).slice(0, 64);

    /** One tenant with everything a session needs, varied only by the artifact under test. */
    async function privacyLinkFor(artifact: {
      privacyUrl?: string;
      privacyBody?: string | null;
      placeholder?: boolean;
      isDemo?: boolean;
      marketing?: string;
    }) {
      const {
        privacyUrl = "https://coach-site.test-not-reserved.com/privacy",
        privacyBody = "The published privacy policy body.",
        placeholder = false,
        isDemo = false,
        marketing = "Marketing language.",
      } = artifact;

      await db.query("begin");
      try {
        const tenant = (await db.query(
          `insert into public.tenants (slug, name, billing_contact_email, status, is_demo)
           values ('disclosure-probe', 'Disclosure Probe', 'billing@probe.invalid', 'active', $1) returning id`,
          [isDemo],
        )).rows[0].id as string;
        const confirmer = (await db.query(
          `insert into public.users (id, email, role, tenant_id)
           values (gen_random_uuid(), 'confirmer@probe.invalid', 'coach', $1) returning id`,
          [tenant],
        )).rows[0].id as string;
        const contact = (await db.query(
          `insert into public.contacts (tenant_id, last_channel) values ($1, 'webchat') returning id`,
          [tenant],
        )).rows[0].id as string;
        const identity = (await db.query(
          `insert into public.contact_identities (tenant_id, contact_id, provider, channel, provider_identity_id, consent_state)
           values ($1, $2, 'meta_direct', 'webchat', 'probe-identity', 'conversation') returning id`,
          [tenant, contact],
        )).rows[0].id as string;
        await db.query(
          `insert into public.offer_layers (tenant_id, status, version, program_name, content_hash)
           values ($1, 'published', 1, 'Probe Program', $2)`,
          [tenant, hex("f")],
        );
        await db.query(
          `insert into public.onboarding_optin_artifacts
             (tenant_id, version, template_version, marketing_language, marketing_language_hash,
              non_marketing_language, non_marketing_language_hash, terms_url, privacy_url,
              campaign_description, campaign_description_hash, artifact_hash,
              privacy_body, placeholder, is_current, confirmed_at, confirmed_by)
           values ($1, 1, 'v1', $2, $3, 'Non-marketing language.', $4,
                   'https://coach-site.test-not-reserved.com/terms', $5,
                   'Campaign description.', $6, $7, $8, $9, true, now(), $10)`,
          [tenant, marketing, hex("a"), hex("b"), privacyUrl, hex("c"), hex("d"), privacyBody, placeholder, confirmer],
        );

        const started = await db.query(
          `select privacy_url from public.start_consumer_conversation_session('disclosure-probe', $1, $2, now() + interval '1 hour')`,
          [identity, hex("e")],
        );
        return started.rows[0].privacy_url as string;
      } finally {
        await db.query("rollback");
      }
    }

    it("returns the link when the page behind it will render", async () => {
      expect(await privacyLinkFor({})).toBe("https://coach-site.test-not-reserved.com/privacy");
    });

    it("returns nothing when the privacy body was never published", async () => {
      // The legal row that started this: a URL with no body, linking to "Privacy policy not
      // published." An absent link is honest about that; a dead link is not.
      expect(await privacyLinkFor({ privacyBody: null })).toBe("");
    });

    it("returns nothing for a placeholder artifact on a real tenant", async () => {
      expect(await privacyLinkFor({ placeholder: true })).toBe("");
      // A demo tenant is the one place a placeholder is legitimate, exactly as the artifact reader
      // has it -- so the link comes back. Asserting "" here is what a rule copied by shape rather
      // than by meaning would say, and it is what the first draft of this test said.
      expect(await privacyLinkFor({ placeholder: true, isDemo: true }))
        .toBe("https://coach-site.test-not-reserved.com/privacy");
    });

    it("returns nothing when demo placeholder markers survived onto a real tenant", async () => {
      expect(await privacyLinkFor({ marketing: "SETTERFI_DEMO_PLACEHOLDER_MARKETING" })).toBe("");
    });

    it("returns nothing for a host that can never resolve, demo tenant included", async () => {
      // Live today: the one confirmed current artifact in the hosted database carries
      // https://example.invalid/phase5-demo/privacy, which passes the column's ^https:// check.
      expect(await privacyLinkFor({ privacyUrl: "https://example.invalid/phase5-demo/privacy" })).toBe("");
      expect(await privacyLinkFor({ privacyUrl: "https://example.invalid/x", isDemo: true })).toBe("");
      expect(await privacyLinkFor({ privacyUrl: "https://coach.example.com/privacy" })).toBe("");
    });

    it("still starts the session in every one of those cases", async () => {
      // Ruled deliberately: a lead who gets no conversation at all because their coach's privacy
      // body is empty is a worse outcome than a disclosure line without a link.
      await expect(privacyLinkFor({ privacyBody: null })).resolves.toBe("");
    });

    it("judges a reserved host without catching the names that merely resemble one", async () => {
      const reachable = async (url: string) =>
        (await db.query(`select app.disclosure_host_is_reachable($1) as ok`, [url])).rows[0].ok as boolean;
      expect(await reachable("https://example.invalid/x")).toBe(false);
      expect(await reachable("https://foo.test/x")).toBe(false);
      expect(await reachable("https://app.localhost:3000/x")).toBe(false);
      expect(await reachable("https://user:pw@evil.invalid/x")).toBe(false);
      // Neither of these is reserved, and a looser rule -- a substring or a bare suffix on
      // "example" -- would refuse both and take a real coach's policy down with it.
      expect(await reachable("https://notexample.com/x")).toBe(true);
      expect(await reachable("https://myexample.com/x")).toBe(true);
      expect(await reachable("https://sub.coach.co.uk/privacy?a=1#b")).toBe(true);
    });
  });
});
