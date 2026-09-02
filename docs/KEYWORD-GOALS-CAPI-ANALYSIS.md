# Keyword goals and Meta CAPI analysis

**Client request:** Alec Delpuech, 2026-09-01  
**Analysis status:** source-complete; provider credentials and three product rulings remain open  
**Implementation phase:** Phase 13 — DM Ad Keyword Goals and Meta CAPI

## Verdict

SetterFi has most of the downstream seams this feature needs: direct Meta messaging, durable
inbound receipts, an exact qualification transition, a confirmation-safe booking transition,
per-keyword measurement, provider selectors, audit registries, forced-RLS conventions, and
receipt-backed Connections UI. It does not have keyword-goal configuration, CAPI dataset/event
storage, or any CAPI driver.

Two existing gaps are more important than adding a provider client. `conversations.first_touch_keyword`
already feeds the keyword KPI query but no live ingest path writes it, and the current Meta
normalizer discards the referral object for Messenger, Instagram, and WhatsApp. The new work must
make attribution durable at the same transaction boundary that creates the conversation before it
can truthfully branch by keyword or report keyword outcomes.

This document treats the provider facts supplied by Ayman on 2026-09-01 as locked. It does not
substitute remembered Meta behavior or invent unsupported event names.

## Locked provider contract

- Delivery uses the Conversions API for Business Messaging: `POST
  graph.facebook.com/{DATASET_ID}/events`, `action_source = "business_messaging"`, and
  `messaging_channel` equal to `messenger`, `instagram`, or `whatsapp`.
- The qualified transition sends the fixed Meta event `QualifiedLead`. The booked transition sends
  the fixed Meta event `Purchase`; `Schedule` and the client's labels `SF Qualified DM` and
  `SF Schedule DM` are not provider event names.
- Messenger user data is Page ID plus PSID. Instagram user data is Instagram business account ID
  plus IGSID. WhatsApp user data is WABA ID plus `ctwa_clid`.
- Messenger and Instagram ad attribution comes from the webhook referral object: `ad_id`,
  `source = "ADS"`, `ads_context_data`, and optional `ref`. WhatsApp `ctwa_clid` comes from its
  inbound referral object and must be persisted on first ingest.
- Dataset provisioning is get-or-create on the connected asset: Page ID for Messenger, Instagram
  user ID for Instagram, and WABA ID for WhatsApp. The coach's business owns it.
- The filing needs `page_events`, `instagram_manage_events`, and
  `whatsapp_business_manage_events` in the same App Review submission as the corresponding
  messaging permissions. The events permissions are expected to auto-approve after messaging has
  advanced access. Ads Management Standard Access is a later unlock, not a build blocker.
- Meta does not deduplicate these events. SetterFi owns the one-event-per-conversation boundary.
- Messenger and WhatsApp click-to-message ads can optimize from these events. Instagram receives
  measurement only; SetterFi must never promise Instagram ad optimization.

## Current source map

