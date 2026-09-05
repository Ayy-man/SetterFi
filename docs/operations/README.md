# Operations package

The operator documentation for running SetterFi day to day. Every file in this directory except
this index is **generated** from the admin guide registry (`src/lib/admin-help-guides.ts`) and the
`audit_actions` and `alert_rules` tables by `scripts/generate-phase8-handover.mjs`; the same
content is served inside the product at `/admin/help`. Do not hand-edit the generated files:
`scripts/phase8-gate.mjs` regenerates them and fails on any diff. To refresh after a guide or
registry change, with a local Postgres up:

```bash
node scripts/generate-phase8-handover.mjs --generated-at <iso timestamp> --source-commit <sha>
```

| File | What it is for | Read it when |
| --- | --- | --- |
| `operator-guide.md` | Task-based runbooks for the platform team: the Brain (draft, import, evaluate, publish, roll back), client book and impersonation, provisioning, channel health, money corrections, exports, system health, and the help package itself. Includes the admin navigation coverage table. | You are operating the admin console and want the procedure, not the screen. |
| `failure-procedures.md` | What to do when a provider, webhook, job, or credential fails: diagnosis order, the honest state to show, the replay or rotation path, and the receipt that proves recovery. | Something stopped arriving, sending, or booking. |
| `escalation-path.md` | Who is contacted, in what order, for each incident class. Named contacts are inputs the owner supplies; placeholders remain until they do. | You need a human and do not know which one. |
| `running-costs.md` | The per-provider cost lines the platform carries and how each is metered. Cost rates are inputs the owner supplies; placeholders remain until they do. | You are reviewing what the platform costs to run, or filling in the rates. |
| `alert-rule-registry.md` | Every alert rule by event key and scope: name, category, audience roles, default destinations, whether it can be suppressed, whether it is on by default. Generated from `alert_rules`. | An alert fired, or did not, and you want to know what governs it. |
| `audit-action-registry.md` | Every registered privileged action: actor kind, scope, whether a reason is required, whether coaches can see it, and the exact "Logged" microcopy. Generated from `audit_actions`. | You are reading the audit log or adding a privileged action. |
| `recording-01-diagnose.md` | Shot list for the first operator walkthrough recording (diagnosing a stalled conversation). The recording itself is still owed. | You are recording or watching the walkthrough. |
| `recording-02-brain-publish-rollback.md` | Shot list for the second walkthrough recording (publishing The Brain and rolling it back). The recording itself is still owed. | Same. |
| `MANIFEST.md` | The generation receipt: timestamp, source commit, counts, and the SHA-256 of every generated file. Read at runtime by `/admin/help` and checked by the package-freshness test. | You want to know when and from which commit the package was generated. |

Two things this package does not prove: that any provider is configured in production (see
`docs/LAUNCH-CHECKLIST.md` section E and `docs/platform-diagram/EVIDENCE.md`), and that the two
walkthrough recordings exist. Placeholders marked "Input required" or "Recording required" are
open items, not omissions.

## What landed after the package was generated (2026-09-05 and 2026-09-06)

The generated files above are pinned to the source commit in `MANIFEST.md`, so the surfaces and
procedures below are recorded here until the guide registry is updated and the package is
regenerated. Each one is a fact about the deployed code, with its contract in the document named.

**Reading System health.** A scheduled job whose driver selector is deliberately unset now finishes
its receipt as `skipped` and reads **Not configured** on the System page, not Failed. Under the
badge are the environment variable names the job is waiting on (names only, never values) and how
long it has waited, measured from the start of the current unbroken run of skipped receipts, and
one line above the jobs block counts the jobs waiting and lists the union of their names. A job
that reads Failed still names its error. On the `followups` receipt, `blocked` and one
`blocked_<reason>` counter per reason (today `blocked_approved_followup_copy_required`) count
touches that were due but had no approved copy for their channel and purpose; they stay scheduled
and are not failures, and the fix is to approve the coach's copy from the Inbox. On the
`billing-cost-rollup` receipt, `estimates` counts roll-ups recomputed for a billing period that is
still open; those rows are rewritten nightly and become final once computed at or after the period
end. On the `engine-evals` receipt the counters are `cases`, `passed`, the six outcomes (`caught`,
`refused`, `missed_by_checker`, `uncaught`, `clean`, `false_block`) and a `judged` or `unjudged`
flag; an unjudged run means no moderator row was active, so every clean refusal the checker could
not see scored as uncaught. Contracts: `docs/BACKEND-SPEC.md` §3, §8 and §9.

