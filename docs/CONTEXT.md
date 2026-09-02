# SetterFi — Full Context (everything not in the other docs)

Background the build needs but that doesn't belong in PRODUCT / ARCHITECTURE / DESIGN: what we're
beating, where the knowledge really lives, the exact account/access model, the external clocks,
and the decisions still open. Read this once so nothing surprises you mid-build.

## What SetterFi is replacing (the competitor bar)

The client currently runs their setter on **AppointWise** and is leaving it. SetterFi has to be
visibly better on the things AppointWise does badly, not just at parity. The teardown that shaped
this product:

- **AppointWise onboarding is a generic wizard** — it asks every SaaS its niche, pricing, and
  scripts from a blank slate. Our wedge: the agent *already* knows the credit/funding industry on
  day one (shared brain pre-installed), so onboarding configures an offer layer, not a brain. The
  word "already" is load-bearing in the onboarding copy.
- **AppointWise shows blank/janky loading and dead-ends.** Our easy win: skeletons on every
  surface, teaching empty states, and a persistent get-started checklist so nothing is a dead-end.
- **AppointWise hides how the agent decides** — it's a black box, which erodes trust and makes
  failures un-debuggable. Our answer: the grounding receipt, the live flow-trace, the seams
  inspector, and the admin conversation-debug trace. The agent's reasoning is inspectable.
- **AppointWise lets the agent freelance on pricing/claims.** Our answer: retrieval-grounded
  generation with hard-gated pricing/guarantees. The agent physically can't invent a number.
- **AppointWise has weak multi-tenant governance** for a platform owner running many coaches. Our
  answer: the whole admin console — one central brain that publishes to all agents, an attention
  queue, per-client channel health, evals as a standing safety gate.

Do not name AppointWise in any client-visible UI. It's the bar we clear, not a label we ship.

## Where the knowledge actually lives (building the Brain)

The client's Notion workspace is **"Legacy Strong"** (`<notion-workspace-id>`,
team plan; teamspaces Clients, Programs, Extras, Legacy Strong). Extracted in full 2026-08-13/14
and mapped in `docs/NOTION-MAP.md` — **verified against the live workspace**, not inferred.

**Retracted:** earlier revisions of this file named the workspace "Appointwise Setup - CCA
Clients" and split it into "A-docs = universal brain / B-docs = per-client offer layers." No
workspace by that name exists, and the strings "A-doc" and "B-doc" appear nowhere in the
workspace or in any call transcript. AppointWise is the competitor SaaS the client is replacing;
"the AppointWise setup that we currently have" (client call, 2026-07-17) meant their
configuration inside that product. Three separate things — AppointWise, the knowledge base, and
Notion — were fused into one proper noun that then propagated through six documents.

What is actually there, for the Brain's purposes:

- **One 46-row database is the whole SetterFi-relevant corpus.** `Prospect FAQ Sheet / FAQs`,
  1,987 words: `Category` (multi_select — General Questions, Credit, Business, Program/Service,
  Application/Booking, Funding Qs) → `Inbound Message` (title) → `Response` (text). Each row is
  a lead message paired with the reply, already carrying offer-layer placeholders
  (`[dream outcome]`, `[niche]`, `[target funding amount]`, `[requirements]`).
- **Roughly 99% of the workspace belongs to the separate funding platform** — Client Portals is
  1.90M words on its own — and is not SetterFi's to sync.

**Corrected 2026-08-31:** the 46-row database is the largest structured piece of the corpus, not the
whole of it. Ten more SetterFi-relevant pages sit under `Team SOPs / Team SOPs [db] / Appointwise
Setup - CCA Clients` in the same 2026-08-14 extraction: six shared industry documents — A1 Personal
Credit Fundamentals, A2 Business Funding Products, A3 Qualification Logic by Credit Range, A4
Objection Responses, A5 Compliance Language, A6 Voice and Tone — plus four per-client templates
carrying `client_business_name` placeholders, B1 Offer Details, B2 Proof and Case Studies, B3 Team
and Calendar, B4 FAQ. Last edited 2026-06-16, client-authored for an AppointWise setup, and
**unconfirmed by Alec** — finding them establishes that they exist, not that they are current or
authoritative, and no value may be seeded from them until he says so (found in the 2026-08-31
re-read of the extraction).