| Concern | Current source | What exists | Gap this phase owns |
|---|---|---|---|
| Meta normalization | `src/lib/integrations/meta.ts` | Messenger/Instagram and WhatsApp messages normalize into one `NormalizedInboundMessage`. | Both normalizers read message text and identity but drop referral, `ad_id`, `ref`, `ads_context_data`, and `ctwa_clid`. |
| Provider-neutral inbound contract | `src/lib/integrations/types.ts` | `NormalizedInboundMessage` carries message, account, identity, and reply-window data. | It has no optional attribution snapshot. |
| Durable ingest | `src/lib/identity.ts`, `src/lib/webhooks/process-inbound.ts`, `public.persist_inbound_message(...)` most recently wrapped in `20260905000010_backend_security_sagas.sql` | Signed receipts are processed with an explicit tenant; identity, contact, conversation, and message are replay-safe. | The RPC has no attribution or keyword parameters, and conversation creation leaves `first_touch_keyword` null. |
| Existing keyword attribution | `conversations.first_touch_keyword` from `20260813000001_init.sql` | Indexed tenant-scoped text field intended for first-touch attribution. | No production TypeScript or SQL writer exists. |
| Existing keyword analytics | `public.coach_measurement_snapshot(...)` in `20260823000001_phase7_measurement.sql`; `src/components/workspace/live/coach-measurement.tsx`; export resource `coach-measurement-keywords` | Groups eligible conversations by trimmed `first_touch_keyword` and reports conversation, qualified-contact, responded-conversation, and booked-contact counts. The table already exports through the server route. | Current UI is count-only, uses “Conversations” rather than the client's “Opt-ins,” and has no per-stage count/percent mode. The qualified definition includes `BOOK` and `qualified_no_buy`; the client needs the exact AI-qualified transition. |
| Offer layer | `offer_layers`, `offer_prices`, `offer_assets`; `src/lib/repositories/offer-layer.ts`; `/api/coach/offer`; `src/components/workspace/live/coach-offer.tsx` | Tenant offer drafts/published versions already carry HTTPS assets, prices, qualification rules, voice, and cadence. | A shared asset library cannot express one goal and one post-booking destination per trigger. Keyword goals need their own tenant table and write contract, while links may optionally reference or copy an existing asset. |
| Qualified seam | `qualificationTurnRpcInput(...)` in `src/lib/webhooks/process-inbound.ts`; `public.apply_qualification_turn(...)` in `20260905000005_qualification_runtime.sql` | One inbound message can atomically set the contact outcome to `BOOK`, `SOFT_DQ`, or `HARD_DQ`, with replay receipts and compare-and-swap checks. | `BOOK` is the exact AI-qualified seam, but it emits no external-conversion outbox row. |
| Booked seam | `public.record_provider_appointment(...)` and `public.finalize_booking_slot_confirmation(...)`; caller in `src/lib/webhooks/process-inbound.ts` | Provider appointment creation is idempotent, while the conversation closes as booked only after the exact outbound confirmation is durable. | `Purchase` must enqueue at confirmation, not provider creation, or an interrupted confirmation could be counted as booked before the lead was told. |
| Existing outbox pattern | `booking_lifecycle_outbox`, its claim/finish RPCs, and `src/app/api/jobs/appointment-reconcile/handler.ts` | Forced-RLS service-only queue, `SKIP LOCKED` claims, leases, retry scheduling, and a cron-authenticated worker. | CAPI needs its own fixed-event queue, bounded retry count, terminal state, provider receipt, and per-attempt error collapse. |
| Connection and credential custody | `channel_connections`, `channel_connection_secrets`, `src/lib/integrations/connection-resolver.ts` | Ready/live Meta connections expose an external asset ID while the encrypted token stays service-only. WhatsApp `external_ref` already stores `waba_id` and `phone_number_id`. | Dataset provisioning needs a metadata resolver that returns Page/IG/WABA asset ID and a token without exposing either to the client. |
| Provider selection and flags | `src/lib/env-contract.ts`, `src/lib/integrations/selector.ts` | Explicit real selectors fail closed when named configuration is absent; feature flags are exact-string booleans. | Add `SETTERFI_CAPI_LIVE` to the single env inventory and consult it at the CAPI driver boundary. Test/demo custody must override that flag and select exclusion before any real driver is constructed. |
| Connections UI | `/coach/integrations`; `src/components/workspace/live/coach-integrations.tsx` | Connection states are receipt-backed and say who owns the next action. Local rows export. | When the CAPI flag is on, each direct Meta channel needs “Conversion tracking: connected / not set up” from a persisted dataset receipt, never inferred from channel readiness. |
| Agent UI | `/coach/agent`; `src/components/workspace/live/coach-offer.tsx` | Phase 12 has already replaced the former six-tab layout with four large open configuration cards and demoted program/assets into a disclosure. | Final Keyword goals placement is unresolved. A standalone section can be built and tested, but mounting it relative to those cards is a product ruling, not a code inference. |
| Audit | `audit_actions`, `app.write_audit_row(...)`, `src/lib/audit/actions.ts`, `LoggedButton` | Human and system privileged writes use registered keys; human controls show registry-backed Logged microcopy. | Dataset provisioning and successful provider event sends need new registered actions. A human-triggered dataset setup control must use the new typed key and return audit read-back. |
| App Review package | `docs/META-APP-REVIEW-PACKAGE.md` | Twelve permission rows have evidence and screencast columns, including `page_events`, `instagram_manage_events` and `whatsapp_business_manage_events`. | The three events permissions must file in the same submission as their messaging permissions; the package says so and nothing may record an expected auto-approval as an approval. |

