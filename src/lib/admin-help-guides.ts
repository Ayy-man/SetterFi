/**
 * Operator-facing runbooks for the admin console. Separate from the coach guides on purpose:
 * these name platform operations (publishing the shared brain, reading a trace, adjusting a
 * metered count) that a coach must never see. Written steps only — no video stubs.
 */

export type AdminGuideCategory =
  | "The Brain"
  | "Diagnostics"
  | "Client success"
  | "Channels"
  | "Billing";

export type AdminGuideStep = {
  heading: string;
  caption: string;
};

export type AdminGuide = {
  id: string;
  title: string;
  detail: string;
  category: AdminGuideCategory;
  /** What the operator ends up holding once the steps are done. */
  outcome: string;
  steps: AdminGuideStep[];
  /** Concrete checks that prove the run worked. */
  verify: string[];
  /** The one line for when the verify checks fail. */
  troubleshoot: string;
  /** Guide id to chain to, so the runbooks read as a rail rather than a menu. */
  next: string | null;
};

export const ADMIN_GUIDES: AdminGuide[] = [
  {
    id: "publish-brain",
    title: "Publish the Brain safely",
    detail: "Take a draft from diff review to every agent without publishing more than you checked.",
    category: "The Brain",
    outcome: "Every agent inherits exactly the change you read in the diff, and the publish is on the record.",
    steps: [
      {
        heading: "Read the diff before anything else",
        caption:
          "The Brain header carries the DRAFT and PUBLISHED lifecycle with version history beside it. Open the diff and read what actually changed (qualification outcomes, objection responses, compliance language) rather than trusting the section you happened to edit.",
      },
      {
        heading: "Check the eval status on the publish button",
        caption:
          "The button surfaces the latest suite result. A failing safety suite soft-warns instead of hard-blocking, which means the decision to continue is yours and it is attributed to you.",
      },
      {
        heading: "Try the change on the Evals page",
        caption:
          "Ask the lead question the edit was meant to fix and compare the draft against the published version. The grounding receipt shows the retrieval behind the answer before any coach sees it.",
      },
      {
        heading: "Publish to all agents",
        caption:
          "One action pushes the published version to every agent. The confirmation names what propagated; anything still sitting in draft stays in draft and keeps saying so.",
      },
      {
        heading: "Confirm the audit entry",
        caption:
          "A brain publish is a privileged action, so it writes an entry with the actor, the version, and the timestamp. That entry is what settles a later question about when a behavior changed.",
      },
    ],
    verify: [
      "The Brain header reads PUBLISHED at the new version with no draft badge left behind.",
      "The version history shows your publish with your name and the diff attached.",
      "A test-bench run on the edited topic returns the new passage, not the previous one.",
    ],
    troubleshoot:
      "If an agent still answers the old way, check whether the section you edited was saved into the same draft; an unsaved section never reaches a publish.",
    next: "run-evals",
  },
  {
    id: "run-evals",
    title: "Run an eval suite before publish",
    detail: "Prove a brain or model change against the safety and regression suites first.",
    category: "The Brain",
    outcome: "You can say which suite passed, on which configuration, before the change went out.",
    steps: [
      {
        heading: "Pick the configuration under test",
        caption:
          "The Evals page runs against draft, published, or a candidate configuration, with a client-overlay picker and channel simulation. Choose the one you intend to publish, not the one already live.",
      },
      {
        heading: "Run the safety suite first",
        caption:
          "Qualification, compliance, and prompt-injection cases are the gate. They matter more than tone cases because they are the ones that create a real incident.",
      },
      {
        heading: "Read the failures as receipts, not scores",
        caption:
          "Each case opens to the grounding receipt: the rule that fired and the passage it drew from. That is where you see whether the case failed on knowledge or on the decision table.",
      },
      {
        heading: "Add the case that caused the change",
        caption:
          "Any production conversation can be added as an eval case. A fix you add a case for stays fixed across later prompt and model swaps.",
      },
      {
        heading: "Carry the result into the publish",
        caption:
          "The publish button reads the latest suite status. Run the suite last so the status the operator sees at publish time is the one you just produced.",
      },
    ],
    verify: [
      "The suite run shows the configuration you are about to publish, not the live one.",
      "Every failing case opens to a receipt naming the rule and passage it used.",
      "All eval traffic stays labeled as test data and never lands in client analytics.",
    ],
    troubleshoot:
      "If a suite passes here but a coach reports the old behavior, the run was against the published configuration rather than your draft. Re-run with draft selected.",
    next: "channel-health",
  },
  {
    id: "channel-health",
    title: "A2P and channel health",
    detail: "Tell a carrier review in progress apart from a channel that is actually broken.",
    category: "Channels",
    outcome: "You know which clients are genuinely blocked and which are simply waiting out a clock.",
    steps: [
      {
        heading: "Start from the System health grid",
        caption:
          "Per-client heartbeats cover the Meta token, the A2P probe with its last test-send result, and webhook freshness. One row tells you whether the problem is one client or the platform.",
      },
      {
        heading: "Read registering as pending, not failed",
        caption:
          "A2P 10DLC registration is a carrier review that normally runs 2–3 weeks per client. It shows amber for the whole window and must never be reported to a coach as ready.",
      },
      {
        heading: "Separate token expiry from carrier state",
        caption:
          "An expiring Meta token disconnects Instagram and Messenger and is fixable today by asking the client to reconnect. A carrier review is not fixable by anyone here, so the two need different messages.",
      },
      {
        heading: "Replay the webhook queue when freshness slips",
        caption:
          "Stale webhook freshness with healthy channels usually means delivery, not connection. The retry queue supports manual replay, and replaying is safe because delivery is idempotent per event.",
      },
      {
        heading: "Tell the client what is true",
        caption:
          "Alerts already fire on channel disconnected and A2P cleared. Confirm the alert went out and that the client-facing state still reads amber where the clock has not cleared.",
      },
    ],
    verify: [
      "Every amber channel on the grid maps to an open carrier review or an in-flight verification, not a silent failure.",
      "A client whose token expired shows a reconnect path rather than a registration state.",
      "After a replay, webhook freshness moves and the missing conversations appear in the client's Inbox.",
    ],
    troubleshoot:
      "If a registration stays open past the stated 2–3 week carrier window, check the registration record for an outstanding business detail or a terminal rejection.",
    next: "rescue-signup",
  },
  {
    id: "rescue-signup",
    title: "Rescue a stalled signup",
    detail: "Find where a self-serve onboarding stopped and move it forward without taking it over.",
    category: "Client success",
    outcome: "The client resumes at the step that blocked them, and the intervention is attributed.",
    steps: [
      {
        heading: "Take it from the attention queue",
        caption:
          "Overview leads with the at-risk queue, and onboarding stalled at a named step is one of its entries. The named step is the whole diagnosis. Start there rather than opening the client cold.",
      },
      {
        heading: "Read the onboarding progress on client detail",
        caption:
          "Client detail shows exactly which step a signup stalled at alongside channel health and the offer snapshot. A stall on a channel step is usually a permission the client could not grant.",
      },
      {
        heading: "Nudge before you impersonate",
        caption:
          "Nudge stalled onboarding and resend signup link are the light actions and they keep the client in control of their own account. Reach for them first.",
      },
      {
        heading: "View-as only when you must reproduce",
        caption:
          "Impersonation is logged with your name and the client's account. Use it to see what they see, and edit their offer on their behalf only when they have asked for it.",
      },
      {
        heading: "Leave the internal note",
        caption:
          "The activity timeline is how the next success owner picks this up. One line naming the blocker and what you did saves the client repeating themselves.",
      },
    ],
    verify: [
      "The client's onboarding progress advances past the step named in the queue entry.",
      "Any view-as session appears in the audit log with your name and the time.",
      "The at-risk queue drops the entry once the step completes, without anyone clearing it by hand.",
    ],
    troubleshoot:
      "If the stall repeats at the same step after a nudge, the step is genuinely blocked. Check channel health for a permission the client cannot grant from their side.",
    next: "adjust-meter",
  },
  {
    id: "adjust-meter",
    title: "Adjust a metered count",
    detail: "Settle a disputed booked-call count with a reasoned, audited correction.",
    category: "Billing",
    outcome: "The count matches the evidence, and the correction carries a reason anyone can read later.",
    steps: [
      {
        heading: "Reconcile before you adjust",
        caption:
          "Open the per-client metering table on Tiers and billing and compare booked calls against the conversations behind them. Only confirmed bookings count; a proposed slot the lead never accepted does not.",
      },
      {
        heading: "Export the cycle the client is disputing",
        caption:
          "Every table exports CSV and JSON with the rows currently filtered and sorted. A disagreement about a number gets settled from the same rows both sides can read.",
      },
      {
        heading: "Adjust with a reason, not a silent edit",
        caption:
          "The metered-count adjustment requires a written reason. Outcome billing produces disputes, so the reason field is the product feature, not paperwork around it.",
      },
      {
        heading: "Confirm the audit trail entry",
        caption:
          "Meter adjustments are privileged and write an entry with the actor, the client, the old and new counts, and the reason. Check it landed before you reply to the client.",
      },
      {
        heading: "Answer the client in their own terms",
        caption:
          "Coaches never see platform economics. Explain the corrected count and what it means for their allowance, and keep cost-versus-revenue inside this console.",
      },
    ],
    verify: [
      "The client's usage meter and the metering table agree after the adjustment.",
      "The audit entry names you, the reason, and both counts.",
      "Nothing about margin or platform cost appears in what you send the client.",
    ],
    troubleshoot:
      "If the counts still disagree after an adjustment, check whether test-data conversations were counted. Segregated test traffic never meters, and a mismatch there is a fixture problem, not a billing one.",
    next: "publish-brain",
  },
  {
    id: "platform-inbox",
    title: "Work the platform Inbox",
    detail: "Triage system problems and lead handoffs from one queue, ranked by how long each has waited.",
    category: "Diagnostics",
    outcome: "Every row that needed a person has been read, and the ones you acted on carry an audit entry.",
    steps: [
      {
        heading: "Read the order before you read the rows",
        caption:
          "Both lanes rank by how long a row has waited. Nothing in the platform stores a response target or a reply promise, so no row is late and none is breaching. A long wait is the oldest thing here, not a missed commitment.",
      },
      {
        heading: "Work the system lane first, because those rows block replies",
        caption:
          "A disconnected channel or a blocked provisioning step stops an agent from answering. Open the row, read the blast radius, and follow the account to Channel health, which carries the provider's own error text. Read the receipt checklist there with care: the signed round-trip receipt has no write path yet, so an empty one means nothing was recorded rather than that the test failed.",
      },
      {
        heading: "Read the handoff lane as accounts, not as leads",
        caption:
          "A handoff row names the account, the channel, what handed the thread over and how long it has waited. It never carries the lead's name or their message: those stay inside the coach's tenant, and the coach sees the thread in their own inbox. Contact the coach rather than trying to reach the lead.",
      },
      {
        heading: "Mark read when you are done looking, and say the rest out loud",
        caption:
          "Marking read is the only per-row state the store keeps, and it means somebody looked. It does not mean the problem is fixed, and nothing records who is working a row, so hand off in writing rather than assuming the queue carries it.",
      },
    ],
    verify: [
      "The waiting figure equals the unopened rows in the system lane plus the rows in the handoff lane.",
      "A row you marked read shows Marked read and stays in the list rather than disappearing.",
      "With the cross-tenant handoff queue switched off, the lane says it is not counted rather than showing zero.",
    ],
    troubleshoot:
      "If the handoff lane says it could not be read, that is a failed projection call rather than an empty platform. Check the queue flag and the RPC before telling a coach nothing is waiting.",
    next: "support-inbox",
  },
  {
    id: "support-inbox",
    title: "Work the support inbox",
    detail: "Reply to coach support threads without mixing them with lead conversations.",
    category: "Client success",
    outcome: "The coach receives a persisted reply and the next operator can see who owns the thread.",
    steps: [
      {
        heading: "Choose My clients or All clients",
        caption:
          "My clients narrows the queue to your assigned book; All clients is an operating view, not a wider permission. Open the thread in Client requests and keep internal notes separate from the reply the coach will read.",
      },
      {
        heading: "Reply from the support thread",
        caption:
          "Use Reply for coach-visible text and Internal note for staff context. Support messages live in their own system and never become lead-conversation messages.",
      },
      {
        heading: "Confirm the persisted read-back",
        caption:
          "A successful reply reappears with its author and time. Reassignment reads Reassigned only after the owner and audit receipt both match the request.",
      },
    ],
    verify: [
      "The reply appears in the same support thread with the operator and timestamp.",
      "The coach view contains the reply and no internal note.",
      "Any ownership change appears in Audit with the assigning operator and assignee.",
    ],
    troubleshoot:
      "If the reply does not read back, leave the thread unchanged and use System to check the current service state before retrying.",
    next: "client-book",
  },
  {
    id: "client-book",
    title: "Manage the client book",
    detail: "Review client ownership and make a reasoned, audit-backed reassignment.",
    category: "Client success",
    outcome: "The intended success owner is persisted and the reassignment has one matching audit receipt.",
    steps: [
      {
        heading: "Open Clients and compare the two books",
        caption:
          "My clients shows the current operator assignment; All clients shows the platform book. Use the persisted support and account states to decide whether ownership needs to change.",
      },
      {
        heading: "Choose the assignee and write the reason",
        caption:
          "Reassignment is privileged. The reason should explain the operating need without copying lead or credential data into the audit trail.",
      },
      {
        heading: "Wait for Reassigned and Logged",
        caption:
          "Both labels come from the returned owner and audit read-back. If either receipt is missing, the previous owner remains the displayed truth.",
      },
    ],
    verify: [
      "The client appears under the new owner's My clients view.",
      "Audit shows tenant.success_owner.reassigned with the same tenant and assignee.",
    ],
    troubleshoot:
      "If the owner does not change, keep the prior assignment and check the audit reason and assignee eligibility before trying again.",
    next: "support-inbox",
  },
  {
    id: "agent-roster",
    title: "Read the agent roster",
    detail: "See which client's setter is live, which is on an old version, and which has never published.",
    category: "Client success",
    outcome: "You can name every client whose setter is not answering leads on its newest configuration, and say why.",
    steps: [
      {
        heading: "Open Agents and read the three states apart",
        caption:
          "There is one setter per client. Live means it is answering leads on a published version. Draft means edits are saved but nothing has ever been published, so it is answering nothing. Never published means the client has no offer layer at all. They are three different pieces of work, so they are three different sentences rather than one word in three colours.",
      },
      {
        heading: "Check the unpublished count before you chase anyone",
        caption:
          "The count is the client's draft versions standing above their live one, read from offer_layers. A live setter with two unpublished edits is working correctly on older instructions -- that is a conversation with the coach, not an incident.",
      },
      {
        heading: "Go to where the setting is owned",
        caption:
          "This screen reports state and does not change it. Publishing happens on the client's own offer page, where a change can be reviewed against what it replaces; channels and escalation are their own screens. Each row links to the one place that owns it.",
      },
    ],
    verify: [
      "The inherited count on a client matches how many offer-layer settings they have left unset.",
      "A client with no published offer layer reads as never published, not as live on version 0.",
    ],
    troubleshoot:
      "If the open-thread count reads as unavailable, the conversation store did not answer; the publish states are read separately and are still accurate. If The Brain's version is not named, no brain snapshot is currently published.",
    next: "client-book",
  },
  {
    id: "alert-preferences",
    title: "Review alert preferences",
    detail: "Change optional destinations while leaving required notices locked and visible.",
    category: "Diagnostics",
    outcome: "The account's bell, email, and Slack choices match the persisted registry read-back.",
    steps: [
      {
        heading: "Open Notifications and read the rule before changing it",
        caption:
          "The event, scope, audience, and default destinations come from the alert registry. Required billing consequences remain enabled and their controls read Required.",
      },
      {
        heading: "Change one optional destination",
        caption:
          "The control is committed only after the service returns the persisted preference. A failed save restores the prior value rather than leaving an optimistic state on screen.",
      },
      {
        heading: "Confirm delivery separately",
        caption:
          "A saved preference proves intent, not provider delivery. Use the bell receipt and System delivery queue for the actual destination state.",
      },
    ],
    verify: [
      "A reload shows the same optional destination state.",
      "Every nonsuppressible row remains visible, enabled, and locked as Required.",
    ],
    troubleshoot:
      "If a preference reverts, the write did not persist; keep the returned value and inspect System rather than toggling repeatedly.",
    next: "delivery-queue",
  },
  {
    id: "alert-registry",
    title: "Read platform alert settings",
    detail: "Inspect the shared rule registry without treating configuration as delivery evidence.",
    category: "Diagnostics",
    outcome: "You can name the event, audience, required state, and intended destinations for a platform rule.",
    steps: [
      {
        heading: "Open Settings and find the event",
        caption:
          "Search by the named event rather than by display copy. Scope separates tenant rules from platform rules, and audience shows who can receive each one.",
      },
      {
        heading: "Check Required before interpreting a control",
        caption:
          "Required rows cannot be suppressed. Optional rows still need an account preference before a destination is selected.",
      },
      {
        heading: "Export the current registry when handing it over",
        caption:
          "The server export uses the same columns and sort as the rendered table and writes an audit start and finish pair.",
      },
    ],
    verify: [
      "The event and scope match the generated alert-rule registry.",
      "The export has both audit receipts and the same visible column set.",
    ],
    troubleshoot:
      "If the registry is unavailable, do not infer defaults from a previous export; use the generated package as dated evidence and escalate the current read failure.",
    next: "alert-preferences",
  },
  {
    id: "delivery-queue",
    title: "Diagnose delivery queue and retries",
    detail: "Separate queued, accepted, delivered, retrying, and terminal notification states.",
    category: "Diagnostics",
    outcome: "You can state what the platform attempted and which receipt is still missing.",
    steps: [
      {
        heading: "Start with the queue evidence",
        caption:
          "Queue depth and terminal attempts come from persisted delivery rows. Unknown evidence stays Unavailable and must not be summarized as healthy.",
      },
      {
        heading: "Read the destination-specific state",
        caption:
          "Email acceptance reads Sent until a signed receipt arrives; Slack requires its documented success response; a bell is delivered by the database commit.",
      },
      {
        heading: "Let the bounded retry policy own retries",
        caption:
          "Do not create a second send from the UI. A leased attempt and its retry time keep the provider call idempotent and visible.",
      },
    ],
    verify: [
      "The attempt count and last-attempt time advance only after a persisted attempt.",
      "Email never reads Delivered without a matching signed receipt.",
      "A terminal row has a named safe error code and no further due time.",
    ],
    troubleshoot:
      "If queue evidence is unavailable, do not retry manually; preserve the current rows and use the escalation path for a database or worker read failure.",
    next: "system-health",
  },
  {
    id: "system-health",
    title: "Read System health",
    detail: "Assess queue, jobs, and provider mode from receipts without exposing configuration values.",
    category: "Diagnostics",
    outcome: "You can distinguish a current receipt, an explicit failure, and an unknown state.",
    steps: [
      {
        heading: "Read queue evidence first",
        caption:
          "Delivery queue depth, terminal attempts, and the latest attempt time are persisted facts. Unavailable means the evidence could not be read, not that the count is zero.",
      },
      {
        heading: "Check each job receipt",
        caption:
          "A job is current only when a stored run receipt exists inside its expected window. A configured schedule with no receipt remains Unavailable.",
      },
      {
        heading: "Use provider mode as configuration state only",
        caption:
          "System shows mock, real, or unavailable plus environment variable names. It never displays a key, webhook address, sender value, or other configuration value.",
      },
    ],
    verify: [
      "Every Healthy or Failed label points to a persisted receipt and time.",
      "Unknown queue, job, or provider evidence renders Unavailable.",
      "No configuration value or mutation control appears on the page.",
    ],
    troubleshoot:
      "If the evidence read itself fails, capture the named unavailable section and follow the escalation path; do not infer platform health from provider mode.",
    next: "delivery-queue",
  },
  {
    id: "audit-log",
    title: "Use the audit log",
    detail: "Trace a privileged action through its actor, target, reason, and time.",
    category: "Diagnostics",
    outcome: "You can answer who did what, to which target, and whether test data was involved.",
    steps: [
      {
        heading: "Filter by the registered action",
        caption:
          "Action keys come from the audit registry. Search the exact key so similarly worded actions do not collapse into one explanation.",
      },
      {
        heading: "Read actor, target, reason, and test lineage together",
        caption:
          "A human action requires an actor; a system action does not borrow a human identity. Missing lineage remains unavailable rather than being called Real.",
      },
      {
        heading: "Match paired operations",
        caption:
          "Exports have start and finish rows. A start without a finish means the stream may have ended after some bytes and is an operating signal, not a completed export.",
      },
    ],
    verify: [
      "The action exists in the generated audit-action registry.",
      "The row contains the actor shape required by that registry entry.",
    ],
    troubleshoot:
      "If an action expected to read Logged has no row, treat the action as unverified and escalate the missing receipt.",
    next: "export-table",
  },
  {
    id: "export-table",
    title: "Export a rendered table",
    detail: "Download the current server-side table scope with an auditable start and finish pair.",
    category: "Diagnostics",
    outcome: "The CSV or JSON matches the visible filter, sort, and columns, with a recorded byte and row count.",
    steps: [
      {
        heading: "Set the table state first",
        caption:
          "Choose the filter and sort you intend to hand over. The export route applies that same closed scope rather than serializing only the browser's current page.",
      },
      {
        heading: "Choose CSV or JSON",
        caption:
          "The server streams the full authorized result and neutralizes spreadsheet formula prefixes in CSV. Cross-client exports require a tenant and a reason.",
      },
      {
        heading: "Check the audit pair",
        caption:
          "The start records resource, filter, columns, and actor; the finish records row and byte counts after the final byte.",
      },
    ],
    verify: [
      "The file columns and ordering match the rendered table.",
      "Audit contains one matching start and finish pair.",
    ],
    troubleshoot:
      "If the file is truncated, keep the unmatched start as evidence and repeat only after the source read is available.",
    next: "audit-log",
  },
  {
    id: "compliance-dnc",
    title: "Review compliance and DNC evidence",
    detail: "Separate active suppression from the authoritative record retained after deletion.",
    category: "Diagnostics",
    outcome: "You can explain whether a contact is currently suppressed and what durable evidence remains.",
    steps: [
      {
        heading: "Open Compliance and identify the record type",
        caption:
          "Current suppression entries drive send refusal. Suppression tombstones retain the protected proof after contact deletion; one cannot substitute for the other.",
      },
      {
        heading: "Check provider confirmation",
        caption:
          "Provider-confirmed and provider-unconfirmed are different states. An unconfirmed clear or push remains an escalation and must not resume messaging.",
      },
      {
        heading: "Export the compliance artifact when required",
        caption:
          "Use the reason-required server export and retain its audit pair. Do not copy identifiers into an internal note or hand-written spreadsheet.",
      },
    ],
    verify: [
      "The current send decision and the durable tombstone are read from their named sources.",
      "No provider-unconfirmed record is presented as cleared.",
    ],
    troubleshoot:
      "If provider read-back is missing, leave the local suppression in place and follow the STOP or tripwire failure procedure.",
    next: "channel-health",
  },
  {
    id: "provisioning-tracker",
    title: "Operate the provisioning tracker",
    detail: "Find the exact step owner and evidence before retrying a stalled setup.",
    category: "Client success",
    outcome: "The setup advances through a persisted retry or remains honestly blocked on its named owner.",
    steps: [
      {
        heading: "Read the step state and owner",
        caption:
          "The tracker separates coach action, platform action, and external-provider waiting. A registering A2P row stays amber for the 2–3 week carrier window.",
      },
      {
        heading: "Retry only eligible work",
        caption:
          "A retry is a privileged action backed by the current step lease and audit receipt. A permanent 10DLC rejection remains permanently blocked and has no retry control.",
      },
      {
        heading: "Verify the next persisted state",
        caption:
          "The row must read back the new attempt, state, and evidence time. A queued step is not complete and must never read 100 percent or all set.",
      },
    ],
    verify: [
      "The row identifies who or what owns the next action.",
      "Registering copy says 2–3 weeks and terminal rejection remains blocked.",
    ],
    troubleshoot:
      "If the same eligible step fails again, stop retrying and use the onboarding-stall failure procedure with the recorded error code.",
    next: "rescue-signup",
  },
  {
    id: "measurement-evidence",
    title: "Read platform measurement",
    detail: "Interpret platform and agent-performance metrics only when their named evidence is complete.",
    category: "Diagnostics",
    outcome: "You can state the definition, window, denominator, and availability reason for a displayed metric.",
    steps: [
      {
        heading: "Start from the metric definition",
        caption:
          "Overview and Agent performance use the committed metric registry. The definition and the query must agree on population, attribution window, and exclusion of Demo and Test rows.",
      },
      {
        heading: "Treat absent evidence as absent",
        caption:
          "Unavailable, No completed events yet, and Needs more history are evidence states. They never become zero, a dash, or a cached result presented as current.",
      },
      {
        heading: "Use the role boundary",
        caption:
          "Success operators receive operational evidence only. Platform economics remain owner/admin-only and incomplete margin has no renderable field.",
      },
    ],
    verify: [
      "The metric definition names the same window and population as the rendered view.",
      "Demo and Test rows are excluded from real analytics and labelled in test-only views.",
    ],
    troubleshoot:
      "If a definition and number disagree, treat the metric as unavailable and escalate the projection rather than explaining the number from memory.",
    next: "run-evals",
  },
  {
    id: "billing-operations",
    title: "Review tiers and billing",
    detail: "Operate fixed tiers and subscription state without exposing platform economics to coaches.",
    category: "Billing",
    outcome: "The displayed tier, allowance, and account state match the persisted billing mirror.",
    steps: [
      {
        heading: "Read the subscription mirror",
        caption:
          "The billing page uses persisted subscription and invoice evidence. A provider identifier on its own is not an active subscription receipt.",
      },
      {
        heading: "Separate overdue from suspended",
        caption:
          "Overdue keeps the agent operating while dunning continues. Suspension is a reasoned human action that stops new conversations and follow-ups without silencing in-flight conversations.",
      },
      {
        heading: "Keep operating cost inside admin",
        caption:
          "The platform cost rollup and running-cost handover are for the owner/operator. Coach replies contain allowance and account facts, never margin or cost-versus-revenue detail.",
      },
    ],
    verify: [
      "Tier, allowance, period, and account state have persisted source evidence.",
      "Incomplete cost sources render absent rather than a partial margin.",
    ],
    troubleshoot:
      "If provider and mirror states disagree, preserve the mirror as the application truth and follow the billing-failure procedure before changing access.",
    next: "billing-corrections",
  },
  {
    id: "billing-corrections",
    title: "Decide a billing correction",
    detail: "Review a requested count correction and preserve the offset and audit evidence.",
    category: "Billing",
    outcome: "The request is approved or rejected with a reason and an immutable read-back.",
    steps: [
      {
        heading: "Open Corrections and read the source event",
        caption:
          "Compare the request with the billable event and supporting appointment evidence. Do not change the original ledger row.",
      },
      {
        heading: "Approve or reject with a reason",
        caption:
          "Approval writes an offset event; rejection records the decision. Both paths require the persisted decision and audit receipt before the UI confirms them.",
      },
      {
        heading: "Confirm the resulting count",
        caption:
          "The current allowance view must reflect the original event plus its offset. A decision label without that read-back is incomplete.",
      },
    ],
    verify: [
      "The decision and audit ids match the request.",
      "An approved request has one offset event and leaves the original event immutable.",
    ],
    troubleshoot:
      "If the read-back does not reconcile, keep the request open and escalate rather than adding a second correction.",
    next: "adjust-meter",
  },
  {
    id: "affiliate-operations",
    title: "Review affiliate records",
    detail: "Separate referral attribution, commission accrual, payout approval, and recorded send evidence.",
    category: "Billing",
    outcome: "Each affiliate amount has a persisted attribution and its payout state is described without implying a transfer we did not make.",
    steps: [
      {
        heading: "Start from referral attribution",
        caption:
          "The affiliate record is immutable after signup. The portal exposes only business name, account status, and commission earned, never referred-coach performance.",
      },
      {
        heading: "Read the ledger events",
        caption:
          "Collected revenue accrues commission and refunds or disputes create offsets. The current amount is the append-only sum, not an editable balance.",
      },
      {
        heading: "Distinguish approved from recorded sent",
        caption:
          "Approved for payout is an internal decision. Recorded sent requires an external reference and date, and says only that the transfer was recorded.",
      },
    ],
    verify: [
      "The amount reconciles to the immutable ledger entries.",
      "Recorded sent has the required reference, date, event, and audit receipt.",
    ],
    troubleshoot:
      "If the ledger does not reconcile, stop before payout approval and escalate the specific referral or invoice evidence gap.",
    next: "billing-operations",
  },
  {
    id: "use-handover",
    title: "Use the handover package",
    detail: "Open the generated operating package and verify its source metadata before relying on it.",
    category: "Diagnostics",
    outcome: "You are using the committed package whose file hashes match its manifest.",
    steps: [
      {
        heading: "Open Help for the task you are performing",
        caption:
          "The in-product guide is the operating source for screen procedures. The generated operator guide contains the same guide text for offline use.",
      },
      {
        heading: "Check the manifest metadata",
        caption:
          "Generated at, source commit, registry counts, and file hashes identify the exact package. They are injected build evidence, not a claim about deployment or provider state.",
      },
      {
        heading: "Use the escalation path when evidence is absent",
        caption:
          "The package labels missing cost, contact, recording, provider, and deployment inputs. Do not replace those labels with an operator guess.",
      },
    ],
    verify: [
      "Every generated file hash matches MANIFEST.md.",
      "The manifest source commit is the package source you intended to use.",
    ],
    troubleshoot:
      "If a hash differs, stop using the edited copy and regenerate from the committed source metadata.",
    next: "system-health",
  },
  {
    id: "publish-account-terms",
    title: "Publish the account terms",
    detail: "Put the approved terms and privacy copy into the registry a signup acceptance is recorded against.",
    category: "Diagnostics",
    outcome:
      "One published version exists, with a content hash an auditor can compare against the approved document.",
    steps: [
      {
        heading: "Save the approved copy as a draft",
        caption:
          "Paste the terms and the privacy policy exactly as counsel supplied them. SetterFi writes no legal copy of its own, and the content hash is computed from these two bodies, so a reformatted paste is a different document.",
      },
      {
        heading: "Publish the draft you checked",
        caption:
          "Publishing stamps the version with your identity and the time, and both the draft and the publication are recorded in the audit log. A published version cannot be edited, replaced, or withdrawn from this screen.",
      },
      {
        heading: "Switch acceptance on separately",
        caption:
          "Publishing alone changes nothing a coach sees. Signup only asks for acceptance once SETTERFI_ACCOUNT_TERMS_LIVE is on, which is why the publisher stays reachable while that flag is off.",
      },
    ],
    verify: [
      "The registry names one published version, with its key, hash, and publication date.",
      "The audit log holds an account.terms.published row naming that version key.",
    ],
    troubleshoot:
      "If publishing is refused because a version is already published, stop: the registry holds one published version and nothing here can withdraw it. Take the replacement to whoever owns the schema.",
    next: "audit-log",
  },
];