This changes the retrieval shape: structured rows with a category filter, not heading-aware prose
chunking. See `docs/BRAIN-COMPILER.md` for the import pipeline as built.

**Corrected 2026-08-31:** that still holds for the FAQ rows, which are what Phase 2 ingests. The ten
Appointwise pages are prose, so ingesting them would need heading-aware chunking after all — and
whether we ingest them at all is a decision nobody has made.

The intake answer "Supabase synced with Notion" (INTAKE.md:38) is still the only stated client
requirement for a *sync*, and it is a preference whose reason was never captured — whether this
is an ongoing sync or a one-time import with the Brain as authority is open and owned by Alec.
The qualification matrix stays data-driven and admin-editable, never baked
into code; confirm its values with Alec directly, since the workspace does not contain a matrix.

**Corrected 2026-08-31:** it does contain one — Doc A3, Qualification Logic by Credit Range, on the
same axes the qualification-matrix decision asks about, plus a timeline modifier (found
2026-08-31). The confirmation
therefore runs against A3 rather than starting from a blank, which changes the shape of the
conversation with Alec and nothing else. The matrix stays data-driven and admin-editable either way,
A3 and the seeded values have never been compared, and no seeded value becomes client-confirmed by
A3 existing; the matrix-values decision is still open and still his.

## The account and access model (who owns what)

Everything is built on **one project email the client owns at handover:
support@livelegacystrong.com** (on their domain, already created and in use for all build
accounts). Every third-party account we stand up is created under that email so ownership transfers
cleanly at the end. Never tie a build account to a personal address.

Access tiers and sequence:

- **Tier 1 (verified, in hand):** project email, Supabase, Slack, OpenRouter. The SetterFi
  Supabase project lives in the client's own Supabase org, "Legacy Strong HQ", which also hosts the
  separate funding platform's project (active, unrelated to SetterFi). Ownership sits client-side
  from day one.
- **GHL:** agency admin access granted and verified; SaaS mode + Agency Pro confirmed on.
- **Notion:** granted and verified.
- **Domains:** setterfi.com and setterfi.io, registrar GoDaddy, project email has registrar
  access (verified). This gates the Meta app submission and Meta's review clock.
- **Stripe:** live keys still owed; see `docs/LAUNCH-CHECKLIST.md` section E.
- **Meta:** the open critical-path item — see below.

Admin access for the client's team goes to **alec@livelegacystrong** (owner). Alec is the point
of contact for both product and technical questions until the client names another technical
contact; the security bar is the same either way.

## The Meta apps (updated 2026-07-27 — setup executed; gaps found 2026-08-13)

Created live with Alec on the July 27 call, under **Alec's Business Portfolio**, both shared to
the dev side with full app access:

- **SetterFi Connector** — Facebook Login use case (coach OAuth).
- **SetterFi Messaging** — WhatsApp + Instagram + Messenger use cases. This is the channel app.
- System user **setterfib** (admin) with both apps assigned; token generated on SetterFi
  Messaging carrying instagram_manage_messages + pages_messaging + whatsapp_business_management +
  `business_messaging` — **not** `whatsapp_business_messaging`, the scope that authorizes WhatsApp
  send/receive, so the token likely needs regenerating before any real WhatsApp send. The WABA was
  also created *after* the token was minted, and its assignment to `setterfib` is unconfirmed.
- WABA **"SetterFi support"** created (professional services). No real phone number attached yet
  (test number only); a dedicated support number (e.g. OpenPhone) can be added and verified later.
- **Business verification asserted, not verified.** Alec's answer on the call ("Everything should
  be set up. I've been running a lot of money through ads here") covers ad spend, which is not
  Meta Business Verification — and the question bundled 2FA in with it, so neither is confirmed.
  Check Business Settings → Security Center before treating the App Review clock as unblocked.

