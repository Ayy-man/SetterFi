# Coach rehaul notes

The running log for the coach side, in the same shape as
`docs/plans/2026-09-03-ui-rehaul-notes.md`, which is what kept the owner console pass coherent
across twenty-six corrections. Ayman's notes go in verbatim, in arrival order, each with what was
found underneath it and what was done.

The rules the owner pass was built on are in `docs/COACH-REDESIGN-PLAYBOOK.md`. Read that first.
The visual authority is `docs/REDESIGN-CANVAS.md`, which is still right on layout, anatomy, copy and
ordering, and out of date on colour.

## Note 1 (2026-09-04, screenshot of coach Overview at `/coach`, first-run variant)

> this is kind of shit dont you think, and is there a way to fake these steps being done for demo
> purposes, temporarily ofc, then it resets in 10 minutes, also this whole page itself looks
> fucking weird,

Three separate asks: a judgement on the setup rail, a demo affordance, and a layout complaint.

**What the screenshot shows.** `Welcome, Reid`, one line reading "1 step is waiting on you", a
second line reading "Demo data, excluded from real analytics", then a two column block: "Your setup"
with a four card timeline on the left, "Your numbers" with three stacked figure cards on the right.
Below that, roughly a third of the viewport is empty.

**What is actually wrong, read against the component rather than the picture.**

1. **The step list has four cards and a counter that says "0 of 3 done".** The counter is honest by
   design, `coach-dashboard.tsx:671` counts only the rungs this page actually read, but a reader
   sees four rows and a denominator of three and concludes the page is broken. An honest number that
   reads as a bug is still a bug.
2. **The rows do not share an anatomy.** Step 1 and the last two cards carry a footer action bar;
   step 2 has none. Two different cards carry the same "See setup" label pointing at different
   places. Two rows are numbered steps and two are not.
3. **The blocked card repeats the page header.** The header already says "1 step is waiting on you"
   and the third card says "1 step is blocked" with a Blocked pill. Same fact, twice, eleven
   hundred pixels apart. This is playbook rule 4.
4. **The icon rail draws three icons for four rows,** so the spine does not line up with the cards
   it is threading.
5. **The dead space is our own absence rule at page scale.** The lower panels exist in the component
   (leads, booked calls, time to book, and the grids below them) and refuse to render on a first run
   account because they have nothing measured to show. Rule 1 of the playbook is right for a single
   card and wrong for two thirds of a viewport: the page needs a first run composition, not the
   ordinary composition with its middle removed. This is also exactly what the client said about
   Inbox on the 2026-09-02 call, "does not fill the screen; must work on every monitor".
6. **The figure cards are mostly empty.** Three tall cards holding one number each, with the number
   sitting in the top third and nothing under it.

**The demo affordance.** Wanted: mark the setup steps complete for a demo, then have it expire on
its own after ten minutes.

The hard constraint is the release boundary in `README.md`: nothing may present a provider,
integration or booking as complete unless a real receipt supports it. So this cannot write
`provisioning_steps`, and it cannot exist on a real tenant. Shape ruled on 2026-09-04:

- Presentation only. It never writes provisioning state, never writes an audit row, and never
  changes what any other reader sees.
- Available only when the tenant carries `is_demo` and demo logins are enabled, so it cannot appear
  on a real coach's account even by accident.
- Per viewer and time boxed. It is stored in the viewer's own browser with an expiry stamp, so it
  expires on its own and cannot outlive the demo, and a second viewer of the same tenant is
  unaffected.
- Visibly labelled while it is on, so nobody in the room mistakes the demo for the product.

**Decided.** The demo affordance ships now because it is small and unblocks demos. The dashboard
composition is the first coach surface of the redesign proper, and it follows the playbook sequence
rather than being patched ad hoc: draw it, build it as a new component, ship it to the demo tenant
for reaction.

## Note 2 (2026-09-04)

> is this literally the first onboardnig stage a new customer ever sees

