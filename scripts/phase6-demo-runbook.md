# Phase 6 demo runbook

This runbook proves only the labelled mock story persisted in the selected database. It does not prove Stripe, deployment, cron execution, approved pricing, approved terms, or client acceptance.

1. Run `npm run demo:seed-phase6` twice, then `npm run demo:run-phase6 -- --verify-idempotent`. Expect exactly two `is_demo` tenants, one checkout, two subscriptions, four attributed appointments, four labelled test billable rows, two corrections, two allowance actions, five commission-ledger entries, two payout events, and two cost rollups.
2. Open `/coach/billing` as the synthetic money coach. Confirm the Demo label, current placeholder tier, four booked calls, pending next-period placeholder tier, correction history, and overdue state. Export CSV and JSON; confirm the exported rows match the visible tenant-scoped rows and contain no margin or cost fields.
3. Open `/affiliate/referrals` as the synthetic affiliate. Confirm only the referred placeholder coach name, account status, earned commission, and sent payout history are visible. Export CSV and JSON; confirm there are no tenant billing, price, cost, or margin fields.
4. Open `/admin/money` as the synthetic platform admin. Confirm the overdue and separately suspended labelled tenants, immutable correction receipts, commission accrual/offset/recovery entries, payout approval/sent receipts, and complete/incomplete cost evidence. Export CSV and JSON and reconcile the row counts to the seeded database evidence.
5. Confirm every displayed commercial string starts with `SETTERFI_DEMO_PLACEHOLDER_`, no content is approved, no real phone number appears, and every seeded tenant carries the Demo label.
6. Run `npm run demo:reset-phase6`, then `npm run demo:run-phase6 -- --verify-idempotent`. The second command must fail with `PHASE6_DEMO_TENANTS_INVALID`, which proves the reset removed the fixed Phase 6 story. Rerun `npm run test:rls` to prove exact-set database contracts remain green.

Stripe real-arm evidence requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, owned by Ayman. Approved Prices are also Ayman-owned; approved commercial copy and terms are Alec/counsel-owned. Until those inputs exist, those lanes remain partial rather than passed.