/** One guide owns each canonical admin navigation path; nested tasks may chain to more guides. */
/**
 * The admin routes each guide is about, and the reason this exists beside the nav map.
 *
 * `ADMIN_GUIDE_NAV_MAP` runs route -> guide, so it answers "does this page have help?" and cannot
 * answer "does this help have a page?". On 2026-09-01 a guide called `read-trace` shipped through
 * that blind spot: its first step read "any lead conversation offers view trace" and no surface
 * in the product offers one -- `messages.trace` is written and never read
 * (`src/lib/repositories/traces.ts` exports no read operation on purpose). It was not in the nav
 * map at all, hanging off `run-evals` as a `next:`, so the coverage guard never looked at it, and
 * `handover/generator.ts` shipped it to the client as `operator-guide.md`: documentation of how to
 * operate something that was never built.
 *
 * So every guide names at least one route it is about, and every route named here has to be a real
 * admin destination. A guide about a view that does not exist has nothing it can honestly list,
 * which is the point -- the author has to confront the absence at the moment they write the guide
 * rather than at the moment a client follows it.
 *
 * Several guides name more than one route because the work genuinely spans them, and
 * `export-table` names four because it is about an affordance every table carries rather than
 * about a page. That is not a weaker claim: each of the four is checked to exist.
 */
