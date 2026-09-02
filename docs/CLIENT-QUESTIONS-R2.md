# Round 2 — questions only you can answer

**For:** Alec Delpuech, Live Legacy Strong
**From:** Ayman, Hexona Systems
**Date:** 2026-08-15, extended 2026-08-16 with §3, §4, §6, §8 and §9

---

## What this is

We spent this week going through SetterFi decision by decision — every place the build had a fork in
it, what happens on each side, and which way we are going. Most of them we settled ourselves; those
are recorded and you do not need to read them. This document is the leftover: **the questions where
the right answer depends on how your business actually runs, and guessing would mean building
something you then have to ask us to change.**

**Almost none of this is a blank box.** Where we could write a draft, we wrote one and you cross out
what is wrong. Where there were three sensible answers, they are checkboxes. Crossing things out is
faster than facing an empty field, and disagreeing with our draft tells us more than a blank would.
The two genuine blanks both say why they are blank.

**Nothing here blocks the build.** Every question ends with **"If we don't hear back"** — what ships
in the meantime. Every one of those defaults is deliberately the cautious option, which usually
means the agent says less rather than more. So silence is safe, and it is also a choice: the default
becomes the answer.

**If you only have twenty minutes**, do §4 question 1 (how the cash-campaign leads opted in — it
gates outbound texting and every coach's carrier filing), §5 question 1 (what a coach controls — a
table you strike through), §2 question 1 (what the agent may say about numbers), and §11 question 2
(what happens when a safety test fails). Those four decide the most.

`docs/BRAIN-CONTENT-ASK.md` is separate and still stands — it is the content ask, it is longer, and
it has the most leverage of anything we have sent. This document does not replace it.

---

## Contents

- **§1 — When a coach writes something risky** — 2 questions
- **§2 — What the agent can never say** — 3 questions
- **§3 — When the agent stops, and who picks it up** — 4 questions
- **§4 — Consent, STOP, and deleting a lead** — 7 questions
- **§5 — What your coaches can change about their own agent** — 5 questions
- **§6 — Signup to working agent** — 6 questions
- **§7 — The channels your agent runs on** — 4 questions
- **§8 — Follow-up cadence and when a conversation ends** — 4 questions
- **§9 — The booking moment and what counts as a booked call** — 5 questions
- **§10 — What the agent knows** — 3 questions
- **§11 — How we prove the agent behaves** — 3 questions
- **§12 — The numbers on your dashboard** — 5 questions
- **§13 — Pricing, plans, and billing disputes** — 6 questions
- **§14 — Affiliates and commission** — 5 questions
- **§15 — Who on your team can do what** — 5 questions
- **§16 — Alerts, exports, and what your team gets at handover** — 5 questions

---

## §1 — When a coach writes something risky

### 1. When a coach's offer text trips the review flag, who reads it and how fast?

**Why it matters.** Coaches write their own program name, proof points, and sample lines, and that
text goes into the prompt their agent runs on. We scan it when they save. The scan is not a
blocker — it is deliberately loose, because a strict one would reject honest copy and still miss
the real problem — so what it produces is a **queue for a human**: "this coach just saved
'guaranteed approval', someone look."

**What breaks without it.** A queue with nobody on it is worse than no queue. If flagged text sits
unread, either we hold the coach's agent back and they are blocked with no explanation, or we let
it through and the flag was theatre. Both are worse than not scanning.

**What we need from you:**

- **Who reads the queue?** ☐ Your success team, whoever owns that coach ☐ One named person
  ☐ Us, and we escalate to you only when it looks real
- **How fast, on your side?** ☐ Same business day ☐ 24 hours ☐ 48 hours ☐ Best effort
- **Roughly how many coaches onboard in month one?** ☐ Under 10 ☐ 10–30 ☐ 30–100 ☐ More than 100
  *(A rough band is all we need. This decides whether the queue is two items a week or forty a day,
  which changes what we build — a line item on the client detail page versus a real review screen.
  Under 10 and we build the cheap version, which is the right call at that size.)*

**If we don't hear back:** we build the queue on the admin Platform Clients detail screen with no
SLA attached, assigned to the success person who already owns that coach's book, and **we do not
hold the offer back** — flagged text goes live and the flag is a notification. Holding a paying
coach's agent behind an unstaffed queue is the worse failure, so the safe default has to be the
one that keeps them running. If you tell us there is a human on it, we flip it to hold-until-
reviewed, which is the stronger control.

---

### 2. Does the coach see that their text was flagged?

**Why it matters.** This is your relationship, not our system behavior. A coach saves a sentence,
something in it trips a compliance flag, and there are three honest ways to handle it — tell them
immediately in the editor, tell them nothing and have their success person raise it on the next
call, or hold the save and explain why. Each says something different about how much you are
willing to let a coach see the guardrails.

**What breaks without it.** The failure we want to avoid is the silent one: a coach's text is
flagged, their agent quietly behaves differently or their offer sits unpublished, and nobody tells
them. That is the exact thing our honest-states rule exists to prevent, and it is the version most
likely to happen by default if nobody decides.

**Which is it?**

☐ **Tell them in the editor**, plainly: "we can't have the agent promise guaranteed results —
  here's how to say this instead." Most transparent, and it teaches; also tells a coach exactly
  which words trip the filter, which a determined one could work around.
☐ **Tell them nothing**; their success person raises it. Keeps the guardrail invisible; risks the
  coach discovering it from their agent's behavior instead of from you.
☐ **Hold the save and explain.** Strongest control, most friction, and it means a coach can be
  blocked on a Friday evening by a queue that is staffed on Monday.

**If we don't hear back:** we take the first option — a plain, non-accusatory note in the editor
naming the phrase, and the offer saves anyway. It is the one that keeps the coach informed without
blocking them, and it is the only one of the three consistent with the honest-states rule we hold
everywhere else in the product. Note that this pairs with Q1: if you staff the queue and we switch
to hold-until-reviewed, this message has to change too, and we would come back to you before
changing it.

---

## §2 — What the agent can never say

### 1. The gray zone needs a source, not a qualifier

**Why it matters.** Your §2.2 answer options are Fine / Never / Only with a qualifier, and two of
those five rows are about **numbers**:

> Naming a typical funding range clients have received
> Saying a specific credit score is "usually enough"

Here is what we learned building the checker. Every number the agent says gets checked against a
list of numbers you or the coach actually put in the system, and anything not on that list is
blocked before it sends — that is the whole mechanism that stops the agent inventing figures. A
qualifier does not change whether a number is on the list. "Clients *typically* see around $75K"
is exactly as ungrounded as "you'll get $75K" if nobody ever told us $75K.

**What breaks without it.** If you answer "only with a qualifier," we cannot implement it — the
agent will simply be unable to say the sentence, and it will deflect to the call instead. That may
be fine. But it is a different outcome from what you thought you were choosing, and you should
choose it deliberately.

**Worth knowing before you answer:** your own FAQ sheet already names ranges in several answers —
"$50k-$150k of funding", "most of the time the max amount will be around $150k", "in some cases
$500k+". So the agent will be asked this, your team already answers it, and the only open question
is where the number comes from once a hundred different coaches are using it.

**So, for each of the two numeric rows:**

**Typical funding range —** pick one:

☐ The agent never names a range — always defers to the call
☐ **Each coach's own range**, from their settings — a coach who fills in nothing names no range
☐ **One platform range you give us**, the same for every coach, and coaches cannot change it
☐ Each coach's own range, but only after you have approved it

