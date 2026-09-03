# Fingerprints

Every site you build with **scroll-craft** gets one row here, appended after it
ships. The registry exists so your next build can prove it is a different page
rather than a re-skin of one you already made.

This file is **yours**. It starts empty on purpose: the gate is about not
repeating *yourself*, so it has nothing to say until you have built something.

The rules and the gate live in the skill's
`references/uniqueness.md`. Short version:

**A new build must differ from EVERY row below on at least 4 of the 6
dimensions.** Four against each row individually, not four on average across the
table. If a planned build fails, change the plan. Never edit a row to make room
for it.

The six dimensions are: **grammar**, **nav treatment**, **hero device**,
**act-sequence shape**, **close pattern**, **signature move**.

Dimension 6 is free, because a signature move is unique by definition. So the
gate really asks for three more out of the remaining five, and a build that
changes only grammar and world will fail it.

---

## The registry

| Build | Grammar | Nav treatment | Hero device | Act-sequence shape | Close pattern | Signature move | World | Port |
|---|---|---|---|---|---|---|---|---|
| setterfi (2026-09-03) | Continuous world (worldflight, one DOM leg, camera = transform on the world) | Wordmark plus Sign in and one CTA, no map (the owner removed the waypoint rail for production) | Establishing wide shot of a DOM world (the two calendars, no clip) | Dive and loop: wide, push into the night (dark ground), hold on the phone, pull back to the consoles, peak on Friday, then across the world to the Meta events card and the coach's numbers, settle back to the wide shot; 13vh track, 8 waypoints | Arrival back at the hero frame with the CTA as a world object (reply bubble) and a one-line footer | The provenance line: an SVG path draws from the 02:14 message across the world onto the Friday 11:00 slot, which lights only when it arrives | Pale blue-grey product world, Archivo + IBM Plex Mono, real console screenshots | 4531 |

*(empty: your first build has nothing to clear, so build whatever the interview
points at. From the second onwards, this table is the constraint.)*

---

## What is taken

Add a bullet here whenever a build claims something a later build should avoid
reusing: a grammar, a nav treatment, a close pattern, a signature move, an
act-count-and-length band. The shared columns are what the next build inherits
as a constraint, so writing them down is the whole point.

- Continuous world in worldflight with a DOM leg and a camera transform (setterfi).
- Dive-and-return sequence that closes on the hero frame (setterfi).
- The provenance line: a path that draws from a message to a calendar slot (setterfi).

---

## Appending a row

After shipping, add one line to the table and one bullet to **What is taken** if
the build claimed something new. Fill every column. Say what the build shares
with existing rows.

Rows are append-only. A build that has been superseded stays in the table,
because the space it occupies is still occupied.

---

## Worked example

The skill's author kept a registry of twelve builds across eight page grammars.
If you want to see what a filled-in table looks like, and which shapes tend to
collide, read `EXAMPLES.md` in the scroll-craft repository. Treat it as
illustration only: those rows are somebody else's builds and they do **not**
constrain yours.
