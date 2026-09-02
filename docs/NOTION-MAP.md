# SetterFi — Notion workspace map (sanitized)

Structural map of the client's Notion workspace, written from a complete extraction so the Brain
can be designed against what is really there instead of what we assumed.

**This file is sanitized on purpose.** It records names, shapes, sizes, and schemas — never row
values. The raw capture holds real consumer credit data, coach business contact details, and at
least one plaintext credential column, so it lives outside this repo in
the local Notion capture and must never be committed, pasted into a hosted service, or shown
to a client. `.notion/` stays gitignored for the same reason.

## Provenance

Extracted 2026-08-13/14 by driving the client's signed-in browser session against Notion's
internal v3 API (`loadPageChunk`, `queryCollection`, `syncRecordValues`), read-only. Nothing in
the workspace was created, edited, renamed, moved, or deleted.

| | |
|---|---|
| Space | **Legacy Strong** — `<notion-workspace-id>`, team plan |
| Teamspaces | Clients, Programs, Extras, Legacy Strong |
| Blocks | 305,719 |
| Pages | 7,379 |
| Databases | 733 |
| Database rows | 18,689 |
| Words | ~2.79M |

**Not captured:** binary media (Looms, videos, images, PDFs and file attachments appear as URLs
or attachment references only), page comments, edit history, and member/permission lists.

Two extraction bugs were found and fixed; both would have produced a confidently wrong map.
`queryCollection` silently caps results at the requested `limit` with no `hasMore` signal, so six
databases came back truncated at 500 rows against true sizes up to 4,657. And the renderer keyed
output files on an 8-character id prefix, which collided across the per-client template
duplicates and silently overwrote 1,622 pages and 93 databases. Row counts here reconcile exactly
against the capture.

## The headline: the SetterFi-relevant corpus is one 46-row database

Six documents specced a Notion→Supabase sync as the Brain's knowledge source. The workspace does
contain that knowledge — it is just far smaller and far more structured than the spec assumed.

**`Prospect FAQ Sheet / FAQs`** — 46 rows, 1,987 words. Three columns:

| property | type | options |
|---|---|---|
| `Category` | multi_select | General Questions, Credit, Business, Program/Service, Application/Booking, Funding Qs |
| `Inbound Message` | title | — |
| `Response` | rich_text (the sanitized capture labels this `text`; the API returns rich-text property values, which the importer flattens to plain text before normalization) | — |

Every row is a lead message paired with the reply a setter should send. The rows already carry
offer-layer placeholders in the response text — `[dream outcome]`, `[niche]`,
`[target funding amount]`, `[requirements]`, `[income qualifiers]`, and a bare `X` where a link
belongs — which means the client has *already* factored their content the way SetterFi's two-layer
brain wants it: shared logic in the row, per-coach specifics substituted at send time.

This is the single most useful artifact in the workspace for Phase 2, and it is also the reason
Phase 2 was re-scoped. See "What this means for retrieval" below.

## Second most useful: the offer layer already exists as intake forms

Three form-backed databases collect, from real coaches, close to the exact field set SetterFi's
coach offer layer needs. Schemas only — row values are business contact details and are not
reproduced here.

**`CCA LAUNCH - Avatar + Biz Info`** — 96 rows. Company Name, Tagline/Slogan, Niche Target,
Funding Range, Color Palette, Logo Files, Business Email / Phone / Physical Address, and
`KEYWORDS (For IG DM Automation)`. That last column is notable: the client is already thinking in
terms of Instagram DM trigger keywords, which is SetterFi's channel.

**`Onboarding Form - CCA`** — 115 rows. Experience level, self-ranked ability, monthly revenue,
12-month revenue goal, biggest obstacle, which content they watched, what leads/audiences they
have ready. This is qualification-adjacent data about *coaches*, not leads.

**`Onboarding Form - Funding`** — 83 rows. LLC details (name, industry, NAICS, establish date,
address, virtual-address flag), business checking accounts, cash deposits available, aged-corp
purchase flag, plus **Credit Report (PDF)** and **Articles of Incorporation** file columns. This
is funding-platform intake and carries real consumer financial data.

Also present: `Sales Presentation Doc [TEMPLATE]` (1,066 words) and the `Avatar Maps` templates,
both of which describe ICP and pitch structure in prose.

## What the rest of the workspace is (and why it is not ours)

Roughly 99% of the content belongs to the **separate funding platform** project, not SetterFi.
Rolled up by top-level root:

