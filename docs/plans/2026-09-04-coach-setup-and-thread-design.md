# Coach setup from first principles, and a thread you can read for an hour

**Written:** 2026-09-04, afternoon. Follows `docs/plans/2026-09-04-coach-rehaul-notes.md` (the
coach rebuild), `docs/plans/2026-09-04-connect-flow-research.md` (the connect sheet) and
`docs/plans/2026-09-04-coach-mobbin-research.md`. The owner-side reasoning this inherits is in
`docs/COACH-REDESIGN-PLAYBOOK.md` and `docs/plans/2026-09-03-ui-rehaul-notes.md`.

The published canvas for the coach round is the "SetterFi Coach Console" artifact
(`https://claude.ai/code/artifact/6f11eb2f-0630-41e8-a095-cf0929e9c941`, the newer of the two
publishes that day); its source is `design/coach/setterfi-coach-console-v2.html`, built from the
`design/coach/*.dc.html` artboards and `design/coach/canvas.json`.

Three screenshots of the seeded demo coach started this round: the Inbox thread, the Setup page,
and the first-run Home. The brief was to tear the onboarding flow down and start again from what
a coach actually needs, and to make the thread comfortable for long reading even where that means
leaving the app's own palette.

---

## Part 1. Setup

### What the screenshots show

The same coach, the same afternoon, is told three different stories about the same setup.

| surface | what it lists | what it says |
|---|---|---|
| `/coach/home`, first run | 3 rows: Instagram and Messenger, Texting registration, Opt-in pages | "0 of 3 done", "1 step is waiting on you", a **Blocked** pill and a **Fix this step** button |
| `/coach/get-started` | 4 steps: Business details, Carrier review, Safe test, Go live; then 4 channels | "Nothing is waiting on you. Everything here is with us or the carriers." |
| `/onboarding` | 6 rungs: Business profile, Connect, Texting eligibility, Calendar, Your offer, Go live | "Five steps are still yours to finish" |

Each list is internally honest, and the notes record why each read what it reads. Together they
are a contradiction a coach cannot resolve: Home sends them to fix a blocked step, and the page it
sends them to says nothing is waiting and offers nothing to press. The same fact has three names
(Texting registration, Carrier review, Texting eligibility). Two lists count things the coach
cannot do; one counts things they can. None of them says which is which.

The Home rail's "Blocked" row is the sharpest defect. `provisioning_steps.blocked` is the worker
refusing a step, which is SetterFi's problem, and the row dresses it as a chore with a repair
button that leads nowhere.

### The question a coach is asking

A coach three days after signup, who is not confident with software, has exactly three
questions: what do I have to do, what are you doing, and when will I be live. Every design
decision below is one of those answered once.

### The four rules

**One list.** Every surface that talks about setup draws rows from one derivation,
`coachSetupRows`, off one read, `loadCoachSetup`. Home draws the same rows compact; Setup draws
them in full; the six task screens under `/onboarding/*` are where a row's button goes, and the
`/onboarding` root, which was a third copy of the list, redirects to Setup.

**Every row has an owner, and the owner decides what the row can carry.** A row that is the
coach's carries at most one button. A row that is SetterFi's or the carriers' carries a date, a
day count or a sentence, and nothing to press. A blocked provisioning step is SetterFi's, so it
reads "We stopped here on Tuesday and someone from SetterFi will contact you", with no button.
This is the Etsy and Mercury pattern from the research: an unavailable row keeps its place and
swaps its button for prose.

**One row is open.** The first row that is the coach's to do is expanded: its explanation, its
one button, and where the button goes. Every other row is a single line. This is the Klaviyo,
Graphite and Outseta shape, and it is what turns a checklist into an instruction. The page spends
its one accent fill on that row's button, and on nothing when no row is the coach's.

**The wait is a timeline, not a pill.** Carrier review, the safe test and go-live are drawn as
the Mercury and Gusto vertical timeline: filed on a date, in review on day N of about 21, the
safe test after that, live after that. A timeline says the order and the elapsed time in one
drawing; the old page said it across four pills and a sentence.

### The rows

In journey order, each with its read and its owner. A row reads the same table its own task
screen reads, which is the rule the onboarding lane established and the reason the lists could
not agree before.