Still open on Meta: payment-method attachment to the WABA (Alec has a card on file with Meta for
ads; verify it's attached to the WABA before real sends), and the later App Review / Advanced
Access submission for onboarding coaches' own accounts via Embedded Signup (needed ~2–3 weeks
before coach self-serve go-live, not for the build/demo).

WhatsApp direction: **direct via our own app (Tech Provider path)**, decided on the 2026-07-27
call. GHL's WhatsApp channel remains the fallback behind the same adapter.

Because that clock is unbounded, **GHL-native Meta is the interim fallback**: if review runs long, coaches connect FB/IG through GHL and we cut over to our own app when
it clears. Both paths sit behind one channel adapter so the switch is a config change, not a
rewrite. Meta can be live immediately via the fallback; never promise the direct path on a date.

## The A2P / SMS clock

SMS numbers are GHL-provisioned per sub-account and each needs **per-client A2P 10DLC
registration**. The real duration is longer than the "~1–2 weeks" this document has been carrying:
the sequence is brand registration → brand vetting → campaign submission → **carrier vetting, which
alone runs two to three weeks**, so plan on roughly three weeks end to end and flag a stall at ~21
days rather than ~10 (a 10-day alert fires on healthy registrations).

There is **no status API** — GHL exposes A2P registration state nowhere, verified across its entire
published surface. The old detection method written here (attempt a send, catch the not-registered
error) does not work, because **a failed send is not attributable**: GHL returns a bare status word
with no error code, so a not-registered campaign is indistinguishable from a landline, a
disconnected number, or a carrier drop. Readiness is instead probed by sending to **a number we own
and have verified**, which eliminates every other explanation by construction. Surface it as honest
amber — "registering, ~3 weeks, flips on automatically" — and note that some rejections are
**terminal and non-resubmittable**, which needs its own permanently-blocked state rather than a
longer wait.

The **cash-campaign mechanics** (what they send, how leads opt in, volume) were deferred to the
call — we need them verbatim to register the A2P campaign, so chase that answer before the
compliance/SMS build.

## The Meta clocks — there are four processes here, not one

"Meta review" has been treated throughout our docs as a single external clock. It is four distinct
processes with different owners and durations, and one of them appears in no document today:

1. **Business Verification** — the client's action, not ours. Alec asserted it was done; nobody has
   checked Business Settings → Security Center, and his answer described ad spend, which is not the
   same thing. Everything below is blocked on it.
2. **Access Verification** — **missing from every document until now.** Roughly 5 days. It is what
   lifts the 10-onboardings-per-rolling-7-days cap on WhatsApp Embedded Signup, so it gates coach
   self-serve volume rather than the demo. Needs an owner and a submission date.
3. **App Review / Advanced Access** — an **exit gate, not a day-one form**. Each permission
   requested needs at least one successful live API call plus a screen recording demonstrating it,
   which means the integration has to be built and working before we can submit at all. Meta
   publishes "typically less than one week, often 2–3 days" for the review itself.
4. **Tech Provider / Solution Partner onboarding** for the WhatsApp Embedded Signup path.

## A third clock, explicitly *not* on the critical path

GHL caps a **Private** marketplace app at **5 agencies**, and lifting it means a security review
with no published SLA. This constrains the business model rather than the build — SetterFi running
on more than five agencies is a growth question, and it has zero bearing on the 08-19 demo or on
launch. Worth noting: the cap **applies only to apps created on or after 2025-11-18**, so the first
thing to establish is when the SetterFi app was actually created. If it predates that, the cap does
not bind at all.

## A fourth clock: Google OAuth verification

New as of 2026-09-02, and numbered fourth here only because this file counts the GHL agency cap
above; other documents count three clocks because the GHL cap is a business-model constraint
rather than a build one.

SetterFi now has its own Google Cloud project and a coach-facing Google Calendar connect flow,
built behind `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE`. The app's publishing status is **Testing**,
which means two things Google states plainly: only listed test users can complete the consent
screen, and "Authorizations by a test user will expire seven days from the time of consent"
(`https://support.google.com/cloud/answer/15549945`, read 2026-09-02). So a real coach cannot
connect a calendar yet, and the `expired` state is the normal operating condition rather than an
edge case until the app is published.

