# Meta App Review and verification package

**Package status:** `not_filed`
**Filing actors:** Ayman and Alec
**Graph version implemented:** `v25.0`
**Prepared:** 2026-08-17

This package prepares the evidence for Meta Business Verification, Access Verification, and App
Review. It does not claim that any process was filed, reviewed, or approved. Ayman or Alec may
advance the ledger only after recording a Meta reference and the date Meta supplied it.

## Filing gate

The filing remains an external action owned by Ayman and Alec. Before filing, all of these must be
present:

- Business Verification is confirmed in the correct Business Portfolio's Security Center.
- Access Verification is submitted for the Tech Provider business and its Meta reference is saved.
- The deployment has the named configuration inputs in deployment custody; no value belongs in
  this package, a recording, an audit payload, or source control.
- A designated app-role test user can grant the requested permissions against designated test
  assets owned or managed for review.
- Every permission below has at least one successful live call and its own screencast segment.
- The webhook callback passes GET verification and a POST is accepted only with a valid
  `X-Hub-Signature-256` over the raw request bytes.
- The privacy-policy URL, data-deletion URL or instructions, terms/consent owner, and reviewer login
  instructions have been supplied by Alec. Placeholders are not filing-ready inputs.

Missing evidence keeps the package at `not_filed`. An HTTP 2xx alone is not round-trip evidence;
messaging completion requires a provider response ID, a signed provider receipt, and persisted
tenant-scoped readback.

## Requested permission inventory

Only permissions requested by the implemented flows are listed. `HUMAN_AGENT` is intentionally
absent because SetterFi does not implement that reviewed feature.

**SAME FILING REQUIRED:** `page_events`, `instagram_manage_events`, and
`whatsapp_business_manage_events` must ship in the same App Review filing as their corresponding
messaging permissions. The events permissions are expected to auto-approve after the corresponding
messaging permission has advanced access, but that expectation is not an approval receipt and does
not justify filing them later.

| Permission | Implemented use and exact call | Successful-call evidence to capture | Dedicated screencast segment |
|---|---|---|---|
| `business_management` | Facebook Login for Business configuration used by `POST /api/channels/meta/connect`; the server exchanges the returned code at `GET /v25.0/oauth/access_token` and validates it with `GET /v25.0/debug_token`. It is a dependency for the Page/Instagram asset flow. | Meta response reference or request timestamp plus the allowlisted response field names `access_token`, `data.app_id`, `data.is_valid`, `data.expires_at`, and `data.scopes`; never record a token value. | `01-business-management`: show the app-role user launching Connect, the Meta grant screen, callback success, and the redacted server readback of app ID validity/scopes. |
| `pages_show_list` | Server-side Page discovery through `GET /v25.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,name}` after the callback. | A redacted result containing the designated Page `id` and `name`; omit `access_token`. | `02-pages-show-list`: grant the permission, return to SetterFi, and show the server-discovered designated Page in the asset picker. |
| `pages_read_engagement` | Required dependency on the same server-owned `GET /v25.0/me/accounts` discovery used to prove that the selected Page is available to the authenticated business user. | Successful discovery timestamp and the allowlisted Page `id`/`name` field names only. | `03-pages-read-engagement`: show the permission grant, repeat discovery for the designated Page, and show the eligible Page row without exposing credentials. |
| `pages_manage_metadata` | Subscribe the selected Page through `POST /v25.0/{PAGE_ID}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reactions,messaging_seen,standby`; selection is handled by `POST /api/channels/meta/assets`. | Provider `success=true`, the designated Page ID by reference, the requested subscribed-field names, and persisted `webhook_subscribed_at`. | `04-pages-manage-metadata`: choose the designated Page, submit it, show the subscription success, then show persisted state as `ready`, never `live`. |
| `pages_messaging` | Messenger receive through signed `POST /api/webhooks/meta` events and send through `POST /v25.0/{PAGE_ID}/messages`. | Outbound provider message ID, signed inbound or delivery receipt ID, and persisted message/receipt readback for the designated test recipient. | `05-pages-messaging`: send from the designated test user, show signed inbound persistence and the provider-blind engine result, then show the outbound provider ID and persisted receipt. |
| `instagram_basic` | Discover the Instagram professional account nested under the designated Page through `GET /v25.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,name}`. | The designated Instagram account `id`/`name` and its Page subscription target by reference; omit Page token values. | `06-instagram-basic`: grant access, return to SetterFi, and show the server-discovered Instagram professional account in the asset picker. |
| `instagram_manage_messages` | Instagram receive through signed `POST /api/webhooks/meta` events and send through `POST /v25.0/{INSTAGRAM_ACCOUNT_ID}/messages` using the selected server-held credential. | Outbound provider message ID, signed inbound or delivery receipt ID, and persisted tenant-scoped message/window readback for the designated test identity. | `07-instagram-manage-messages`: send a DM from the designated test identity, show signed receipt persistence, provider-blind engine handling, and the response ID plus persisted readback. |
| `whatsapp_business_management` | Embedded Signup v4 returns the designated WABA/phone IDs; the server validates assets, subscribes the WABA with `POST /v25.0/{WABA_ID}/subscribed_apps`, and reads phone status with `GET /v25.0/{PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,status`. | WABA subscription `success=true`, phone ID match, phone status field names, and persisted subscription/phone-verification timestamps; no number or token value in this package. | `08-whatsapp-business-management`: complete the test Embedded Signup flow, show the designated WABA/phone selection, WABA subscription, and redacted phone-status readback. |
| `whatsapp_business_messaging` | The server rejects a token missing this scope, receives signed WhatsApp events at `POST /api/webhooks/meta`, and sends freeform or registered templates through `POST /v25.0/{PHONE_NUMBER_ID}/messages`. | Provider message ID, signed status receipt, and persisted message/template/window readback for the designated test recipient. Outside-window evidence must use an approved designated test template; it may not use draft client copy. | `09-whatsapp-business-messaging`: show scope inspection, an in-window freeform round trip, then an outside-window approved test-template send with signed status and persisted readback. |
| `page_events` — auto-approve expected | Sends the fixed `QualifiedLead` event when the AI qualification commits and the fixed `Purchase` event when the calendar booking is confirmed for Messenger business messaging. | Successful `/{DATASET_ID}/events` receipt with `action_source=business_messaging`, `messaging_channel=messenger`, the fixed event name, and tenant-scoped outbox readback; never record a token or PSID. | `10-page-events`: show one designated Messenger qualification and booking, the two safe event receipts, and persisted deduped readback. |
| `instagram_manage_events` — auto-approve expected | Sends the same fixed `QualifiedLead` and `Purchase` events for Instagram business messaging measurement. Instagram is measurement only; SetterFi does not claim ad optimization for Instagram. | Successful event receipt with `messaging_channel=instagram`, the fixed event name, and tenant-scoped readback, with the IGSID omitted from the recording. | `11-instagram-manage-events`: show designated Instagram qualification and booking measurement, then state on screen that Instagram is measurement only. |
| `whatsapp_business_manage_events` — auto-approve expected | Sends the fixed `QualifiedLead` and `Purchase` events for WhatsApp business messaging after the inbound referral supplied and SetterFi stored `ctwa_clid`. | Successful event receipt with `messaging_channel=whatsapp`, fixed event name, and tenant-scoped outbox readback; omit the `ctwa_clid`, recipient, and token. | `12-whatsapp-business-manage-events`: show a designated click-to-WhatsApp qualification and booking with safe receipts and deduped readback. |