## Proposed end-to-end flow

1. A signed Meta webhook is normalized. Missing referral data is valid and does not fail ingest.
   Present referral data is reduced to the allowlisted fields only; the raw webhook body never moves
   into a conversation column.
2. The inbound persistence RPC creates or finds the conversation and writes attribution only while
   its first-touch fields are empty. A replay or later message cannot replace the original ad,
   `ctwa_clid`, keyword, or keyword-goal binding.
3. A keyword resolver performs an exact normalized match against active tenant keywords. Substring
   matching is unsafe (`fund` must not trigger inside `refund`), and collisions after normalization
   are refused by a unique index.
4. Resource mode prefixes the first qualification turn with the configured resource copy/link;
   book mode enters the existing qualification flow without that prefix. This needs a product
   ruling on whether resource delivery and the first question share one outbound message.
5. The durable qualification receipt enqueues one `QualifiedLead` row when the exact outcome first
   becomes `BOOK`. The unique `(conversation_id, event_name)` boundary makes provider replay and
   worker retry safe.
6. The durable booking-confirmation transition enqueues one `Purchase` row after the confirmation
   message is stored and the conversation closes as booked. Provider appointment creation alone is
   deliberately insufficient.
7. The cron worker claims due rows, rejects test/demo rows before selecting a driver, resolves the
   stored dataset and channel identity, and sends through mock or real CAPI. Retryable failures get
   bounded exponential retry; an invalid contract, missing required identity, or max-attempt
   exhaustion becomes terminal with a stable error code.
8. Dataset setup resolves the connected asset, calls get-or-create, stores the provider receipt and
   audit row, then the Connections page reads that stored result. A connected messaging channel
   without a stored dataset remains “not set up.”

## Additive schema contract

Use one new migration after the current highest applied filename:
`supabase/migrations/20261007000001_keyword_goals_capi.sql`. No earlier migration is edited.

### New enum

`public.keyword_goal_mode`: `resource | book`.

Event names remain a checked text column rather than a PostgreSQL enum so the provider's fixed list
is explicit at the table boundary without implying SetterFi owns the provider vocabulary.

### New table: `public.keyword_goals`

| Column | Contract |
|---|---|
| `id uuid primary key` | Stable binding for conversations and UI rows. |
| `tenant_id uuid not null` | Tenant FK with cascade; part of every lookup and uniqueness boundary. |
| `keyword text not null` | Coach-entered trigger as displayed. |
| `normalized_keyword text not null` | Server/SQL normalized exact-match key; unique per tenant. |
| `goal public.keyword_goal_mode not null` | Resource first or direct to booking qualification. |
| `resource_url text` | Required only for `resource`; HTTPS only. |
| `resource_message text` | Optional coach text for the resource step, with a bounded length. |
| `post_booking_url text` | Optional until Alec confirms whether every keyword must have one; HTTPS when present. |
| `post_booking_message text` | Optional coach text paired with the post-booking link. |
| `active boolean not null default true` | Deactivation preserves historical attribution. |
| `created_by`, `updated_by uuid` | Human provenance. |
| `created_at`, `updated_at timestamptz` | Stable export and audit ordering. |

Checks enforce goal/link shape, HTTPS, nonblank normalized keys, and bounded text. Enable and force
RLS. Coach/coach-member reads stay tenant-scoped; writes go through an audited RPC that refuses
impersonation. The table gets a server export resource if it is mounted as a table or row list.

### Extended table: `public.conversations`

Add only these columns:

| Column | Contract |
|---|---|
| `keyword_goal_id uuid null` | FK to `keyword_goals`, `on delete set null`; pins the matched config without erasing `first_touch_keyword`. |
| `ad_id text null` | First ad ID from Messenger/Instagram referral. |
| `ad_source text null` | Currently only `ADS`; null when no referral exists. |
| `ad_ref text null` | Optional ad `ref` value, stored independently from keyword until the required/optional ruling. |
| `ctwa_clid text null` | WhatsApp click-to-ad identifier; immutable after first capture. |
| `ads_context_data jsonb not null default '{}'` | Allowlisted snapshot of `ad_title` and `post_id`; object-only and size bounded. |
| `ad_attribution_captured_at timestamptz null` | Timestamp only when at least one attribution field was accepted. |

