# Factory design language

The house style for UIs the factory builds. This is not a suggestion sheet — it is
the bar the **design-reviewer** stage (`agents/design-reviewer.md`) judges against,
and the thing the implementer is told to read before writing a single component
(`agents/implementer.md`). Screens that read as unstyled framework defaults fail
review. The reference implementation of this style is the factory's own
mission-control UI (`ui/src/styles/globals.css`) — when in doubt, look there.

The one rule everything else serves: **if the screen you built could be swapped for a
plain form, a bulleted list, or a wall of grey cards with no loss, it is not done.**

---

## 1. Foundations — dark-first, instrument-grade

Design for the dark end first; a light theme is a port, never the origin.

**Surfaces** are a near-black ladder, not pure `#000` and not grey. Each step up the
ladder = one level closer to the user (page → panel → raised/hover). Mission control's
ladder, reuse it or derive your own with the same 4–6px luminance steps:

| token | value | use |
|-------|-------|-----|
| `bg0` | `#0a0c10` | page |
| `bg1` | `#10141b` | panel / card |
| `bg2` | `#171d28` | raised / hover |
| `line` | `#232b38` | hairlines |
| `line2` | `#334054` | emphasized borders |

**Text** is never pure white on near-black — it vibrates. Use a soft off-white
(`#e8edf4`) and step *down* in luminance for secondary/tertiary (`#96a0b5`,
`#5c6880`) rather than dropping opacity (opacity muddies over textured backgrounds).

**One accent does the talking.** Pick a single characterful "live/active" colour and
let it own attention (mission control: instrument amber `#ffb224`). Semantic colours —
success/green, error/red, plus at most two role chips — are the whole rest of the
palette. A UI that uses six accent colours has none. Reserve the accent for the state
that matters *right now* (running, selected, your turn), not for decoration.

**Contrast is a floor, not a style choice:** body text ≥ 4.5:1, large/UI text ≥ 3:1
against its actual surface. Test on `bg1`, not `bg0`.

---

## 2. Type — characterful, paired, tabular

Two families, deliberately contrasted, never the system default alone:

- A **display/sans** with personality for headings, labels, UI chrome (mission
  control: Space Grotesk). Geometric or grotesk with a point of view.
- A **monospace** for anything numeric, tabular, code, IDs, timers, scores (mission
  control: IBM Plex Mono). Numbers **always** `font-variant-numeric: tabular-nums` so
  they don't jitter as they tick.

Rules:
- **Section labels**: ~10.5px, uppercase, letter-spacing ≈ 0.08em, in the faint text
  colour. This single move reads as "designed" more than any other.
- Set a real type scale (e.g. 10.5 / 13 / 16 / 20 / 28) and stick to it. Ad-hoc
  `font-size: 15px` one-offs are how a UI turns to mush.
- Line-height 1.4–1.5 for prose, 1.1–1.2 for display.
- Ship the fonts (self-host / bundle). A flash of Times New Roman is a taste failure.

---

## 3. Space, density, rhythm

- **One spacing scale**, multiples of 4px (4/8/12/16/24/32). Every margin and pad
  snaps to it. Off-grid spacing is the single most common tell of AI-default UI.
- **Density is intentional, per surface.** An instrument/dashboard surface should be
  *dense* — pack real information, hairline-separated, no wasted acreage. A focus/hero
  surface should *breathe*. Choose per screen; never default to sparse-because-empty.
- Hairline borders (`1px` in `line`) over drop shadows for structure on dark. Shadows
  on near-black read as smudges; use a lighter raised surface (`bg2`) instead.
- Align to a grid. Ragged left edges and centre-everything are amateur tells.

---

## 4. Motion — the difference between alive and dead

Motion is not decoration; it is feedback. Every state change a user causes gets a
visible, sub-second response. Every state change the *system* causes gets an animated
transition, never a jump-cut.

Discipline, so it reads as craft not chaos:

- **Transforms and opacity only.** Animate `transform` and `opacity`; never `width`,
  `height`, `top`, `left`, `margin` — those hit layout and drop frames. This is the
  60fps rule and it is non-negotiable.
- **Durations:** 120–200ms for UI feedback (hover, press, mount), 200–400ms for
  transitions between views, ≥ 2s for ambient loops. Ease-out for enters, ease-in for
  exits.
- **One ambient loop, maybe.** Mission control's *only* infinite animation is a 2.4s
  opacity pulse on the live indicator. If everything pulses, nothing does.
- **Entrances:** list/feed items mount with a 150ms fade + 2px rise. Staggered by
  ~30ms when several arrive together. Never pop in.
- **Springs for anything physical** (a score incrementing, a card grabbed, a value
  landing) — springs, not linear tweens, are what make a number feel like it has mass.
- **Always honour `prefers-reduced-motion: reduce`** — disable loops and non-essential
  transitions. A reduced-motion path is part of "done", not an afterthought.

---

## 5. Feedback & juice (interactive surfaces)

Applies to anything a user pokes at — the more game-like, the more this dominates.
Every interaction has four moments; a dead UI skips three of them:

1. **Anticipation** — hover/focus state changes *before* the click (cursor, glow,
   scale 1.02). The UI tells you it heard you.
2. **Action** — the press itself registers physically (scale 0.98, a tick of colour).
3. **Result** — the outcome animates in; success and failure look *different* and
   both are unmistakable.
4. **Reward** — on the moments that matter (a score, a completion, a win), give more
   than the minimum: a spring, a particle burst, a colour bloom, a sound.

Sound is part of the palette for game-like UIs — short, tasteful, mutable, never
absent where a hit/success/error happens. A silent game feels broken even when it
isn't.

See `skills/game-feel/SKILL.md` for the scored juice rubric and r3f/three.js patterns.

---

## 6. Distinctiveness — the anti-template clause

The failure mode is not ugliness; it's genericness. A change fails the taste gate when
it looks like it fell out of a starter template:

- Unstyled shadcn / Bootstrap grey, default border-radius everywhere, the "every SaaS
  in 2021" look.
- System font stack with no display face.
- Flat equal-weight cards with no visual hierarchy — everything the same size, colour,
  and prominence.
- Centre-everything layouts with a 600px column and nothing else.
- Forms and multiple-choice lists standing in for what should be an *experience*.

Give the UI one memorable, coherent idea — an instrument panel, a terminal, a physical
control surface, a world you fly over — and commit to it on every screen.

---

## 7. Scored checklist (the taste gate reads this)

Score each 0–2 (0 = absent, 1 = present but weak, 2 = deliberate and strong). A UI
ticket **passes** the taste gate at **≥ 12/16 with no zeros in Motion, Feedback, or
Distinctiveness**. Any interactive/game screen that "could be a form" is an automatic
fail regardless of score.

| # | Axis | 0 | 2 |
|---|------|---|---|
| 1 | **Palette** | grey defaults / rainbow | dark-first ladder, one owned accent |
| 2 | **Type** | system font only | paired display + tabular mono, tracked labels |
| 3 | **Density** | sparse-by-default | intentional per surface |
| 4 | **Layout** | centre-everything | grid-aligned, real hierarchy |
| 5 | **Motion** | jump-cuts | transform/opacity, sub-second, reduced-motion path |
| 6 | **Feedback** | click does nothing visible | all four interaction moments present |
| 7 | **Reward/juice** | none | springs/particles/sound on moments that matter |
| 8 | **Distinctiveness** | template soup | one committed, memorable idea |

Motion axis at 0 (animating layout props, or no reduced-motion path) fails on its own —
it is both a taste and a performance defect.
