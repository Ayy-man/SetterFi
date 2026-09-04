# Coach screens: Mobbin pattern research

**Written:** 2026-09-04, before the redesign canvas round. Source: Mobbin screen and flow search,
web and iOS, images inspected rather than read off metadata.

Purpose: give each coach-facing screen three to five shipped references so the canvas borrows a
proven interaction instead of inventing one. Every recommendation here is held to the coach
density in `docs/COACH-REDESIGN-PLAYBOOK.md` part 1 rule 11: 16px body, 46px titles, 44px targets,
five top pills, no uppercase, no 9.5px overline. Where a reference violates that, the note says so.

A pattern that recurs across almost every search, and is the single most useful finding: **the
strongest references state the machine's behaviour as a sentence and give the user one control per
decision.** The weakest ones draw a canvas, a node graph, or a grid of identical cards. That split
maps exactly onto the ruling in `docs/SIMPLIFICATION-SPEC.md` section 4.

---

## 1. Home (dashboard)

**References**

- [HoneyBook setup dashboard](https://mobbin.com/screens/7c915d6b-2a99-4eb0-956d-e7a3a97bb265) ·
  HoneyBook. Named greeting, then one checklist panel titled "Let's start step-by-step" with a
  6/7 counter and a per-row time estimate. Lift the counter plus the per-row estimate: it turns an
  open-ended setup into a bounded one, which is what a coach on day three needs.
- [Oyster first-run](https://mobbin.com/screens/b36e49cb-4dce-41aa-a161-696caedaef44) · Oyster.
  Four numbered rows, each with its own state word (Completed, Draft, Pending) and a single button
  on the row that is actionable. Nothing else on the page. This is the closest shipped thing to the
  spec's "Get started card at the top of Home", including that a step with nothing to press shows a
  state word rather than a disabled button.
- [Copilot home](https://mobbin.com/screens/297c2971-e2d8-412d-8095-3885d993d668) · Copilot. The
  checklist sits above Analytics, and the analytics block says in words "Metrics will show after
  you create 10 clients (3/10 created so far)" instead of drawing an empty chart. That is playbook
  rule 1 already shipped by somebody else: absence stated, not drawn.
- [Substack home](https://mobbin.com/screens/66c647d9-d369-4c8b-8d8a-768801df2505) · Substack.
  Setup panel collapses to a slim bar once most rows are done, and the Overview figures below it
  print an en dash for "Pledged annualized revenue" with no invented zero.
- [Deel mobile home](https://mobbin.com/screens/63e34f8f-acb6-4620-bfd6-dbb38ef1508d) · Deel, iOS.
  The whole setup card is one stacked block with a percentage and three rows, each row a title, a
  next-step line, and a right-hand button. Useful for the 390px case because it never puts two
  controls on one line.

**Avoid.** Nearly every analytics result was the same page: six identical tiles with a sparkline in
each, then a chart, then two half-width tables. Whop, Cloudflare, Vercel and X all draw it. It reads
as a template rather than a page about this business, and at 16px body it will not fit six across.
Also avoid Langdock's points-and-leaderboard framing of setup, which turns provisioning into a game.

**Recommendation.** One column, not a grid. Greeting and status sentence, then the date-range pills,
then the Get-started panel while provisioning is incomplete, then the six figures, then one chart,
then the keyword table. The Get-started panel is the Oyster shape: numbered rows, one state word or
one 44px button per row, a counter in the header band, and the whole panel unrenders when the last
row completes rather than turning into a congratulation. The primary control on the page is the one
button on the first incomplete row; when setup is done the page spends no accent fill at all. A
figure with no reading prints the Copilot sentence in its place and the card ends short. At 390px
the six figures become a two-column grid of stacked label-over-figure blocks, the date pills scroll
horizontally, and the keyword table becomes stacked rows with the keyword as the row title.

---

## 2. Agent (linear configuration)

**References**

- [ManyChat auto-send links in DM](https://mobbin.com/screens/8be8c93d-0912-471c-ba2b-13b64be363c1)
  · ManyChat. The left column reads as prose with fields inside it: "When someone DMs you with"
  a specific word or words, "They'll get a DM back from you with a link", then "Other things to
  automate" holding the follow-up messages. This is SetterFi's keyword to purpose to resource
  message to follow-up sequence, already shipped as a readable sentence rather than a node graph.
  It is the single strongest reference in this document.
- [Mercury onboarding step rail](https://mobbin.com/screens/6f8ae213-ac64-47a2-885c-dd5a4965065d) ·
  Mercury. "3 / 6" over a left rail where completed steps carry a check, the current one is filled,
  and later ones are grey and unpressable. One question group per step, Back and Next at the bottom.
  Lift the numeral pair and the three-state rail exactly.
- [Remote add an employee](https://mobbin.com/screens/d6094185-b959-4f34-8022-248f0ea7ff52) ·
  Remote. Same rail on a coloured panel, seven steps, and each optional add-on inside a step is a
  card with a checkbox, a price and a plain description. Good model for the qualification tiers,
  where each tier needs a name plus a sentence rather than a row of inputs.
- [Typeform question list](https://mobbin.com/screens/1ffcdfce-1120-4b82-823c-1738a8e63a45) ·
  Typeform. Left rail of numbered questions with drag handles, centre shows the one selected
  question full size, right panel holds that question's settings including its Required toggle.
  Selection, ordering and per-question settings are three separate regions, which is why it stays
  legible where an inline accordion does not.
- [Asana form question](https://mobbin.com/screens/c43ca5b8-94fc-4b4c-911b-601695903a65) · Asana.
  The per-question row carries an up arrow, a down arrow, a duplicate and a delete as explicit
  buttons beside the Required toggle. Arrows are the accessible ordering control; drag is the
  shortcut, not the only path.

**Avoid.** The node-canvas builders: [Intercom workflows](https://mobbin.com/screens/cb6e5ce9-733d-470c-a5d5-70dcfb99ad36),
[n8n](https://mobbin.com/screens/3e1f7e34-d1c6-4a97-8bf5-1db52f4d068c),
[ElevenLabs agent workflow](https://mobbin.com/screens/29ef3c9a-5ae8-4ca6-8074-fe4b8d81ae19) and
[Vapi](https://mobbin.com/screens/d6c6222f-01e0-4fbf-92ec-3c7851b77be0) all draw a zoomable graph
with branch labels. Every one of them requires the reader to hold a topology in their head. This is
the "whole mess" the client already named, drawn more expensively.

**Recommendation.** A left step rail at Mercury's proportions, a single question group in the centre
at 640px maximum, and a footer bar carrying Back and one primary Continue. Steps in the spec order:
keywords, purpose per keyword, resource link and message, follow-up, qualification questions, tiers,
disqualified path, conversion event, calendar, post-booking message. Each step states what SetterFi
already decided as a sentence at the top of the pane, then presents only the coach's own field.
Ordering uses Asana's up and down buttons at 44px with drag as an enhancement; the per-question
switch is a labelled toggle, never an icon. Absence is stated per step in the rail: a step with
nothing saved reads "not set yet" in the rail rather than showing an empty check. At 390px the rail
collapses to a "Step 4 of 10" line with a progress bar and a back chevron, the footer bar sticks to
the bottom, and the sentence at the top of each pane stays because it is what carries the context
the rail was giving.

---

## 3. Conversations (inbox)

**References**

- [ManyChat inbox](https://mobbin.com/screens/f28866e3-672c-4482-8560-e54366df4274) · ManyChat.
  Instagram thread with a channel chip under the contact name, grey centred system lines recording
  every handover ("Conversation was assigned to Alex", "Automations have been resumed by Alex"), a
  **Pause** control in the thread header, and Reply and Note as two tabs above one composer. This
  is the whole SetterFi inbox including the takeover, already built.
- [Pipedrive live chat](https://mobbin.com/screens/b3baff7f-b642-4817-bfe7-f66a092a7c7f) ·
  Pipedrive. Prints "You joined the conversation · 12:29 PM" as a centred line the moment the human
  takes over, and the lead-details rail sits third with its fields read-only until something exists
  to fill them. Lift the provenance line verbatim in shape.
- [Plain threads](https://mobbin.com/screens/db1a5cad-1e3d-428f-ab61-35ca043e0dbc) · Plain. Each
  message carries an explicit "AI agent" byline beside the sender name and timestamp. Attribution in
  the copy, which is the Never-Colour-Alone rule in `docs/DESIGN.md` applied to a bubble.
- [Front thread](https://mobbin.com/screens/3faeb823-3170-4f64-8c92-de9e49d71e55) · Front. The
  internal-comment composer is visually distinct from the reply composer and says "Comment will be
  visible to teammates" under it. Good precedent for the note mode's label.
- [Wolt Delivery thread](https://mobbin.com/screens/792d7590-5d24-4785-b1d7-a741aa729794) · Wolt,
  iOS. Two bubble styles, an avatar only on the incoming side, timestamps outside the bubble. The
  minimum honest phone thread.

**Avoid.** Zillow's inbox puts "Powered by EliseAI" as 10px grey text under each agent message,
which is both below the coach type floor and easy to miss. Attribution belongs at the head of the
message at reading size.

**Recommendation.** Three panes at desktop: thread list, transcript, lead details, with the details
rail toggleable per R2c. The transcript's primary control is the agent on and off toggle in the
thread header at 44px, labelled with words on both states ("Your setter is answering" / "You are
answering"), never an unlabelled switch. Every handover writes a centred system line in the
transcript in the Pipedrive shape, so the thread itself is the audit trail. Agent messages carry a
byline at body size in the Plain shape. The composer has two mode chips at 44px and keeps the note
mode's warning sentence under it. An empty view says which view is empty ("Nothing is waiting on
you") and does not draw an illustration. At 390px it becomes three routes rather than three panes:
list, then thread, then a details sheet from a button in the thread header; the agent toggle moves
into a sticky bar under the header so it never scrolls away.

---

## 4. Contacts (leads)

**References**

- [Attio mobile contacts](https://mobbin.com/screens/294bb80d-1bc4-4cf7-b0b0-396cccad7bc7) · Attio,
  iOS. Two columns only, name and a status with a coloured dot beside the word. A blank status cell
  is genuinely blank rather than a dash. The phone answer to a wide table.
- [Lightfield contacts](https://mobbin.com/screens/76496176-2e7f-4ccf-a3db-c01a422dcb59) ·
  Lightfield. Row click opens a right sheet with the record's fields stacked, unset fields shown as
  quiet "Set phone number" prompts, and an Activity list underneath. The sheet is a reader, not a
  form, which is what the coach side wants.
- [HubSpot contacts](https://mobbin.com/screens/d5ecef27-352b-42dc-b629-d961d3cf7a70) · HubSpot.
  The sheet leads with the person's name and email, then a row of large labelled action buttons,
  then the record. Good ordering: identity, then what you can do, then the detail.
- [Booking.com bookings list](https://mobbin.com/screens/1ba66376-38d6-4dea-ae2e-e58ac3a74108) ·
  Booking, iOS. Status pills sit under the title at body size in a filled pill with a word in it,
  never colour alone. Directly reusable for qualification tier and booking state.
- [Squarespace contacts](https://mobbin.com/screens/116c1238-3c3c-45e4-9034-20528b320a86) ·
  Squarespace. The detail sheet has a "Full profile" link at the top and closes with an explicit
  Close, rather than relying on a click outside.

**Avoid.** Salesforce and Dovetail both put eight or more columns on screen with a checkbox column
first. Bulk selection is a mis-click surface for this audience and the spec kills it.

**Recommendation.** The quiet-lines table treatment from `docs/DESIGN.md`: name over a mono subline
carrying the channel and relative age, the qualification tier as a worded pill, the booking state as
a second worded pill, and a whole-row chevron as the open affordance. Search plus one stage filter
above it, export at the end. Row height at the coach density, 19px by 26px padding. The record sheet
is read-only in the Lightfield shape with unset fields saying what is unset; the only controls in it
are "Report a duplicate" and "Request deletion", both routing to the support thread. At 390px the
table becomes stacked cards, name first, the two pills on a second line, and the sheet becomes a
full-screen route with a back chevron.

---

## 5. Pipelines (leads by stage)

**References**

- [Pipedrive deals board](https://mobbin.com/screens/2ff3c977-7902-48b5-8361-0c89710e5c2e) ·
  Pipedrive. Column header carries the stage name, the total and the count on two lines, and the
  cards hold three facts each. The lightest board in the results.
- [Twenty companies board](https://mobbin.com/screens/b4ca148d-0555-4928-877c-8f2ee3115856) ·
  Twenty. A coloured dot beside each stage name is the only colour on the board, so stage identity
  survives without every card being tinted.
- [Rox opportunities](https://mobbin.com/screens/f8f6c9a5-deef-4aad-8744-a559b8ed5a61) · Rox. An
  empty stage says "No opportunities" in the column body rather than sitting blank, so the reader
  can tell an empty stage from a stage that failed to load.
- [Lightfield board](https://mobbin.com/screens/582464c2-f4b2-4ad1-b267-804451ee22d4) · Lightfield.
  A Table and Board switch as a single two-way control at the top right, which is exactly the
  List / Board merge the spec asks for.

**Avoid.** Zoho and Apollo print six or more fields per card in label-value pairs. At 16px that card
is taller than the viewport, and drag becomes impossible because nothing else is visible.

**Recommendation.** Four or five stage columns at a fixed 300px, each header holding the stage name
with its dot, the count, and nothing else. Cards carry the lead's name, the qualification tier pill,
and the age of the last message. Drag is the primary gesture and it must have a keyboard and menu
equivalent: a "Move to" item in a per-card menu at 44px, because drag alone fails the audience and
the accessibility floor. An empty column prints the Rox sentence. At 390px the board becomes a
single-column accordion of stages, each stage a collapsible section with its count in the header,
and moving a card is the menu rather than the drag.

---

## 6. Billing

**References**

- [Base44 subscription](https://mobbin.com/screens/905cd729-ed46-4bd8-8645-07f96ace09eb) · Base44.
  Four stacked full-width blocks: subscription details as four labelled figures on one line, payment
  method, billing information, then billing history with a Paid pill and a download icon. No side
  columns, no plan grid. The cleanest structure in the set.
- [Kajabi subscription](https://mobbin.com/screens/1ca66fcc-bc5a-4527-b9b2-7b01a1bb6893) · Kajabi.
  "Your upcoming bill" as a large figure with "Autopay on Nov 14, 2024" beneath it in plain words,
  and one View invoice button. States the next event as a sentence rather than as a date field.
- [Bloom billing](https://mobbin.com/screens/2f3777ff-a65c-4e57-9747-dc208bf7362d) · Bloom. Current
  plan card shows credits, top-up credits, price and renewal date as four labelled figures, then a
  plain invoice table. Directly maps onto plan, allowance, price, period.
- [Teachable plan and usage](https://mobbin.com/screens/060a8022-2832-44b9-9e2e-519aec885311) ·
  Teachable. Usage counters read "1 / 5" beside each entitlement, and a breached one turns into a
  red "Limit reached" line with an Add more link. Honest usage without a percentage ring.

**Avoid.** Superhuman and Midjourney both lead with a three-plan comparison grid. The coach has one
plan; showing three is an upsell page wearing a billing page's name.

**Recommendation.** Four stacked blocks, sentence-case headings, no overlines: the plan card (plan
name, price, period, booked-call allowance as a Teachable-style pair), the attendance question, the
invoice list, and a billing notice line inside the plan card when one is outstanding. The primary
control is "Change plan" and it is the page's only accent fill; "This count looks wrong" is a
secondary button that opens a free-text box. An allowance with no usage yet prints "no calls booked
in this period" rather than 0 of 20. At 390px the four figures in the plan card stack two by two and
the invoice table becomes rows of date over amount with the status pill on the right.

---

## 7. Integrations (connection states)

**References**

- [Rox integrations](https://mobbin.com/screens/3e819b97-b78d-4adc-86ea-b100a8e6e9e7) · Rox.
  Splits the page into Current and Not connected, with a Connected pill, a Connecting pill on the
  one mid-flight, and a Connect button only on the rows that can be connected. Three states, three
  different treatments, no disabled toggles.
- [Mercury integrations](https://mobbin.com/screens/cb40503d-fd6c-437c-bbba-aaec53ce22f3) ·
  Mercury. Active integrations are a single row list with the word "Connected" and a chevron; the
  browse list underneath is plain rows. No card grid at all, which is why it reads instantly.
- [Customer.io connections](https://mobbin.com/screens/e95bd92b-7d41-4dff-aa5d-3eef55514906) ·
  Customer.io. A broken connection shows a red dot with the word "Error" and a second row shows "No
  recent data", two different failures named differently. Precedent for saying which absence it is.
- [LangChain integrations](https://mobbin.com/screens/c3ee2df7-4268-4daa-a45d-194770781ec6) ·
  LangChain. A half-working connection reads "Missing scopes" in amber rather than Connected or
  Disconnected, which is the case SetterFi has when a Meta token loses a permission.

**Avoid.** Replit's table of thirty rows each with a Sign in button, and Ditto's card wall. Both make
the reader scan a catalogue when they own four channels.

**Recommendation.** This is not a rail destination. It is the connection block inside the
Get-started panel on Home, plus one sentence on Home when something breaks. Four rows, one per
channel: the channel name, a worded state, and at most one 44px button. States are connected (a
sentence with the account name, no button), connecting (the real day counter in mono, no button, no
percentage), needs you (Connect or Reconnect as the button), and broken (the plain sentence, "We're
fixing it", no button, because it is not the coach's to fix). A missing-scope case gets its own
words in the LangChain shape rather than being flattened into disconnected. At 390px each row
stacks the state under the name and the button goes full width.

---

## 8. Get started and onboarding

**References**

- [N26 "My status"](https://mobbin.com/flows/fc7b54bc-18d1-4755-94eb-e81914511561) · N26, iOS. A
  vertical seven-step list where done steps carry a check, the current one is a filled ring with its
  label in full colour, and later ones are grey. One Continue button at the bottom resumes wherever
  you are. The best answer in the set to "resumable and persistent", and it works at 390px unchanged.
- [Mercury onboarding](https://mobbin.com/flows/5fcdc0f3-f4bd-4687-8303-a6129ce532cd) · Mercury.
  Six-step rail with a thin top progress bar, one form per step, questions asked in plain language
  with the reason attached ("Please provide details for yourself and anyone with at least a 25%
  stake"). Steps a coach can leave and return to.
- [Wave setup](https://mobbin.com/flows/f15ab950-6a55-4e71-9c1b-c1cc99f81eca) · Wave. "Step 1 of 3"
  as words, a split layout with the form left and an illustration right, and questions written as
  sentences ("What does your business do?"). Also shows a conditional follow-up question appearing
  inline under its parent rather than on a new step.
- [Melio activation](https://mobbin.com/flows/2e8d1cf7-6a63-4033-b6c2-96cc94b8d700) · Melio. The
  rail marks a step complete the moment its data is saved, and the footer keeps Cancel, Back and
  Continue in the same three places on every step.
- [Monese questionnaire](https://mobbin.com/flows/8d8c40df-0e61-4d79-8ccf-ca7a1571067c) · Monese,
  iOS. "Question 5 of 5" in the title bar, one question per screen, large tap rows with a radio at
  the right. The right shape for the texting-eligibility questions on a phone.

**Avoid.** Evernote's onboarding runs a fake "Personalizing your experience, 40%" progress ring, then
a paywall. A percentage over work that is not measurable is exactly what the SMS day counter rule
forbids.

**Recommendation.** Six steps, the N26 vertical list as the map and the Mercury rail as the working
chrome. Overview is a read-only page ending in one Start button, then business profile, connect,
texting eligibility, calendar, offer. Progress persists per step and the footer's Continue always
resumes the first incomplete one. The texting step never draws a percentage: it prints the day
counter in mono with the amber dot and a sentence saying what happens next. A step blocked on
someone else says who ("Waiting on the carrier") and stays visibly incomplete rather than passing.
At 390px the rail becomes the N26 list on its own screen, reachable from a "Step 3 of 6" title, and
each step is a full-screen route with a sticky footer button.

---

## 9. Settings, Help and Tips

**References**

- [Zillow account settings](https://mobbin.com/screens/bbb5d8a4-ed51-4c1e-941f-c7eb3b3284cc) ·
  Zillow. Three enormous rows, each a title, a sentence of what it covers, and a chevron. Roughly
  80px tall. This is the size the coach settings page should be.
- [Later account settings](https://mobbin.com/screens/7cac4773-2262-489e-993e-afc3631b1b28) ·
  Later. Every row states the current value as text with a small Edit or Change button beside it,
  so the page reads as a summary you can act on rather than a form you must fill.
- [Melio support page](https://mobbin.com/screens/7fbaecc4-6b79-4f31-ae86-9d783549cd63) · Melio.
  Three headings, three sentences, two buttons: launch a tour, start a chat. No article grid, no
  search box. The right amount of help centre for five screens.
- [Loops support](https://mobbin.com/screens/1e0ce07c-8ab4-42f3-92cc-34e7478962c3) · Loops. The
  bubble opens a real conversation with a named human and their photo in the header, above a plain
  composer. That framing is what R9 asked for, a way to ask a person.
- [Podia help bubble](https://mobbin.com/screens/753f0b38-c867-4c23-9100-abf2055c23de) · Podia.
  Opens to five large stacked choices, one of which is "Ask a Question", and states its hours in
  the panel when live chat is closed. Honest availability rather than an unanswered message.

**Avoid.** komoot and Skillshare both render a notification matrix of thirty rows with two icon
columns. That is the exact object the spec reduces to one question, and seeing it drawn confirms
why: nothing on those pages tells you what is already being sent.

**Recommendation.** Settings is one page of Zillow-sized rows, each stating its current value in the
Later shape with one Edit control. Notification preference is a single question with three large
choices, Email, Text, Both, and everything else SetterFi sends is a counted sentence above them.
Every non-editable decision is a sentence with a "Request a change" link where a change is possible
and no link where it is not, per spec section 4. Help is a bubble bottom right at 56px, always
present, opening to the Podia shape: three or four large choices with "Message us" first, the guides
second, and Tips and trainings third linking out to the videos. The bubble panel states support
hours when nobody is on. At 390px the bubble panel goes full screen and the settings rows stack
their value under the title with the Edit button full width beneath.

---

## What recurred, across all nine

Three things showed up often enough to be worth stating once rather than per screen.

1. **The best products name the state; the worst colour it.** Rox, Customer.io, LangChain and
   Booking all put a word inside the pill. Zillow's 10px AI byline and the tinted-card boards are
   the counterexamples, and both fail the coach type floor as well.
2. **A checklist that collapses beats a dashboard that congratulates.** Substack, Oyster and
   HoneyBook all shrink or remove the setup block when it is done. None of them shows a completion
   banner, which matches the no-completion-theatre rule the product already has.
3. **Every good linear builder is a sentence with fields in it.** ManyChat's DM automation and
   Wave's onboarding read as prose. Every node canvas found was harder to read than the thing it
   described, and three of them were for exactly SetterFi's use case.