**"A 640 is usually enough" —** ☐ The agent never says this ☐ It may state the coach's own
minimum score as a requirement ("Marcus works with 640 and up") but never as a prediction ("640 is
usually enough to get approved")

The other three rows in §2.2 — how long the process takes, referring to a past client's result,
"specializes in" — are not numeric and the Fine / Never / Qualifier answers work as written.

**If we don't hear back:** the agent names no funding range at all, and states the coach's minimum
score only as a requirement, never as a prediction. Both are the safe reading, and both make the
agent quieter than it needs to be — which is the failure we would rather have.

---

### 2. What does the agent actually say when it refuses?

**Why it matters.** When the agent is about to say something blocked, it does not edit the
sentence — it stops and says something else. That replacement is a real sentence a real lead
reads, and it is one of the most brand-visible things the agent ever produces, because it is the
moment a prospect pushes and the agent holds. Our draft is generic by construction.

**What breaks without it.** You get our words in your coaches' funnels at the highest-tension
moment in the conversation. Nothing is unsafe about them. They just are not yours.

**Redline these — one per situation:**

> **A lead asks for a number we can't stand behind:**
> "I don't want to throw a number at you that I can't stand behind. That's exactly what the call
> is for — Marcus will go through your actual file and tell you straight."
>
> **A lead asks for a guarantee:**
> "I won't promise you an approval — nobody honest will. What I can tell you is what's worked for
> people in your situation, and the call is where you get a real answer."
>
> **A lead asks about something we don't touch (legal, tax, disputing items):**
> "That's outside what I can help with, and I'd rather send you to someone who does it properly
> than guess."
>
> **A lead asks the agent to do something unrelated to credit and funding:**
> "Credit and funding is the whole job for me. Where's your score sitting right now?"

**If we don't hear back:** these ship as written and your success team can edit them in the
Compliance tab at any time without us — they are content, not code, exactly so you can change your
mind on a Tuesday.

---

### 3. Where is the line on "you qualify"?

**Why it matters.** Your blocked list has *"you qualify" (before a human has confirmed) — only the
coach qualifies anyone on the call*. We agree with the rule and we cannot implement it as
written, because booking qualified leads is the agent's entire job. Somewhere between "I've got
you on Marcus's calendar Thursday" and "you qualify" is a line, and the checker needs to know
where it is.

**What breaks without it.** Draw it too tight and the agent books people while sounding
unconvinced, which costs you conversions at the exact moment they are won. Draw it too loose and
the agent tells a lead they qualify for funding they may not get, which is the claim your list
exists to prevent.

**Which of these may the agent say?**

| | Say it | Never |
|---|:---:|:---:|
| "Based on what you've told me, it makes sense to get you on a call with Marcus." | ☐ | ☐ |
| "You're a good fit for what Marcus does." | ☐ | ☐ |
| "You meet the requirements to book a call." | ☐ | ☐ |
| "You're pre-qualified." | ☐ | ☐ |
| "You qualify for the program." | ☐ | ☐ |

**If we don't hear back:** the agent speaks only about **the call**, never about the funding — "it
makes sense to talk", "let's get you on Marcus's calendar" — and never uses the words qualify,
pre-qualified, approved, or eligible in any form. That keeps every promise the agent makes one it
can personally keep, which is the version we would argue for anyway.

---

## §3 — When the agent stops, and who picks it up

Four questions. Everything else about when the agent stops was decided on our side. These four are here because each one is a policy about your customers and their customers, and a wrong default costs you a relationship rather than a rebuild.

### 1. The four moments the agent stops and gets a person

**Why it matters.** The agent hands off in exactly four situations. In each one, the last thing the
lead reads is a line we wrote, and then nothing happens until somebody on your side opens the
thread. These lines set the lead's expectation about how long that takes, so they are the difference
between a lead who waits and a lead who goes somewhere else.

**What breaks without it.** We ship our drafts. They are written to be safe and slightly formal,
which is the wrong register for a brand whose whole pitch is a straight-talking human. The agent
will sound like it changed personality at the worst moment in the conversation.

> *Starter drafts. Rewrite anything that does not sound like you — and strike the whole row if you
> think the agent should stay quiet instead.*

| When | What the agent says |
|---|---|
| The lead asks for a person | "Absolutely — I've flagged this for the team and someone will pick it up here shortly." |
| The agent has missed twice in a row on questions the brain does not cover | "That one's outside what I can answer properly. Let me get someone who can — they'll come back to you right here." |
| A lead pushes a second time on something the agent has to refuse (CPNs, guaranteed outcomes) | "I'm not the right one for that. I'm passing this to the team so a person can talk it through with you." |
| The agent's own draft failed our compliance checks twice | "Let me get someone on the team to answer that properly — hang tight and they'll come back to you here." |

**Change the wording, or strike the row:** ______________________

**One thing we are deliberately not doing:** the agent never says "I'm an AI, transferring you to a
human." It says a person is coming. If you want it more explicit than that, say so.

**If we don't hear back:** the four lines above ship as written.

---

### 2. Who picks it up, and how fast

**Why it matters.** When the agent stops, we send an alert. Right now the alert goes to the coach
and nobody else, and if the coach does not open it, nothing else happens — ever. We do not
auto-resume the agent on a timer, on purpose: a system that decides on its own that a compliance
escalation has expired is a system you will eventually have to explain. So the safety net is a
second and third alert, and the question is who gets them and when.

**What breaks without it.** A lead sits in silence for three days because a coach was on holiday,
and the first anyone hears about it is the coach asking why the agent stopped working.

> *Strike, change the hours, or change who gets it.*

| Situation | First alert | Still nobody has picked it up after… | Then who |
|---|---|---|---|
| Ordinary handoff (asked for a person, brain missed twice) | The coach | 4 business hours | The coach again |
| Same, still unclaimed | — | 24 hours | The coach's assigned success person on your team |
| Compliance trigger (CPN pushed twice, guarantee demanded twice) | The coach **and** your admin team, immediately | 4 business hours | Your admin team again |

**Two specific things to confirm or strike:**

- **Do the 4-hour and 24-hour timers run on business hours or wall-clock hours?** Business hours is
  our default — a 2am escalation should not page your success team at 6am.
- **Should a compliance trigger reach your team even when the coach handles it promptly?** Our
  default is yes, because a compliance event on a coach's tenant is your exposure before it is
  theirs.

**If we don't hear back:** 4 business hours, then 24 hours to the assigned success person, and
compliance triggers always copy your admin team.

---

### 3. The seven pipeline stages

**Why it matters.** These seven are already on the screens you have seen, and the win-rate number on
the coach dashboard is computed from them — a lead in "Booked" counts as won, one in "Qualified No
Buy" or "Disqualified" counts as lost, and the rest are still open. If a stage does not match how
your coaches actually work, the Kanban becomes a column nobody drags into and the win rate is
computed over a population that means nothing.

**What breaks without it.** Nothing, immediately — we ship the seven. The cost lands later, when a
coach tells you the board does not match their process and moving a stage means a migration.

> *Strike any stage you would not use. Rename anything that has a different name in your world.*

| Stage | Who moves the card | Counts as |
|---|---|---|
| New Lead | The system, on first contact | open |
| Qualification Active | The system, on the first answer captured | open |
| Booked (won) | The system, when a call lands on the calendar | **won** |
| Qualified No Buy | The coach, by hand | **lost** |
| Long-Term Follow-Up | The coach, by hand | open |
| No Show | Either — dragging the card marks the call a no-show, and marking a no-show moves the card | open |
| Disqualified / Bad Fit (lost) | The system, on a hard disqualification | **lost** |

**The two we are least sure about are Qualified No Buy and Long-Term Follow-Up**, because those are
judgements about a lead rather than anything the agent can observe, and coaches vary a lot in
whether they distinguish them. If they are one thing in your world, say so and we ship six stages.

**One thing worth a second look:** we treat **No Show as still open** — the call was booked and did
not happen, so counting it as a win overstates the agent and counting it as a loss blames the agent
for a lead's Tuesday. If you would rather it counted as won, since the agent's job ended at the
booking, that is a one-line change and we would rather make it now.

**If we don't hear back:** all seven ship as above, with No Show open.

---

### 4. Legal threats and leads in genuine distress

**Why it matters.** An agent talking to strangers on Instagram at volume will eventually receive two
kinds of message that have nothing to do with credit. One is a lead saying something like "I'm
speaking to my attorney about this." The other is a message about somebody's life falling apart —
this industry's leads are, by definition, people under financial stress.

In both cases the agent stops immediately rather than after a second attempt, and we need to know
where it points.

**What breaks without it.** The default behaviour with no policy is that the agent carries on
qualifying, and "the agent asked them about their credit score" is a sentence you do not want in
either story.

> *Strike or rewrite.*

**Legal threat or complaint framing.** The agent stops and says:

> "I want to make sure this gets handled properly rather than by me. I'm passing this to the team
> now and someone will be in touch."

The escalation goes to **your admin team as well as the coach** — our default, because a complaint
about one coach is your platform's problem too. ☐ Coach only instead

**A lead in distress.** The agent stops and says:

> "It sounds like there's a lot going on right now, and I'm not the right one to help with that.
> I'm going to get a person from the team to reach out."

☐ Use this ☐ Different wording: ______________________ ☐ Say nothing and just hand off silently

**Do you want the agent to name any outside resource** (a crisis line, a debt-counselling service)?
Our default is **no** — pointing someone at a hotline they did not ask for is a judgement we are not
qualified to make on your behalf, and getting it wrong is worse than staying quiet. If your team has
a view here, it is yours to set.

**If we don't hear back:** both lines above ship, both escalate to the coach and your admin team,
and the agent names no outside resource.

---

## §4 — Consent, STOP, and deleting a lead

**Read this one first if you read nothing else.** Question 1 is the single most load-bearing unanswered input in the project. It is the factual basis for how we gate outbound texting, and the same answer is required word-for-word to file each coach's A2P campaign — which carries a roughly three-week carrier clock per coach that nobody controls. It was asked at intake and the recorded answer is "Discussed on call," so it is not on paper anywhere.

### 1. The cash campaigns — the mechanics, on paper this time

**Why it matters.** Two separate things run on this answer, and both are blocked without it.

The first is **legal**. US texting law does not care whether someone is a good lead; it cares
whether that specific phone number was given to *you* for *this purpose*. Getting it wrong is
per-message and statutory — the numbers are $500 per text, trebled to $1,500 if a court finds it
willful — so a single bad list is not a small mistake. We are building the gate that stops a
message going out to someone who never opted in. To build it we have to know what your existing
opt-in actually looks like, because the gate has to recognise it.

The second is **operational**. Every coach's phone number needs an A2P 10DLC campaign registered
with the carriers before a single text can leave it. That filing requires a written description of
exactly how people opt in, plus sample messages that match what the agent really sends. The
carriers reject filings that are vague about opt-in — it is the single most common rejection
reason. Each rejection-and-refile cycle costs weeks against a clock we do not control.

**What breaks without it.** We ship a conservative default: nobody gets a text unless they texted
us first or filled in our own opt-in form. Your existing list, however good it is, is unusable
through SetterFi until someone attests to how it was collected. And we file A2P campaigns with our
own drafted opt-in language, which may not match what you actually do — and a mismatch between the
filed language and the real flow is itself a rejection reason.

#### 1.1 Walk us through one campaign

> *Answer these however is quickest — a voice note is genuinely fine, we will transcribe it.*

**What do you send?** ______________________________________________

**Who do you send it to?** ______________________________________________

**What do you send it from?** *(strike the ones that are wrong)*

~~GoHighLevel~~ · ~~A different SMS tool — which: __________~~ · ~~Instagram/Facebook DM, not SMS~~ ·
~~Email, not SMS~~ · ~~A mix — the split is: __________~~

**Roughly how many people, and how often?** __________ people, about every __________

#### 1.2 How did those people opt in to being texted? *(the important one)*

> *Strike everything that is not how it happens. Leave what is.*

| How the number was collected | Yours? |
|---|---|
| They filled in a form on a website of ours, with a tickbox saying they agree to be texted | ~~strike if no~~ |
| They filled in a form on a website of ours, with **no** tickbox about texting | ~~strike if no~~ |
| They commented or DM'd on a post and we asked for their number in the conversation | ~~strike if no~~ |
| They gave a number at a live event, a webinar, or on a call | ~~strike if no~~ |
| They came from a lead vendor or a purchased/shared list | ~~strike if no~~ |
| They are past clients from before any of this was set up | ~~strike if no~~ |
| Some other way: ______________________________________________ | |

**If there is a tickbox or a consent line anywhere, paste the exact wording:**

> ______________________________________________________________

**Do you still have a record of when each person opted in and what they were shown?**
☐ Yes, per person   ☐ Only roughly   ☐ No

#### 1.3 The two sample messages the carriers need

> *These go into the A2P filing verbatim. They have to look like what the agent really sends. Here
> is our draft — edit it. Do not make it more impressive; make it more boring and more accurate.*

**Sample 1 — the first message to someone who just came in:**

> "Hey {{first_name}}, it's Sarah with {{business_name}} — saw you were looking at funding options.
> Mind if I ask a couple quick questions to see if we can help? Reply STOP to opt out."

**Sample 2 — a follow-up:**

> "Hey {{first_name}}, just circling back on that funding question. Still want me to find you a
> time with {{coach_name}}? Reply STOP to opt out."

**Your edits:** ______________________________________________

**If we don't hear back:** we ship the gate on the conservative setting — inbound-only. A lead who
texts you first gets a full conversation; a lead who DM'd on Instagram gets a full conversation on
Instagram and no text; and any list you or a coach imports is marked "not verified" and the agent
will not text it. We file A2P campaigns with our own drafted opt-in language and the two sample
messages above as written. That is safe and it under-uses whatever you already have.

---

### 2. Has the SMS side ever been rejected or complained about?

**Why it matters.** Carriers permanently refuse A2P campaigns for credit repair, direct loan
marketing, and debt reduction, and those rejections are documented as **not eligible for
resubmission** — a rejected campaign is finished, not fixable, and there is no toll-free fallback
on the same grounds. Coaching and education are not on that list, so a coaching business booking
consultations has a defensible registration. But the reviewer reads the coach's own website and
sample messages, and this industry routinely advertises the exact vocabulary that triggers the
refusal. If some of your coaches will never get SMS, we need the product to say so honestly on a
tracker rather than leaving them on an amber "registering" state forever.

**What breaks without it.** We design as though every coach eventually gets SMS. The provisioning
tracker gets a permanently-blocked state either way, but nobody screens a coach's website before we
file, so the first person to find out is the coach whose campaign is dead.

**Strike what does not apply:**

~~We have had an A2P or 10DLC campaign rejected before~~ ·
~~We have had a number blocked or a carrier filter us~~ ·
~~We have had a TCPA demand letter or claim~~ ·
~~We have had an FTC, CFPB, or state AG contact~~ ·
~~We have had a credit-repair-claim complaint from a client~~ ·
~~None of the above~~

**Do you have counsel who looks at this?** ☐ Yes — ____________ ☐ No ☐ Only when something happens

**If we don't hear back:** we assume no prior incidents, build the permanently-blocked state, and
add a warning step in coach onboarding that reads the coach's own site for the trigger vocabulary
before we file. That step is worth building regardless.

---

### 3. If a lead says stop to one coach, does that stop every coach?

**Why it matters.** Your coaches each get their own phone number and their own carrier
registration, so legally each one is a separate sender and a "stop" to coach A says nothing about
coach B. That is how we have built it. But it is your platform's posture across your customers, and
there is a real argument the other way: if two of your coaches buy leads from the same source, the
same person could tell one to stop and get texted by the other next week, and to that person it is
one company.

**What breaks without it.** Nothing — the default works. But if you would rather it were
platform-wide, that is a one-line change now and a data migration later.

**Strike one:**

~~**Per coach** — a stop to coach A stops coach A only. *(our default)*~~

~~**Platform-wide** — a stop to any coach stops every coach.~~

**Either way, we keep a platform-wide list that only your admin team can add to**, for
complaints, anyone who involves a lawyer, and known bad numbers.

**If we don't hear back:** per coach, with the admin-only platform-wide list alongside it.

---

### 4. The quiet-hours window

**Why it matters.** Federal law bans marketing calls and texts before 8am and after 9pm in the
**lead's** local time, not yours. Several states cut it at 8pm, and 2024–25 saw a large wave of
lawsuits over exactly this. We have set the platform to **8am–8pm, seven days**, everywhere, which
is inside every state rule we could find and costs you one hour in the evening.

**What breaks without it.** Nothing. This is a confirmation, not a blocker.

**Strike one:**

~~**8am–8pm** everywhere. *(our default — safest, costs an evening hour)*~~

~~**8am–9pm**, the federal line, with a shorter window only for leads we can place in a stricter state.~~

**Can a coach change it?** No, and we would push back hard on making it possible. Your admin team
can make a specific coach's window *narrower* (say 9am–6pm) and nobody can make it wider. A coach
who could widen their own window is a coach who can create liability for your platform from a
settings page.

**If we don't hear back:** 8am–8pm, admin-adjustable narrower only, invisible to coaches except as
a read-only note explaining why a follow-up went out this morning instead of last night.

---

### 5. What "delete this lead" should actually do

**Why it matters.** Two things collide. Privacy requests say delete everything. Texting law says
that once someone has told you to stop, you must keep a record of that for **five years** — and if
you delete the record along with everything else, you will text them again and that is the
violation. So a deletion always leaves one thing behind: a suppression record with no name, no
conversation, and no details, just enough to keep the door shut.

The second half is smaller. When one of your leads' messages has been promoted into our test
library — which happens when a conversation turns out to be a good test case, and the message is
stripped of names, numbers, and emails when it is copied — should a deletion request destroy that
test too?

**What breaks without it.** The screen currently promises a **7-day undo** on a deletion. We are
removing that, because it means the data still exists for a week after we told someone it was
deleted. Instead you see exactly what will be destroyed, type a reason, and it happens immediately.
If you would rather have the undo, we build it and the screen has to tell the lead their deletion
completes in seven days.

**Strike one on each:**

**The undo:** ~~Delete immediately, with a preview and a typed reason first. *(our default)*~~ ·
~~Keep a 7-day undo and tell the lead it takes 7 days.~~

**The test library:** ~~Keep the test case, cut every link back to the person, re-run the stripping.
*(our default)*~~ · ~~Delete the test case too.~~

**One thing we cannot do, and the screen will say so.** We can delete a lead from GoHighLevel. We
**cannot** remove the conversation from a coach's Instagram or Messenger inbox — Meta provides no
way to do that, and the thread stays in the coach's own app. Better that the screen admits it than
that we claim a clean sweep.

**If we don't hear back:** immediate delete with a preview and a typed reason, the suppression
tombstone kept, the test case kept with its links severed, and the Instagram limitation stated on
screen.

---

### 6. Two messages every lead will eventually see — redline them

**Why it matters.** These are the only two messages the AI does not write. They are fixed text,
because an opt-out confirmation that a model improvises is a compliance failure with a random seed.
They are also the last thing a lead ever hears from a coach, so the wording is brand.

**The opt-out confirmation** — sent once, immediately, and never again:

> "You're unsubscribed from {{business_name}} and won't get any more messages. Reply START if you
> change your mind."

**The HELP reply** — required by the carriers, sent whenever someone texts HELP:

> "{{business_name}} — we text about booking your funding consultation. Msg & data rates may apply.
> Reply STOP to unsubscribe. Questions: {{support_email}}"

**Your edits:** ______________________________________________

Neither may contain an offer, a link, or a booking prompt — that is a rule, not a preference.

**If we don't hear back:** both ship as written above.

---

### 7. Do your coaches text leads from GoHighLevel directly?

**Why it matters.** This is a small question with a large consequence. If a coach builds a broadcast
inside GoHighLevel and sends it themselves, it does not go through SetterFi, so our opt-out list
never sees it — a lead who told the AI to stop can still receive that blast. The only fix is that we
push every opt-out into GoHighLevel's own suppression as well as holding it ourselves. We have
planned to build that, but it sits on the "cut if the schedule slips" list, and your answer decides
whether it can be cut.

**Strike one:**

~~Coaches send their own texts from GoHighLevel regularly.~~ ·
~~Occasionally, for one-off announcements.~~ ·
~~No — everything goes through the agent.~~

**If we don't hear back:** we assume they do, and provider-side suppression comes off the cut list
and ships. It is the correct assumption to make wrongly.

---

## §5 — What your coaches can change about their own agent

### 1. The list itself — the intake question that never got answered

**Why it matters.** Your intake asked it directly: *"Beyond price point, loan types, and
disqualifiers, what else should each client be able to set themselves?"* The answer field is blank
— not "discussed on call," just never filled in. Every setting we have given a coach since then is
our guess, and it is the guess that decides how much of your agent stays yours.

**What breaks without it.** Two opposite failures, both expensive. Give coaches too little and
every one of them opens a support ticket asking you to change a sentence for them. Give them too
much and a coach writes something in their own words that your agent then says in your brand, on
your infrastructure — which is your liability, not theirs.

**Here is what we have built them. Cross out anything a coach should not touch, and add anything
missing.**

| A coach can set | | A coach cannot set (platform-owned) |
|---|---|---|
| Program name | | The qualification decision table — they set the inputs, you own the outcomes |
| Minimum credit score, and whether it is a hard cut-off | | Blocked language and compliance rules |
| Minimum funding goal | | Whether pricing, guarantees, and outcomes are gated |
| Whether business revenue is required | | Follow-up timing and number of touches (see Q4) |
| Which credit products they offer (see Q3) | | Quiet hours, STOP handling, opt-in |
| Whether they do credit repair, and how | | Which links the agent is allowed to send |
| Booking window and whether the agent books directly or sends a link | | The mission, objections, and FAQ answers — your brain |
| Brand voice: friendly / neutral / professional | | |
| Three sample lines in their own words: how they greet a lead, how they ask about funding, what they say when someone needs time | | |
| Proof points and case studies | | |
| Lead magnets and videos the follow-ups link to | | |
| The purpose of each follow-up touch (value nudge, proof point, send a lead magnet, …) | | |
| Their own program prices (see Q5) | | |

**And here are twenty-one more we think are worth adding. Cross out the ones a coach should not have.**

We would rather hand you a list to cut than a blank box to fill. Every one of these is optional
with a sensible default, so a coach who ignores all of them gets exactly the agent they get today —
and none of them lets a coach change an outcome, only the facts their agent works from. The right
column is what the agent does when a coach leaves it empty, which is the part worth reading: if the
empty behavior is fine with you, the field costs you nothing.

| # | Setting | What the agent can say that it can't today | If the coach leaves it blank | Cut? |
|---|---|---|---|---|
| 1 | **Funding range — the top end** | State a range at all. We only store the bottom of it today, so "$50K–$150K" is a sentence the agent isn't allowed to write | States the minimum only | ☐ |
| 2 | **Who this is for** (their niche) | "built for trucking owner-operators" instead of repeating the program name back | Uses the program name, as today | ☐ |
| 3 | **When to bring up price** — freely / only if asked / never before the call | Hold price for the call *while still* having their prices on file | Only if asked | ☐ |
| 4 | **Minimum time in business** | Answer "do I qualify?" for a brand-new business | Not asked | ☐ |
| 5 | **Do they need an LLC already** — must have / we help you form one / not needed | Turn a disqualifier into a selling point where it is one | Not required | ☐ |
| 6 | **Where they can work** — US / US + Canada / worldwide / named states | Stop booking calls with leads they legally can't serve | No location filter | ☐ |
| 7 | **Hard disqualifiers** — open bankruptcy, active collections, recent charge-off, under 18, no SSN/ITIN | Say no early and kindly, instead of on the call | Credit score is the only filter | ☐ |
| 8 | **Who runs the call** | "Marcus walks you through it" instead of "someone from the team" | "our team" | ☐ |
| 9 | **How long the call is** | Answer the last question a lead asks before booking | Doesn't mention it | ☐ |
| 10 | **What actually happens on the call** (a sentence or two, their words) | Answer "is this just a sales pitch?" | Describes it in your brain's words | ☐ |
| 11 | **The main ask** — book a call / apply first / webinar / DM a keyword | Run an application-first funnel instead of always pushing the calendar | Book a call | ☐ |
| 12 | **Their application link** (only if they picked "apply first") | Send it. Links still have to be on your approved list | Falls back to booking a call, and the coach is told | ☐ |
| 13 | **Emoji** — none / light / match the lead | Sound like them in a DM rather than like a form letter | Light | ☐ |
| 14 | **Message length** — short / standard | Match a coach who texts in fragments | Standard | ☐ |
| 15 | **Words their agent must never use** (up to 10) | Add to your blocked list. They can add, never remove — your rules always stand | Your list only | ☐ |
| 16 | **"I'm already with another program"** — don't engage / acknowledge and redirect | Handle the top-five objection we currently have one answer for | Don't engage | ☐ |
| 17 | **Refund policy** — none / conditional / money-back window / don't discuss | State their actual policy without ever calling it a guarantee | Don't discuss, defer to the call | ☐ |
| 18 | **Typical time to results** (a range in days) | Answer "how long does this take?", the question right after price | Doesn't discuss timelines | ☐ |
| 19 | **When to pull in a human, and who** | Actually tell somebody. Today the agent flags it and nobody is notified | Flags it, notifies nobody | ☐ |
| 20 | **When a human is actually available** | "someone will come back to you in the morning" instead of implying somebody is there at 11pm | Never states a response time | ☐ |
| 21 | **Minimum monthly revenue** | Finish the sentence you already use — "we only work with clients that are already doing at least $5k a month" (see Q2) | "already generating revenue", no figure | ☐ |

**Five we considered and cut ourselves**, so you know the list above is not padded: booking hours
(your calendar already owns that, and a second copy will disagree with it), a payment-plans toggle
(the price list already carries it), a greeting-style setting (brand voice plus their own sample
greeting already cover it), testimonial permission (their proof entries answer it), and language —
that last one is one checkbox for a coach and a translated brain, blocked-word list, and test suite
for us, so we have parked it rather than pretended it is cheap.

**If we don't hear back:** we ship the split above and all twenty-one additions, every one of them
defaulted to its "left blank" column — so a coach who touches nothing gets today's agent, and
silence here changes nothing a lead sees. The split is deliberately conservative: every item in the
right-hand platform column is one we can loosen later without a migration, while moving something
the other way after coaches have been using it means changing what their agent already says.

---

### 2. Two fill-in-the-blanks in your FAQ sheet, narrowed

**Why it matters.** This is the leftover from §6.2 of the earlier ask, and we have a proposal now
rather than an open field. Two slots in your FAQ answers — `[dream outcome]` and
`[income qualifiers]` — have no obvious source, and under our design a slot we cannot fill means
that answer is hidden from the agent entirely rather than sent with a blank in it.

**What breaks without it.** If we treat those two as required and cannot fill them, the answers
containing them disappear for *every* coach, not just an incomplete one.

**What we propose instead of asking each coach to write them.** We generate both from what the
coach has already told us, so there is nothing new for them to fill in and nothing new for them to
get wrong. Here are your own sentences with our proposed fill in bold — the test is whether they
read naturally, so read the whole line rather than the phrase:

> *"Unfortunately we do charge high ticket for our service. Our goal is to help you get funding so
> that you can **scale your business without draining your savings**."*
>
> *"…our goal is to help you get funding faster and easier on your own that you can leverage to
> **scale your business**."*
>
> *"Your personal credit is actually more important than the revenue. So you could still get
> funding. However we tend to only work with clients that are **already doing at least $5k a
> month**."*

**Do those read right?**

☐ Yes, both
☐ The first one is off — it should say: ______________________
☐ The second one is off — it should say: ______________________

**One thing we cannot generate.** The revenue answer needs a number, and it is the one number
nowhere in your system: we know *whether* a coach requires business revenue, never *how much*. So
one of two things is true, and you know which:

☐ **There is a real minimum**, and it should be a field each coach fills in *(our recommendation —
it is one box, and it also makes the agent able to answer "does my business make enough?", which is
a question your sheet says leads ask)*
☐ **There is no fixed number** — the agent should say "already generating revenue" and leave the
figure to the call

**If we don't hear back:** we generate both as above, and we mark them optional — so if a coach's
offer is too thin to generate one, the answer still goes out with a slightly more general sentence
rather than being held back. Without a revenue number we use "already generating revenue."

---

### 3. The credit products list

**Why it matters.** A coach ticks which products they offer, and the agent qualifies against that
list. We seeded five.

**What breaks without it.** A coach who offers something not on the list either cannot say so or
has to pick the nearest wrong option, and the agent then qualifies leads for a product that coach
does not sell.

**Our five — add, remove, or rename:**

☐ Personal credit cards ☐ Personal loans ☐ Business credit cards
☐ Business line of credit ☐ Business term loans

**Missing:** ______________________________________________

**If we don't hear back:** these five ship as a fixed list. Adding a sixth later is a one-line
change, so this is low-risk to leave — we would just rather not have coaches working around a gap
for a month first.

---

### 4. Can a coach change how often the agent follows up?

**Why it matters.** Right now the agent follows up five times over two weeks — roughly two hours,
one day, three days, one week, two weeks — and the coach chooses only what each touch is *for*
(value nudge, proof point, send a lead magnet). They cannot make it more frequent.

**What breaks without it.** This is the one coach setting with your name on the legal exposure. A
coach who sets forty touches over three days is a TCPA problem, and it lands on Live Legacy Strong
because the messages go out on your infrastructure under your carrier registration — the coach's
own worst case is a bad funnel, yours is a complaint.

**What we recommend, plainly: keep timing platform-owned.** It removes the whole category of
problem rather than capping it, and in a year of running this nobody has asked us for it.

☐ **Agreed — timing stays ours.**
☐ **Coaches should be able to change it**, within limits we set.
  → Maximum touches: ______  Minimum gap between touches: ______

**If we don't hear back:** timing stays platform-owned and coaches keep choosing the purpose of
each touch. If you change your mind later we add it with hard caps, never uncapped.

---

### 5. May the agent state a coach's own price?

**Why it matters.** "How much is it?" is the most-asked question a setter gets, and today the agent
has no way to answer it — there is nowhere for a coach to put their price, so the agent either
refuses or deflects to the call every time.

**What breaks without it.** The safety half of this already works: the agent can never invent a
number. But a gate with nothing behind it means the honest answer to a normal question is
permanently "I'll cover that on the call," which is a worse conversation than your setters have and
the kind of thing a lead reads as evasive.

**What we propose.** Each coach lists their prices — a name and an amount, up to eight of them —
and the agent may state **only** those, exactly as written, and nothing else. Any number the agent
produces that is not on that list is blocked before the message sends. So:

> Lead: *"What does the program run?"*
> Agent: *"The Accelerator is **$4,500**, or three payments of **$1,650**. Want me to get you on a
> call to walk through what's included?"*

and if the coach has listed no prices, the agent falls back to today's behavior — defer to the
call.

☐ **Yes — coaches list prices and the agent may state them.**
☐ **No — price is a call conversation, always.** The agent never states a number.
☐ **Yes, but only these coaches / only above a tier:** ______________________

**If we don't hear back:** we build the price list and default every coach to **empty**, which
means the agent behaves exactly as it does today — no number, defer to the call — until a coach
deliberately fills it in. That way the machinery exists and nothing changes without a coach's own
action.

---

## §6 — Signup to working agent

We have finished designing the path a coach walks from clicking your signup link to having an agent answering real leads — seventeen provisioning steps, what runs automatically, what needs the coach, what waits on a third party, and what the screen says at each one. Six things in that path are business decisions rather than engineering ones. Two are commercial (Q1, Q5), two are legal-adjacent and worth ten minutes of your counsel's time (Q2, Q3), and two are small (Q4, Q6). **If you only read one, read Q5.** It is the one where a coach finds out they can never have text messaging, and it is the only question here with a customer on the other end of it.

### 1. SMS arrives weeks after everything else. We are designing around that, not hiding it.

**Why it matters.** A coach signs up and, within minutes, their agent is answering Instagram and
Messenger DMs and booking calls. Text messaging is not minutes — it is a carrier registration that
takes **two to three weeks**, and neither we nor GoHighLevel control the clock. The sequence is
brand registration, brand vetting, campaign submission, then carrier vetting, and that last stage
alone is two to three weeks.

So we made a call: **the SMS setup does not appear inside the main setup flow at all.** The coach
walks Connect → Meet → Go live, goes live on Instagram and Messenger, and text messaging sits in
their persistent "Get started" checklist as a thing they open when they want it. The alternative is
putting a three-week step inside a five-minute wizard, which reads as "you are stuck at step 2"
regardless of what colour we make it.

**What breaks if we are wrong about this.** If you sell SetterFi to coaches as primarily a
text-message product, this IA buries the headline feature. If you sell it as an Instagram and DM
setter that also texts, this is right.

**Related, and not a question — a correction.** The screens we demoed say the carrier wait is
"about 1–2 weeks." That number came from an early estimate and it is wrong; the real figure is
2–3 weeks for carrier review on its own. We are changing the copy to say 2–3 weeks and to show a
live day counter ("Registering with carriers · day 12"). A coach told two weeks who waits
twenty-five days opens a support ticket on day fifteen convinced something is broken. Say the word
if you would rather we keep the optimistic number, but we would be arguing against it.

☐ Correct — SMS is a channel that arrives later, keep it out of the main flow
☐ No — SMS is core, put it in the main setup flow even though it takes weeks
☐ Something else: ______________________

**If we don't hear back:** SMS setup lives in the Get-started checklist, outside the main flow, and
the copy says 2–3 weeks with a day counter.

---

### 2. We have to publish a consent page, a terms page, and a privacy policy for every coach. Whose words are they?

**Why it matters.** The carriers will not register a coach's text-message campaign without a
compliant opt-in page, and the requirements are specific enough to be a build spec: two separate
consent checkboxes for marketing and non-marketing, neither pre-ticked, both optional to submit even
where the phone field is required, a terms page with an explicit clause saying data is not shared
with third parties or affiliates, and a privacy policy. The reviewer checks all of it.

**What breaks without an answer.** Nothing blocks — we will ship the default below. But the default
means **we are generating legal text that appears under a coach's business name**, which is worth
you knowing about rather than discovering.

**Our default:** we host all three pages per coach, generated from one platform template with their
business name and details filled in. The coach reviews and confirms. Coaches who already have their
own terms and privacy pages can point us at theirs instead. **The consent form is always ours**,
because its exact wording is the evidence we have to produce if anyone ever disputes consent, and a
coach's homemade version will not survive that.

The template carries a line telling the coach to have their own counsel look at it before
confirming, and we record that they saw it.

**The ten-minute version of this question for your counsel:** is Live Legacy Strong comfortable
publishing a terms page and privacy policy under a coach's business identity, generated from a
template, with the coach confirming rather than authoring it?

☐ Fine as designed
☐ Fine, but you want to see and approve the template text first
☐ No — coaches must supply their own terms and privacy pages, and cannot register SMS without them
☐ Something else: ______________________

**If we don't hear back:** we host all three from a template, the coach may substitute their own
terms and privacy URLs, the consent form stays ours, and the template tells the coach to have it
reviewed.

---

### 3. One human click before we file a coach's carrier registration — but only when we spot a problem.

**Why it matters.** Carriers permanently refuse text-message registrations for credit repair,
direct loan marketing, and debt reduction. Those refusals are **not resubmittable** — a rejected
campaign is finished, not fixable, and there is no toll-free fallback. And the reviewer reads the
coach's own website, which we do not control. Coaching and consulting are perfectly registrable;
"we fix your credit" on a coach's homepage is not.

So before we file anything, we scan the coach's website and their offer text for the vocabulary
that triggers the refusal. If it comes back clean, the filing happens automatically and nobody
touches it. **If it comes back with hits, we show the coach exactly which phrases on which page,
explain that a refusal cannot be appealed, and let them either fix the page or proceed anyway — and
proceeding queues one confirmation from your team before we actually file.**

**What this costs.** It is the one place a human on your side touches an otherwise zero-touch
signup, and zero-touch is a selling point. **What it buys:** a coach does not burn their single,
permanent, non-refundable shot at text messaging because nobody looked.

**What breaks without it.** Coaches in this industry advertise the exact words that get refused. We
would file, they would be rejected, and there would be no second attempt — ever — for that
business.

☐ Yes, one confirmation from our side when the scan finds a problem
☐ No — if the coach acknowledges the warning and clicks through, file it, no human on our side
☐ Something else: ______________________

**If we don't hear back:** a clean scan files automatically; a flagged scan waits for one
confirmation from your team, and we log who confirmed it.

---

### 4. Coaches without an EIN can register, but the limits are severe. Do we let them?

**Why it matters.** Carrier registration branches on whether the coach's business has an EIN, and
it is an eligibility rule rather than a preference — the Sole Proprietor path is *only* for
businesses without one, so any US LLC is ineligible for it.

The Sole Proprietor path is worse in three ways a coach will feel:

- **~1,000 messages a day**, total. A coach with real volume will hit it.
- **One campaign, one number.** No room to grow.
- Verification is a one-time code to the coach's **personal mobile**, and that number can be used
  for this **three times in total, across every carrier registration anywhere, ever**. If a coach
  uses a shared or office number, they burn one of three lifetime uses for whoever else ever tries
  it from that line.

Our default is to let them on, and to show them all three limits **before** they commit rather than
after. The alternative is telling a signed-up, paying coach that text messaging is not available to
their business structure.

☐ Let them on with the limits stated up front
☐ Don't offer SMS to businesses without an EIN at all — say so plainly at signup
☐ Something else: ______________________

**If we don't hear back:** sole proprietors can register, and the screen states the daily cap, the
single-number limit, and the three-lifetime-uses warning before they enter anything.

---

### 5. Some coaches will never be able to text. What do we do for them commercially?

**Why it matters.** This is the hardest screen in the product. A coach has signed up, paid, and
connected everything, and the carriers have permanently refused their text-message registration
because of what their own website says. There is no appeal, no resubmission, and no alternative
route. Their agent still works perfectly on Instagram, Messenger, and their calendar.

The product side is decided: the screen says exactly that, in plain words, without the word
"pending" anywhere on it, and it does not offer a retry button for something that cannot be
retried. We will not show a coach a spinner for a wait that will never end.

**What we cannot decide is the commercial side.** Options, roughly:

- **Nothing changes.** They keep their tier and their price; SMS was one of several channels and
  the rest work. *(This is our default.)*
- **A discount or a lower tier** for accounts where SMS is permanently unavailable.
- **A refund window** — they can cancel within N days of the refusal with no charge.

**What breaks without an answer.** Nothing technically — the screen ships either way. But whoever
takes that support call needs to know what they are allowed to offer, and right now nobody does.

☐ Nothing changes — they keep their plan
☐ Discount / lower tier — which: ______________________
☐ Refund window — how long: ______________________
☐ Something else: ______________________

**If we don't hear back:** the screen tells the truth, nothing changes commercially, and the copy
points them at support.

---

### 6. Is there a free trial, or does the card get charged at signup?

**Why it matters.** Right now the design creates the Stripe subscription during signup and the
coach is billed immediately, before their agent has answered a single lead — and before text
messaging, which may be three weeks out. That is a defensible way to sell it, and it is also the
kind of thing that produces a chargeback from a coach who never finished setting up.

Two consequences flow from the answer, so it is worth thirty seconds:

- **We alert your success team when a paying coach still has not gone live after 14 days.** Whether
  that clock starts at signup or at the end of a trial depends on this.
- Whether a coach can reach "Go live" without a cleared payment at all. Our default is no — a card
  that never cleared means they have not actually subscribed.

☐ No trial — charge at signup, as designed
☐ Trial: ______ days, then charge
☐ Something else: ______________________

**If we don't hear back:** no trial, card charged at signup, and the "paying but not live" alert
fires at day 14.

---

### The two things you already owe us that this topic now depends on

Not new asks — both are already on the list from earlier rounds. They have moved from
"nice to have" to "named step in the pipeline" and are worth repeating with that context.

1. **The cash-campaign sample messages**, verbatim. Carrier campaign registration requires sample
   messages, and the top rejection reason is samples that do not match what the agent actually
   sends. We generate them from each coach's configuration so they match by construction — but the
   cash-campaign wording has to come from you, because it describes an offer we cannot invent.
   Until it lands, no coach's campaign can be filed, which means no coach gets text messaging.
2. **Meta App Review / Advanced Access.** Until it clears, we cannot connect a third-party coach's
   own WhatsApp number at all. The design handles this honestly — the WhatsApp option reads "Not
   available yet" rather than showing a verification spinner that will never resolve — but it does
   mean WhatsApp is not a channel any coach can use until that filing goes through.

---

### Summary — what ships if you say nothing

| # | Question | What we ship |
|---|---|---|
| 1 | Where SMS setup lives | Outside the main flow, in the Get-started checklist; copy says 2–3 weeks with a day counter |
| 2 | Whose consent / terms / privacy pages | We host all three from a template; coach may substitute terms and privacy; consent form stays ours |
| 3 | Human check before filing | Clean scan files automatically; flagged scan waits for one confirmation from your team |
| 4 | Coaches without an EIN | Allowed, with all three limits stated before they enter anything |
| 5 | Permanently refused SMS | Screen tells the truth; nothing changes commercially |
| 6 | Trial | No trial; card charged at signup; "paying but not live" alert at day 14 |

---

## §7 — The channels your agent runs on

### 1. Naming the providers on the coach's integrations screen

**Why it matters.** You asked us to name GoHighLevel and Twilio literally on the coach
integrations screen. The white-label rule says infrastructure providers stay out of coach-visible
UI, and those two asks point in opposite directions — but only if "provider name" is one category.
We think it is two, and the split resolves most of it.

**What breaks without it.** If we hide every provider name, a coach clicking **Connect** on their
calendar cannot tell what they are about to sign into, which is a genuinely bad screen and
generates the support ticket you were trying to avoid. If we name every provider, a coach sees
"GoHighLevel" attached to a service they have no account with, no login for, and no way to act
on — and now your platform looks like a reseller of somebody else's product.

**What we are shipping unless you say otherwise.** Name what the coach personally authenticates
against. Hide plumbing they have no relationship with.

| Coach sees the real name | Coach sees a generic name |
|---|---|
| **Google Calendar** — they log into their own Google account | **Text messages (SMS)** — brokered on your numbers; the coach has no account anywhere |
| **Instagram** — they connect their own account | **Calendar** *(when it is your calendar, not theirs)* |
| **Facebook Messenger** — their own page | |
| **WhatsApp** — their own business number | |

**The one thing we can't answer for you.** Some coaches may eventually bring their own Twilio
subaccount rather than using your numbers. Under the rule above that coach *would* see "Twilio"
named, because they do have an account and a bill. Is that what you want, or should SMS always
read generically no matter whose numbers are underneath?

☐ Name Twilio when it's their own account  ☐ Always generic  ☐ No coach ever brings their own

**If we don't hear back:** we ship the table above and SMS reads generically in every case. It is
the reversible direction — turning a generic label into a specific one later is a copy change,
while un-naming a provider after coaches have learned the screen is a support problem.

---

### 2. Which WhatsApp templates you actually want approved

**Why it matters.** WhatsApp will not let the agent send a free-form message more than 24 hours
after the lead's last reply. After that window the only thing that can go out is a message
template you registered with Meta in advance and Meta approved. Every follow-up that lands the
next morning is a template send. If the templates don't exist, the follow-up doesn't happen — it
isn't delayed, there is simply nothing legal to send.

**What breaks without it.** Meta template approval is its own clock, separate from app review, and
it runs per template. Templates submitted late are follow-ups that silently don't go out for the
first weeks of live traffic, on the channel you were most excited about.

**Here are the four we think you need. Redline the wording — a marked-up draft is far more useful
to us than a blank field.**

| # | When it fires | Draft |
|---|---|---|
| 1 | Next morning, lead went quiet mid-qualification | Hi {{1}} — picking up where we left off on your funding goal. Still want me to check what you'd qualify for? |
| 2 | Day 3, no reply | {{1}}, still happy to run through your options whenever you've got two minutes. Want me to send a time? |
| 3 | Booked call reminder, day before | Hi {{1}} — you're booked with {{2}} tomorrow at {{3}}. Reply RESCHEDULE if you need a different time. |
| 4 | Lead went quiet after a booking was offered | {{1}}, I've still got a couple of slots open this week if you'd like one. |

**Anything you'd add?** ______________________________________________

**If we don't hear back:** we submit those four as written. They are deliberately plain and make
no claim about credit outcomes, funding amounts, or approval odds, which is also what keeps them
approvable. You can revise the wording later, but each revision is a fresh approval cycle, so the
first submission is worth reading now.

---

### 3. Can a coach have more than one Instagram account?

**Why it matters.** We currently allow one Instagram connection, one Messenger, one WhatsApp, and
one SMS number per coach. That is a schema-level rule, so it is cheap to change now and expensive
later.

**What breaks without it.** It isn't only a limit — if a coach genuinely runs two accounts, the
agent has to decide which one to reply *from* on every outbound message, and nothing in the
product currently answers that. So this is a two-part question and the second part is the
expensive one.

**Do any of your coaches run more than one Instagram account or Facebook page for the same
business?**

☐ No, one each  ☐ Some do  ☐ Don't know yet

**If we don't hear back:** one connection per channel per coach. It covers every coach in your
current book as far as we can tell, and adding a second is additive work rather than a rewrite —
whereas building multi-account routing nobody uses costs us a week we do not have.

---

### 4. Is GoHighLevel's Instagram connection a permanent path or a stopgap?

**Why it matters.** Right now Instagram and Messenger reach the agent through GoHighLevel while
our own Meta app is in review. Once the app is approved we can connect coaches directly, which is
faster and removes a dependency. The question is whether coaches get moved across.

**What breaks without it.** Moving a coach from GoHighLevel's connection to ours changes the id
the lead arrives under. If a coach is mid-conversation with twelve leads when that happens, and we
haven't planned for it, those twelve leads reappear as brand new people with no history —
the agent greets them from scratch and the coach watches it happen. We can prevent that, but
preventing it is work we schedule, not something we discover on cutover day.

**Which is it?**

☐ Everyone moves to our direct connection once approved
☐ GoHighLevel stays for existing coaches, direct for new signups
☐ Depends on how review goes

**If we don't hear back:** we assume everyone eventually moves, and we build the identity carry-
over so a cutover keeps conversation history intact. If it turns out nobody moves, we have spent
a day on something unused — the reverse mistake is unrecoverable in front of a live coach.

---

## §8 — Follow-up cadence and when a conversation ends

**Question 1 is the one to read.** It is the answer to the window-aware follow-up idea you flagged as a game-changer, and the answer is not the one the idea assumed. Everything else here is confirmation.

### 1. Instagram closes the door at 24 hours, and there is only one way to keep it open

**Why it matters.** Meta lets an automated system send free-form messages to a lead for **24 hours
after that lead's last message**, and then stops. On WhatsApp there is a way back in through
pre-approved templates. **On Instagram and Facebook Messenger there is none** — the only documented
post-window mechanism is a "human agent" tag that Meta restricts to actual humans, and it is behind
an App Review permission we have not asked for and would not get for a bot.

This is Meta's rule, not our design choice, and we verified it rather than remembered it.

**What that does to the follow-up cadence you have seen.** The demo shows five touches: 2 hours, 1
day, 3 days, 7 days, 14 days. On a lead who came in by SMS, all five send. **On a lead who came in
by Instagram DM, the first one sends and the other four do not exist.** Not "might be delayed" —
Meta refuses them.

That is the honest position, and it is why the follow-up screen is changing: a coach will see the
five-touch cadence for text messages and a **two-touch, same-day cadence for Instagram and
Facebook**, with a line explaining why. We are not going to ship a screen that promises a lead
magnet on day 7 to an Instagram lead.

**The one way to keep the conversation alive: get their mobile number while the window is open.**
An Instagram DM is not legal permission to text somebody — the law cares about the number being
given to you, for texting, on purpose. So the agent has to actually ask, and the lead has to
actually confirm. That flow is already designed and legally clean:

1. The agent asks for a mobile number once, after the lead has engaged (not in the first message).
2. If they give one, we send **one** text, which is not a sales message.
3. They reply YES. Only then can the agent text them, and the whole cadence continues by text.
4. They do not reply — we never text that number again. Not once.

**What breaks without it.** Every Instagram lead who does not reply within 24 hours is gone
permanently, with one nudge attempted. That may be acceptable — plenty of them were never leads —
but it should be your decision, not a side effect.

#### 1.1 Should the agent ask Instagram and Facebook leads for their mobile number?

*(strike the ones that are wrong)*

~~Yes — ask once, after they have engaged. This is the default.~~ ·
~~Yes, but only after they answer the qualification questions~~ ·
~~No — do not ask. Instagram leads end at 24 hours.~~ ·
~~Ask for email instead — we will tell you what that changes~~

#### 1.2 Redline the ask

> Draft, as the agent would say it. Change the words; the two compliance sentences in the
> confirmation are fixed by carrier rules and cannot move.

**The agent asks:**

> "Quick one — Instagram cuts me off if we go quiet for a day. What's the best mobile number for
> you? I'll text you the funding breakdown so it doesn't get lost in here."

**The confirmation text we then send (one message, one time):**

> "{Business name} here — you asked about funding on Instagram. Reply YES and I'll keep helping you
> by text. Msg & data rates may apply. Reply STOP to opt out."

#### 1.3 Redline the first text of the continued conversation

> This is what a lead sees days later, from a number they do not recognise. If it does not
> immediately say who this is and why, it reads as spam and they block it.

> "Hey {first name} — {business name} here, following up on your Instagram message about funding.
> Still worth me sending over the readiness guide?"

**If we don't hear back:** we build 1.1's default — the agent asks once, after engagement, with the
draft wording in 1.2 and 1.3. The two fixed compliance sentences ship regardless. Nothing about
this blocks; the wording can change any time after launch without a rebuild.

---

### 2. We are not building "wake up a cold lead" for launch. Confirm.

**Why it matters.** There is a real, valuable feature here: pick every lead who went quiet three
months ago and message them again. We are deliberately **not** building it for launch, and we would
rather you disagree now than in week seven.

**What it actually requires**, which is why it is not a small addition to the follow-up cadence:

- A way to define the group ("everyone who didn't book, credit 640+, last spoke 90+ days ago").
- A message that is written once for the whole group, not generated per lead.
- A **different and much stricter permission check.** A lead messaging you is permission to reply to
  them for about three months. After that, messaging them again is a marketing campaign, and it
  needs the kind of opt-in a signup form produces — which most inbound DM leads will never have.
- A send-rate throttle, because carriers cap a new phone number at roughly 2,000 messages a day and
  will shut it down if you blast.
- A record of exactly who was sent what and on what permission, because this is the send most likely
  to produce a complaint.

**What breaks without it.** Nothing breaks. Cold leads sit in the Long-Term Follow-Up column and a
coach can message them by hand, which is legal and which good coaches do anyway. What you lose is
the ability to re-run a list at the push of a button.

*(strike the wrong one)*

~~Agreed — not in v1. Build it after launch.~~ ·
~~This is contractual, it has to be in the launch build — I will accept the schedule cost~~

**If we don't hear back:** it is not in v1. It is written into the plan as a named, deferred piece
of work (FUP-06) rather than left as a gap, so it is a scheduling conversation later and never a
surprise.

---

### 3. The cadence numbers themselves

**Why it matters.** These are platform-wide — every coach gets the same timing, and the coach picks
only what each touch is *for*. That was settled separately (a coach setting their own send frequency
is direct legal exposure for you). What is open is whether the platform's numbers are the right
numbers. You have run these campaigns; we have not.

**What breaks without it.** Nothing — we ship what is in the demo. But these are the numbers every
lead in the system experiences, so they are worth ten seconds of your attention.

#### 3.1 Text-message leads — five touches. Strike or change anything wrong.

| # | When | What it is | Change to |
|---|---|---|---|
| 1 | 2 hours after they go quiet | Send free lead magnet | __________ |
| 2 | 1 day | Value nudge | __________ |
| 3 | 3 days | Proof point / case study | __________ |
| 4 | 7 days | New angle | __________ |
| 5 | 14 days | Last touch | __________ |

#### 3.2 Instagram and Facebook leads — two touches, both inside the 24-hour window.

| # | When | What it is | Change to |
|---|---|---|---|
| 1 | 2 hours after they go quiet | Send free lead magnet | __________ |
| 2 | ~4 hours before Meta closes the window | Last touch | __________ |

#### 3.3 The six things a touch can be

> These are the only options a coach can pick from, per touch. Strike any you would never use, add
> any that are missing.

~~Send free lead magnet~~ · ~~Send free training~~ · ~~Value nudge~~ · ~~Proof point~~ ·
~~New angle~~ · ~~Last touch~~ · Missing: __________

**If we don't hear back:** we ship exactly what is in the tables above — it is what the demo already
shows, so nothing you have seen changes.

---

### 4. The Long-Term Follow-Up column — reminder, or robot?

**Why it matters.** The pipeline board has a **Long-Term Follow-Up** column. There are two things it
could mean, and they are very different products:

- **A reminder for the coach.** The card sits there; the coach decides when to reach out; nothing is
  sent automatically.
- **A slow automatic cadence.** Dragging a card there starts the agent messaging that lead every few
  weeks, indefinitely.

We are building the first one, for two reasons. Dragging a card is a gesture with no confirmation and
no note attached — making it start automated messaging to a real consumer means the most legally
consequential action in the product is also the easiest one to do by accident. And "long term" in
credit work means about ninety days, which is exactly the point where a reply-based permission runs
out and a campaign permission is required, so the slow cadence would be illegal roughly when it
became useful.

*(strike the wrong one)*

~~Agreed — it is a reminder column. No automatic sends.~~ ·
~~I want it to send automatically — let's talk about what that needs~~

**If we don't hear back:** it is a reminder column. Cards sit there, nothing is sent, and the coach
can message manually from the contact.

---

### Cross-references

- Question 3 is the platform's numbers. **Whether individual coaches may change their own timing** is
  a separate question already asked as **§5 question 4** — if that comes back yes, these numbers become
  the defaults rather than the rule, inside hard caps either way.
- Question 1 depends on the opt-in mechanics asked in **§4 question 1**, which is the highest-priority
  unanswered question in the project and also blocks each coach's carrier registration.
- Question 1.2's confirmation text is a third platform-constant message in the same family as the
  two redlined in **§4 question 6** (the STOP confirmation and the HELP reply), and it is also the text
  filed with the carriers as an A2P sample message under **§4 question 1** — so it should be answered in
  the same sitting as both.

---

## §9 — The booking moment and what counts as a booked call

Five questions. Everything else about booking was decided on our side — how slots are fetched, what happens when two people grab the same time, how a reschedule is stored, how a no-show is recorded. These five are here because each one is either your money or your voice, and we should not be guessing at either.

### 1. After they book, does the agent keep talking?

**Why it matters.** This is the last thing a lead reads before they meet you, and it is the only
moment in the whole conversation where the agent has finished its job and is still in the room. The
two answers produce genuinely different products: one where the lead can ask "do I need to bring
anything?" and get an answer, and one where the thread goes quiet the second the calendar invite
lands.

**What breaks without it.** We ship the talkative version, and if you wanted the clean stop, a lead
gets an AI answer to a question you would rather have answered yourself.

> *This question is already in the content ask as a checkbox. It is repeated here because the answer
> is a build decision, not just a script one.*

☐ **Confirm and stop.** The agent sends the confirmation and goes silent. Anything the lead says
after that waits for a person.

☐ **Keep answering questions.** The agent stays live and answers logistics and light questions until
the call happens or the thread goes quiet for three days. It is still bounded by every rule it had
before — it cannot quote prices, guarantee anything, or invent a number.

**Anything you want it explicitly *not* to discuss after a booking:** _______________________

**If we don't hear back:** we build **keep answering**, and the conversation closes itself when the
call starts or after 72 hours of silence, whichever comes first. Switching to confirm-and-stop later
is a one-line change, not a rebuild.

---

### 2. The booking moment — we want to change your draft, and here is why

**Why it matters.** The draft in the content ask sends a link. What we are actually building offers
real times from your calendar and books the call inside the conversation, without the lead ever
leaving the DM. That is the harder thing to build and, we think, the better thing to have — a lead
who has to click a link, load a page, and pick a slot is a lead with three more chances to change
their mind.

**What breaks without it.** Nothing breaks, but the words we ship would describe a flow we are not
building.

> *Your current draft (from the content ask):*
> "Based on what you've told me, you'd be a good fit for a call with [coach]. Here's the link — grab
> whatever time works: [link]"

> *What we'd ship instead:*
> "Based on what you've told me, you'd be a good fit for a call with [coach]. I've got Thursday at
> 2pm Eastern or Friday at 10am Eastern open — which works better?"
> …then, once they pick: "Done — you're on for Thursday at 2pm Eastern. [Coach] will see everything
> you've told me before the call."

**Your version:** _______________________________________________________________

**One thing to know either way:** we keep the link version available as a per-coach setting, for a
coach who runs a booking form with a deposit or a questionnaire on it. Even then the agent never
sends a bare URL on its own line — it qualifies first and wraps the link in a sentence.

**If we don't hear back:** direct booking ships as the default for every coach, with the wording
above, and the link version stays available as a setting.

---

### 3. Does a call you booked yourself count against the coach's allowance?

**Why it matters.** This is your revenue, so it is genuinely your call. Once a coach connects their
calendar, we see every appointment on it — including the ones the agent had nothing to do with. A
coach who books their existing clients by hand in the calendar would, if we counted everything, be
charged for calls we did not produce. They will notice on the first invoice and it will be an
awkward conversation.

**What breaks without it.** We build the conservative version, which is the one that never generates
that phone call — but it also means you are not charging for some genuine volume.

☐ **Only calls the agent booked count** *(our default)*. If the agent qualified the lead and put them
on the calendar, it counts. If you or the lead booked it some other way, it shows up in the coach's
pipeline with a small "not booked by your agent" label and does not touch their allowance.

☐ **Every appointment on the connected calendar counts.** Simpler to explain on a pricing page,
harder to defend when a coach's own client shows up on their bill.

**If we don't hear back:** only agent-booked calls count. The other appointments are still stored and
still visible to the coach — they just do not bill. If you want to switch later it is a setting, not
a rebuild.

---

### 4. Reminders before the call — do you want them, and from whom?

**Why it matters.** No-shows are the most expensive thing that happens after a successful booking,
and a reminder is the cheapest fix for them. But a reminder from the agent, a day before the call,
is a message the lead did not ask for — and on Instagram and Messenger, Meta will not let us send it
at all more than 24 hours after the lead's last message. So this is only ever an SMS thing, which
means it only works once that coach's texting is registered with the carriers.

**What breaks without it.** We ship no reminders, and every no-show is a no-show that a text might
have prevented.

☐ **No reminders.** The calendar's own invite is enough.
☐ **One text the day before.** ☐ **One text the day before and one an hour before.**

> *Draft, if you want them:* "Hey [name] — quick reminder you're on with [coach] tomorrow at 2pm
> Eastern. Reply here if you need to move it."

**Should a lead be able to reschedule by replying to that text, or should it point them somewhere?**
_______________________

**If we don't hear back:** no reminders in the first release. The calendar invite goes out from your
calendar as it does today, and we build reminders in a later phase once you have real no-show numbers
to aim at.

---

### 5. Google Calendar — how should a coach connect one?

**Why it matters.** You told us the reality is a mix: some coaches live in the GHL calendar, some
live in Google. There are two ways to connect a Google calendar and they differ in what a coach has
to do and in what breaks when it breaks. This is flagged in our own notes as "confirm before the
calendar build," and that build is now.

**What breaks without it.** We build the GHL path only, and a Google-native coach has an extra setup
step where they connect Google to GHL first — which works, and is one more screen where somebody
gets stuck.

☐ **Google through GHL** *(our default)*. The coach connects Google inside the GHL calendar, exactly
as your existing coaches do today. Nothing new for us to build, one more step for them, and when the
connection breaks the fix is in GHL rather than in our product.

☐ **Google directly through SetterFi.** One click inside our onboarding, no GHL step. Better first
run, and it means we own a Google app and its review process — which is a real timeline item, not a
weekend.

**If we don't hear back:** Google connects through GHL for launch. We are building the calendar
connection so that adding the direct Google path later is a new row rather than a redesign, so this
one is genuinely reversible.

---

### Not asked here, deliberately

**Whether a canceled or no-showed call still counts against the allowance** is already §13 question 2, and the answer there governs. Our build assumes it does — the agent did its job when
it put a qualified person on your calendar, and attendance is something only the coach can report.
Nothing in this document changes that.

---

## §10 — What the agent knows

### 1. Is the FAQ sheet really everything, or is there a script somewhere?

**Why it matters.** We went through your workspace and found one thing we can teach the agent
from: the 46-row prospect FAQ sheet. Everything else in there is either a template, a course
outline, or belongs to a different part of your business. Forty-six answers is a real starting
point and it is also less than we expected, so we would rather ask than assume.

The specific thing we are looking for is different from FAQs: the language your best closer uses.
A call script, a training doc for new setters, the objection-handling notes somebody typed up once
and everyone still refers to — anything where the *phrasing* is the value, not the fact.

**What breaks without it.** The agent knows 46 answers and nothing else. It will be correct and it
will sound like a competent stranger rather than like your team, and every gap gets handled by
deflecting to the call (see question 2), which works but converts worse than a good answer would.

**What we need:** either "that's all of it" or a pointer to the document. Rough, outdated, or half
finished is fine — we would rather adapt something real than invent something clean. A recording of
you handling a hard objection is also usable.

**If we don't hear back:** we build on the 46 rows, and the agent's voice comes from your existing
FAQ responses and the sales language already in the workspace. Adding a document later is
straightforward — it does not change anything we build now, it just gives the agent more to work
with.

---

### 2. What does the agent say when it doesn't know?

**Why it matters.** With 46 answers, the agent will regularly get a question nothing covers. That
is not a defect — it is the normal condition of any setter in their first month — but it happens
often enough that the "I don't know" reply is one of the most frequent things the agent will ever
say. Right now it is our sentence, not yours.

There is a real choice inside it. The agent can push toward the call ("that's exactly what Marcus
covers — when are you free?"), which converts, or it can offer to find out ("let me check and come
back to you"), which is honest and slower and means somebody actually has to come back. Those two
answers produce very different funnels.

**What breaks without it.** We pick, and we will pick the conservative one, which costs you
conversions at the highest-intent moment — a lead asking a question they care enough to type.

**Which of these is right?**

☐ Always steer to the call — the agent never promises to follow up
☐ Steer to the call, but if the lead pushes twice, offer to find out and hand it to a human
☐ Offer to find out first, book second
☐ Something else: _______________________________________________

**And the words, if you want them to be yours:**

> "That's a good question and I don't want to guess at it. Marcus goes through exactly that on the
> call — what does your week look like?"

**If we don't hear back:** the agent steers to the call and never promises a follow-up it cannot
keep, because a promise nobody fulfils costs more trust than a deflection does. It is a settings
change whenever you want it different.

---

### 3. When a lead asks something new, who writes the answer?

**Why it matters.** Every time the agent hits a question it cannot answer, we log it. That list is
the single most valuable content you will get out of this platform — it is your leads telling you,
in their own words, what your FAQ sheet is missing, ranked by how often they ask. In month one it
will be long.

An answer written into that list goes to **every** coach's agent, so it is your team's call, not a
coach's. Which means someone on your side has to work the list, or it just grows.

**What breaks without it.** The queue fills up and nobody reads it. The agent keeps deflecting the
same question for months, which is the exact failure your competitors have, and the one piece of
compounding value in the product never compounds.

**Two things to confirm:**

- **Who works it, and how often?** Weekly is plenty. It is reading a list and writing a few
  sentences, not a project.
- **Who is allowed to publish the answer?** Same person, or does it need your sign-off before it
  reaches every agent?

**If we don't hear back:** the queue exists, sorted by how often each question comes up, and it
notifies your admins weekly. Nothing publishes automatically — an answer only reaches agents when a
human writes it and publishes it, so an unworked queue is a missed opportunity and never a risk.

---

## Note to add to the sync-cadence decision when §7 goes out

The sync question reads riskier than it is, and Alec may be weighing a risk that does not exist.
Whatever he chooses, **nothing typed in Notion changes what any agent says until a human publishes
it.** An import creates a batch of proposed changes that someone reviews; accepted changes become
drafts; drafts reach agents only through a publish that mints a new version. So the real question
is only whether his team wants to click "Import from Notion" themselves or find a batch waiting for
them in the morning. Both are safe, and the answer does not change what we build first.

---

## §11 — How we prove the agent behaves

### 1. Which of these ten sound wrong?

**Why it matters.** Four of our six test suites are mechanical — did the agent state a number
nobody gave it, did it repeat a blocked phrase, did it leak its own instructions. Those we can
check without asking you anything. The fifth is voice and tone, and there is no mechanical version
of "does this sound like a Live Legacy Strong agent."

We are not asking you to write that for us. Your `Prospect FAQ Sheet` already has 46 answers in
your own words, so we took the voice out of those and wrote ten messages the agent would send in
the three situations that come up most. **Read them and cross out the ones that are wrong.** Two
minutes, and it tells us more than a blank box would.

Two things to hold while reading. Your 46 rows were written as *answers to questions*, and these are
*replies inside a conversation* — a different job, so where one sounds stiff, that gap is probably
why, and that is exactly what we want flagged. And the numbers below are Live Legacy Strong's own,
because yours are the ones on file; each coach's agent will use that coach's figures instead.

**A lead hesitating on money**

| # | Draft | Wrong? |
|---|---|---|
| 1 | "Totally get it. Based on what you've told me about your credit, there may still be options here — want me to walk you through them on a quick 30-minute call this week?" | ☐ |
| 2 | "I'll be straight with you — we do charge high ticket. The whole point is getting you access to funding you can actually build with. If that sounds worth exploring, happy to lay out what it looks like." | ☐ |
| 3 | "It depends on what you need and how long we work together, so it ranges. Fastest way to get you a real number is a quick call — what does your week look like?" | ☐ |
| 4 | "If you're after something under that range we might not be the right fit, and I'd rather say so now than waste your time. We focus on getting clients into the $50–150K range." | ☐ |

**A lead who is clearly not a fit**

| # | Draft | Wrong? |
|---|---|---|
| 5 | "Yeah — you'd need 700+ to qualify on the funding side, so that's the blocker right now. Good news is credit is fixable, and we have a program built for exactly that. Want me to send details?" | ☐ |
| 6 | "I see you in the system — looks like the application didn't clear on credit. Have you started working on that yet?" | ☐ |
| 7 | "Honestly, we only take on clients we're confident we can get results for, so if the form didn't let you book, something's likely missing. The free trainings will genuinely help in the meantime — want the link?" | ☐ |

**A lead ready to book**

| # | Draft | Wrong? |
|---|---|---|
| 8 | "We only do booked calls — I like to prep so we're not wasting your time. Here's the link, grab whatever works: [link]" | ☐ |
| 9 | "We don't run calls on weekends, but you can book any weekday slot once the application's done. Here's the link: [link]" | ☐ |
| 10 | "Happy to go through it properly — let's start with a call and take it from there. Here's my calendar: [link]" | ☐ |

**And one question about the crossed-out ones:** too formal, too pushy, too soft, or just not
something your team would say? One word next to the cross is enough — that word is what we grade
future drafts against.

**One situation we deliberately left out.** We wanted a fourth: a lead who has been burned by a
previous program. Your sheet has nothing on it — the closest row is "how do I know you aren't
scammers?", which is about trusting a stranger rather than being let down by someone. We would
rather tell you that than invent three messages and present them as yours. If you have a line you
use for it, that is the one gap worth filling: ______________________________________________

**If we don't hear back:** the ten drafts above become the voice suite as written, marked as ours
rather than yours. Voice never blocks a publish either way — a tone we disagree on is not a safety
problem — so an unanswered question here costs nothing until the day the agent sounds off and
nobody set the bar.

---

### 2. When a safety test fails, who do we wake up?

**Why it matters.** We are making one change to how publishing works. Today the plan is that a
failing safety test shows an amber warning and you can publish anyway. We want the four safety
suites — compliance, pricing, jailbreak, and instruction leakage — to actually stop the publish
until the failure is fixed, rather than warn about it. The reasoning is short: a compliance failure
means the agent, right now, says something your own blocked list forbids, and that content is about
to reach every coach on the platform. That is not a judgement call, so there is nothing useful for
a human to acknowledge. Qualification and voice keep the warning-and-proceed behavior, because
those failures usually mean the test is out of date and a person is the right judge.

**What breaks without an answer.** Somebody on your team will hit this block on a day they are in a
hurry. If they do not know who fixes it or how long it takes, the pressure goes on us to add a
bypass button, and a bypass button gets used routinely within a month.

**Three things to confirm:**

- **Who gets told?** A named person or a shared inbox — the block posts there with the failing case
  and the rule it broke, not just "eval failed."
- **Do you want any way to publish past a hard block?** Our position is no: the fix is either the
  agent or the test, and either way it goes through us. If you want one, we would make it require
  two people and log it permanently — never one click.
- **How often should the full test run on its own?** We would run it nightly so a failure surfaces
  the morning after rather than the moment somebody tries to publish. It calls the real model, so
  it costs real money — roughly $150 a month at the size the library is now.

**If we don't hear back:** the four safety suites hard-block with no bypass, failures post to the
platform notifications your admins already see, and the full run happens nightly. Anything you
change here is a settings change, not a rebuild.

---

### 3. Can a real lead's message become a permanent test case?

**Why it matters.** The most valuable test cases are the ones that already happened — a real
conversation where the agent said something slightly off is worth more than ten we invented. So the
product has a button that turns a real conversation turn into a permanent test case. Two things
about that are worth you knowing rather than discovering: the test library is **platform-wide**, so
a message from one coach's lead becomes a case that runs against every coach's setup, and it lives
in that library indefinitely — long after the lead is gone.

**What breaks without an answer.** We either build the button and quietly move your coaches' leads'
words into a shared library, or we do not build it and every test case is one we made up.

**How we would do it, if you say yes:** the lead's name, phone, email, address, and any links are
replaced before the case is saved — the amounts and credit scores stay, since those are usually the
thing being tested. Whoever saves it sees the redacted version and confirms it. Only your team can
do it; coaches cannot. And every promotion is logged with which conversation it came from, so if a
lead asks to be deleted we can find the copy.

☐ Yes, redacted as described ☐ Yes, but only from your own test conversations, never a real lead
☐ No — we write our own cases

**If we don't hear back:** we build it redacted exactly as described, restricted to your team, and
logged. It is the version that is useful without moving anything identifiable, and it is reversible
— if you would rather it never touched a real conversation, turning it off is a setting.

---

## §12 — The numbers on your dashboard

### 1. When a coach sees "conversion rate", what are they converting?

**Why it matters.** There are two honest answers and they produce very different numbers.

One reading is **leads to qualified** — of everyone who messaged in, how many did the agent decide
were a genuine fit. That measures your lead quality and your traffic.

The other is **leads to booked** — of everyone who messaged in, how many ended up on the calendar.
That measures the agent.

For a coach running paid traffic these can be miles apart: sixty percent qualified and thirty
percent booked is an entirely normal shape, and a coach who thinks the number means the first thing
while it means the second will conclude their ads are failing when they are not.

**What we have built:** leads to booked. Our reasoning is that a call on the calendar is the thing
the coach is paying you for, so it is the number the product should be judged on — and qualified
leads are already a separate figure on the same row, so nothing is hidden. But your coaches are the
ones who will read it, and you know their vocabulary better than we do.

**If we don't hear back:** conversion rate is leads to booked calls, with qualified shown separately
alongside it.

---

### 2. Should a call that was cancelled or nobody turned up to still count?

**Why it matters.** A coach books twenty calls in a month, six cancel and two are no-shows. Is that
month twenty, or twelve?

We think it has to be **both, in different places, clearly labelled** — and we want to check that
reads as sensible to you rather than as a fudge.

The plan-allowance counter on their home screen — the "18 of 25" — counts every call the agent
booked, including ones later cancelled, because that is what the agent did and that is what the
billing reflects. Reversing it would mean a coach's plan usage moved backwards days after the fact,
and neither of us wants to explain that.

The performance graph is the opposite. When a coach looks at six months of history to judge whether
this is working, they want calls that happened, so cancellations and no-shows come out of that line.

**One thing that follows from this**, and it connects to a separate question we have already sent
you about marking attendance: we can only take no-shows out of the performance graph if somebody
marks them. If attendance goes unmarked, the graph counts a no-show as a booked call, and we would
rather tell you that now than have you find it in month three.

**If we don't hear back:** the plan counter counts every booking; the performance graph counts calls
that were not cancelled, and treats an unmarked call as having happened.

---

### 3. Your own admin dashboard has five numbers that cannot be true in month one

**Why it matters.** The platform overview has a row reading new signups, churn rate, lifetime value,
average retention, and growth trend. On launch day there have been no cancellations, nobody has
completed a lifetime, and there is no previous period to grow from.

We can render all five. Churn rate would read 0%, which sounds like good news rather than no data.
Lifetime value and average retention would be produced by us picking an assumption and multiplying
by it — the number would look authoritative and mean nothing, and it is exactly the kind of number
an owner makes a decision on.

**What we have built:** new signups and active subscriptions ship at launch because they are real
from day one. Churn rate appears once one full billing cycle has been through. Lifetime value,
average retention and growth trend stay behind a "needs more history" state until there is enough
history — realistically three to four months in.

The question is whether you would rather see the placeholders sitting there so the shape of the
dashboard is familiar from day one, or have those tiles appear when they become real. Either is fine
by us; what we will not do is show a computed figure with nothing behind it.

**If we don't hear back:** the tiles are visible but show "not enough history yet" until they can be
computed honestly.

---

### 4. Do you want a permanent demo account, and who gets to use it?

**Why it matters.** We are building one environment, so demos and sales conversations run against
the real system on a seeded test account. That account has to be excluded from all your platform
numbers, or your revenue and client counts quietly include a fake customer.

We are building the exclusion regardless. What we need to know is the shape of it:

- **Is this a permanent sales-demo account** you or your team will show to prospective coaches on
  calls, or a temporary thing that goes away after launch? Permanent means it needs looking after —
  the conversations in it should look plausible and current rather than obviously six months stale.
- **Who logs into it?** If several people on your team demo from the same account they will be
  editing the same agent, and one person's demo prep changes what the next person shows.

**If we don't hear back:** one permanent demo account, excluded from every platform figure, badged
clearly as demo everywhere it appears in the admin console, with access limited to your team.

---

### 5. Do your coaches actually run keyword campaigns?

**Why it matters.** The coach home screen carries a keyword performance table — one row per campaign
trigger word, showing how each performs. Building the attribution properly is real work, and it
only pays off if coaches run traffic that way.

The mechanism assumes a lead arrives having used a specific word ("FUNDING", "CREDIT") in a comment
or an ad, and we capture that word at the moment the conversation starts. Leads who just DM the coach
directly, or reply to an SMS, have no keyword — and if that is most of your coaches' traffic, the
table will show one large "No keyword" row and a handful of tiny ones, which is a worse screen than
not having the table.

So: **do your coaches run comment-to-DM or keyword-triggered campaigns today, and roughly what share
of their inbound comes in that way?** If it is a meaningful share we build it as specified. If it is
marginal, we would rather spend that effort on the trend graph and tell you why.

**If we don't hear back:** we build keyword attribution as specified, with an explicit "No keyword"
row so the table always accounts for every lead.

---

---

## §13 — Pricing, plans, and billing disputes

### Before the questions: none of this blocks the build

Worth saying up front, because the list looks heavier than it is. Every pricing model below needs
exactly the same thing underneath it: **an accurate, per-coach, per-month count of leads the agent
handled and calls it booked, correctable by a human with a reason recorded.** That is the part we
are building either way, and it is the part that is hard.

The pricing formula sits on top of that count. Changing it later is changing a calculation, not
rebuilding a system. So take the time you need on Q1 — we are not waiting on it.

Each question ends with **"If we don't hear back"** — what ships in the meantime.

---

### 1. How should coaches be charged?

**Why it matters.** The plan currently says three flat monthly prices with a booked-call allowance:
$297 up to 25 booked calls, $597 up to 75, $997 above that. We want to re-open that with you rather
than build it by default, because it is the single decision that shapes what every screen in the
product says, and because we never put the full set of options in front of you.

Four models are genuinely buildable:

**A. Flat plans with an allowance** *(what is currently specified)*. $297 / $597 / $997, each with a
booked-call allowance. Predictable for the coach, predictable for you. The awkward moment is the
coach who goes one call over — see Q1a below.

**B. Pay per booked call.** No monthly floor, or a small one, and a fixed price per call the agent
books. Perfectly aligned: they pay when it works. Harder for you to forecast, and a quiet month for
a coach is a quiet month for you.

**C. Base plus overage.** A monthly base that includes an allowance, then a per-call price beyond
it. The middle path, and the one that most usage products land on. The cost is that the coach's
dashboard becomes a running bill — we would need to change how the booked-call counter is presented,
because it is currently designed to read as an achievement ("18 of 25"), never as money owed.

**D. Pay per lead handled.** Charge on conversations the agent worked rather than calls it booked.
Reflects the work done even when a lead was never going to book. **One caution, and it is real:** it
multiplies the number of things a coach can dispute. Disputing 25 booked calls is a conversation.
Disputing 400 handled leads is a spreadsheet, every month, for every coach.

**What we have ruled out:** paying per closed deal. We would love to price on your coaches' actual
outcomes, but the platform cannot see whether a coach closed anybody — that happens on a sales call
we are not in, in a CRM we do not read. Any number we charged against would be self-reported, and a
number the customer types is not a billing input.

**Two things we need from you alongside the choice:**

**Q1a. If you stay with flat plans — what happens on booked call #26 for a $297 coach?** We have
assumed: nothing that month, and their next month bills at $597. They keep working, they are told
before it happens, and you can override the price for an individual coach if a good customer went
one call over. The alternatives are cutting the agent off at 25 (nobody wants that), charging per
extra call (changes the dashboard, see C), or jumping the price mid-month (chargebacks).

**Q1b. Do the terms coaches agree to at signup cover an automatic price increase?** If they do not,
the upgrade has to be something the coach confirms rather than something that happens to them. That
is a small change to the flow and no change at all to the counting, but it is much cheaper to know
now.

**If we don't hear back:** we build A with automatic upgrade at the start of the next cycle,
advance warning to the coach, and a per-coach price override for you. That is what the contract and
the current demo already describe, so it is the least surprising default.

---

### 2. If a lead books a call and then cancels — or just doesn't turn up — does it still count?

**Why it matters.** It decides what a coach is actually buying. Our position is that it counts: the
agent did the job the coach pays for when it put a qualified lead on the calendar, and whether that
person shows up is outside the agent's control.

There is also a practical problem with the alternative. The platform has no way to *see* whether a
call happened — no join event, no recording, nothing. The only source is the coach marking their own
calendar, and that is asking the person who pays the bill to type the number the bill is based on.
Every genuinely ambiguous call becomes a no-show, and neither of us can tell the honest coaches from
the rest.

What we would rather do is give the coach a simple way to record how a call went **without it
touching the bill** — so the number stays honest and both of you can see which leads actually turn
up, which is a far more useful figure for coaching the agent. Then the genuinely unfair cases (an
obviously junk booking, a duplicate) go through the correction path in Q3, where a human looks at
it and can spot a pattern.

**If we don't hear back:** booked means booked. Cancellations and no-shows do not reduce the count
automatically, and the correction path handles the exceptions.

---

### 3. Who can correct a booked-call count, and can a coach ask?

**Why it matters.** Outcome-based pricing guarantees disagreements, so there has to be a civil way
to resolve one. The question is who holds the pen.

Our plan: **the coach raises it with a reason, and your team approves or rejects it.** Nothing gets
changed silently, the original number is never overwritten (a correction is recorded as a separate
adjustment, so the history of what was disputed and by whom survives), and your side sees every
request in one place — which also means you can see if one coach disputes a third of their calls
every month.

Two things to confirm: **(a)** are you happy for coaches to raise these themselves, or would you
rather they go through your support team and never see a "dispute" button at all? **(b)** which of
your people can approve one? Right now the plan gives billing access to owner/admin only, which
means your success people can take the complaint but not resolve it. That may be exactly what you
want. It may also mean everything lands on you.

**If we don't hear back:** the coach can request a correction with a mandatory reason, and only
owner/admin can approve it.

---

### 4. When a coach's payment fails, what should happen to their agent?

**Why it matters.** The plan says a failed payment marks the account overdue and alerts your team,
and then says nothing about what the coach's agent actually does.

Our position: **while the card is retrying, nothing visible happens — the agent keeps working.** A
failed card is usually a card, not a decision, and switching the agent off means one of that coach's
leads gets silence in the middle of a conversation with a real person on the other end. That is a
bad look for your coach in front of *their* customer, and the support call comes to us.

If it is still unpaid after that, our position is that we stop the agent taking on *new* leads
rather than switching it off — anyone already mid-conversation gets a proper ending rather than
being ghosted. Turning an account fully off stays a deliberate decision by your team, not something
that happens automatically.

You may want this harder than we have written it. It is your revenue and your relationship with
these coaches, and you know which of them are worth the patience.

**If we don't hear back:** the agent runs through the retry window, then stops taking new
conversations while finishing the ones it is in. Full suspension stays a manual action.

---

### 5. Stripe — whose account, and what is already on it?

**Why it matters.** This is the one item on this list that genuinely blocks work, and it has been
open since week 5.

It needs to be **Live Legacy Strong's Stripe account**, not ours — affiliate commission is money
moving out of it, and that has to sit with you. What we need to know is whether the account already
exists, whether anything is configured on it, and who can give us access to set up the plans.

We can also confirm one thing that simplifies this a lot: because we are moving to flat plans that
change at the end of a cycle rather than charging per unit, **we do not need any of Stripe's
usage-metering features.** Plain subscriptions and a price change. That is a much smaller ask of
the account than the original plan assumed.

**If we don't hear back:** we build everything against a test account of ours and switch it over.
That works, but it is the one thing that cannot be finished without you, and it will be the last
thing standing before launch.

---

### 6. The fair-use number on the top tier

**Why it matters.** The demo you have seen says the $997 tier gets "human review above 120 calls."
**We made 120 up** to have something on the screen. It has never been checked against what your
coaches actually do.

What we need is the number, or a rough sense of it: at what monthly booked-call volume would you
want to have a conversation with a coach rather than just let it run? It does not have to be exact —
it is a trigger for a human to look, not a hard limit.

**If we don't hear back:** 120 ships as the review threshold, and it is one number to change later.

---

### What we are getting on with meanwhile on §13

The counting itself, the correction flow, the record of who changed what and why, and the plan
structure with three editable tiers and per-coach overrides. None of it depends on which pricing
model you land on, which is why we would rather you took a proper look at Q1 than answered it
quickly.

---

## §14 — Affiliates and commission

### 1. When a referred coach cancels, what happens to commission already earned?

**Why it matters.** The plan says there is a "clawback" when a referred coach cancels, and does not
say how far back it reaches. A coach who signs up in January and cancels in September has generated
eight months of commission. Is that reversed, or does the affiliate keep it and simply stop earning?

**What we have built:** future commission stops, anything not yet paid out is reversed, and money
already sent to the affiliate is not reclaimed.

Two reasons, and you may disagree with both. First, an affiliate who can lose eight months of
earnings because someone else churned will stop promoting you — and the whole point of the programme
is that they promote you. Second, and more practically: payouts are manual, so once you have sent
someone their money there is no mechanism to take it back. A rule that reaches further than that
produces an argument rather than a recovery.

**One thing worth separating.** We have treated *cancelling* and *being refunded* as different
events. A coach who paid for six months and then leaves has given you six months of revenue — the
affiliate earned that. A coach who charges back or gets refunded has taken the money back, and there
we do reverse the commission, because otherwise you are paying 10% of money you no longer have.

**If we don't hear back:** cancellation stops future commission and reverses anything unpaid;
refunds and chargebacks reverse the commission for the period refunded; nothing already sent is
reclaimed.

---

### 2. Is the 10% on the list price, or on what the coach actually paid?

**Why it matters.** These are the same number until you discount someone, and then they are not.

The system supports setting a custom price for an individual coach. If a coach on the $597 tier is
paying $450 because you agreed a rate with them, does their affiliate earn $59.70 or $45?

**What we have built:** 10% of what the coach actually paid. Two consequences worth being explicit
about, because they cut both ways:

- If you comp an account — invoice at zero — no commission is generated. Under the other rule, a
  free account would still create a $59.70 monthly liability, which is almost certainly not what
  anyone intends.
- If you discount someone, their affiliate earns less than the headline. An affiliate might
  reasonably feel that a discount you chose to give should not come out of their commission.

**We have also excluded tax from the base.** If a coach pays $597 plus tax, commission is on the
$597. Otherwise you are paying an affiliate 10% of tax you hand straight to the government.

**If we don't hear back:** 10% of the amount actually collected, after any discount, before tax.

---

### 3. Twelve months from when, exactly?

**Why it matters.** The programme is "10% recurring for up to 12 months per referred coach." We have
built that as **twelve calendar months from the referred coach's first payment** — so the clock runs
whether or not they pay every month.

The other reading is twelve *payments*. If a coach pauses for three months and comes back, the
calendar reading gives their affiliate nine paid months and the payment reading gives them twelve.
An affiliate will read it the second way; it is the more generous interpretation and the one that
sounds like what was promised.

**If we don't hear back:** twelve calendar months from the first payment.

---

### 4. What may an affiliate see about the coaches they referred?

**Why it matters.** The plan says an affiliate sees the referred coach's name, status, and
commission earned — and nothing else. We want to confirm what "name" means, because the affiliate
portal is the one surface where one of your customers sees information about another.

**What we have built:** the coach's business name, whether their account is active, and the
commission earned. No performance data — not their lead volume, not their booked calls, nothing
about how well their agent is doing.

The question is whether a business name is right, or whether your affiliates introduce people
personally and would expect the person's name. And whether "status" should be as coarse as
active/inactive, or whether an affiliate should be able to see that a referral has gone overdue —
which is arguably useful to them and arguably none of their business.

**If we don't hear back:** business name, active/inactive, and commission earned.

---

### 5. Who actually pays affiliates, and how?

**Why it matters.** We want to be clear about what the system does and does not do, because getting
this wrong means an affiliate sits waiting for money that was never going to arrive.

**In the first version the platform does not move money.** It calculates what each affiliate is
owed, shows you the ledger, and lets you record that you have paid someone — but the payment itself
happens wherever you normally send money. Automatic payouts through Stripe are a later phase.

So we need to know: **how will you actually pay them**, and do you want the affiliate to see a
"pending payout" state before you have sent it? We would rather show them "approved, payment on its
way" than a bare "Paid" that means "Alec ticked a box," because the second one generates a support
message every time there is a lag.

**If we don't hear back:** the ledger shows what is owed, you mark items paid with a reference, and
the affiliate sees "approved for payout" until you do.

---

---

## §15 — Who on your team can do what

### 1. When your team looks inside a coach's account, does the coach get told?

**Why it matters.** Your admins and support people can open a coach's account and see exactly what
the coach sees — that is how you answer "my agent is doing something weird" without a screenshare.
It is genuinely useful and we are building it.

Two things about it we have decided already, and you should know both. **Your team can look but not
touch**: while viewing a coach's account nobody can change anything, because a support person
clicking something on a coach's screen and altering their settings is the kind of accident that is
invisible until it causes a problem. Anything your team needs to change on a coach's behalf goes
through a separate action that records it properly. And **every session is recorded** — who opened
it, which coach, why, and for how long — so if a coach ever asks, you have the answer.

**The question is whether the coach is told at the time.** Some platforms show a banner. Some send
an email afterwards. Some say nothing and rely on the terms of service.

We have gone with **saying nothing in the app**, because a banner appearing while somebody is
routinely helping them will alarm coaches more often than it reassures them, and the record exists
either way. But this is a trust question about your customers and you may feel differently —
especially since coaches in this industry are handling their clients' financial information and may
be sensitive about who can see their accounts.

**If we don't hear back:** your team can view a coach's account read-only, every session is recorded
with a reason, and the coach is not notified at the time.

---

### 2. Can your support people approve a billing correction, or only you and your admins?

**Why it matters.** We have built a flow where a coach who thinks they were billed for something
wrong submits a correction request with a reason, and someone on your side approves or rejects it.
The question is who "someone" is.

**We have restricted it to you and your admins**, and deliberately left your success/support people
out. The reason is not that we distrust them — it is that they are the ones with the ongoing
relationship with the coach, so they are the ones who will be asked directly, repeatedly, by
somebody they speak to every week. Taking that decision off their desk protects them as much as it
protects the numbers.

The cost is a bottleneck: if a correction can only be approved by two or three people, corrections
wait. If your support team is bigger than your admin team and this is going to be a regular
occurrence, the middle path is letting support approve up to a value — say anything under a couple
of calls — with anything larger escalating. Tell us which shape fits your team.

**If we don't hear back:** only owner and admin accounts approve corrections.

---

### 3. Should a coach be able to see the history of changes to their own account?

**Why it matters.** We keep a permanent record of every significant thing that happens to a coach's
account — tier changed, price adjusted, agent paused, offer edited on their behalf, account
suspended. Right now that record is for your team only.

There is a decent argument for showing coaches their own slice of it. "Your plan was changed on 14
August by Alec" answers a question before it becomes a support message, and it is their account.
The argument against is that the same record carries your team's internal reasoning — a note
attached to a suspension is written for your team, not for the coach reading it later.

**What we have built:** no coach-facing history in version one, but the mechanism is built so it can
be switched on for specific actions later without any rework. So you could, for example, show
coaches every billing change while keeping support and compliance actions internal.

**If we don't hear back:** internal only, with the switch available per action whenever you want it.

---

### 4. Can one person be both a coach and an affiliate?

**Why it matters.** A coach who is happy with the platform is your single best referrer, and right
now the system cannot represent that person — they would need two separate logins under two
different email addresses, which is enough friction that they would not bother.

We can fix that cleanly, and it is a small change. But whether you *want* it is a commercial
question rather than a technical one, and there are two versions of the answer.

If a coach refers another coach, they earn 10% of that coach's subscription for twelve months, same
as any affiliate. That is straightforwardly good — it turns your customers into a sales channel at
no upfront cost. The thing to be aware of is that it also creates an incentive that did not exist
before: coaches talking to each other about pricing, and a coach who refers several others becoming
someone whose commission matters more to them than their own subscription.

**If we don't hear back:** we build it so one login can be both, since the alternative is a change
that gets harder later, and you can simply not promote it if you would rather coaches did not refer.

---

### 5. Who answers coach support messages, and does the coach see who is assigned?

**Why it matters.** There is a support thread on every coach's account — they message, your team
replies, it lands in your admin inbox. We are building it, and two details shape how it feels.

**Does the coach see a name?** If each coach has an assigned success person, showing "Sarah is
looking after your account" makes the platform feel staffed rather than automated, which is worth a
lot in a product where the rest of the conversation is with an AI. The cost is that coaches then
notice when Sarah is on holiday and someone else replies, and they will ask.

**And can your team write private notes on a coach's thread?** We are building it so they can — your
people will want to leave context for each other, and those notes are never visible to the coach.
Worth confirming you want that rather than a separate internal channel.

**If we don't hear back:** the coach sees that a named person is assigned to them, any of your team
can reply, and internal notes on the thread stay internal.

---

---

## §16 — Alerts, exports, and what your team gets at handover

### 1. Who is running this after we hand it over?

**Why it matters.** Everything we write for the handover — the guides, the runbook, the recorded
walkthroughs — is pitched at a specific reader, and the two possible readers need genuinely
different documents. Someone technical can be handed the database and a diagram and get on with it.
You and an operations person need every procedure written as things you click, with anything that
needs a developer clearly marked as "call us" rather than buried as step four.

We know your systems lead has moved on and that a replacement is expected. What we do not know is
whether that person will be in the seat before launch, and it changes what we build rather than just
how much we write.

**We are writing for the non-technical reader**, because it degrades gracefully in one direction
only. A technical hire arriving in month two reads the plain-English version perfectly well and then
asks us for the technical detail, which we have and can hand over in an afternoon. The reverse does
not work — an operations person handed a technical runbook is stuck, and rewriting it properly at
that point is a fortnight nobody scheduled.

The related question is what happens in week nine when somebody is stuck and the runbook does not
cover it. We are documenting a named escalation path as part of the package. What that path is
commercially is yours to say, and we would rather write it down than leave it as an assumption on
both sides.

**If we don't hear back:** everything is written for you plus a non-technical operator, and the
handover documents an escalation route to us without committing you to anything.

---

### 2. Which two walkthroughs do you want recorded?

**Why it matters.** Two recorded walkthroughs are in the deliverables and nobody has said which two.
Recording them is cheap; recording the wrong two costs you the one document people actually watch.

**Our pick is the two things that go wrong loudly.** The first is diagnosing a coach who says the
agent is behaving oddly — starting from the health view, into the conversation, into the trace that
shows why the agent said what it said, and taking over the thread by hand if you need to. That is
the single most common support call any platform like this gets.

The second is publishing a change to the shared brain — writing the draft, running it against the
test cases, publishing it, and rolling it back. That one is on the list because it is the action
that touches every coach at once, so it is the one where a mistake is expensive and the person doing
it is usually in a hurry.

The obvious alternative is recording the signup and onboarding flow, and we would push back on that:
the product already walks people through onboarding on screen, so a video of it documents the part
that needs the least documenting.

**If we don't hear back:** we record the diagnostic walkthrough and the brain publish walkthrough.

---

### 3. Where should billing notices go — the coach's login email, or a separate billing address?

**Why it matters.** A few messages we send are not really notifications, they are notices — you have
reached 90% of your included calls, and your plan is moving up on the 21st. We have decided those
cannot be switched off, because a coach who mutes them finds out their bill changed when the charge
lands, and that becomes a support conversation and a refund request rather than a heads-up.

Since they cannot be muted, the address matters more than usual. Right now the only address we hold
for a new coach is whatever they logged in with, which for a coaching business is often a personal
address or a shared inbox rather than whoever handles the money. There is a billing contact field in
settings, but nothing asks for it at signup, so between signing up and someone remembering to fill it
in there is a gap where the notice lands wherever.

**If we don't hear back:** billing notices go to the billing contact when one is set and to the
login email when it is not, and the message says which address it went to so it is obvious when it
is the wrong one.

---

### 4. Does your team actually use Slack — and one channel or one per person?

**Why it matters.** Slack is one of the three places alerts can go, and it was specified before
anyone checked whether your team uses it. If you are on Teams, or you run on WhatsApp, or you simply
do not want another feed, then we are building a destination nobody switches on — and we would
rather spend that time on the two destinations you will use.

If you do use it, the shape question is whether alerts land in one shared channel for the whole team
or whether each person points it at themselves. A shared channel is better for anything the team
covers collectively — payment failures, stalled onboardings — because whoever is around picks it up
and nobody has to be on holiday-cover duty. Per-person is better when each success person owns their
own book and only wants their own clients.

**If we don't hear back:** we build one shared team channel per destination, which is the
lower-maintenance shape, and per-person routing stays available for email.

---

### 5. When a coach cancels, how long do they keep access to their data?

**Why it matters.** Two different things are involved and they deserve different answers.

Their **contact list and conversation history** is their data, and the decent thing is a window to
export it after they cancel. How long is a business call — thirty days is common, and shorter reads
as punitive while longer means we are storing consumer records for people who are no longer
customers, which is a liability rather than a service.

The **do-not-contact list** is different, and stricter. It is the record of every person who told
that coach's agent to stop texting them, and the coach is legally obliged to keep honouring it
whether or not they are still your customer. If that list disappears with their account, we have
turned your billing decision into their compliance problem, and the person who gets hurt is a
consumer who asked to be left alone and then gets texted from the coach's next system.

**Our position is that the do-not-contact list outlives access** — it stays exportable to a
cancelled coach, and it is worth saying so in your terms so nobody is surprised. The contact list we
would keep to a defined window.

**If we don't hear back:** thirty days of export access for contacts and history after cancellation,
and the do-not-contact list stays available beyond that.

---