Keep `first_touch_keyword` as the reporting label. Do not overload it with `ref` until Alec rules on
the contract. An attribution guard prevents tenant changes, post-capture replacement, a non-ADS
source, cross-channel `ctwa_clid`, and a `keyword_goal_id` owned by another tenant.

### New table: `public.capi_datasets`

| Column | Contract |
|---|---|
| `id uuid primary key`, `tenant_id uuid`, `channel messaging_channel` | Unique tenant/channel dataset state. Only direct Meta channels are accepted. |
| `channel_connection_id uuid` | Exact credential/asset relationship used for provisioning. |
| `source_asset_id text` | Page ID, Instagram user ID, or WABA ID used in the provider call. |
| `dataset_id text` | Present only after a provider or mock receipt validates. |
| `status text` | `not_set_up | provisioning | connected | failed`; UI renders this, not an inference. |
| `provider_receipt jsonb` | Allowlisted provider response metadata; never token material. |
| `is_mock boolean` | Prevents a mock receipt from being presented as a real connection. |
| `last_error text`, `provisioned_at`, `created_at`, `updated_at` | Honest failure/read-back state. |

Enable and force RLS. Tenant actors may read their row; only the audited provisioning RPC and
service role may write it.

### New table: `public.capi_events`

| Column | Contract |
|---|---|
| `id uuid primary key`, `tenant_id uuid`, `conversation_id uuid` | Tenant-bound outbox identity. |
| `dataset_id uuid null`, `channel messaging_channel` | Dataset binding and messaging channel. Dataset may be unresolved at enqueue but must exist before real send. |
| `appointment_id uuid null` | Required for `Purchase`, forbidden for `QualifiedLead`. |
| `event_name text` | Check limited to `QualifiedLead | Purchase`. |
| `dedup_key text` | Canonical `conversation_id:event_name`; unique and immutable. |
| `event_time timestamptz` | Qualification receipt time or booking confirmation time. |
| `currency text null`, `value numeric null` | Both present or both absent; real `Purchase` behavior awaits Alec's value ruling. |
| `status text` | `pending | processing | retry | sent | terminal_failed | excluded_test | mock_sent`. |
| `attempts int`, `max_attempts int default 8`, `next_attempt_at timestamptz` | Bounded retry state. |
| `claim_token uuid`, `claimed_until timestamptz` | Lease shape used by existing outboxes. |
| `provider_receipt jsonb`, `last_error text`, `sent_at`, `created_at`, `updated_at` | Receipt and stable failure evidence. |
| `is_test boolean`, `is_demo boolean` | Inherited at enqueue. Either true forces `excluded_test` before any real-driver selection. |

Enable and force RLS and revoke direct writes from all roles, including service role; only narrowly
granted security-definer enqueue/claim/finish functions may mutate rows. Enqueue from the existing
qualification receipt and booking confirmation seams, not from an asynchronous observer that can
lose the originating transaction.

## Driver and worker contract

Add a CAPI-specific provider interface rather than expanding the messaging driver:

- `getOrCreateDataset({ channel, sourceAssetId, accessToken })` returns `datasetId` plus a safe
  receipt.
- `sendEvent({ datasetId, eventName, eventTime, channel, userData, customData })` returns a safe
  provider receipt.
- The real implementation posts only to the locked endpoint and accepts only the two fixed event
  names. The mock implementation returns deterministic IDs and records `isMock = true`.
- `SETTERFI_CAPI_LIVE` is consulted explicitly before the real driver is constructed. Test/demo
  exclusion happens first. Missing dataset, credential, channel identity, `ctwa_clid`, or approved
  Purchase value fails closed with a stable code and no network call.
- Retry classification is local: network/5xx/429 are retryable; malformed success, unsupported
  channel/event, missing required identity, and provider 4xx other than 429 are terminal. The
  supplied provider facts are silent on provider-specific error subcodes, so none are invented.
