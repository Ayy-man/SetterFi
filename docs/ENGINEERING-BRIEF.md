# SetterFi: Engineering Brief

This is the operating brief for working on SetterFi. Read this first, then the docs in `/docs`
as needed. Keep this file lean; deep detail lives in the docs.

## What SetterFi is

SetterFi is a white-label, multi-tenant AI appointment-setter SaaS for the credit and
business-funding coaching industry. A coach signs up, and within minutes deploys an AI agent
that answers their inbound Instagram / Facebook DMs and SMS, qualifies leads against a shared
industry brain, handles objections, and books qualified leads into a calendar. The platform owner
(the client) edits one central brain; every coach's agent inherits it instantly. Coaches only
configure a thin "offer layer" on top (their pricing, products, disqualifiers, brand voice).

This repository is **SetterFi only** (the appointment setter). A separate business-funding
platform is a distinct project and is out of scope here.

## Who it serves (three roles + the lead)

- **Admin**: the client's team. Edits the central brain, manages coaches and integrations,
  sets tier pricing, watches platform health. Has a support-team sub-structure: each success
  person owns an assigned book of coaches (round-robin, reassignable), with "my clients" vs
  "all clients" views.
- **Coach (client)**: a credit/funding coach who subscribes. Restricted portal: analytics,
  contacts, conversations, pipelines, and their own agent settings. Never sees platform
  configuration or cost economics.
- **Affiliate**: refers new coaches, earns commission. Sees only referred-coach name, status,
  and commission earned, never their performance data.
- **The lead (end consumer)**: the coach's inbound prospect seeking funding. This is who the AI
  actually talks to. The AI never talks to the coach; it talks to the coach's leads.

Seven role values (`owner`, `admin`, `success`, `build`, `coach`, `coach_member`, `affiliate`)
map onto those three workspaces; the mapping lives in `src/lib/auth/claims.ts`.

## Tech stack

- **Next.js (App Router)** on Vercel. Animated/interactive surfaces are client components.
- **shadcn/ui + shadcnblocks (premium)** for the dashboard/table/form/billing surfaces, themed to
  SetterFi tokens (`src/app/tokens.css`). Never ship stock shadcn styling.
- **Motion (formerly Framer Motion)** for all transitions and the signature animations.
- **React Flow (`@xyflow/react`)** for the live agent flow-trace canvas (onboarding + Meet Your
  Agent + eval playground).
- **Supabase** (Postgres + pgvector): the brain/knowledge store and app data. Seeded from the
  client's Notion knowledge base.
- **OpenRouter**: LLM access, model-configurable (so models can be swapped and A/B-evaluated).
  **OpenAI** for embeddings only.
- **Stripe**: subscription billing and affiliate commission calculation.
- **GoHighLevel**: the CRM, sub-account, phone number and SMS backbone. Invisible to coaches and
  leads.
- Agent replies stream token-by-token via route handlers. Respect `prefers-reduced-motion`.

## The design language

The bundled HTML export (the "Claude Design file") was ported into the Next.js app and remains the
source of truth for IA, content, data shape, and flows, never for visual execution.

The redesign pass, live as of 2026-08-30, replaced the visual language rather than polishing it.
The reference is the Vapi assistant console: a three-pane shell, nav grouped under tiny caps
labels with an icon and a count on every item, sections as tabs and collapsed accordion rows
instead of a stack of equal-weight blocks, an explanation on every row, and the accent spent no
more than twice per screen. Adapted for done-for-you: most rows state the value SetterFi already
chose rather than offering a control, so the few things a coach actually owns are the only
interactive things on the page.

`docs/DESIGN.md` describes the tokens that exist in `src/app/tokens.css`; where an earlier
paragraph in that file has been overtaken, its Corrections section is the authority.
`docs/REDESIGN-CANVAS.md` is the visual authority on layout and anatomy, and
`docs/SIMPLIFICATION-SPEC.md` governs the coach surface. Several tests read those documents and
pin the code to them; read the test before changing the rule.

## Hard rules (do not drift)

- **One knowledge system, one name.** It's called "The Brain." No competing "Knowledge" vs
  "Self-Learning" split.
- **No GoHighLevel branding anywhere client-visible.** GHL is backend plumbing only.
- **No client-visible margin/cost economics.** Cost-vs-revenue is admin-only.
- **Honest states.** Nothing reads "done" or 100% while anything is still provisioning (amber).
  SMS is genuinely registering for two to three weeks per coach (carrier A2P vetting alone). Say
  so with a real day counter, never a percentage, never a predicted date, and never a fake
  "all set."
- **Test data is segregated** from real analytics, and labeled as such on-screen. The columns are
  `is_test` on tenant-scoped rows and `is_demo` on tenants; both are what the migrations define
  (`supabase/migrations/20260813000001_init.sql`, `20260817000001_phase1_demo_path.sql`), and the
  analytics projections exclude them.
- **Grounded, not hallucinated.** Agent answers are retrieval-grounded against the brain. Pricing,
  guarantees, and outcomes are checked by the reply pipeline and held when they fail the check;
  the agent cannot invent numbers.
- **Every table exports CSV/JSON.**
- **Privileged actions are audit-logged** with visible "Logged" microcopy.
- **Verify every provider claim against the provider's current documentation, with a URL and the
  date it was read.** Model recall is not a source for a provider fact. A claim about Meta, GHL,
  Stripe, Google, Twilio or the carriers that carries no URL and date is a guess and is written as
  one.

## One environment

There is one deployed environment: work ships to `main` and deploys to the single `setter-fi`
Vercel project, backed by one Supabase project. Safety comes from discipline rather than a staging
split:

- New backend behaviour lands behind env flags, so nothing changes for the client until a flag is
  switched on. Flag names and the driver selector convention are in `docs/SETUP.md`.
- Demos run on a seeded test tenant whose rows are excluded from analytics.
- Every migration is a production migration. Never edit a migration that has been applied; add a
  new one that makes the corrective change.
- Secrets live in Vercel and Supabase configuration only. Never in the repo, never in chat, never
  in a commit message. If you find one where it should not be, say so immediately; the rotation
  procedure is in `docs/operations/failure-procedures.md`.

## Ground rules for anyone working in this repo

1. **Least privilege.** Take only the access a task needs: this repo, the Supabase project, a
   sandbox or test GHL agency, and the env var names a task reads. Test against seeded data, not
   the client's live Notion playbook, live Meta tokens, or Stripe live keys, unless the task is
   explicitly a live-arm proof.
2. **Nothing hits production unreviewed.** Every change: branch, pull request, CI green (typecheck,
   lint, tests including the cross-tenant suite), review, merge. A technical reviewer may audit any
   change after the fact; code accordingly.
3. **Client-safe writing.** Commit messages, PR text, code comments, and docs may be read by the
   client and their reviewers. No internal economics, no shorthand about people, professional
   tone.
4. **Test data discipline.** Anything created for testing carries `is_test = true` end to end (and
   demo tenants carry `is_demo = true`). Analytics must provably exclude it; there are tests for
   this, keep them green.
5. **Honest completion.** A provider action is complete when the provider's receipt or an
   authoritative read-back says so, never on an HTTP 200 alone. A skipped step is reported as
   skipped.

## Conventions

- TypeScript strict. Narrow every boundary payload (webhook bodies, API bodies, offer-layer writes)
  from `unknown` before use.
- One integration client per provider under `src/lib/integrations/`; no raw fetch to providers
  scattered through routes.
- Webhooks: verify signature, acknowledge in under a second, process in `waitUntil`. Idempotency
  keys everywhere.
- Every privileged mutation writes `audit_log`. If the UI shows "Logged", the backend logged it.
- UI conventions: amber is the only persistent status colour; honest states, nothing says done
  while anything is pending; every table exports; sentence case.
- Tests are Vitest (`npm test`, plus `npm run test:ui` for the browser project and
  `npm run test:rls:clean` for the database contract suite on a reset database). The API tests
  that exist are adversarial on purpose; match that bar.
- Migrations are Supabase CLI SQL files under `supabase/migrations/`, reproducible from a clean
  database.

## Who's who

- **Alec Delpuech**, owner of Live Legacy Strong, the client. Product and technical point of
  contact. The client is also their own first coach ("client number one").
- **The client's technical reviewers**: anyone the client asks to audit the codebase. Build as if
  a skeptical senior engineer reads every change.
- **Coaches, affiliates and leads**: the users. See "Who it serves".

## External clocks nobody controls

Two processes extend only the work they block, day for day, never the whole plan: **Meta app
review** (and the Business Verification and Access Verification steps that precede it) and
**per-coach A2P 10DLC registration** (two to three weeks of carrier vetting per coach). A third,
**Google OAuth app verification**, gates real-coach Google Calendar connections. All three are
described in `docs/CONTEXT.md` and set up in `docs/SETUP.md`.

## Docs

Reading order for a contractor: `README.md`, this brief, `docs/PRODUCT.md`,
`docs/ARCHITECTURE.md`, `docs/BACKEND-SPEC.md` (with `docs/BRAIN-COMPILER.md`), `docs/SETUP.md`,
then `docs/LAUNCH-CHECKLIST.md` and `docs/operations/README.md`.

Reading order for the owner: `docs/RETRIEVAL-EXPLAINER.md`, `docs/LAUNCH-CHECKLIST.md` sections A
and E, `docs/operations/operator-guide.md`.

- `docs/PRODUCT.md`: every surface, its data, and its actions (admin, coach, affiliate, consumer,
  onboarding, Meet Your Agent, evals).
- `docs/ARCHITECTURE.md`: the brain, the channels (Meta/GHL/SMS/A2P/calendar), self-serve
  onboarding, billing, security model.
- `docs/BACKEND-SPEC.md` and `docs/BRAIN-COMPILER.md`: implementation-grade backend and Brain
  contracts.
- `docs/SETUP.md`: environment (the single source for env var names), GoHighLevel, Meta, A2P,
  Stripe and Google Calendar.
- `docs/META-APP-REVIEW-PACKAGE.md`: the Meta App Review filing package.
- `docs/LAUNCH-CHECKLIST.md`: what to switch off, what is unbuilt, what to fix, and what the
  client still owes before real coaches arrive.
- `docs/platform-diagram/`: the platform diagram and its evidence ledger.
- `docs/operations/`: the generated operator package, indexed by its README.
- `docs/CONTEXT.md`: the competitor bar, where the brain's knowledge lives, the account/access
  model, the external clocks, and open vs fixed decisions.
- `docs/INTAKE.md`: the client's onboarding intake reproduced verbatim. Ground truth for client
  intent.
- `docs/DESIGN.md`, `docs/REDESIGN-CANVAS.md`, `docs/SIMPLIFICATION-SPEC.md`: the design
  authorities.
- `docs/RETRIEVAL-EXPLAINER.md`, `docs/BRAIN-CONTENT-ASK.md`, `docs/CLIENT-QUESTIONS-R2.md`,
  `docs/KEYWORD-GOALS-CAPI-ANALYSIS.md`, `docs/NOTION-MAP.md`: written for or with the client.
- `scripts/phase1-demo-runbook.md` through `scripts/phase6-demo-runbook.md`: the seeded demo
  walkthroughs.