Each recording is a separate file or separately selectable segment. It must show the app user
granting that permission and the implemented product using it. Recordings show only designated test
assets and redacted identifiers; browser developer tools, request headers, query-string token
values, and deployment configuration values stay out of frame.

SetterFi sends only Meta's fixed `QualifiedLead` and `Purchase` event names. Labels such as
“SF Qualified DM” or “SF Schedule DM” are custom conversions created and owned by the coach or
account owner in Ads Manager; SetterFi never sends those labels as `event_name`. Messenger and
WhatsApp click-to-message ads may use these events for optimization. Instagram receives
measurement only, not ad optimization.

## Reviewer roles and designated assets

Fill these names before recording. Do not replace a placeholder with a credential value.

| Input | Required placeholder |
|---|---|
| Filing Business Portfolio | `<BUSINESS_PORTFOLIO_NAME>` |
| Meta app | `<META_APP_NAME>` |
| Facebook Login for Business configuration | `META_LOGIN_CONFIG_ID` in deployment custody |
| App-role reviewer/test user | `<META_APP_ROLE_TEST_USER_NAME>` |
| Designated Facebook Page | `<META_TEST_PAGE_NAME>` |
| Designated Instagram professional account | `<META_TEST_INSTAGRAM_ACCOUNT_NAME>` |
| Designated WABA | `<META_TEST_WABA_NAME>` |
| Designated WhatsApp phone | `<META_TEST_PHONE_LABEL>` |
| Designated Messenger recipient | `<META_TEST_MESSENGER_RECIPIENT_NAME>` |
| Designated Instagram recipient | `<META_TEST_INSTAGRAM_RECIPIENT_NAME>` |
| Designated WhatsApp recipient | `<META_TEST_WHATSAPP_RECIPIENT_NAME>` |
| Designated approved test template | `<META_TEST_APPROVED_TEMPLATE_NAME>` |
| Reviewer login URL | `<REVIEWER_LOGIN_URL>` |
| Reviewer instructions | `<REVIEWER_INSTRUCTIONS_REFERENCE>` |

The test user must have a role on the app and the required role/task on each designated asset.
Use client-owned or review-owned test assets only; never contact a coach, lead, or unrelated Page.

