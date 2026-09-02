import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260905000009_provider_connection_atomicity.sql",
), "utf8");
const hardeningMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260905000010_backend_security_sagas.sql",
), "utf8");
const inboundSource = readFileSync(resolve(
  process.cwd(),
  "src/lib/webhooks/process-inbound.ts",
), "utf8");
const embeddedSignupSource = readFileSync(resolve(
  process.cwd(),
  "src/app/api/channels/meta/embedded-signup/handler.ts",
), "utf8");

describe("atomic provider connection custody", () => {
  it("persists GHL installed state and both credential envelopes in one RPC", () => {
    expect(migration).toContain(
      "create or replace function public.persist_ghl_install_credentials_atomic",
    );
    expect(migration).toContain("insert into public.ghl_install_secrets");
    expect(migration).toContain("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
    expect(migration).toContain("set tenant_id = p_expected_tenant");
    expect(inboundSource).toContain('client.rpc("persist_ghl_install_credentials_atomic"');
    expect(inboundSource).not.toContain('.from("ghl_installs").upsert(');
    expect(inboundSource).not.toContain('.from("ghl_install_secrets").upsert(');
  });

  it("persists Meta readiness, evidence, credential custody, and audits in one RPC", () => {
    expect(migration).toContain(
      "create or replace function public.persist_meta_whatsapp_connection_atomic",
    );
    expect(migration).toContain("perform app.phase4_assert_tenant_actor");
    expect(migration).toContain("'whatsapp_business_management', 'whatsapp_business_messaging'");
    expect(migration).toContain("'scopes', to_jsonb(coalesce(p_scopes, '{}'::text[]))");
    expect(migration).toContain("insert into public.channel_connection_secrets");
    expect(migration).toContain("'channel.connect.started'");
    expect(migration).toContain("'channel.connect.completed'");
    expect(embeddedSignupSource).toContain(
      'client.rpc("persist_meta_whatsapp_connection_atomic"',
    );
    expect(embeddedSignupSource).not.toContain('.from("channel_connections")');
    expect(embeddedSignupSource).not.toContain('.from("channel_connection_secrets")');
  });

  it("exposes both custody transactions only to service role", () => {
    expect(migration).toContain("from public, anon, authenticated;");
    expect(migration).toContain("to service_role;");
  });

  it("enforces every credential-envelope field at the database boundary", () => {
    expect(hardeningMigration).toContain("create or replace function app.credential_envelope_valid");
    expect(hardeningMigration).not.toContain("jsonb_object_length");
    expect(hardeningMigration).toContain("from jsonb_object_keys(p_envelope)");
    expect(hardeningMigration).toContain("p_envelope ?& array[");
    expect(hardeningMigration).toContain("jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'");
    expect(hardeningMigration).toContain("p_envelope -> 'version' <> '1'::jsonb");
    expect(hardeningMigration).toContain("p_envelope -> 'keyVersion' <> '1'::jsonb");
    expect(hardeningMigration).toContain("p_envelope ->> 'algorithm' <> 'A256GCM'");
    expect(hardeningMigration).toContain("length(ciphertext_text) % 4 = 1");
    expect(hardeningMigration).toContain("regexp_replace(encode(ciphertext_bytes, 'base64'), '\\s', '', 'g')");
    expect(migration).toContain("not app.credential_envelope_valid(p_access_credential_envelope)");
    expect(migration).toContain("not app.credential_envelope_valid(p_credential_envelope)");
    expect(hardeningMigration).toContain("ghl_install_secrets_access_envelope_chk");
    expect(hardeningMigration).toContain("ghl_install_secrets_refresh_envelope_chk");
    expect(hardeningMigration).toContain("channel_connection_secrets_envelope_chk");
  });

  it("downgrades ready credential-backed parents that have no valid custody", () => {
    expect(hardeningMigration).toContain("connection.provider in ('ghl', 'meta_direct')");
    expect(hardeningMigration).toContain("connection.state in ('ready', 'live')");
    expect(hardeningMigration).toMatch(/connection\.state in \('ready', 'live'\)[\s\S]*not exists \([\s\S]*credential_envelope_valid/);
    expect(hardeningMigration).toMatch(/install\.install_state <> 'uninstalled'[\s\S]*not exists \([\s\S]*access_credential_envelope/);
  });

  it("retires GHL state and credential custody atomically", () => {
    expect(hardeningMigration).toContain("create or replace function public.mark_ghl_uninstalled_atomic");
    expect(hardeningMigration).toContain("delete from public.ghl_install_secrets");
    expect(hardeningMigration).toContain("set install_state = 'uninstalled'");
    expect(inboundSource).toContain('client.rpc("mark_ghl_uninstalled_atomic"');
  });
});
