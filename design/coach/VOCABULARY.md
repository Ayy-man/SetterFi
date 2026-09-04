# Coach canvas vocabulary

The exact values the nine core artboards use. `Vocabulary.dc.html` draws every element below with a
label; this file is the copyable half. Every artboard is generated from one Python source so the chrome,
panel, pill and button markup is byte-identical across files; copy the snippets here verbatim rather
than re-deriving them, and keep the `--drench` block if you add a hero panel.

## Tokens

The `:root` block is `src/app/tokens.css` bare `:root` (the light palette), lifted verbatim, plus four
canvas-only names. Copy the whole `<helmet>` from any artboard; the values are:

```
--canvas oklch(0.9612 0.0042 262)   --pane oklch(0.9745 0.0034 262)   --card-top oklch(0.9975 0.0016 262)
--card oklch(0.9905 0.0026 262)     --well oklch(0.983 0.0048 262)    --raised var(--card-top)
--band rgba(60,90,150,0.1)          --row-hover rgba(60,90,150,0.035) --control-fill rgba(28,42,82,0.035)
--line rgba(60,90,150,0.13)         --line-soft rgba(60,90,150,0.06)  --line-input rgba(60,90,150,0.15)
--ink oklch(0.2325 0.023 262)       --body oklch(0.2905 0.032 262)    --muted oklch(0.3604 0.036 262)   --faint oklch(0.4349 0.039 262)
--accent oklch(0.5 0.15 264)        --accent-fill linear-gradient(180deg, oklch(0.523 0.148 266), oklch(0.443 0.152 261))
--accent-hover oklch(0.455 0.158 264) --accent-line rgba(46,92,200,0.32) --accent-text oklch(0.44 0.165 264)
--accent-wash rgba(46,92,200,0.07)  --accent-wash-strong rgba(46,92,200,0.1) --accent-edge rgba(46,92,200,0.22)
--on-accent oklch(0.99 0.003 267)   --focus-ring oklch(0.47 0.16 264 / 0.65)
--good oklch(0.6237 0.095 164)      --good-text oklch(0.4992 0.09 164)    --good-wash rgba(36,132,96,0.09)    --good-line rgba(36,132,96,0.26)
--warning oklch(0.6409 0.115 71)    --warning-text oklch(0.5183 0.105 71) --warning-body oklch(0.47 0.045 80)
--warning-wash rgba(176,116,32,0.1) --warning-line rgba(176,116,32,0.28)
--waiting oklch(0.6398 0.115 271)   --waiting-text oklch(0.5152 0.105 271) --waiting-wash rgba(92,110,196,0.09) --waiting-line rgba(92,110,196,0.26)
--shadow-card 0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(28,42,82,0.04), 0 8px 20px -14px rgba(28,42,82,0.16)
--shadow-raised 0 1px 2px rgba(28,42,82,0.06), 0 10px 26px -10px rgba(28,42,82,0.16), inset 0 1px 0 rgba(255,255,255,0.7)
--pane-bloom radial-gradient(85% 50% at 78% -8%, rgba(46,92,200,0.06), rgba(46,92,200,0) 60%)
canvas-only: --drench linear-gradient(158deg, oklch(0.36 0.1 264), oklch(0.27 0.075 266))  --on-drench oklch(0.99 0.003 267)
             --on-drench-muted rgba(255,255,255,0.78)  --drench-line rgba(255,255,255,0.16)
             --primary-shadow 0 1px 0 rgba(255,255,255,0.25) inset, 0 8px 20px -8px var(--accent)
```

Page ground is `--canvas`; the content area under the chrome adds `background-image: var(--pane-bloom)`.
Panel faces are `linear-gradient(180deg, var(--card-top), var(--card))` on `1px solid var(--line)` with
`--shadow-card`. Wells inside a panel are `--well` on `--line`, radius 11px.

## Type

Archivo for text, IBM Plex Mono for figures only. Font link (in the helmet, exactly):
`https://fonts.googleapis.com/css2?family=Archivo:wght@400;450;500;540;600&family=IBM+Plex+Mono:wght@400;500&display=swap`

| role | face | size | weight | tracking | line | colour |
|---|---|---|---|---|---|---|
| page title | Archivo | 46px | 600 | -0.026em | 1.05 | --ink |
| status sentence under the title | Archivo | 17px | 450 | 0 | 1.5 | --body, max 76ch |
| section heading | Archivo | 22px | 500 | -0.015em | 1.2 | --ink |
| panel name (in the band) | Archivo | 20px | 500 | -0.015em | 1.2 | --ink |
| panel eyebrow | Archivo | 14px | 450 | 0 | 1.55 | --muted |
| body | Archivo | 16px | 450 | 0 | 1.55 | --body |
| sentence under a figure | Archivo | 16px | 450 | 0 | 1.5 | --muted, max 34ch |
| row text in tables and lists | Archivo | 16px | 450 | 0 | 1.55 | --body |
| a name in a row | Archivo | 17px | 500 | 0 | 1.55 | --ink |
| small: timestamps, footers, labels | Archivo | 14px | 450 | 0 | 1.55 | --muted |
| big figure | Plex Mono | 62px | 500 | -0.075em | 0.92 | --ink |
| medium figure (stepper, price) | Plex Mono | 22px | 500 | 0 | 1.1 | --ink |
| table figure | Plex Mono | 17px | 400 | 0 | 1.55 | --ink |
| pill count | Plex Mono | 14px | 400 | 0 | 1 | tone text |

