# SetterFi — Client Intake (verbatim)

The onboarding intake as the client submitted it, reproduced word-for-word from the intake form
"SetterFi (Live Legacy Strong): AI Setter Onboarding" (round 1). This is the
authoritative record of what the client told us and what they left for the call. Where an answer
here disagrees with a later doc, the later doc wins only if a call/contract superseded it —
otherwise treat this as ground truth for client intent.

Gate at export: not yet submitted · 6 blocking requirements · 2 still outstanding.

## GoHighLevel

GoHighLevel is the backbone for every client's contacts, calendars, pipelines, and phone numbers.

Q: Are SaaS mode and Agency Pro enabled on your GoHighLevel? (yes/no, required)
A: Yes

Q: How do your cash campaigns actually work? Walk us through the mechanics: what you send, who
you send it to, how those people opt in to being texted, what tool you blast from, and rough
volume. (long, required)
A: Discussed on call

## Facebook and Instagram connection

Q: How should your clients connect Facebook and Instagram? (choice, required — options: Through
GoHighLevel / Direct on our platform / Decide on our call)
A: Decide on our call

Q: Can you grant Meta Business Manager admin access and complete Meta business verification?
(yes/no, optional — shown only if the previous answer is "Direct on our platform")
A: (not answered — conditionally hidden)

## Knowledge base access

Q: Where does your industry knowledge and qualification logic live, that the central brain should
be built from? List the sources (Notion pages, docs, recordings, anything). We will walk these on
the call. (long, optional)
A: Supabase synced with Notion

## Who signs up and who the AI talks to

Q: Confirm: your paying clients are credit and funding coaches, the AI talks to their inbound
leads, and you are client number one yourself? (yes/no, required)
A: Yes

Q: Beyond price point, loan types, and disqualifiers, what else should each client be able to set
themselves? (long, optional)
A: (not answered)

## Pricing and billing

Q: Base subscription price per client? (text, required)
A: 297/mo upto 25 calls/m

Q: Outcome tiers: at how many booked calls does the price step up, and to what? (long, required)
A: 597/m upto 75 calls/m
   997 beyond that

Q: Messaging overage policy, if any? (long, optional)
A: ---

## Calendars

Q: Default booking calendar? (choice, required — options: GoHighLevel calendar / A mix)
A: A mix

Q: For clients on Google Calendar, how should they connect it? (choice, optional — options:
Connect Google inside GoHighLevel / Our own Google app / No clients use Google Calendar)
A: (not answered)

## Affiliates

Q: Do you want an affiliate tier on the setter (referral links plus commission tracking)?
(choice, required — options: Yes, include it / No, not needed)
A: Yes, include it

Q: Can one person be both a client and an affiliate? (choice, optional — options: Yes, one
account can do both / No, separate roles / Not sure)
A: Yes, one account can do both

Q: Affiliate signup, open or invite-only? (choice, optional — options: Open signup / Invite or
approval only / Not sure)
A: (not answered)

Q: Commission basis: percentage or flat, recurring or first-payment-only, and does it claw back
if the client cancels? (long, optional)
A: 10% recurring upto a year

Q: What should affiliates see about their referred clients? (choice, optional — options: Name,
status, and commission earned / Full performance data on referred clients / Not sure)
A: Name, status, and commission earned

Q: OK with manual affiliate payouts from the ledger in v1? (yes/no, optional)
A: Yes

## Business identity

Q: Legal entity name (text, required)
A: Legacy Strong LLC (per executed contract and GHL agency record)

Q: Registered business address (text, required)
A: 401 E Las Olas Blvd, Fort Lauderdale, FL (per GHL agency record; contract holds executed
   version)

Q: Platform name (what your clients will see) (text, required)
A: SetterFi

Q: Do you have a domain for the platform? (choice, required — options: Yes / No)
A: Yes

Q: Which domain? We will then ask you to grant our project email access to your domain registrar
so we can connect the platform. (text, optional — shown if "Yes" above)
A: setterfi.com and setterfi.io, registrar GoDaddy, access granted to project email

Q: No domain yet is fine. Note any you are planning here, and let us know once it is registered.
We will build on a placeholder meanwhile. (text, optional — shown if "No" above)
A: (not answered — conditionally hidden)

Q: Brand assets: logo, colors, fonts (file, optional)
A: (not uploaded)

## Project email

Q: Everything we build runs on one project email that you own at handover. How should we set it
up? (choice, required — options: Create a fresh Gmail / Use an address on my domain / Recommend
one for me)
A: Use an address on my domain

Q: What address, and who administers your email so we can set it up day one? (text, optional —
shown if "Use an address on my domain")
A: support@livelegacystrong.com, created and in use for all build accounts

## Access

Q: Who on your team needs admin access? (text, required)
A: alec@livelegacystrong | edder@livelegacystrong.com

## Requirements ledger (readiness gate)

Each row is something the client owes us before or during the build. Status is as of the export
(round 1, July 2026) and the client's wording below is preserved verbatim. **Two rows have since
been superseded by the 2026-07-28 Meta call — marked inline. Never read this ledger as current
status; `docs/LAUNCH-CHECKLIST.md` is the live truth.**

1. GoHighLevel agency admin access granted — client-owned, blocking — VERIFIED.
2. Facebook connection approach decided — client-owned, blocking — ANSWERED. Decided: direct
   OAuth via our own Meta app is primary for FB and IG, GHL-native Meta is the backup. WhatsApp
   stays on GHL's channel per contract §2.8.
   **SUPERSEDED 2026-07-28:** Alec redirected WhatsApp to the direct Tech Provider path on our
   own Meta app; GHL's channel is now the fallback, not the plan. See ARCHITECTURE.md channels.
3. Legal entity name and registered address provided — client-owned, blocking — VERIFIED.
4. Platform name provided — client-owned, blocking — VERIFIED. Now blocks Meta app creation (the
   app is named at creation). Critical path.
5. Notion access granted for knowledge base — client-owned, non-blocking — VERIFIED.
6. Stripe access granted by week 5 — client-owned, non-blocking — UNANSWERED (due week 5).
7. Setter domain registered plus DNS and registrar access — client-owned, blocking — VERIFIED.
   Gates the Meta app submission and Meta's review clock. Urgent.
8. Tier 1 access granted: project email support@livelegacystrong.com, Supabase, Slack,
   OpenRouter — client-owned, non-blocking — VERIFIED.
9. Meta: app created (SetterFi) and connected to Alec's Business Portfolio, Alec and Edder added
   as app Administrators, business verification completed — client-owned, blocking — UNANSWERED.
   State: portfolio person-invite done, developer 2FA on, full-control bump pending with Edder,
   app creation next (messaging use cases FB + IG, no WhatsApp, connect to the Alec Delpuech
   portfolio at creation). Business verification NOT STARTED — it is the unbounded clock and
   blocks app review. Alec starts it in Business Settings → Security Center with EIN docs handy.
   **SUPERSEDED 2026-07-28 — DONE:** both apps created on Alec's Business Portfolio, business verification was **already complete** (Alec runs ads), system user
   `setterfib` minted, WABA "SetterFi support" and number live, WhatsApp use case included after
   all. The feared unbounded clock never materialized. Only App Review / Advanced Access — needed
   for onboarding third-party coaches' own assets, not for the demo — is still unfiled.
