# How the agent finds its answers

*Written for the Live Legacy Strong team. This is the plain-language contract for how SetterFi's
agent decides what to say, and how your Notion content feeds it. No code here — just the model
you can organize your knowledge around.*

## The one-sentence version

The agent never writes from imagination: every answer starts with a lookup into a knowledge
store you control, and the reply is composed only from what that lookup returns.

## The three shelves the agent reads from

Structurally there are two stores — the shared Brain and each coach's offer layer (this matches
ARCHITECTURE.md). But the agent treats the FAQ entries inside the offer layer specially enough
that it's clearest to think of three shelves, in a fixed order of authority:

1. **The shared Brain (yours, platform-wide).** Qualification logic, objection responses,
   compliance rules, credit and funding fundamentals, funding products. You edit it once in the
   admin Brain screen; every coach's agent inherits the change the moment you publish.
2. **The coach's offer layer (per coach, bounded).** Their program name, pricing, products,
   disqualifiers, proof points, and bounded voice examples. A coach can shape their own offer here but
   can't touch the engine — nothing in the offer layer can override a compliance rule or a
   qualification threshold.
3. **FAQs (direct answers).** Question-and-answer pairs that live in the shared Brain and are
   matched before general retrieval: when a lead's message clearly matches an FAQ question, the
   stored answer is used as-is. This is the right shelf for anything with exactly one correct
   answer — hours, links, "do you work with startups", refund policy. The answers can carry
   placeholders like `[niche]` or `[target funding amount]`, which get filled from the coach's
   offer layer at send time — so one entry stays correct for every coach.

## What happens on each message

1. The lead's message arrives and is matched against the **FAQ list first**, narrowed to the
   relevant category. A confident match returns that answer directly, with the coach's offer
   values substituted in — fast and word-for-word predictable.
2. No FAQ match → the message is used to **retrieve the most relevant passages** from the shared
   Brain plus that coach's offer layer. Retrieval is by meaning, not keywords — "what's this
   gonna run me" finds the pricing-objection material even though no word matches.
3. The agent **writes its reply from those passages only**, in the coach's brand voice.
4. **Hard gates check the draft before it sends.** The system layer hard-gates pricing,
   guarantees, and outcome claims: figures can only come from approved configuration, and
   guarantee or approval language is blocked outright regardless of what any entry says. The
   agent physically cannot invent a number, promise an approval, or quote a result you didn't
   approve.

## How to organize content so retrieval stays sharp

The system rewards the same discipline AppointWise's knowledge base does — and the habits are
simple:

- **One topic per entry.** A focused paragraph about "bankruptcy on record" beats a page that
  covers bankruptcy, late payments, and disputes together, because retrieval pulls whole entries
  — a mixed entry drags unrelated text into the answer.
- **Write entries as answers, not notes.** Each entry should read like something the agent could
  say to a lead after light rewording. Internal shorthand ("push to call, see matrix") gives the
  agent nothing usable.
- **Put single-fact items in FAQ entries, explanations in general Brain entries.** "What does the
  call cost?" wants one exact answer, so it's an FAQ. "Why we don't quote pricing before
  qualification" is reasoning the agent should retrieve and reword, so it's a general entry.
- **Tag the category, and keep it honest.** Every FAQ entry carries a category — General, Credit,
  Business, Program/Service, Application/Booking, Funding — and matching filters by category
  before it ranks by meaning. A miscategorised entry is effectively invisible to the leads who
  need it, so the category matters more here than in a plain search box.
- **Universal vs. per-coach: write the sentence once, leave a slot for the difference.** If every
  coach should say it identically, write it in the shared Brain. If part of it depends on the
  coach — their niche, their funding range, their booking link — leave a placeholder there rather
  than forking the entry per coach. Forked entries drift; one entry with a slot doesn't.

## How Notion maps in

The **Prospect FAQ Sheet → FAQs** table in your Legacy Strong workspace is what seeds the Brain.
Each row imports as one entry: the `Inbound Message` column becomes what a lead's message is
matched against, `Response` becomes the answer, and `Category` becomes the filter. The
placeholders your responses already use — `[dream outcome]`, `[niche]`, `[requirements]` — become
the offer-layer slots described above, so they're a feature of the import rather than something
to clean up first.

One thing we need from you before we build the sync: **do you want to keep authoring in Notion,
or move to the Brain editor in SetterFi?** If Notion stays the authoring home, we build a
scheduled sync plus a manual "Sync now." If it's a one-time import, the Brain becomes the single
place an entry is edited, which is simpler and avoids the case where the same entry is changed in
both places and nothing decides which version wins. Either way the import itself is the same
work — it's only the ongoing machinery that differs.

Publishing in SetterFi is what makes a draft live for agents — you'll see a version number and a
diff of what changed, and every coach's agent picks the new version up instantly. Nothing a lead
is told ever comes from a source outside this versioned store.

## What this buys you

- **Edits propagate once.** Fix an objection response in the Brain and every agent on the
  platform answers the new way — no per-coach updates.
- **No hallucinated claims.** The hard gates make invented pricing, guarantees, and outcomes a
  structural impossibility, not a prompt request.
- **Testable before live.** The Evals test bench asks questions the way a lead would, so you can
  watch a change answer correctly before publishing it.