- Provider receipts store request/event IDs and response shape only. They never store access
  tokens or full user identifiers.

The worker should live at `/api/jobs/capi-events`, authenticate with the existing `CRON_SECRET`
pattern, and run on a short Vercel cron only after the route tests and topology inventory are
updated. With no credentials, the mock driver and injected fetch tests prove payload shape,
deduplication, retry, terminal failure, and exclusion; they do not prove provider acceptance.

## UI and copy guardrails

The product needs the fixed-event correction and Instagram caveat everywhere a coach can infer
what SetterFi or Meta will do:

1. **Keyword goals section:** helper copy must say SetterFi sends Meta's `QualifiedLead` when the
   lead qualifies and `Purchase` when the calendar booking is confirmed. It must say custom labels
   such as “SF Qualified DM” are configured by the owner in Ads Manager, not created in SetterFi.
2. **Keyword KPI area:** the count/percent control describes measured opt-ins, qualified leads, and
   confirmed bookings. It cannot label the figures “optimized,” “optimization,” or imply that a
   displayed percentage caused delivery changes.
3. **Connections conversion row:** connected means a stored get-or-create dataset receipt exists.
   Its supporting sentence must say Messenger and WhatsApp click-to-message ads can use the events
   for optimization, while Instagram is measurement only.
4. **Dataset setup confirmation/error:** the human action creates or finds a dataset owned by the
   coach's connected business asset. Success copy names “Conversion tracking connected,” never
   “Ads optimized.” Failure remains “not set up.”
5. **App Review package:** use the fixed `QualifiedLead` and `Purchase` names in call evidence, add
   the three events permissions, and state that Ads Manager owns any custom-conversion labels.
6. **Operator/help copy added for this feature:** troubleshooting may describe event delivery and
   receipts, but it must repeat that Instagram is measurement-only. There is no current CAPI help
   copy elsewhere in source, so existing pages need no correction beyond the new surfaces above.

The control direction follows the current coach simplification work: 16px body copy, a 44px target
floor, plain labels, existing `Input`, `Switch`/segmented controls, `Field`, `Surface`,
`DataState`, `ExportMenu`, and `LoggedButton`. No provider jargon appears in the primary form.

## KPI definition requiring one careful extension

The existing keyword query is a useful base but cannot be relabeled blindly:

- “Opt-ins” should count first eligible conversations attributed to the keyword, not inbound
  messages, or a lead who sends three messages becomes three opt-ins.
- “Qualified” should count the exact first `BOOK` qualification outcome tied to that conversation,
  rather than the current broader pipeline-stage fallback.
- “Booked” should count a confirmed booking tied to the same conversation, not any appointment for
  the contact across another conversation.
- Count mode shows the three numerators. Recommended percent mode shows qualified/opt-ins and
  booked/opt-ins; the opt-in percentage itself needs Alec to choose between share of all keyword
  opt-ins and a fixed 100% cohort baseline.
- Empty denominators render “not yet,” never `0%`, because no cohort was observed.

The export must carry both raw counts and the denominator so exported percentages can be
reproduced. Test and demo exclusion remains in the security-invoker analytics views.

## Audit contract

Add registry rows in the migration and the typed UI key where needed:

- `capi.dataset.provisioned` — human, tenant, coach-visible; returned by the provisioning RPC and
  rendered by `LoggedButton` on the setup action.
- `capi.event.sent` — system, tenant, not coach-visible; written when a real provider receipt is
  committed with the successful outbox transition.

Mock sends use `mock_sent` and do not write `capi.event.sent`, because an audit sentence saying an
event was sent would be false. Retry and terminal state remain durable in the outbox; they do not
need a new audit row unless a human later receives a retry control.

## Tests required before the feature is called code-complete

- Meta normalization fixtures for Messenger, Instagram, and WhatsApp referral capture, plus absent
  referral and malformed optional-field cases that still ingest the message.
- Inbound persistence replay tests proving first-touch immutability, tenant binding, exact keyword
  resolution, and `ctwa_clid` preservation.
- RLS isolation and FORCE RLS assertions for `keyword_goals`, `capi_datasets`, and `capi_events`,
  including cross-tenant FK/guard attempts.