Leaving Testing is a chain, not a form. Google's Branding page requires home page, privacy policy
and terms links, and says "You will not be able to submit your app for verification if it is missing
these links"; the homepage must be on a verified domain you own, must describe the app's
functionality rather than being only a login page, and must itself link the privacy policy at the
same URL given on the consent screen. Branding must be published before scope verification can be
requested (`https://support.google.com/cloud/answer/10311615`, read 2026-09-02). The privacy policy
is the piece that is not ours to wave through — it needs the public consumer privacy URL that is
already on the pile, on the same domain as the homepage. `docs/LAUNCH-CHECKLIST.md` row E8 carries
the owed input.

## How the external clocks affect the timeline

Neither Meta review nor A2P nor Google verification is in our control, so they extend **only the
work they block, day-for-day**, not the whole schedule. The plan proceeds;
the FB/IG-direct and live-SMS pieces slip if and only if their clock slips, the Google-calendar
piece slips only for real coaches while the flow stays provable on a test user, and the fallback
keeps the product usable meanwhile.

## Remaining external inputs and decisions

- **Facebook/Instagram connection model** — intake says "Decide on our call." Working decision:
  direct OAuth via our own Meta app is primary, GHL-native is backup. Confirm before wiring the
  channel adapter.
- **Google Calendar model** — default booking is "A mix" (GHL calendar + Google). Settled on the
  build side as of 2026-09-02: Google connects through **our own Google app**, via the OAuth flow at
  `/api/calendars/google/*` behind `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE`, and GHL-via-GHL stays
  available for coaches already on a GHL calendar. What is still outside our control is the Google
  verification clock above, which is what decides when a real coach can use it.
- **Affiliate signup** — open signup issues the link immediately; commission starts on the first
  paid invoice and logged revoke deactivates future attribution. Everything else about
  affiliates is settled: one account can be both client and affiliate, 10% recurring up to 12
  months, name/status/commission visibility only, manual payouts from the ledger in v1.
- **Cash-campaign sample messages** — needed verbatim for A2P campaign registration; deferred to
  the call.
- **Extra coach-configurable fields** — "beyond price point, loan types, and disqualifiers, what
  else?" was left blank; the offer layer as specced (pricing, products, disqualifiers, brand
  voice, FAQ, proof) is the working set until the client adds to it.

## Fixed decisions (do not re-open)

- One knowledge system, one name: "The Brain." No Knowledge/Self-Learning split.
- WhatsApp runs **direct on the client's own Meta app** (Tech Provider path), decided with Alec on
  the 2026-07-27 call. GHL's channel stays as the fallback behind the same adapter.
- No GHL branding anywhere a coach or lead can see.
- No client-visible margin/cost economics — admin-only.
- Coach billing tiers: $297 (≤25 booked calls) / $597 (≤75) / $997 (beyond), metered by booked
  calls, admin-editable prices/allowances with per-client overrides.
- Affiliate: 10% recurring up to 12 months, manual payout v1, clawback on cancel.
- One environment: work ships to `main` and deploys to the single `setter-fi` Vercel project. New
  backend behaviour lands behind env flags so nothing changes for the client until it is switched
  on, and demos run on a seeded test tenant whose rows are excluded from analytics.
- Client is Live Legacy Strong (Legacy Strong LLC). Owner Alec Delpuech is the point of contact for
  product and technical questions. The security bar: jailbreak/injection resistance, tenant
  isolation, grounding, honest provisioning states. The client is also their own first coach
  ("client number one").
- Alec's side has a **CRS (credit repair software) dependency**: agreement in review and CRS now
  requires a physical office; Alec is resolving. It gates some backend data integration — build
  around it, don't block on it.

## Repo hygiene note

The client's technical reviewers read this repository. Keep everything here client-safe and
professional: no cost/margin economics, no internal commercial terms, and write your own notes
rather than carrying over any scratch from external design tools.
