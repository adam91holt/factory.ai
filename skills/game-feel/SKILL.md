---
name: game-feel
description: Juice rubric and react-three-fiber / three.js patterns for building interactive, game-like UIs that feel alive. Use when a factory ticket asks for a game, a 3D/WebGL scene, an interactive visualisation, or anything where "feel" matters. The anti-pattern to kill: if it could be a form, it fails.
---

# Game feel

You are building something a person will *play with*, not fill in. The bar is feel,
not just function. This skill is the juice rubric plus the r3f/three.js patterns that
deliver it. Pair it with `docs/design-language.md` (the house visual style).

## The one law

**If the mode you are building could be rendered as a `<form>`, a list of
`<button>`s, or a quiz card with no loss — it fails.** A quiz with a 3D background is
still a quiz. Interactivity means the world responds continuously to input, not that a
button submits an answer. When a ticket says "game" and you reach for multiple-choice,
stop and redesign the interaction.

## Juice rubric (score the build 0–2 each; ship at ≥ 12/16)

1. **Input response** — the world reacts every frame to input (movement, camera,
   cursor), not only on discrete submits.
2. **Motion has mass** — things accelerate, ease, overshoot, settle. Springs and
   damping, never linear teleports.
3. **Feedback on every hit** — visual + (where apt) audio on every meaningful
   interaction; success and failure are unmistakably different.
4. **Reward moments** — score gains, completions, and wins get disproportionate
   celebration: particle burst, camera punch, colour bloom, a sound.
5. **Camera is alive** — easing, slight follow-lag, subtle idle drift or breathing;
   a locked static camera reads as dead.
6. **Ambient life** — the scene moves when idle (drifting light, swaying grass, a
   pulsing beacon) so it never looks frozen.
7. **Sound** — short, tasteful, layered, mutable; present on hits/success/error.
   Silence where a sound belongs is a bug.
8. **Performance** — holds 60fps on a laptop; no jank on interaction. Juice that
   drops frames is negative juice.

A zero on Input response, Feedback, or the "could-be-a-form" law is an automatic fail.

## react-three-fiber / three.js patterns

Assume `@react-three/fiber` + `@react-three/drei`; reach for `@react-three/rapier`
(physics), `maath` (easing/damping), `zustand` (game state), `@react-three/postprocessing`
(bloom/vignette) as the ticket warrants.

**Animate in the frame loop, not React state.** Per-frame updates mutate refs; they
never call `setState` (that re-renders React 60×/s and dies).

```tsx
useFrame((state, delta) => {
  // frame-rate independent: scale by delta, never assume 16ms
  ref.current.rotation.y += delta * 0.5;
  // easing toward a target — the cheapest way to make motion feel good
  easing.damp3(group.current.position, target, 0.25, delta); // maath/easing
});
```

**Springs for anything the user should *feel* land** — score numbers, grabbed objects,
UI that reacts to game events — via `@react-spring/three` or a manual critically-damped
spring. A value that snaps has no weight; a value that springs does.

**Camera has life.** Lerp the camera toward its target with a little lag; add a small
idle drift. Never hard-cut a camera between framings — always `damp`/`lerp`.

```tsx
useFrame((state, delta) => {
  easing.damp3(camera.position, desired, 0.4, delta);
  camera.lookAt(focus.current);
});
```

**Reward = layered burst.** On a scoring/win event, fire *several* things at once:
a particle burst (instanced points), a quick camera punch (kick FOV or position and
damp back), a bloom flash, and a sound. One of these alone is thin; together they land.

**Ambient motion always on.** Drive idle life from `state.clock.elapsedTime` — bob
floating objects, drift lights, pulse emissives. A scene with zero motion at rest
looks broken.

**Sound**: preload short clips (howler.js or raw WebAudio), trigger on events, respect
a global mute, vary pitch slightly on repeats so it doesn't machine-gun.

**Performance**: instance repeated geometry (`<Instances>`), reuse geometries/materials,
keep draw calls down, lazy-load heavy assets with `<Suspense>`, gate postprocessing on
capability. Profile before adding more.

## Anti-patterns (any one is a review fail)

- A "game mode" that is multiple-choice questions with a themed skin.
- Discrete submit-and-check interaction where continuous control was possible.
- Static camera, frozen scene, no idle motion.
- `setState` inside `useFrame`.
- Linear tweens for things that should have weight.
- Silent interactions where a hit/success/error happens.
- Animating CSS `width`/`height`/`top`/`left` for the HUD instead of `transform`.
- No `prefers-reduced-motion` fallback and no mute control.