- Enqueue tests for one `QualifiedLead` per conversation and one `Purchase` per confirmed booking,
  with replay deduplication.
- Worker tests for success receipt, retry, max-attempt terminal failure, malformed provider success,
  missing identity, and test/demo exclusion before driver construction.
- Dataset get-or-create tests for all three asset types, idempotent stored read-back, mock receipt
  honesty, and audited human provisioning.
- Keyword UI tests for resource/book mode, conditional resource fields, optional step copy,
  validation, large targets, keyboard use, empty/error/saved states, and export.
- KPI UI tests for count/percent mode and “not yet” on a zero denominator.
- Connections UI tests for flag off, no dataset, mock dataset, real receipt, and Instagram
  measurement-only copy.
- App Review package assertions preventing the events permissions or same-filing warning from
  disappearing.
- Existing `typecheck`, lint, unit, UI, RLS, production build, job-topology, and export route gates.

## Open product questions — do not guess in the real arm

### Q1. What value does `Purchase` represent for a booked call?

**Recommended default:** use an explicitly configured booked-call/session value and ISO currency;
if none is configured, keep the real `Purchase` row terminally blocked as
`CAPI_PURCHASE_VALUE_UNCONFIGURED` rather than infer from a price label. The current `offer_prices`
table has no semantic marker that identifies a “session price,” so selecting a row by name or array
position would silently send the wrong value. If Alec confirms that Meta accepts and he wants a
value-less Purchase, permit both fields to remain null as an explicit product rule.

**Safe work before the ruling:** schema, nullable event fields, mock payloads, qualification sends,
booking enqueue/dedup, and a real-driver refusal for unconfigured Purchase.

### Q2. Are ad `ref` tags required, optional, or merely stored?

**Recommended default:** make `ref` optional. Resolve a keyword from an exact inbound message first;
when a nonblank `ref` is present, store it and allow an exact secondary match only after Alec
confirms the ad-tag convention. Never reject an otherwise valid inbound message because referral or
`ref` is absent.

**Safe work before the ruling:** capture `ref` immutably, expose it in service-only diagnostics, and
leave it out of keyword selection.

### Q3. Where does Keyword goals sit in the current Agent information architecture?

The voice note permits “its own section within the agent,” while current source has already removed
the old six-tab Agent UI in favor of four open cards plus a demoted Program/Assets disclosure.

**Recommended default:** a full-width “Keyword goals” section after the four coach-owned cards and
before “What SetterFi handles for you.” It is a recurring coach-owned workflow, so hiding it in the
one-time Program/Assets disclosure would make the primary ad setup hard to find.

**Safe work before the ruling:** build the isolated component, API contract, states, tests, and
export. Do not mount it into `/coach/agent` until Alec or Ayman chooses its position.

## Additional rulings worth confirming

- **Resource turn shape:** recommended default is one outbound response containing optional intro,
  resource URL, and the first qualification question. A resource-only turn has no reliable next
  inbound trigger and can strand the flow.
- **Post-booking link requirement:** recommended default is optional per keyword; when present it is
  appended to the already-durable booking confirmation rather than sent as a second message that
  could fail independently.
- **Opt-in percent denominator:** recommended default is each keyword's share of all attributed
  keyword opt-ins for the selected window; qualified and booked percentages remain conversions from
  that keyword's opt-ins.
- **Keyword matching:** recommended default is Unicode-normalized, trimmed, case-insensitive exact
  full-message matching with no substring behavior.
- **New-follower outreach:** the voice note mentions it as another possible source, but the supplied
  Phase 13 scope and flowchart are keyword/DM-ad specific. It remains a future source type and is not
  silently added to this build.

## Credential-free completion boundary

Without live Meta credentials this phase can deliver additive schema, forced RLS, referral capture,
first-touch attribution, keyword-goal CRUD contracts, fixed-event outbox creation, mock and injected
real drivers, dataset provisioning contracts, honest UI states, exports, App Review documentation,
and automated gates. It cannot prove dataset ownership, provider permission approval, provider
event acceptance, Ads Manager custom-conversion setup, Messenger/WhatsApp optimization behavior, or
signed-in visual approval. Those remain separate live-provider and human evidence.

