import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const legacy = readFileSync(
  new URL("../../../supabase/migrations/20260820000001_phase4_channels.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../../supabase/migrations/20260905000010_backend_security_sagas.sql", import.meta.url),
  "utf8",
);

describe("legacy credential quarantine migration", () => {
  it("recognizes the deliberate V0 legacy envelope that exists on live upgrade paths", () => {
    expect(legacy).toContain("'version', 0");
    expect(legacy).toContain("'algorithm', 'LEGACY_CIPHERTEXT'");
    expect(migration).toContain("not coalesce(app.credential_envelope_valid");
  });

  it("downgrades channel readiness before deleting unusable legacy custody", () => {
    const downgrade = migration.indexOf("update public.channel_connections connection");
    const deletion = migration.indexOf("delete from public.channel_connection_secrets secret");
    const constraint = migration.indexOf("channel_connection_secrets_envelope_chk");
    expect(downgrade).toBeGreaterThan(-1);
    expect(migration.slice(downgrade, deletion)).toContain("state = 'error'");
    expect(migration.slice(downgrade, deletion)).toContain("LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED");
    expect(downgrade).toBeLessThan(deletion);
    expect(deletion).toBeLessThan(constraint);
  });

  it("fails sub-account installs and clears refresh leases before secret deletion", () => {
    const downgrade = migration.indexOf("update public.ghl_installs install");
    const deletion = migration.indexOf("delete from public.ghl_install_secrets secret");
    expect(migration.slice(downgrade, deletion)).toContain("install_state = 'failed'");
    expect(migration.slice(downgrade, deletion)).toContain("reauthorization_required_at");
    expect(migration.slice(downgrade, deletion)).toContain("refresh_lock_expires_at = null");
    expect(migration.slice(downgrade, deletion)).toContain("refresh_lock_token = null");
    expect(downgrade).toBeLessThan(deletion);
  });

  it("removes inline agency custody while retaining a failed row for reauthorization", () => {
    const downgrade = migration.indexOf("update public.ghl_agency_installs install");
    const constraints = migration.indexOf("ghl_agency_installs_access_envelope_chk");
    const block = migration.slice(downgrade, constraints);
    expect(block).toContain("install_state = 'failed'");
    expect(block).toContain("access_credential_envelope = null");
    expect(block).toContain("refresh_credential_envelope = null");
    expect(block).toContain("reauthorization_required_at");
    expect(migration).toContain("ghl_agency_installs_missing_custody_chk");
  });

  it("validates every strict constraint in the same migration after cleanup", () => {
    for (const name of [
      "ghl_install_secrets_access_envelope_chk",
      "ghl_install_secrets_refresh_envelope_chk",
      "channel_connection_secrets_envelope_chk",
      "ghl_agency_installs_access_envelope_chk",
      "ghl_agency_installs_refresh_envelope_chk",
      "ghl_agency_installs_envelope_pair_chk",
      "ghl_agency_installs_missing_custody_chk",
    ]) {
      expect(migration).toContain(`validate constraint ${name}`);
    }
  });

  it("keeps the immutable validator invoker-safe and executable only by service role", () => {
    const helper = migration.slice(
      migration.indexOf("create or replace function app.credential_envelope_valid"),
      migration.indexOf("-- Phase 4 deliberately quarantined"),
    );
    expect(helper).not.toContain("security definer");
    expect(helper).not.toContain("jsonb_object_length");
    expect(helper).toContain("from jsonb_object_keys(p_envelope)");
    expect(helper).toContain("p_envelope ?& array[");
    expect(migration).toContain("grant execute on function app.credential_envelope_valid(jsonb) to service_role");
    expect(migration).toMatch(/revoke execute on function app\.credential_envelope_valid\(jsonb\)[\s\S]*from public, anon, authenticated/);
  });
});