| words | docs | rows | root | whose |
|---:|---:|---:|---|---|
| 1,903,100 | 6,478 | 6,084 | Client Portals | funding platform |
| 710,601 | 851 | 2,816 | Client Resources | funding platform |
| 246,264 | 16 | 1,177 | The Vault | funding platform |
| 209,827 | 23 | 1,344 | Content Pipeline | marketing ops |
| 168,534 | 76 | 996 | Client Intake | mixed — offer-layer forms above |
| 151,157 | 9 | 4,657 | Team TO DOs | internal ops |
| 109,378 | 162 | 176 | Credit Coach Academy | coaching program |
| 85,641 | 18 | 205 | Team SOPs | internal ops |
| 61,636 | 51 | 231 | Memberships | funding platform |
| 58,266 | 93 | 56 | Legacy Marketing | marketing ops |
| 39,376 | 109 | 0 | 5-Day Mini Funding Challenge | coaching program |
| 34,801 | 108 | 127 | Jacob - Dev Zone | funding platform |
| 6,229 | 2 | 688 | Bank Phone Database | funding platform |
| **1,987** | **2** | **46** | **Prospect FAQ Sheet** | **SetterFi** |

The funding-platform-heavy databases — `State Funding Boards` (1,020 rows), `ALL 50 STATES`,
`Bank Datapoints`, `List of banks in USA` (688 rows), `Client Portals` (201 rows),
`Memberships` (198 rows), `Client Call Recordings` (961 rows) — are the live bank-intel and
delivery system for that other product. The handoff brief at
`scratchpad/funding-platform-handoff-prompt.md` points that project at this same capture so it
does not need to re-crawl.

## What this means for retrieval

`docs/BACKEND-SPEC.md` §5 specs heading-aware ~500-token prose chunking with cosine retrieval
over the chunks. Against 46 rows averaging ~43 words, that pipeline degenerates: every row
becomes exactly one chunk, the heading-awareness has no headings to work with, and the `Category`
facet — the one piece of structure the client actually maintains — gets flattened into
embedding-space similarity where it can be overridden by wording.

The shape the data wants:

- **Row-level entries**, one per FAQ row, with `category` as a real filterable column.
- **Embeddings over `Inbound Message` only.** That column is the lead's phrasing, which is what
  an incoming DM is being matched against. Embedding the `Response` text pollutes the match — a
  reply mentioning "credit repair" would surface for a lead question about pricing.
- **Filter by category, then rank by similarity within it**, rather than similarity across the
  whole corpus.
- **Placeholders resolved at render time** from the coach's offer layer, never baked into the
  stored row, so one edit by the admin propagates to every coach.

Prose chunking still applies to genuinely prose sources (`Sales Presentation Doc [TEMPLATE]`,
Avatar Maps) if those get pulled in. Both shapes will need to coexist; the row shape is the one
that matters first.

At this size the honest observation is that 46 rows do not need a vector index to be correct —
they need the right facet and good placeholder handling. Build the retrieval path so it stays
correct as the client grows the table, but do not let the pipeline's sophistication outrun the
corpus.

## Handling and safety notes

- **The capture contains real consumer PII** — credit-report attachments, three-bureau reviews,
  client portals, membership records, names, addresses, and phone numbers. It stays out of this
  repo and out of any hosted service.
- **`CCA LAUNCH - Software Connections` stores a plaintext `Zapier Password` text column**
  alongside a `Zapier Email` column, across 68 rows. This is the client's existing practice, not
  something we introduced, and it is out of SetterFi's scope to fix — but if SetterFi ever reads
  this database, it must not ingest that column, and it is worth raising with Alec.
- **Attachment URLs in the capture are Notion-signed and expire.** Treat file columns as
  "a file existed here," not as retrievable content.
- **No qualification matrix exists in the workspace.** The decision-table values have to come
  from Alec directly. The matrix stays data-driven and admin-editable regardless.

## Open questions this map does not answer

- Sync cadence, and whether Notion stays authoritative after the first import. Open, owned by
  Alec.
- Whether the client intends to keep authoring FAQs in Notion or move to the Brain editor. This
  determines whether the two-writer conflict is real.
- Whether the 96 `Avatar + Biz Info` rows should seed coach offer layers at onboarding, or
  whether coaches re-enter that data in SetterFi.

## Reproducing or refreshing

The capture and the renderer both live outside this repo: the local Notion capture holds
`raw/capture.json`, `pages/`, `databases/`, and `INVENTORY.md` (the full tree with word counts —
read this first). Refreshing means re-running the browser extraction, not a Notion API call;
`NOTION_API_KEY` and `NOTION_KB_ROOT_ID` are still not provisioned.
