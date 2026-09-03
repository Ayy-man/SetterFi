# SetterFi

SetterFi is a multi-tenant AI appointment-setting platform for credit and business-funding
coaches. It provides role-scoped coach, admin, affiliate, onboarding, and consumer experiences,
with Supabase-backed tenancy, workflow state, audit trails, outbound delivery, provider custody,
and operational recovery paths.

## What is in this repository

- Next.js 16 App Router application with React 19, TypeScript, and Tailwind v4, under `src/`.
- Supabase SQL migrations (105 files under `supabase/migrations/`) and database-contract tests
  under `supabase/tests/`.
- Server-enforced authorization, tenant isolation, consent and suppression handling, booking
  workflows, notification preferences, provider integrations, and scheduled job routes.
- Explicit recovery and reconciliation flows for inbound delivery, bookings, outbound sends,
  provider connections, and contact deletion, so an interrupted request can be resumed without
  inventing success.
- Documentation under `docs/`, the generated operator package under `docs/operations/`, and the
  seeded demo runbooks under `scripts/`.

## Run locally

```bash
npm install
cp .env.example .env.local   # names only; fill values from your deployment configuration
npm run dev
```

`docs/SETUP.md` is the single source for every environment variable name and what it gates. Use an
ignored `.env.local` for local credentials. Never commit provider keys, Supabase service-role keys,
or the Shadcn Blocks credential.

## Verify

```bash
npm run verify        # typecheck, lint, unit tests, UI tests
npm run test:rls:clean  # database contract suite on a freshly reset local Supabase stack
npm run build
```

Verify a release against a clean export of the commit (`git clone --local` at the SHA) rather than
the working directory: `tsc`, `eslint` and `next build` read the disk, so a working tree can pass
every gate while the committed tree does not compile.

Run the migration and database test workflows against a disposable local stack before changing
schema contracts. Never edit a migration that has already been applied to an environment; add a new
migration that makes the corrective change.

## Where to start reading

For a contractor:

1. `docs/ENGINEERING-BRIEF.md`: what SetterFi is, who it serves, the stack, the hard rules, and the
   ground rules for working in this repo.
2. `docs/PRODUCT.md`: every surface and what it does.
3. `docs/ARCHITECTURE.md`: the brain, the channels, provisioning, billing, security model.
4. `docs/BACKEND-SPEC.md` with `docs/BRAIN-COMPILER.md`: implementation-grade contracts.
5. `docs/SETUP.md`: environment, GoHighLevel, Meta, A2P, Stripe and Google Calendar.
6. `docs/LAUNCH-CHECKLIST.md` and `docs/operations/README.md`: what stands between the current
   deployment and real coaches, and how to operate the platform.

Before redesigning any coach surface, read `docs/COACH-REDESIGN-PLAYBOOK.md`: the rules the owner
console rehaul was built on, why the coach side is the larger job, and the traps that have already
cost several sessions.

For the owner:

1. `docs/RETRIEVAL-EXPLAINER.md`: how the agent answers from The Brain.
2. `docs/LAUNCH-CHECKLIST.md` sections A and E: what to switch off and what is still owed.
3. `docs/operations/operator-guide.md`: the task-based runbooks.

The seeded demo walkthroughs are `scripts/phase1-demo-runbook.md`,
`scripts/phase2-demo-runbook.md`, `scripts/phase3-demo-runbook.md`,
`scripts/phase4-demo-runbook.md` and `scripts/phase6-demo-runbook.md`.

## Release boundary

The service deliberately distinguishes a completed local operation from confirmed provider
delivery. Do not present a provider, message, booking, deletion, or integration as complete until
the provider receipt or authoritative read-back supports it. The operational prerequisites before
real coaches arrive are in `docs/LAUNCH-CHECKLIST.md`; the live evidence behind each one is in
`docs/platform-diagram/EVIDENCE.md`.