**Working the platform Inbox.** Follow-up copy a coach submitted for approval appears in the Inbox
as its own panel, listed by workspace, channel and purpose, and an owner or admin approves or
rejects each text with a required reason; the decision is logged and the row leaves the queue. The
same queue is at `/admin/followup-copy`. Until copy is approved the coach's follow-ups for that
channel and purpose stay blocked, which is what the `blocked_*` counters above are counting.

**Reading a held reply in a coach Inbox.** When the engine held the agent's last draft, the thread
shows a "Held:" panel with a plain-language reason, which layer held it (Checker or Moderator), the
rule id, and the moderator's short note when the moderator held it. That panel is the whole of what
a coach sees; the full trace with its checks, violations, prompt material and model configuration
stays on the admin side. The evidence behind it is the `moderator_class`, `moderator_rule_id`,
`moderator_reason` and `moderator_model_config_id` columns on `message_traces`.

**Running the evals by hand.** Two read-only runners exercise the same corpora the nightly job and
the admin comparison use, against the published Brain snapshot and the active generator and
moderator rows, and print one line per case plus a summary without writing to the database. Run
them from the repository root with the repository's `.env.local` and the stale shell exports unset:

```bash
env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET \
  zsh -c 'set -a; source .env.local; set +a; npx --yes tsx scripts/eval-engine.ts'
env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET \
  zsh -c 'set -a; source .env.local; set +a; npx --yes tsx scripts/eval-moderator.ts'
```

Both accept `--only <category>` and `--limit <n>`; the engine runner also takes `--key <substring>`
and `--json`, and exits 1 on any `false_block`, `missed_by_checker` or `uncaught` case. A full
48-case engine run costs about 0.01 OpenRouter credits, so it is cheap to run after any prompt,
checker or model-pair change. The moderator runner scores each of the 44 labelled cases as
correct, false allow, false block, class mismatch or error, and reports strict and verdict-only
accuracy with p50 and p95 latency.

**Running the retrieval suite.** The same runner has a second suite that measures whether the
Brain's retrieval ranks the right entry for a lead's phrasing. It runs `evals/corpus/retrieval.json`
through the real retrieval path against the published snapshot's own match function and the live
embeddings driver; no generator or moderator runs, so it costs only embedding calls and needs
`SETTERFI_EMBEDDINGS_DRIVER=real` rather than the OpenRouter driver flag:

```bash
env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET \
  zsh -c 'set -a; source .env.local; set +a; npx --yes tsx scripts/eval-engine.ts --suite retrieval'
```

Its summary is separate from the safety pass rate and the two are never added together. Read the
four figures as ratios with their numerator and denominator printed beside them; a denominator of
zero prints `null`, never 100%:

- **precision@1** — of the cases that expect a specific entry, the share whose expected entry
  ranked first. This is the number a lead experiences, since the top candidate is what the prompt
  leans on.
- **recall@5** — of the same cases, the share whose expected entry appears anywhere in the five
  prompt candidates. A gap between this and precision@1 means the right knowledge reaches the
  prompt but does not lead it.
- **no-match precision** — of every case the pipeline answered "no match", the share that expected
  no match. Off-topic, other-industry and gibberish messages are the only source of this figure,
  so a low value means real questions are being refused, and a run where nothing was refused
  prints `null` here rather than a score.
- **citation validity** — of every candidate retrieval offered the prompt, the share whose entry id
  exists in the snapshot. Anything under 1 means the engine could declare a citation the trace
  cannot verify.

Every case also prints its outcome: `hit_at_1`, `hit_at_5`, `miss`, `false_no_match`,
`no_match_correct`, `no_match_missed`, `unresolvable` (the corpus names an entry the published
snapshot does not contain, which counts against precision and recall rather than being dropped) or
`error`. The runner exits 1 unless every case is `hit_at_1` or `no_match_correct`. The
`platform.knowledge_usage_count` figure on the platform Overview is the production counterpart:
one event per sent reply whose declared citation the engine verified, so it rises only when
retrieval put a real entry in front of the model and the model used it.

**Reseeding the demo.** The demo is written by seeders only, in the order in `docs/SETUP.md`
section 1.7, with the history seeder last; against the hosted project every seeder needs
`--confirm-hosted`. Since 2026-09-05 the phase 1 seeder writes approved demo follow-up templates
per connected channel and purpose, so the simulated cadence sends, and it no longer replaces the
operator's active or default model rows when another row already holds them.