## Webhook evidence sequence

1. Configure `<HTTPS_WEBHOOK_CALLBACK_URL>` and `META_WEBHOOK_VERIFY_TOKEN` in deployment custody.
2. Record GET verification with `hub.mode=subscribe`; the callback echoes the challenge only when
   the named verify-token input matches.
3. Send one provider-originated event from each designated test asset. Preserve the raw request for
   signature verification inside the server boundary without printing it.
4. Record the `X-Hub-Signature-256` verification verdict, provider event ID, tenant-scoped durable
   receipt ID, and `processed` or explicit `skipped` state.
5. Mutate one byte in a synthetic local copy and show rejection with no receipt, engine invocation,
   or outbound call. This negative case is local evidence, not a provider call.
6. For each messaging permission, record the outbound provider response ID, the signed provider
   receipt, and the persisted readback. Missing any of the three leaves that arm incomplete.

## Legal and reviewer inputs

These are filing blockers owned outside code. The package does not invent their content.

| Input | Owner | Current value |
|---|---|---|
| Privacy policy URL | Alec | `<PRIVACY_POLICY_URL_REQUIRED>` |
| Data deletion URL or instructions | Alec | `<DATA_DELETION_INPUT_REQUIRED>` |
| Terms URL | Alec | `<TERMS_URL_REQUIRED>` |
| Consent-language owner and approved reference | Alec | `<CONSENT_REFERENCE_REQUIRED>` |
| Screencast narrator | Ayman/Alec | `<NARRATOR_NAME_REQUIRED>` |
| Reviewer test-login instructions | Ayman/Alec | `<REVIEWER_INSTRUCTIONS_REQUIRED>` |

## Day-one verification checklist

### Business Verification

- [ ] Ayman/Alec opens Security Center in `<BUSINESS_PORTFOLIO_NAME>` and records the displayed
  status plus a Meta reference/date.
- [ ] The business has no restriction that prevents App Review or Access Verification.
- [ ] The verified legal entity matches the filing Business Portfolio.

### Access Verification

- [ ] Ayman/Alec files Access Verification for the Tech Provider business after Business
  Verification is confirmed.
- [ ] The filing includes the implemented third-party asset use described in this package.
- [ ] The Meta reference/date is entered in the ledger; an app-role test bypass is not evidence
  that Access Verification cleared.

### App Review

- [ ] All twelve permission rows have one successful live call and one dedicated screencast segment.
- [ ] The three events permissions ship in the same filing as their corresponding messaging
  permissions; expected auto-approval is not recorded as an approval before Meta returns a receipt.
- [ ] Every recording uses designated test assets and contains no credential value.
- [ ] Privacy, data deletion, terms, consent ownership, and reviewer instructions are real inputs.
- [ ] Ayman or Alec files the requested permissions together and records Meta's reference/date.

## Token, WABA, and phone-number trap

Do not assume an old token is usable. The real arm requires `SETTERFI_META_DRIVER=real` plus the
named deployment inputs `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`,
`META_SYSTEM_USER_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN`, `META_WHATSAPP_SYSTEM_USER_TOKEN`,
`META_WABA_ID`, `META_WHATSAPP_PHONE_NUMBER_ID`, `SETTERFI_CREDENTIAL_ENCRYPTION_KEY`, and
`APP_BASE_URL` as applicable to the arm.

Before any WhatsApp send, regenerate or confirm the WhatsApp system-user token, inspect it
server-side, and prove that it belongs to `META_APP_ID` and carries
`whatsapp_business_messaging`. Then prove the configured `META_WABA_ID` subscription and the
configured `META_WHATSAPP_PHONE_NUMBER_ID` readback. Explicit Real selection with any unusable
named input must fail closed; missing keys leave the real test visibly SKIPPED.

## Receipt ledger

Only Ayman or Alec changes a state below. `filed`, `under_review`, `approved`, or `rejected`
requires both a provider reference and the provider/status date. Do not paste screenshots,
credentials, request bodies, or token-bearing URLs into this file.

| Process | State | Filing actor | Provider reference | Provider/status date | Notes |
|---|---|---|---|---|---|
| Business Verification | `not_filed` | Ayman/Alec | `<REQUIRED>` | `<REQUIRED>` | Confirm the actual Security Center state before changing this row. |
| Access Verification | `not_filed` | Ayman/Alec | `<REQUIRED>` | `<REQUIRED>` | Independent external gate; an app-role test does not advance it. |
| Meta App Review | `not_filed` | Ayman/Alec | `<REQUIRED>` | `<REQUIRED>` | Package preparation is complete only after the live-call and screencast matrix is filled. |

Allowed state progression is `not_filed` → `filed` → `under_review` → `approved` or `rejected`.
Provider resubmission starts a new ledger row so earlier evidence remains intact.
