# Phase 4 channels demo runbook

This runbook proves the deterministic local Mock path for channels beyond GHL. It does not prove
Meta filing, provider delivery, deployment, or a signed-in browser observation; those evidence lanes
stay open until their named receipts exist.

## Preconditions

- Use only the deterministic `setterfi-demo` tenant. The seed and reset refuse any target whose
  tenant ID, slug, and `is_demo` marker do not match.
- The shared local Supabase stack must be available on API port 54321 and database port 54322.
- Port 3218 is exclusive to this run. Confirm it is free with
  `lsof -nP -iTCP:3218 -sTCP:LISTEN`; no output means the runner may start its server.
- Missing provider credentials select Mock. Do not arm a Real driver unless every named test asset
  is ready and the recipient is a designated test contact.
- Every seeded template is marked Demo. The only seeded approved template has a name and body that
  begin `SETTERFI_DEMO_PLACEHOLDER_`; the four Alec candidate placeholders remain draft.

## Deterministic sequence

1. **Seed twice.** Run `npm run demo:seed` twice. Both runs must report the same exact Phase 4
   readback: 4 connections, 6 identities, 2 provider windows, 10 templates, and 1 open duplicate
   candidate.
2. **Connect and receive a signed inbound.** Run `npm run demo:run`. The runner checks port 3218,
   starts the flagged local app, exercises the historical GHL connection, and posts a correctly signed
   synthetic Meta inbound to the direct Instagram connection. Record the provider receipt, persisted
   inbound message, and provider-window readback printed by the runner. On the current merged base,
   stop and report if the inherited outbound persistence port returns `provider_unconfirmed`; do not
   weaken message-table grants or substitute a direct SQL write for the required gateway receipt.
3. **Confirm the provider-blind engine boundary.** The `Phase 4 gate` case in
   `src/lib/demo-contract.test.ts` normalizes equivalent GHL and Meta events and proves that
   `canonicalInboundEngineInput` is identical. The outbound reply still flows through
   `sendToLead` and the single `provider-dispatch.ts` dispatch path.
4. **Exercise window, template, and refusal.** Run the focused contract tests. An expired Meta
   freeform send must return `PROVIDER_WINDOW_EXPIRED` before driver I/O, while the explicitly
   approved Demo placeholder uses an `approved_template` command. The approved row must render
   `Approved` with `Demo` beside it; approval without its persisted timestamp renders
   `Status unavailable`.
5. **Exercise provider switch and identity backfill.** Use the seeded open conversation and
   historical GHL/direct connections with the provider-switch contract tests. A switch without a
   complete identity backfill is refused; a successful switch preserves the original contact and
   conversation history.
6. **Exercise duplicate merge and unmerge.** Use the seeded field-match candidate and merge audit
   with the merge contract tests. The phone match remains only a suspected duplicate until an
   explicit merge; the immutable audit row is the unmerge source, and test-to-real merges refuse.
7. **Inspect client-visible evidence.** On the live coach contact surface, verify every reachable
   channel and the suspected duplicate are visible, approved synthetic templates carry a `Demo`
   label, merge/unmerge controls reflect persisted state, and each table export produces CSV and
   JSON. This is browser evidence and must remain pending if it is not observed.
8. **Reset twice.** Run `npm run demo:reset` twice. Every delete reasserts the exact Demo tenant and
   targets only deterministic IDs. Both runs must restore the same baseline counts.

## Optional Real arms

`meta.real.test.ts` is a read-only provider probe. It is SKIPPED unless
`SETTERFI_META_DRIVER=real` and all named Meta app and WhatsApp variables are present.

`real-roundtrip.test.ts` additionally requires `SETTERFI_META_REAL_ROUNDTRIP=confirmed`,
`APP_BASE_URL`, hosted Supabase names, and a current provider-signed inbound for the configured
WhatsApp phone. The test refuses local URLs and refuses to send unless that signed inbound resolves
to exactly one `is_test` contact in an `is_demo` tenant. Completion requires all three artifacts:
the outbound provider response ID, a signed status receipt, and an exact persisted receipt readback.
HTTP acceptance by itself is not completion.

## Evidence boundaries

- **Local Mock:** deterministic provider-shaped normalization, signature verification, persistence,
  policy, one physical dispatch, reset safety, and exact database readbacks.
- **Skipped Real:** names the absent selector, credentials, assets, hosted callback, or explicit
  confirmation. A skip is not evidence of provider behavior.
- **Human filing:** the App Review package remains `not_filed`; Ayman or Alec must submit it and
  record the provider reference and date.
- **Deployment/runtime:** CI, deployment, webhook reachability, signed-in browser observations, and
  real provider delivery require their own evidence and are not inferred from local gates.