14px is the floor. Nothing is uppercase. Mono never sets a word: "60 of 86" is `60` in mono then
`of 86 leads` in Archivo 14px `--muted`; a unit stays inside the glyph run (`5.2h`, `8.4%`).
Absence line: where a figure would be, Archivo 20px 500 `--muted`, max 24ch, and the card ends after it.

## Radii, spacing, shadow, icons

Panel `24px 24px 17px 17px`; hero panel `30px 30px 17px 17px`; board card `16px 16px 13px 13px`;
well and stepper row 11px; button 9px; icon button 10px; input 9px; menu 12px; pill and toggle 999px.
Spacing steps: 4, 8, 12, 16, 20, 24, 32, 40. Page padding `36px 40px 96px` (the 96px is the bubble inset
and is never dropped). Grid gaps: bubbles 16px, cards 20px, columns 24px. Band padding `19px 20px`.
Table cells `0 26px`. Icons are inline stroke SVG on a 24 viewBox, drawn at 20px (24px in the bubble and
phone tabs): `stroke: currentColor; fill: none; stroke-width: 1.75; round caps and joins`.

## Controls

| control | height | notes |
|---|---|---|
| navigation pill | 46px | padding 0 26px, 17px, rest 500 `--muted`, active 600 `--on-accent` on `--accent-fill` with `--accent-line` edge |
| primary button | 48px | padding 0 24px, 16px 600, `--accent-fill`, `--accent-line`, `--primary-shadow`. One per page besides the active pill |
| secondary button | 48px | padding 0 22px, 16px 500 `--body`, `--control-fill` on `--line` |
| good button (Showed) | 48px | `--good-wash` on `--good-line`, `--good-text` 600 |
| icon button | 44x44 | radius 10, `--control-fill` on `--line`, `flex: none` |
| band chevron | 44x44 | `--well` on `--line`; the band's only action |
| dashed add | 48px | full width, `--accent-wash` on `1px dashed var(--accent-edge)`, `--accent-text` |
| segmented control | 44px (48 in a page header) | segments padding 0 18px in a 12px well with 4px padding; active `--accent-wash-strong` on `--accent-edge`, `--ink` 600 |
| search and dropdown | 48px | `--well` on `--line-input`, radius 9 |
| text field | 48px min | label above at 16px `--muted` |
| stepper | 64px row | 44px minus and plus either side of a mono 22px value, min-width 96px centred |
| agent toggle | 52px pill | word then a 64x36 track; on is `--good` family, off is `--warning` family; never unlabelled |
| row switch | 44px pill | word (Asked or Skipped) then a 52x30 track |
| state pill | 32px | padding 0 12px, 15px 500, 8px dot then the word; tones good, warning, waiting, accent, neutral |
| inline link | 44px hit box | `display: inline-flex; align-items: center; min-height: 44px; margin: -10px 0; padding: 0 2px` |
| table row | 48px | name cell is a 48px inline-flex link |
| thread row | 44px monogram | padding 18px 22px |
| phone tab | 60px | glyph over a 14px word, active `--accent-wash` on `--accent-edge` |
| support bubble | 56px | `--ink` fill, white mark, `--shadow-raised`, 32px from right and bottom (16px right and 92px up on the phone) |

## Chrome snippet

```html
<div style="display: flex; align-items: center; gap: 32px; height: 76px; padding: 0 40px; border-bottom: 1px solid var(--line); background: var(--pane); flex: none;">
  <div style="display: flex; align-items: center; gap: 12px; width: 250px; flex: none;">
    <div style="display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--accent-edge); background: var(--accent-wash); color: var(--accent-text);">MARK-SVG</div>
    <span style="font-size: 20px; font-weight: 600; letter-spacing: -0.014em; color: var(--ink);">Your agent</span>
  </div>
  <div style="display: flex; justify-content: center; flex-grow: 1;">
    <div style="display: flex; align-items: center; gap: 4px; padding: 5px; border-radius: 999px; border: 1px solid var(--line); background: var(--well);">
      <a class="pill" href="#" style="display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 26px; border-radius: 999px; font-size: 17px; white-space: nowrap; font-weight: 600; color: var(--on-accent); background: var(--accent-fill); border: 1px solid var(--accent-line); box-shadow: var(--primary-shadow);">Overview</a>
      <a class="pill" href="#" style="display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 26px; border-radius: 999px; font-size: 17px; white-space: nowrap; font-weight: 500; color: var(--muted); border: 1px solid transparent;">Inbox<span class="mono" style="display: grid; place-items: center; min-width: 26px; height: 24px; padding: 0 8px; border-radius: 999px; background: var(--warning-wash); border: 1px solid var(--warning-line); color: var(--warning-text); font-size: 14px;">4</span></a>
      <!-- Leads, Agent, Billing as the rest pill above -->
    </div>
  </div>
  <div style="display: flex; align-items: center; justify-content: flex-end; gap: 12px; width: 250px; flex: none;">
    <button aria-label="Notifications" style="display: grid; place-items: center; width: 46px; height: 46px; border-radius: 12px; border: 1px solid var(--line); background: var(--well); color: var(--muted);">BELL-SVG</button>
    <button style="display: flex; align-items: center; gap: 11px; height: 46px; padding: 0 14px 0 8px; border-radius: 12px; border: 1px solid var(--line); background: var(--well); color: var(--ink);"><span class="mono" style="display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--accent-wash); border: 1px solid var(--accent-edge); color: var(--accent-text); font-size: 14px;">RF</span><span style="font-size: 16px; font-weight: 500; color: var(--ink);">Reid</span>CHEVRON-SVG</button>
  </div>
</div>
```
The support bubble, on every page, inside a `position: relative` page root:
`<button aria-label="Message support" style="position: absolute; right: 32px; bottom: 32px; display: grid; place-items: center; width: 56px; height: 56px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: var(--ink); color: var(--on-accent); box-shadow: var(--shadow-raised);">MARK-SVG-24</button>`

