---
name: factory-design
description: The factory's house visual style distilled for building any UI — dark-first surfaces, paired characterful type, one owned accent, disciplined motion, intentional density, and the anti-template rule. Use before writing any React/TSX, CSS, or HTML in a factory ticket. Full reference: docs/design-language.md.
---

# Factory design

Distilled house style for factory-built UIs. Read this before writing UI; the
**design-reviewer** stage judges the result against it. Full detail and the scored
checklist live in `docs/design-language.md`; for interactive/game-like work also read
`skills/game-feel/SKILL.md`.

## The rule that outranks the rest

If the screen could be a plain form, a bulleted list, or a wall of identical grey
cards with no loss — it is not done. Genericness is the failure mode, not ugliness.

## Distilled principles

**Dark-first surfaces.** Design the dark theme first; light is a port. Near-black
ladder (page → panel → raised), 4–6px luminance steps, *not* pure black, *not* flat
grey. Hairline borders over drop shadows on dark. Reference ladder in
`ui/src/styles/globals.css`.

**Off-white text, stepped down.** Never pure `#fff` on near-black. Secondary/tertiary
text steps *down in luminance*, not down in opacity.

**One owned accent.** A single characterful live/active colour owns attention (the
mission-control UI uses instrument amber `#ffb224`). Semantic green/red plus at most
two role chips are the entire rest of the palette. Six accents = zero accents.

**Paired, characterful type.** A display/sans with a point of view for headings and
chrome; a monospace for numbers, IDs, timers, code. Numbers always tabular so they
don't jitter. Section labels: ~10.5px, uppercase, ~0.08em tracking, faint colour —
the single highest-leverage "designed" move. Self-host the fonts.

**4px spacing grid.** Every margin/pad is a multiple of 4. Off-grid spacing is the
loudest AI-default tell. Pick a type scale and hold it.

**Intentional density.** Instrument/dashboard surfaces are *dense* and hairline-ruled;
hero/focus surfaces *breathe*. Choose per surface — never sparse-by-default.

**Disciplined motion.** `transform`/`opacity` only — never animate layout props
(60fps rule). 120–200ms for feedback, 200–400ms for view transitions, one ambient
loop at most. Items fade+rise 2px on mount, stagger when several land. Springs for
things that should feel like they have mass. Always ship a `prefers-reduced-motion`
path.

**Feedback on everything.** Hover/focus before the click, a physical press state, a
distinct result for success vs failure, and real reward on the moments that matter.
A control that looks the same before, during, and after interaction is broken.

**Commit to one idea.** Give the UI a memorable, coherent concept (instrument panel,
terminal, control surface, a world) and carry it across every screen.

## Before you submit

Self-score against the checklist in `docs/design-language.md` §7. UI passes at ≥ 12/16
with no zeros in Motion, Feedback, or Distinctiveness. If any interactive screen could
be a form, fix that before anything else — it fails the gate outright.
