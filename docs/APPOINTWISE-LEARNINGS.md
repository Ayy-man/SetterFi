# AppointWise learnings

**Written:** 2026-09-03 · **Source:** AppointWise V2 (app.appointwise.io) read as Alec Delpuech on
2026-09-02, the CCA TEMPLATE and MAIN accounts; eleven screenshots numbered `01` to `11`, kept in
the project vault under `appointwise-screenshots/`. Node text and prompts were read out of the
builder's own state, so anything quoted below is verbatim.

AppointWise is the tool Alec uses today and the thing he means by "the old UI was simpler." This
page maps each of its patterns to the SetterFi screen it should shape. It is a design input, not a
spec: the hard rules in `docs/ENGINEERING-BRIEF.md` stay in force everywhere below. The Brain is
the one name for knowledge. No GoHighLevel branding reaches a coach. Nothing reads done while
anything is provisioning. Cost economics stay admin-only.

## Pattern to screen

| # | AppointWise pattern | Screenshot | SetterFi screen it shapes | What to take, what to leave |
|---|---|---|---|---|
| 1 | **Question node panel schema.** One qualification question is: display name, question text with variable chips, AI instruction (never shown to the lead), save-answer-as variable, required or skippable, max retries, on-exhaust (skip or disqualify), strictness slider, pushback handling. One-line explanation under every row. | `01-conversation-builder.png`, `05-agent-builder-empty-start.png` | **Admin Brain** (the editable form for each qualification row) and **coach Agent** (the same rows rendered read-only, as the ladder). | Take the schema whole: it is the exact field list our qualification rows lack (instruction-vs-utterance split, retries, on-exhaust, pushback). Leave the free canvas: coaches get a vertical ladder, not a node editor. The instruction/utterance split is also the fix for failure mode 1 below. |
| 2 | **Visible question ladder.** The flow reads top to bottom as Start, pipeline move, question, question, AI branch, booking, end. Green for questions, purple for pipeline actions, blue for AI branches, grey for end goals. | `01-conversation-builder.png` | **Coach Agent.** Alec's Mural flow (keywords, goal per keyword, resource, follow-up, questions, tiers, DQ path, conversion event, booking, post-booking) is this ladder with keyword goals at the top. | Take the vertical, one-step-per-row reading and the four-colour family. Coaches drag and toggle questions (Alec asked twice); everything else on the ladder states what SetterFi chose. |
| 3 | **Collected Answers rail.** The conversation's right pane lists each variable the agent captured with its value ("Client Volume: I had 4 clients this week"), plus assigned agent, status toggle, stage change, AI summary. | `06-conversations-three-pane.png` | **Coach Inbox** right rail; **admin Conversations** (cross-tenant read). | Take the answers block as the first thing in the rail: it answers "what did the agent learn" without prose. Take the three-pane split (list, thread, rail) and the list's All / Unread / Complete tabs. Our Inbox already has the panes; it lacks the answers block and has too much text where this belongs. |
| 4 | **Response-timing card.** "Wait 3 to 8 seconds to collect multiple messages, then 2 seconds to write. Total 5 to 10 seconds." Three numbers, one sentence, done. | `02-agent-tab-mission.png` | **Coach Agent**, as a statement row under "What SetterFi handles for you." | Take the wording and the shape. Leave the controls: the platform owns the timing. |
| 5 | **Analytics leaderboard.** Six stat tiles with delta captions (Total leads, Booked, Disqualified, Active, Conversion, Avg time to book), a Leads vs Booked trend, and a table with Leads / Booked / Active / DQ'd / Conv % / Time to book / trend sparkline, one row per agent, click to drill. Window pills 1D 1W 1M 3M All Custom. | `07-account-analytics-leaderboard.png` | **Coach Overview** with keywords as the rows, exactly as Alec asked on 2026-09-02; **admin Analytics** with clients as the rows. | Take the tile set, the one trend, and the per-row sparkline and drill. Our measurement snapshot already groups by keyword and has count and percent modes. Leave the six-tile density on the coach side to four or five tiles at coach scale. |
| 6 | **Pipeline stage names.** New Lead, Qualification Active, Qualified, Call Booked, Unqualified, Rescheduled, Booking Cancelled. Kanban, one column each, count badge per column. | `09-pipeline-kanban.png` | **Coach Leads** (board view) and the lifecycle labels in **Inbox**. | Take the seven names verbatim so Alec reads the same words he has today. Map our lifecycle states onto them rather than inventing a parallel vocabulary. |
| 7 | **Contacts stat strip and table.** Total / In progress / Completed / Failed / Agent off / Conversion above a table with Agent, Source, Activity, Status pill, per-row view and agent on/off. Filters: last month, any status, all agents. | `08-contacts.png` | **Coach Leads** (list view). | Take the strip-above-table shape and the per-row agent on/off. Our list has the table and export already; the strip replaces the prose header. |
| 8 | **Agent mission as sections.** Identity, Goal, Tone, Pricing, Guardrails as short headed blocks, then Disqualification criteria as "one rule per line", Personality as one card, Ask Human as one card with a timeout. | `02-agent-tab-mission.png` | **Admin Brain.** Alec's mission text seeds the Brain's agent defaults; his seven DQ lines seed the global gate list. | Take the sectioned mission and the one-rule-per-line DQ list as the Brain's editing shape. Coaches never see the mission; they see the offer layer only. |
| 9 | **Knowledge tabs and the A/B split.** Agent Knowledge lists attached documents with priority; Alec's ten PDFs split into A (industry: credit, funding products, qualification logic, objections, compliance, voice) and B (per-client: offer, proof, FAQ, templated with `client_business_name`). | `03-agent-knowledge-tab.png` | **Admin Brain** (A is the Brain) and **coach Agent** (B is the offer layer). | Take the split as confirmation of our architecture, and the "highest priority in search" note as a one-line row. Leave the document-list UI; the Brain has its own import flow. Leave the force-graph and Self-Learning page entirely; it was empty for Alec and is cosmetic. |
| 10 | **Agent list with status chips.** Draft / Published / Archived filter chips, status column, created-at sort. | `04-ai-agents-list.png` | **Admin Client book** and **admin Agents**. | Take the chip filter row and the status column. The coach never sees a draft/publish state (one Save). |
| 11 | **Integrations page.** Provider cards with a Connected pill and provider-specific extras; test panel refuses to run until the CRM is connected ("Fix before testing"). | `11-integrations.png` | **Admin Channel health** and **coach Home setup card**. | Take the honest refusal pattern; we already do it. Do not take the card list: GoHighLevel and Twilio are named on AppointWise's page and must never be named to a coach. Coach-side channels are Instagram, Messenger, WhatsApp, SMS, Calendar. |
| 12 | **Client switcher.** A searchable "Choose a Client" drawer at the top of the rail, one login across sub-accounts. | `06-conversations-three-pane.png` (rail header) | **Admin shell.** | Take the drawer as the admin's client picker, replacing the per-page "Choose a client" select that Channel health puts under its own empty state. |
| 13 | **Self-Learning insights.** Health score, top knowledge, unused knowledge, failure patterns, successful patterns, utilisation by document. | `10-self-learning.png` | **Admin Brain**, later. | Leave for now. Every panel was empty in Alec's account. The failure-patterns idea is the only one worth a note, and it belongs in Evals. |