## Panel snippet

```html
<div style="display: flex; flex-direction: column; border-radius: 24px 24px 17px 17px; border: 1px solid var(--line); background: linear-gradient(180deg, var(--card-top), var(--card)); box-shadow: var(--shadow-card); overflow: hidden;">
  <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-height: 78px; padding: 19px 20px; border-bottom: 1px solid var(--line);">
    <div style="min-width: 0;">
      <span style="display: block; margin-bottom: 4px; font-size: 14px; color: var(--muted);">Eyebrow</span>
      <h2 style="margin: 0; font-size: 20px; font-weight: 500; letter-spacing: -0.015em; line-height: 1.2; color: var(--ink);">Panel name</h2>
    </div>
    <a class="btn" href="#" aria-label="Open" style="display: grid; place-items: center; width: 44px; height: 44px; flex: none; border-radius: 10px; border: 1px solid var(--line); background: var(--well); color: var(--body);">CHEVRON-SVG</a>
  </div>
  <div style="padding: 22px 20px 20px;">
    <div class="mono" style="font-size: 62px; font-weight: 500; letter-spacing: -0.075em; line-height: 0.92; color: var(--ink);">214</div>
    <p style="max-width: 34ch; margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: var(--muted);">One sentence. Never two.</p>
  </div>
  <div style="padding: 0 20px 8px; margin-top: auto;"><!-- optional footer rows, 46px each, border-top var(--line-soft) --></div>
</div>
```
Drenched variant: `border: 1px solid transparent; background: var(--drench); color: var(--on-drench)`, band
hairline `--drench-line`, eyebrow `--on-drench-muted`, chevron on `rgba(255,255,255,0.14)`. Hero radius 30px.
Absence variant: replace the figure with `<p style="max-width: 24ch; font-size: 20px; font-weight: 500; line-height: 1.35; color: var(--muted);">No calls booked yet in this period.</p>` and no footer.

## Pill, button and state snippets

```html
<span style="display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 999px; background: var(--good-wash); border: 1px solid var(--good-line); color: var(--good-text); font-size: 15px; font-weight: 500; white-space: nowrap;"><span style="width: 8px; height: 8px; border-radius: 999px; background: var(--good); flex: none;"></span>Live</span>
<button style="display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 48px; padding: 0 24px; border-radius: 9px; border: 1px solid var(--accent-line); background: var(--accent-fill); color: var(--on-accent); font-size: 16px; font-weight: 600; box-shadow: var(--primary-shadow); white-space: nowrap;">Save</button>
<button style="display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 48px; padding: 0 22px; border-radius: 9px; border: 1px solid var(--line); background: var(--control-fill); color: var(--body); font-size: 16px; font-weight: 500; white-space: nowrap;">Download</button>
<button aria-label="More" style="display: grid; place-items: center; width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--line); background: var(--control-fill); color: var(--body); flex: none;">ICON-SVG</button>
```
State pill tones: good `--good-wash / --good-line / --good-text / dot --good`; warning and waiting the same
pattern on their families; accent `--accent-wash / --accent-edge / --accent-text / dot --accent`; neutral
`--control-fill / --line / --muted / dot --faint`. Words used: Live, Registered, Blocked, Not filed,
Not live yet, Day 14 of about 21, Needs you, Agent handling, Qualified for a call, Not a fit.

## Rules the artboards obey

One filled button per page besides the active navigation pill. One drenched panel per page at most.
A band offers exactly one pressable thing; a state pill beside it is not pressable. Absence is words in the
figure's slot and the card ends short. Bars only for counts over periods or categories; a line only from six
points. Each fact appears once on a screen, so a single-lane view drops the lane pill from its rows.
Explanation belongs in the context eye, not under a heading. 96px of nothing pressable sits above the bubble.