## Provenance: provider facts verified for the client request (2026-09-01)

The feature request arrived from the client owner on 2026-09-01 as a voice note and a flowchart.
Every provider claim below was verified that day against Meta's live documentation (page last
updated by Meta 2026-05-05):
https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging

1. The mechanism is Meta's Conversions API for Business Messaging: a server-side POST to
   `graph.facebook.com/{DATASET_ID}/events` with `action_source` `business_messaging` and
   `messaging_channel` one of `messenger`, `instagram`, `whatsapp`. No browser pixel is involved.
2. Event names are a fixed list of fourteen: Purchase, LeadSubmitted, InitiateCheckout, AddToCart,
   ViewContent, OrderCreated, OrderShipped, OrderDelivered, OrderCanceled, OrderReturned,
   CartAbandoned, QualifiedLead, RatingProvided, ReviewProvided. The client's "SF Qualified DM"
   maps to `QualifiedLead`. There is no Schedule event for messaging, so a booking is sent as
   `Purchase` (with currency and value) and the client names custom conversions on top of it in
   Ads Manager. The client's labels are never sent as `event_name`.
3. Identification per channel: Messenger uses page id plus PSID; Instagram uses the IG business
   account id plus IGSID; WhatsApp uses the WABA id plus `ctwa_clid`. The `ctwa_clid` arrives only
   in the inbound message webhook's referral object and must be stored on the conversation at
   ingest, or the event can never be sent later.
4. Ad attribution in webhooks (Messenger reference, verified 2026-09-01): the referral object
   carries `ad_id`, `source` `ADS`, `ads_context_data` (`ad_title`, `post_id`) and an optional
   `ref` string, which is how a keyword can ride along from the ad.
5. Datasets are one per Page (Instagram: per IG user; WhatsApp: per WABA), created idempotently via
   `POST {asset_id}/dataset`, owned by the coach's business. The token comes from the login flow
   already built (Facebook Login for Business / Embedded Signup).
6. Permissions (app level, advanced access): `page_events`, `instagram_manage_events`,
   `whatsapp_business_manage_events`. Each is expected to auto-approve once the matching messaging
   permission has advanced access, and they must go into the same App Review filing as the
   messaging permissions to avoid a second review cycle (`docs/META-APP-REVIEW-PACKAGE.md`). The
   Marketing API Access Tier feature (renamed from "Ads Management Standard Access"; tiers are now
   Limited and Full) grants Full Access after 500 successful Marketing API calls at under 10% error
   over 15 days.
7. Meta does not deduplicate business-messaging events. Deduplication is ours: one event per
   conversation per `event_name`.

**Two limitations, told to the client on 2026-09-01.** First, there is no Schedule event; the
Purchase-plus-custom-conversion naming above covers it. Second, Meta's FAQ states that purchase
optimization works for click-to-Messenger and click-to-WhatsApp ads only and is "not available for
Instagram ad optimization at this time"; click-to-Instagram campaigns can only optimize for more
conversations. Instagram therefore gets full measurement (which ads produced qualified and booked
leads) but no automatic budget shifting, which matters because the client is Instagram-heavy.

**Workarounds for the Instagram optimization gap, discussed 2026-09-01.** (1) Lookalike audiences
from our own data: a nightly sync of qualified and booked leads into a customer-list custom
audience on the coach's ad account, from which Meta builds lookalikes; standard and automatable.
(2) A post-booking thank-you page carrying the coach's pixel, firing a web Schedule event with
hashed email and phone; this buys per-ad conversion reporting and retargeting audiences on
Instagram but not delivery optimization, because a click-to-message campaign cannot select a web
event as its optimization goal. (3) SetterFi as the optimizer, auto-pausing or scaling ads from
its own booked-call counts per `ad_id`; real scope and real blast radius on client ad budgets, so
a later-version candidate rather than launch scope. Recommended: ship the events plus (1) and (2);
park (3).

**Rejected.** "New follower, reach out" (an automated first-touch DM to new followers) has no
official Meta API path. Keyword replies, story replies, comments and ad-initiated threads are the
supported triggers. Do not promise it.