No. Traced rather than assumed. A new coach goes signup, then the confirmation email lands them on
`/onboarding`, the setup companion, which has its own four step pill rail, its own headline counting
the outstanding checks, and five sub-routes: business profile, connect, texting eligibility,
calendar, offer. The coach role's home is `/coach/home`, which is where every later sign-in lands,
and there is no gate sending an incomplete coach back to `/onboarding`.

So the dashboard's setup rail is compensating for a missing redirect, and the same story is told
twice in two shapes: onboarding draws its rail off the fourteen step provisioning contract, the
dashboard draws four cards off a partial read of the same table. The open product question, not
decided here, is which one survives: route an incomplete coach to the companion and shrink the
dashboard's rail to a line, or fold the companion into the dashboard and delete it as a surface.
The canvas leans the second way, since it folds Get started into the Home setup card.

## Note 3 (2026-09-04)

> is there a way we can manually access that onboarding, for testing purposes

Yes, with nothing to set up. Sign in as the coach and open `/onboarding` directly; the route has no
gate, so it renders for any signed-in coach at any stage. The sub-steps are reachable the same way.
Verified on the dev server as the demo coach.

The visit proved the contradiction in Note 2: `/onboarding` says the demo coach has confirmed 3 of
7 checks with workspace activation ticked, while `/coach/home` says the same coach has 0 of 3 done.

## Note 1, what shipped (2026-09-04): the demo setup override

The affordance ruled on in Note 1 is built. Recording the shape here as well as in the code, because
a ruling that lives only in a comment is the failure the playbook's rule 10 names.

**It is a timestamp in one browser and nothing else.** `src/lib/demo-setup-override.ts` writes an
expiry to `localStorage` and reads it back. There is no server half of that module and there must
never be one: `provisioning_steps` is untouched, no audit row is written, and a second viewer of the
same tenant sees the real setup, which is what keeps this on the right side of the release boundary
in `README.md`.

**The gates are three and they fail closed.** `SETTERFI_DEMO_LOGINS`, `tenants.is_demo` for the
signed-in tenant (both resolved by `src/app/(workspace)/layout.tsx`), and `measurement.isDemo`,
which is the flag the provenance line under the greeting already prints. The third is deliberate
belt and braces: the control cannot appear on a page that is not already telling the room these rows
are seeded. It is also offered only on the first-run composition, because that is the only one with
a setup rail to override.

**The control lives in the context eye,** which is where this console already puts things a reviewer
opens on purpose, and which already labels itself "review only". `ContextEye` grew one anonymous
`action` slot for it; the eye knows nothing about demos. A button in the page header or the account
sheet would have read as a product feature, and this is not one.

**The header, the counter and the cards agree because they read one object.** The override does not
touch three renderers; it substitutes the `CoachChannelStatus` and the blocked-step count once, at
the top of `CoachDashboard`, and the status line, the rungs and the counter all read the
substitution. On the demo coach that turns "1 step is waiting on you" and "0 of 3 done" over four
cards into "Your agent is live on Instagram and Messenger" and "2 of 2 done" over three, with green
Live and Registered pills. The counter's `done` half now counts the channel rung from the status it
was handed rather than being pinned to zero, which is the same number it always was on a real first
run and the right one under the override.

Two things it deliberately does not fix, because Note 1 sends them to the redesign proper: the
greeting still reads "Welcome" rather than "Welcome back" while the override is on, since that word
is bound to the real first-run test that also chooses the page composition; and "The rest of your
setup" still renders under a full counter, because it names no state and is excluded from both
halves by the same rule that excluded it before.

Verified on the dev server as the demo coach, in Chrome: off, on, on after a reload with the same
expiry rather than a restarted clock, and off again. The suite covers the absent control on a real
tenant, the expiry, an expired stamp, a corrupt stamp, a stamp claiming longer than ten minutes, a
storage whose every accessor throws, and the three-way agreement while it is on.