## Alec's logic, as acceptance criteria

The verbatim flow (22 nodes) and mission live in the vault study. What the redesign needs from
them:

- **The ladder is fixed and short.** Funding purpose, funding amount, timeline, credit score, then
  one AI-judged branch (700+ qualifies outright; 600 to 700 and motivated asks about cash; strong
  business asks about revenue; under 600 with no business disqualifies), then invite, email,
  phone, book. This is the coach Agent page's default ladder and the Brain's default rows.
- **Global DQ lines are the only hard stops.** Stop or unsubscribe, under 18, credit under 600,
  goal under $50,000, hostile or selling to us, CPN or synthetic identity or anything illegal,
  clearly not the buyer. A low qualifier answer is a branch, not a disqualification. The DQ path
  moves the lead to Unqualified and turns the agent and follow-ups off.
- **Follow-ups:** five touches at 3h, 1d, 1d, 2d, 2d, cancel on reply. Our cadence purposes map
  onto this ladder; the coach sees the purposes, the platform owns the timing.
- **Booking:** three days ahead, reminder at minus 60 minutes, confirmation copy in the lead's
  thread, post-booking follow-ups paused.
- **Keywords today are four hand-built router agents,** one per keyword, each handing off to a
  full copy of the setter. Our keyword goals collapse that to one agent with a goal and a KPI
  bucket per keyword, which is why the Overview leaderboard keys on keyword rather than agent.

## Two failure modes to design against

Both were visible in Alec's real threads and both are UI-shaped as much as runtime-shaped.

1. **Prompt leak.** A booking node's AI instruction was sent to a lead as the message. The
   question schema in pattern 1 separates instruction from utterance; the Brain form must make
   that split visible and the runtime must refuse to send instruction text.
2. **Script lock.** An existing customer wrote three times over two weeks about a migration and
   was re-asked the next qualification question every time. "I'll flag this for Alec" was said,
   never executed. The Inbox needs an off-script lane that a real escalation lands in, and the
   Collected Answers rail should show that the ladder is paused, not just where it stopped.

## What the current production build gets wrong that AppointWise gets right

From the 2026-09-02 production verification, the controls that most directly contradict the
patterns above: the coach Inbox filter opens an empty popover (pattern 3 needs working list
filters); the Agent page's Professional / Balanced / Friendly chips are spans, not buttons
(pattern 4's one-card personality is the fix); Connect buttons on Connections loop back to Get
started (pattern 11's honest refusal is the shape to use instead); Billing does not load for the
demo coach at all. None of these are design questions, but the redesign should not carry them
forward.
