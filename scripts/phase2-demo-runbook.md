# Phase 2 Brain demo runbook

This continues `phase1-demo-runbook.md`. It proves the local credential-independent Mock arm only;
configured-source, provider, deployment, and signed-in hosted-browser claims remain separate evidence.
Every seeded sentence and row is synthetic, and no content is seeded as approved.

## Continuation sequence

Each numbered step contains one command or one on-screen observation.

14. Run `npm run demo:seed` to establish the guarded Phase 1 demo tenant first.
15. Run `npm run demo:seed-phase2` and observe `review_rows=46`, `qualification=DRAFT`, one published Brain version, and published-plus-draft offer state under `arm=Mock`.
16. Observe `/admin/brain` on the live flag showing `Imported 46 rows — 46 flagged`, every blocking flag code, and disabled acceptance for unresolved rows.
17. Observe one import acceptance after its disposition and blocking resolutions are explicit, then refresh and confirm the persisted decision remains.
18. Observe the exact draft checker showing all six named suites and no hard blocker; treat a stale or missing run as `Not run for this version`.
19. Observe publish disabled for a blank reason, then publish with a reason and confirm `Published vN` plus `Logged` from the returned snapshot and registry receipt.
20. Observe `/coach/agent` keeping the prior published offer live while the saved draft says it is awaiting platform review.
21. Observe a platform-column write and an out-of-bound coach write refused, then refresh and confirm the persisted offer is unchanged.
22. Observe an offer republish returning a new published version and its `offer.published` registry receipt.
23. Observe the next turn in an already-open demo conversation loading the republished offer version in its persisted trace.
24. Observe the trace-backed citation showing `Grounded` only when the declared entry is among the verified retrieval candidates.
25. Observe the Brain version view showing entity changes separately from computed impact lines.
26. Observe rollback disabled for a blank reason, then append a rollback version and confirm the selected source version in the persisted receipt.
27. Observe tenant offer-price, proof, and asset tables each exporting both CSV and JSON.
28. Observe platform import-batch, import-item, knowledge-entry, snapshot, snapshot-diff, and eval-result tables each exporting CSV and JSON only after a reason is present.
29. Observe the Admin Brain and Coach Offer live pages at desktop width with DRAFT/unapproved qualification, honest loading/error controls, and no clipped actions.
30. Observe the same pages at narrow width with usable scrolling, labels, and controls.
31. Observe keyboard focus reaching tabs, fields, reasons, publish or rollback controls, and export format choices in order.
32. Observe a second clean browser context loading the same database draft and published versions without browser-local state.
33. Run `npm run demo:reset-phase2` and observe all mutable Phase 2 demo counts return to zero while immutable history is retained.
34. Run `npm run demo:reset-phase2` again and observe the same zero read-back to prove idempotency.

## Arm boundaries

- Missing Phase 2 driver selectors use Mock and do not block the local run.
- Explicit Real driver selection without its named usable key fails closed.
- The configured 46-row source arm is SKIPPED unless that source is actually exercised; synthetic Mock rows cannot prove source fidelity.
- OpenRouter, GHL, Meta, hosted deployment, and authenticated hosted-browser arms are SKIPPED unless their named prerequisites and persisted receipts are present.
