# The Brain — content request

**For:** Alec Delpuech, Live Legacy Strong
**From:** Ayman, Hexona Systems
**Date:** 2026-08-15

---

## What this is, and why it is the only thing we cannot build for you

The Brain is the shared knowledge every coach's agent inherits. We have finished specifying the
machine around it — how the pieces get assembled into the agent's instructions, how a change gets
reviewed and published to every coach at once, how versions and rollback work. That part is ours
and it is on track.

What the machine has no way to invent is the content. Right now the agent knows 46 FAQ answers
pulled from your Notion sheet and nothing else. It has never been told who it is, what a good lead
looks like to you, what it must never say, or how to handle the objections your setters hear every
day. Those are judgment calls about your business, and a wrong guess from us reads as your brand
saying something you would not say.

**This is written to be filled in, not composed from scratch.** Every section gives you a worked
example, and most give you a starting draft to redline. Crossing things out is faster than facing
a blank box, and disagreeing with our draft tells us more than an empty field would.

Sections are ordered by how much they unblock. Section 1 affects every single message the agent
ever sends; section 7 is a yes/no question. **If you only have an hour, do 1, 2, and 3.**

Each section ends with **"If we don't hear back"** — what ships in the meantime. Nothing here
blocks the build. It just decides whether the agent sounds like Live Legacy Strong or like a
generic chatbot that read your FAQ.

---

## 1. Mission — who the agent is

**Why it matters.** These six fields sit at the top of the agent's instructions on every message
to every lead across every coach. They are the single highest-leverage text in the system: change
one line here and the tone of every conversation on the platform changes.

**What breaks without it.** The agent defaults to a generic helpful-assistant voice. It will be
polite, it will be accurate about your FAQs, and it will sound like nobody in particular. It also
has no stated goal, so it drifts toward answering questions instead of driving toward a booked
call — which is the entire point of the product.

**Length guidance.** Identity, Goal, and Tone: 3–6 sentences each. Criteria, Guardrails, and DQ:
up to about a dozen lines each. These are hard limits in the system because every word is re-sent
on every message. Short and specific beats long and hedged.

### 1.1 Identity — who is speaking

> *Worked example (replace it):* "You are the front-desk setter for a credit and business-funding
> coaching practice. You are not the coach and you never claim to be. You are the person who
> figures out whether someone is a fit and, if they are, gets them onto the coach's calendar. You
> have talked to thousands of people in this exact situation and it shows — you are calm, you are
> not impressed or alarmed by anyone's credit situation, and you have heard every version of every
> story."

**Does the agent have a name?** ☐ No, it stays unnamed  ☐ Yes: ______________________

**Does it disclose that it is AI if asked directly?** ☐ Yes, always  ☐ Deflect  ☐ Other: ________

*(Our strong recommendation is "yes, always" — Meta's messaging policies and general platform risk
both point the same way, and leads who catch a denial react badly.)*

**Your Identity:**

```
_______________________________________________________________________________
_______________________________________________________________________________
_______________________________________________________________________________
```

### 1.2 Goal — what a successful conversation produces

> *Worked example:* "Your goal is a booked call with a lead who actually qualifies. A booked call
> with someone who will be disqualified on the call is worse than no booking — it wastes the
> coach's calendar and the lead's time. You are measured on qualified bookings, not on total
> bookings and not on how pleasant the conversation was."

**Your Goal:**

```
_______________________________________________________________________________
_______________________________________________________________________________
```

### 1.3 Tone — how it sounds

Pick the closest and then tell us what is wrong with it:

☐ **Warm and direct** — friendly but gets to the point, asks the hard question without apologizing
☐ **Consultative** — more listening, more reflecting back, slower to ask for the booking
☐ **High-energy** — enthusiastic, momentum-driven, closer-style
☐ **Other:** ______________________