export const ADMIN_GUIDE_SURFACES: Record<string, readonly string[]> = {
  "publish-brain": ["/admin/brain"],
  "run-evals": ["/admin/brain/testing"],
  "channel-health": ["/admin/channel-health", "/admin/system"],
  "rescue-signup": ["/admin/overview", "/admin/provisioning"],
  "adjust-meter": ["/admin/tiers", "/admin/corrections"],
  "platform-inbox": ["/admin/alerts"],
  "support-inbox": ["/admin/support"],
  "client-book": ["/admin/platform-clients"],
  "agent-roster": ["/admin/agents"],
  "alert-preferences": ["/admin/alerts"],
  "alert-registry": ["/admin/alerts"],
  "delivery-queue": ["/admin/system", "/admin/alerts"],
  "system-health": ["/admin/system"],
  "audit-log": ["/admin/audit"],
  "export-table": ["/admin/platform-clients", "/admin/audit", "/admin/agents", "/admin/affiliates"],
  "compliance-dnc": ["/admin/compliance"],
  "provisioning-tracker": ["/admin/provisioning"],
  "measurement-evidence": ["/admin/agent-performance", "/admin/overview"],
  "billing-operations": ["/admin/billing", "/admin/tiers"],
  "billing-corrections": ["/admin/corrections"],
  "affiliate-operations": ["/admin/affiliates"],
  "use-handover": ["/admin/help"],
  "publish-account-terms": ["/admin/account-terms"],
};

