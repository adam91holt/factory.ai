import { describe, expect, test } from "bun:test";
import { cardEffort } from "../src/catalog.ts";

// execution-profiles: cardEffort() is the "card" leg of meta.ts's resolveEffort
// precedence — reads a card's own frontmatter `effort:` value, previously
// documented-only (catalog.ts's Card doc comment called it "reference, not
// execution"). These are thin smoke tests against the real committed cards
// (agents/*.md), not a fixture repo — the same trust level config.models
// values have (operator-authored, git-committed, never ticket-sourced).
describe("cardEffort", () => {
  test("returns the frontmatter effort value for a real card", () => {
    // agents/implementer.md declares `effort: high` — see agents/implementer.md.
    expect(cardEffort("implementer")).toBe("high");
  });

  test("a review-gate card's frontmatter is read the same way as any other card", () => {
    // agents/reviewer-spec.md declares `effort: high` — bumped from `medium`
    // (see the effort-wiring fix): the SDK's own default is "high", and a
    // formerly-decorative card value must not silently downgrade a
    // cross-vendor gate's reasoning depth the moment it becomes load-bearing.
    expect(cardEffort("reviewer-spec")).toBe("high");
  });

  test("a missing card returns undefined rather than throwing", () => {
    expect(cardEffort("totally-nonexistent-card-name")).toBeUndefined();
  });
});