**Three things it should never sound like** (e.g. "never sound like a used-car salesman", "never
sound like a bank"):

1. ______________________
2. ______________________
3. ______________________

**Is there a real person whose style we should match?** If one of your setters is the standard,
name them and we will pull tone from their transcripts rather than guessing.

______________________

**Your Tone:**

```
_______________________________________________________________________________
_______________________________________________________________________________
```

### 1.4 Criteria — what a good lead looks like, in words

This is the plain-English version. Section 3 turns it into the actual decision table; this field
is what the agent uses for the in-between cases the table does not cover.

> *Worked example:* "A good lead has a real business or a concrete plan to start one, has credit
> that is either already usable or fixable within a few months, wants funding for something
> specific rather than 'just exploring', and can act in the next 90 days. Someone who is curious
> but has no business idea and no timeline is not a good lead no matter how good their credit is."

**Your Criteria:**

```
_______________________________________________________________________________
_______________________________________________________________________________
_______________________________________________________________________________
```

### 1.5 Guardrails — what it must never do

> *Starter draft — cross out what you disagree with, add what is missing:*
>
> - Never quote a price, a rate, or a fee that is not in the coach's own offer settings.
> - Never promise a funding amount, an approval, or a timeline.
> - Never give credit repair advice, legal advice, or tax advice.
> - Never dispute or coach anyone on disputing items on a credit report.
> - Never speculate about what a lender will or will not do.
> - Never continue selling after someone says stop, unsubscribe, or asks to be left alone.
> - Never claim to be a lender, a broker, or a credit repair organization.
> - Never invent a case study, a testimonial, or a client result.

**Add or remove:**

```
_______________________________________________________________________________
_______________________________________________________________________________
```

### 1.6 DQ — how it decides someone is not a fit

Two flavors, and the difference matters because they produce different endings (see section 5).

**Soft DQ** — not now, but worth staying in touch with. *Example: credit is 580 but they are
already in a repair program and expect to be at 660 in four months.*

**Hard DQ** — never a fit, close the conversation cleanly. *Example: outside the country, no
business and no intention of starting one, or looking for a personal loan.*

**What makes someone a hard DQ, in your words?**

```
_______________________________________________________________________________
_______________________________________________________________________________
```

**If we don't hear back:** we write a neutral, competent Mission from your FAQ answers and your
sales materials. It will be safe and it will be generic. This is the one section where our draft
is most likely to be subtly wrong, because it encodes judgment we do not have.

---

## 2. Compliance — what the agent can never say

**Why it matters.** This list is enforced at the platform level, above anything a coach can
configure. A coach cannot switch it off, and the agent cannot be talked out of it by a lead. It is
also what the safety test suite tests against before any change publishes.

**What breaks without it.** We ship our starter list, which is built from general credit and
lending compliance practice rather than from your counsel or your history. If there is specific
language your industry has gotten in trouble for — or specific language *you* have gotten a
complaint about — we do not know it, and the agent will happily use it.

### 2.1 Hard-blocked phrases

> *Starter draft — this is the list we will ship if you do nothing. Redline it.*
>
> The agent must never say, imply, or agree with:
>
> | Blocked | Because |
> |---|---|
> | "guaranteed approval" / "you will be approved" | Promises an outcome no one controls |
> | "we can remove that from your credit report" | Credit repair claim; regulated activity |
> | "this will raise your score by N points" | Specific outcome promise |
> | "no credit check" | Almost never true and draws complaints |
> | "risk-free" / "nothing to lose" | Implies a guarantee that does not exist |
> | "the bank will definitely…" | Speculating on a third party's decision |
> | "you qualify" (before a human has confirmed) | Only the coach qualifies anyone on the call |
> | "0% forever" / any rate stated as permanent | Rate claims the coach does not control |

**Remove any of these:** ______________________

**Add these:**

1. ______________________
2. ______________________
3. ______________________
4. ______________________

### 2.2 The gray zone

Some things are fine to say *carefully* and terrible to say *casually*. Tell us which side each of
these falls on:

| Statement | Fine | Never | Only with a qualifier |
|---|:---:|:---:|:---:|
| Naming a typical funding range clients have received | ☐ | ☐ | ☐ |
| Saying a specific credit score is "usually enough" | ☐ | ☐ | ☐ |
| Mentioning how long the process typically takes | ☐ | ☐ | ☐ |
| Referring to a past client's result without a name | ☐ | ☐ | ☐ |
| Saying the coach "specializes in" a particular situation | ☐ | ☐ | ☐ |

**If a lead asks a question that lands in a blocked area, what should the agent do?**

☐ Say it is not something it can speak to, and offer to get it answered on the call *(default)*
☐ Answer with a heavy qualifier
☐ Other: ______________________

**If we don't hear back:** the starter list above ships as-is and the gray-zone rows all default to
"only with a qualifier."

---

## 3. Qualification — the decision table

**Why it matters.** This is the actual logic that decides BOOK, SOFT DQ, or HARD DQ. It is the
single most consequential table in the product, because it determines which leads reach your
coaches' calendars.

**What breaks without it.** The table currently holds values *we* seeded so the screens would
render. They are placeholders. Nobody at Live Legacy Strong has confirmed a single cell. If they
ship unconfirmed, the agent will be making real routing decisions on our guesses about your
business, and the first sign of a problem will be a coach complaining about their calendar.

**How to fill it in.** Rather than 72 individual combinations, mark the base outcome for each
credit band and business stage below, then note the exceptions. The table stays editable in the
admin screen afterward — this is the starting point, not a permanent commitment.

### 3.1 Base outcomes

Mark one per cell: **B** = book the call · **S** = soft DQ (nurture) · **H** = hard DQ (close out)

| Credit | Startup (no revenue yet) | Operating business | Stage unknown |
|---|:---:|:---:|:---:|
| **700+** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |
| **680–700** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |
| **640–680** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |
| **600–640** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |
| **Below 600** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |
| **Unknown / won't say** | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H | ☐ B ☐ S ☐ H |

*(For reference, the values we seeded — which are guesses — were: 700+ books regardless of stage,
below 600 hard DQs, and 600–640 startups soft DQ.)*

### 3.2 Funding amount as a modifier

Does the amount they are asking for change any of the above?

☐ No, credit and stage decide it
☐ Yes — describe: e.g. "under $50K with sub-640 credit is a soft DQ even if the table says book"

```
_______________________________________________________________________________
```

### 3.3 Timeline as a modifier

Someone who says they are "just exploring" with no timeline:

☐ Still book if the table says book
☐ Always soft DQ regardless of credit
☐ Other: ______________________

### 3.4 The unknown case

A lot of leads will not know their credit score. What should the agent do?

☐ Ask them to check and come back *(risks losing them)*
☐ Ask a proxy question instead — which one? ______________________
☐ Book anyway and let the coach sort it out on the call
☐ Other: ______________________

**If we don't hear back:** the seeded values ship, clearly marked in the admin screen as
unconfirmed, and we raise it again before launch. This is the section where an unanswered question
has the most expensive consequences.

---

## 4. Objections — what your setters actually say

**Why it matters.** Objection handling is where a setter earns their money, and it is the part of
the conversation a generic model handles worst. The agent matches an incoming lead message against
these patterns and uses your response as the basis for its reply.

**What breaks without it.** This table is completely empty today. With nothing in it the agent
improvises from general sales instincts, which is exactly the behavior that produces an
overpromise. Every objection you fill in is one fewer place the agent has to invent something.

**Five categories** (these are fixed in the product):

| Category | What lands here |
|---|---|
| **Timing** | "not right now", "call me next quarter", "I'm in the middle of something" |
| **Clarity** | "what exactly is this?", "how does it work?", "is this a loan?" |
| **Pricing** | "how much does it cost?", "is this free?", "what's the catch?" |
| **Compliance** | "is this legal?", "will this hurt my credit?", "are you a credit repair company?" |
| **Partner** | "I need to talk to my spouse / business partner first" |

Any objection can also be marked **hard-gated**, meaning the agent must use your wording closely
rather than paraphrasing. Pricing and compliance answers are usually hard-gated.

### 4.1 Fill in at least three per category

> *Worked example (Timing):*
>
> - **Lead says:** "I'm not ready yet, maybe in a few months."
> - **Agent responds:** "Totally fair — most people we talk to aren't ready on day one. Quick
>   question though: is it a timing thing on your end, or is there something specific you'd need
>   to have sorted first? Reason I ask is the prep work usually takes longer than people expect,
>   so the call is often more useful *before* you're ready than after."
> - **Hard-gated:** ☐

**Timing**

| Lead says | Agent responds | Hard-gated |
|---|---|:---:|
| | | ☐ |
| | | ☐ |
| | | ☐ |

**Clarity**

| Lead says | Agent responds | Hard-gated |
|---|---|:---:|
| | | ☐ |
| | | ☐ |
| | | ☐ |

**Pricing**

| Lead says | Agent responds | Hard-gated |
|---|---|:---:|
| | | ☐ |
| | | ☐ |
| | | ☐ |

**Compliance**

| Lead says | Agent responds | Hard-gated |
|---|---|:---:|
| | | ☐ |
| | | ☐ |
| | | ☐ |

**Partner**

| Lead says | Agent responds | Hard-gated |
|---|---|:---:|
| | | ☐ |
| | | ☐ |
| | | ☐ |

### 4.2 A faster alternative

If writing these out is slow, send us **five to ten real DM transcripts** where a setter handled an
objection well, and we will draft the table from them for you to approve. Transcripts are better
than written answers anyway, because they capture how your people actually phrase things.

☐ I'll fill in the table  ☐ I'll send transcripts instead  ☐ Both

**If we don't hear back:** the objection table ships empty and the agent handles objections from
general reasoning, constrained by the compliance rules in section 2. It will not say anything
dangerous. It will also not say anything that sounds like your team.

---

## 5. How conversations end

**Why it matters.** Every conversation lands in one of four endings, and each one is a moment where
the wrong sentence costs you either a lead or a reputation.

**What breaks without it.** We write neutral defaults. The soft-DQ ending in particular is worth
your attention — it is the one where a warm lead is told "not yet", and the difference between
losing them and keeping them is entirely in the wording.

### 5.1 The booking moment

The lead qualifies and it is time to get them on the calendar.

> *Default draft:* "Based on what you've told me, you'd be a good fit for a call with [coach].
> Here's the link — grab whatever time works: [link]"

**Your version:** ______________________________________________________________

**After they book, should the agent keep talking?** ☐ Confirm and stop  ☐ Keep answering questions

### 5.2 Soft DQ — not now

> *Default draft:* "Honestly, based on where things are right now, a call probably wouldn't be the
> best use of your time yet. Here's what I'd focus on first: [X]. Reach back out when that's in
> place and we'll pick it up."

**What should go in the "[X]"** — what do you actually want a soft-DQ lead to go do?

______________________________________________________________

**Should the agent follow up later?** ☐ No  ☐ Yes, after ____ days  ☐ Only if they ask

**Your version:** ______________________________________________________________

### 5.3 Hard DQ — never a fit

> *Default draft:* "I don't think we're the right fit for what you're after — I'd rather tell you
> that than take up your time. Wish you the best with it."

**Your version:** ______________________________________________________________

### 5.4 The SMS provisioning window

Text messaging for each coach takes about three weeks to be approved by the carriers. This is
outside anyone's control and we show it honestly rather than pretending it is ready. A small number
of coaches will be **refused outright** rather than delayed — the carriers permanently reject credit
repair, loan marketing, and debt reduction, and the reviewer reads the coach's own website, so a
coach whose marketing promises credit fixes gets rejected on their own copy with no appeal.

**What should a coach see during that wait?**

> *Default draft:* "Text messaging is being registered with the carriers. This usually takes about
> three weeks and we'll email you the moment it's live. Instagram and Facebook are already running."

**And what should a permanently-rejected coach see?** This one needs your wording more than the
other, because it is the message that tells a paying customer they cannot have SMS at all.

**Your version:** ______________________________________________________________

**Your version:** ______________________________________________________________

**If we don't hear back:** the drafts above ship as written.

---

## 6. The FAQ sheet — a confirmation pass

**Why it matters.** Your `Prospect FAQ Sheet` is the only real content the agent has today. All 46
answers go into it directly.

**What breaks without it.** The sheet has not been touched in a while — the individual rows were
last edited **24 February 2025**, and the sheet itself **23 August 2025**. That is roughly eighteen
months since anyone changed an answer. If your offer, pricing posture, or process has moved since
then, the agent is confidently telling leads something that used to be true.

### 6.1 The pass we need

Go through the sheet and mark each row **keep / edit / drop**. You do not need to rewrite anything
— flagging the rows that are wrong is enough, and we will come back on those specifically.

☐ Done, sheet is marked up  ☐ Sheet is still accurate as-is  ☐ Need help — let's do it on a call

### 6.2 The placeholder slots

Several answers contain fill-in-the-blank slots that get replaced with each coach's own details
before the agent sees them. We found these:

| Slot in your sheet | We fill it from | Correct? |
|---|---|:---:|
| `[niche]` | The coach's program name | ☐ |
| `[target funding amount]` | The coach's funding range | ☐ |
| `[dream outcome]` | ⚠️ **We don't know where this comes from** | ☐ |
| `[requirements]` | The coach's qualification summary | ☐ |
| `[income qualifiers]` | ⚠️ **We don't know where this comes from** | ☐ |
| a bare `X` | We believe this is meant to be the booking link | ☐ |

**Where should `[dream outcome]` come from?** ______________________

**Where should `[income qualifiers]` come from?** ______________________

**Is the bare `X` the booking link?** ☐ Yes  ☐ No, it's: ______________________

*(These matter more than they look. If a slot cannot be filled for a particular coach, that answer
is hidden from their agent entirely rather than sent with a blank in it — so an unmapped slot means
a coach quietly loses answers.)*

**If we don't hear back:** all 46 answers ship as written, the two unmapped slots cause their
answers to be held back, and the bare `X` is treated as the booking link.

---

## 7. Where the knowledge lives going forward

**Why it matters.** One question, and it decides whether we build a sync system or not.

Your intake said "Supabase synced with Notion," which we took at face value — but the reason
behind it was never captured, and the reason is what decides the design.

**After the first import, where does your team edit this content?**

☐ **In Notion.** My team lives there and will keep authoring there.
  → We build a scheduled sync plus a "check Notion now" button, and a review screen where you
    approve or reject each incoming change before it reaches any agent.

☐ **In SetterFi.** Once it is imported, the Brain screen becomes the place we edit it.
  → Simpler. We import once and Notion becomes an archive.

☐ **Both, honestly.**
  → This is the one that costs the most, because two systems editing the same answer means
    something has to decide which version wins, and that "something" has to be a screen your team
    uses. Workable, but tell us now rather than later.

**If we don't hear back:** we import once, the Brain becomes the place to edit, and no sync is
built. Adding the sync later is straightforward; we just would rather not build it if nobody wants
it.

---

## Summary — what to do

| # | Section | Effort | If you skip it |
|---|---|---|---|
| 1 | Mission — six fields | ~30 min | Agent is competent but has no voice |
| 2 | Compliance — blocked language | ~15 min redline | Our general-practice list ships |
| 3 | Qualification matrix | ~20 min | **Our guesses route your leads** |
| 4 | Objections | ~45 min, or send transcripts | Agent improvises objection handling |
| 5 | Conversation endings | ~10 min | Neutral defaults ship |
| 6 | FAQ confirmation pass | ~30 min | 18-month-old answers ship as current |
| 7 | Notion sync question | 1 minute | One-time import, no sync built |

Sections 1, 2, and 3 are the ones worth protecting time for. If it is easier to talk through
than to write, a single 45-minute call gets us through 1 through 5 and we will write them up for
your approval afterward.