export const ADMIN_GUIDE_NAV_MAP = {
  "/admin/agent-performance": "measurement-evidence",
  "/admin/account-terms": "publish-account-terms",
  "/admin/agents": "agent-roster",
  "/admin/affiliates": "affiliate-operations",

  "/admin/alerts": "platform-inbox",
  "/admin/audit": "audit-log",
  "/admin/billing": "billing-operations",
  "/admin/brain": "publish-brain",
  "/admin/brain/testing": "run-evals",
  "/admin/channel-health": "channel-health",
  "/admin/compliance": "compliance-dnc",
  "/admin/corrections": "billing-corrections",
  "/admin/help": "use-handover",
  "/admin/overview": "measurement-evidence",
  "/admin/platform-clients": "client-book",
  "/admin/provisioning": "provisioning-tracker",
  "/admin/support": "support-inbox",
  "/admin/system": "system-health",
  "/admin/tiers": "billing-operations",
} as const;

export function findAdminGuide(id: string) {
  return ADMIN_GUIDES.find((guide) => guide.id === id) ?? null;
}

export function filterAdminGuides(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return ADMIN_GUIDES;
  return ADMIN_GUIDES.filter((guide) =>
    `${guide.title} ${guide.detail} ${guide.category} ${guide.outcome} ${guide.steps
      .map((step) => `${step.heading} ${step.caption}`)
      .join(" ")}`
      .toLowerCase()
      .includes(needle),
  );
}
