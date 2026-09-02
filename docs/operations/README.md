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