| row | owner | read | open state carries |
|---|---|---|---|
| Business details | coach | `provisioning_steps.business_profile.completed_at` | "Add your business details" to `/onboarding/business-profile` |
| Instagram and Messenger | coach | `channel_connections` for both, `live` only | the connect sheet; a reconnect when expired; prose while Meta has not approved the app |
| Your calendar | coach | primary `calendar_connections` in `ready` | "Connect your calendar" to `/onboarding/calendar`; a reconnect on `error`, `expired`, `disconnected` |
| Your offer | coach | the published offer row | "Tell us about your offer" to `/onboarding/offer` |
| Carrier review | carriers | the A2P registration through `carrierReviewFrom` | the timeline: sent date, day N of about 21 |
| Safe test | SetterFi | `provisioning_steps.test_pass.completed_at` | "after the carriers finish" |
| Go live | coach, last | `provisioning_steps.go_live.completed_at` | "Go live" to `/onboarding/go-live`, only once every row above is done |

The offer read is new to `loadCoachSetup`; the onboarding root already made it and it moves
across. The technical record read is now optional on the read, because Home does not draw it and
it was a fifth round trip in series.

### The sentence

Both surfaces print one status sentence from the same rows: how many rows are the coach's, in
words, and where the carriers are. "One thing is yours to do. Text messages are on day 14 of
about 21." When nothing is the coach's: "Nothing is waiting on you. Text messages are on day 14
of about 21." Home's separate "N steps are waiting on you", counted off blocked provisioning rows,
is gone: those rows are SetterFi's and the sentence no longer counts them as the coach's.

### What is kept from the shipped page

The technical record stays as one shut `<details>` under the list. Instagram, Messenger, texting
and the calendar keep their connected, expired and outage treatments and their copy. The one-fill
rule, the coach type floor, the 44px targets and the 390 layout all hold. The channel panel as a
separate list is gone: a channel is a row in the journey, and drawing it twice was the repeated
fact the playbook forbids.

### Home

The first-run Home renders the same rows compact: the open row in full with its button, every
other row as one line with its state, the timeline collapsed to its current entry, and a link to
Setup. The "See the rest of your setup" footnote and the three-row rail are gone, because the rail
now is the whole setup. The demo override still swaps the read for a finished one, and because
Home and Setup draw the same rows, the override now presents the same finished list Setup would.

---

## Part 2. The thread

### What the screenshot shows

Dark theme, a seeded thread: the lead's bubbles on near-black navy over black navy, the agent's on
a slightly bluer navy, 17px text, sender and time in the same 14px grey under every bubble, every
stamp carrying its full date. It is legible line by line and tiring over a page, and the coach who
reads it said so.

The palette block for the thread (`--thread-*` in `coach.css`) was written this morning and is
not yet in the screenshot the coach saw. It moves the fills apart. This round goes further,
because the ask is comfort over an hour, not separation at a glance.

### The rules

**The bubble is a reading surface, so it gets reading type.** 18px on 1.6, not 17 on 1.5. The
measure is capped at 60 characters as well as at 62 percent of the pane, because a wide screen was
giving a bubble 90-character lines, and long lines are what makes long reading tiring. Bubble
padding grows to 18 by 16 so the text has air.

**The day is said once, above the messages.** A centred day line, "Tuesday 26 August", opens each
day's run; the stamp under a bubble then carries only the time, "Yolanda, 2:35 pm". Today's line
reads "Today", yesterday's "Yesterday". A thread of forty messages was printing "Aug 26" forty
times.

**Speakers are told apart by lightness as well as hue, in both themes.** In dark the lead's
bubble lifts to a mid grey-blue with white ink, and the agent's stays the solid muted accent with
white ink; the difference is now a lightness step a tired eye reads without hue. In light the
lead's stays white with a hairline and the agent's a pale accent with dark accent ink. The
transcript ground in dark lifts slightly off the pane so the bubbles read as raised rather than as
holes.

**The stamp is quieter than the message and never competes with it.** 14px, one weight, the
speaker first and the time after, in a colour measured above 4.5:1 on its bubble but visibly
lighter than the ink. The name is what a scanning eye needs; the time is what a checking eye
needs; neither is what a reading eye needs.

**Turn spacing says who is talking.** 12px inside a speaker's run, 24px where the speaker
changes, up from 20, so a run of three agent questions reads as one turn.

Everything else about the thread is unchanged: the band and its one control, the handover lines,
the notes, the composer, the rail of facts.

---

## Part 3. Measured, and what is still open

Recorded in `docs/plans/2026-09-04-coach-rehaul-notes.md` under "Setup, second pass" and "Inbox,
second pass" once the round lands, with the screenshots in the round's scratchpad.

Open after this round:

- The canvas artboards `Setup.dc.html`, `HomeFirstRun.dc.html` and `Inbox.dc.html` draw the
  previous anatomy and should be redrawn from the shipped screens once the coach has reacted.
- The offer row reads the published offer; a saved draft reads as not done, which is right, but
  the row cannot yet say "you have a draft" because the read does not carry it.
- The A2P projection still carries no approval date, so a finished carrier review has no date on
  its timeline entry.
