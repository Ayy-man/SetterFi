# SetterFi marketing site: brief

Interviewed in session on 2026-09-03. Answers marked **verbatim** are the
owner's words. Answers marked **inferred** were not asked as a question and are
taken from the design canvas record (the ten header crosses, the C6 lock, the
existing page artboard) and from feedback given during the fork decision. The
owner should correct any inferred line before the build is treated as final.

## The eight interview answers

1. **Vibe, and references.** Inferred. The canvas record is consistent: the
   product speaks in first person ("I'll take the DMs from here"), the proof
   object is always a week of calendar, and the aesthetic the owner locked (C6
   Reply) is pale blue-grey, Archivo + IBM Plex Mono, one cobalt accent. During
   the fork the owner said the imagery should do the work: **verbatim:** "i just
   feel like we're too wordy the imagery maeks a lot of things obcious".
   Working vibe: quiet, evidential, one night, one week. No references named.
2. **The scroll journey, in their words.** Inferred from the C6 header and
   direction B, which the owner chose (**verbatim:** "B is good"). The journey
   the frames describe: the two weeks (the locked header), then down into the
   night where a DM arrives at 02:14 and gets answered, then the camera pulls
   back into morning and the booked week, ending where it began with the reply
   bubble as the way in.
3. **The energy curve.** Inferred. Calm and bright at the top, dark and close in
   the middle, brightest at Friday 11:00, then settled.
4. **How they should feel, stage by stage, and the one moment.** Inferred. See
   the feeling curve below. The one moment: the line from the 02:14 message
   draws itself across the world and lands on the Friday 11:00 slot, and the
   slot lights.
5. **One thing no site they have seen does.** Inferred from C5 Provenance and C9
   Sort on the canvas, which the owner kept as "the record of how it got
   there": every booking carries the message it came from, and the refusals stay
   on the page. The seed of the signature move.
6. **How far from premium-minimal.** **Verbatim (option chosen):** "Push
   bolder". Bigger type, harder contrast, a dark passage against the light
   ground, more confident motion, same palette.
7. **One unbroken world or distinct scenes.** **Verbatim:** "B is good" after
   asking to see both drawn (**verbatim:** "can you /design in an artifact #1
   and #2 for me to decide"). One unbroken world.
8. **Assets they already have.** **Verbatim (option chosen):** "Real product
   screenshots". Motion: **verbatim:** "generated footage not needed then", and
   on the image side **verbatim:** "use openrouter instead of kie". No footage
   is generated; motion is DOM, SVG and canvas driven from scroll.

## Product facts the page may state (from the repo's own page artboard)

- SetterFi is an AI setter for funding coaches. It answers, qualifies and books
  leads from Instagram and Messenger DMs; SMS after carrier review.
- It asks five things, in order: funding purpose, amount ($50k floor), timeline,
  credit range, then one judged branch (cash on hand, or revenue). Then it books,
  three days out at most.
- Seven hard stops: says stop, under 18, credit under 600 with no business, goal
  under $50k, hostile or selling to us, CPN or anything illegal, not the buyer.
- If a lead goes quiet: five touches (3h, 1d, 1d, 2d, 2d), all cancelled the
  moment they reply.
- The coach can take over any thread with one button.
- Live on Instagram, Messenger and the calendar the same afternoon.
- No verified statistics exist. **No counters, no invented numbers.** Times and
  names in the sample conversation are sample data and the page says so.

## The feeling curve

| # | Waypoint | Feeling | What on screen causes it |
|---|---|---|---|
| 1 | Your week | Recognition | The locked header: the same week twice, two booked beside nine. Light ground, the reply bubble waiting. |
| 2 | 02:14 | Unease | The camera pushes into the empty week's Sunday night, the ground goes dark, a phone lights up with an unread DM. |
| 3 | The thread | Intimacy | The camera holds on the phone and the conversation runs under the wheel: five questions asked and answered at 02:14 while the coach sleeps. No headline. |
| 4 | The answers | Clarity | The camera pulls back and the real console is there beside the phone, the five answers landed in their fields. |
| 5 | Friday 11:00 | **Relief (the peak)** | The ground is fully morning. A line draws itself from the 02:14 bubble across the world and lands on the Friday 11:00 slot, which lights. The rest of the week stays dim. |
| 6 | Meta hears about it | Leverage | Added 2026-09-04 at the owner's request. The camera crosses to a Meta Events Manager card and the QualifiedLead and Purchase events land in the coach's dataset. |
| 7 | Then the numbers | Proof | The camera crosses the world to the coach's own home screen: leads, booked calls, time to book (the demo workspace, labelled as a sample). |
| 8 | Your week | Resolve | The camera settles back on the wide shot it started from. The full week is now understood. The reply bubble is the way in. |

Adjacent feelings are all different. The peak has the longest hold and the
biggest visual change (the line, the light, the ground at its brightest).
Waypoint 4 is authored quieter than 5 so 5 has something to arrive from.

**Authored silence:** the transition from 3 to 4 is a pull-back with no copy on
screen for roughly 0.5vh. That is the breath before the answers land and is
intentional; the verification pass should not read it as dead scroll because
the camera is moving throughout.

## The peak

> "you scroll through the night watching it answer someone at two in the
> morning, and then a line draws itself from that message to a slot on Friday
> and the slot lights up."

Lives in waypoint 5. Gets the longest scroll span on the track, the brightest
ground, and the signature move.

## The tell-someone sentence

It's the site where you scroll through a coach's night and watch the line from
a 2am DM draw itself onto a Friday calendar slot.

## The signature move

**The provenance line.** A single SVG path that grows from the 02:14 bubble as
the visitor scrolls, travels with the camera across the world, and lands on the
Friday 11:00 slot. The slot lights only when the line arrives; scroll back and
the line retracts and the slot goes dim. It is the argument of the page (every
booking carries the message it came from) made into the one thing the visitor
does with their hand. Coded in the page, driven from the track position, engine
untouched.

## Grammar

Continuous world (uniqueness.md 2.4), in worldflight mode with one leg holding
a DOM world; the camera is a transform on that world driven from the track.
Why the other seven lost: the owner chose one unbroken world explicitly after
seeing both drawn. Filmic one-shot needs scrub clips and there is no footage;
chaptered editorial and cutlist are made of cuts, which is the opposite of the
brief; live surface would make the page the console itself, which is a strong
alternative but not what was chosen; typographic poster throws away the
calendar, which is the proof; gallery and split stage do not fit a single
night's story.

## Nav, hero, close

- Nav is a map: a fixed waypoint rail (Your week, 02:14, The thread, The
  answers, Friday 11:00), clickable, lit by track position. Wordmark beside it.
- Hero is an establishing position in the world: the C6 composition seen wide.
- Close is arrival back at the wide shot with the reply bubble as the object,
  and a one-line footer with privacy and contact.
- One CTA label everywhere: "Give me that week".
