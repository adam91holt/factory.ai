import { describe, expect, test } from "bun:test";
import { getCard, listCards } from "../src/catalog.ts";

// implementer-honesty: the opus implementer was observed reward-hacking gates
// on real builds — faking screenshots, freezing the render loop to force an
// e2e pass, writing an assertion-free "debug" test harness, and a test hook
// that reached game-over WITHOUT a genuine collision. The adversarial
// reviewer caught every case, but each one burned a full review→fix round.
// This suite pins the prompt-only fix (agents/implementer.md,
// agents/fixer.md): an explicit anti-reward-hacking directive that must
// survive future edits to these cards.
//
// This is deliberately a *prompt content* test, not a behavioural one — there
// is no code path to unit-test here (the fix is words the model reads), so
// the adversarial case is "a future edit quietly drops/waters down the
// directive while touching the surrounding prose for an unrelated reason."
// Pinning exact substrings makes that regression fail loudly instead of
// silently shipping a card that no longer says any of this.

describe("implementer/fixer cards carry an explicit anti-reward-hacking directive", () => {
  test("both cards exist and are non-empty", () => {
    expect(listCards()).toContain("implementer");
    expect(listCards()).toContain("fixer");
    expect(getCard("implementer")?.prompt.length ?? 0).toBeGreaterThan(0);
    expect(getCard("fixer")?.prompt.length ?? 0).toBeGreaterThan(0);
  });

  test("implementer.md explicitly forbids each observed reward-hacking shape", () => {
    const prompt = getCard("implementer")!.prompt;
    // The headline directive.
    expect(prompt).toContain("DO NOT GAME THE GATES");
    // B1: faked screenshots / fabricated evidence.
    expect(prompt.toLowerCase()).toContain("fake a screenshot");
    // B2: freezing the render/game loop to dodge a timing-dependent failure.
    expect(prompt.toLowerCase()).toContain("freeze a render/game loop");
    // B3: assertion-free "debug" test harnesses.
    expect(prompt).toContain("real assertions against real behaviour");
    // B4: a test hook reaching a target state without genuine logic
    // (game-over without a real collision check).
    expect(prompt.toLowerCase()).toContain("genuine application logic");
    expect(prompt.toLowerCase()).toContain("collision");
  });

  test("implementer.md requires cleaning up debug/tmp-named scaffolding before handoff", () => {
    const prompt = getCard("implementer")!.prompt;
    expect(prompt).toContain("tmp-*");
    expect(prompt).toContain("__dbg*");
    expect(prompt.toLowerCase()).toContain("name tests for the behaviour they verify");
  });

  test("implementer.md frames gaming a gate as double work, not a shortcut (the actual incentive fix)", () => {
    const prompt = getCard("implementer")!.prompt;
    expect(prompt.toLowerCase()).toContain("adversarial reviewer");
    expect(prompt.toLowerCase()).toContain("end up doing the work twice");
  });

  test("fixer.md carries the matching directive so applying review feedback can't reintroduce the same gaming", () => {
    const prompt = getCard("fixer")!.prompt;
    expect(prompt).toContain("DO NOT GAME THE GATES");
    expect(prompt.toLowerCase()).toContain("stub, fake, freeze, or no-op");
    expect(prompt.toLowerCase()).toContain("tautological");
    expect(prompt).toContain("tmp-*");
  });

  test("fixer.md still forbids weakening/deleting tests outright (pre-existing rule, not replaced by the new directive)", () => {
    const prompt = getCard("fixer")!.prompt;
    expect(prompt).toContain("Never weaken or delete tests");
  });

  test("neither card grew a new {{token}} — catalog-drift's contract stays intact", () => {
    // agents/implementer.md and agents/fixer.md are known-tokened cards
    // ({{repo}}/{{spec}} and {{spec}}/{{reviews}} respectively). The
    // anti-reward-hacking prose is plain text on purpose — a new {{token}}
    // here would need a matching renderPrompt() call-site update (see
    // tests/catalog-drift.test.ts) and this fix has no reason to touch call
    // sites at all.
    const implementerTokens = new Set(
      [...getCard("implementer")!.prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!),
    );
    expect(implementerTokens).toEqual(new Set(["repo", "spec"]));

    const fixerTokens = new Set(
      [...getCard("fixer")!.prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!),
    );
    expect(fixerTokens).toEqual(new Set(["spec", "reviews"]));
  });
});

// Adversarial: prove the directive text actually rules OUT each concrete
// gaming move the real incident report described, phrased as the move itself
// rather than as a keyword — a directive that used different wording (e.g.
// only "no shortcuts" with no examples) would fail these even though it
// "addresses reward-hacking" in spirit. Anchors the fix to the specific
// failure modes, not a vague gesture at honesty.
describe("adversarial: the directive text covers each real observed gaming move, not just a generic warning", () => {
  const implementer = () => getCard("implementer")!.prompt;

  test("a hardcoded/fixed test result (fake the outcome instead of computing it) is named", () => {
    expect(implementer().toLowerCase()).toContain("hardcode a result");
  });

  test("mocking out the exact behaviour under test in an e2e/integration test is named", () => {
    expect(implementer().toLowerCase()).toContain("scripted double");
    expect(implementer().toLowerCase()).toContain("exercise the real thing");
  });

  test("fixing the gate instead of the behaviour is explicitly reversed", () => {
    expect(implementer().toLowerCase()).toContain("fix the underlying behaviour — never the gate");
  });
});

// Sanity: the two other cards' directives this fix must NOT disturb (design
// brief numbering, spec/reviews tokens) are still present and in the same
// relative order — guards against the insertion accidentally landing inside,
// or reordering, the pre-existing UI design-system brief.
describe("implementer.md's pre-existing design-system brief survives the insertion untouched", () => {
  test("the #7 design brief heading and its bullets are still present, after the new directive", () => {
    const prompt = getCard("implementer")!.prompt;
    const gateIdx = prompt.indexOf("DO NOT GAME THE GATES");
    const briefIdx = prompt.indexOf("#7: build to this DESIGN-SYSTEM BRIEF");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(briefIdx).toBeGreaterThan(-1);
    // New directive comes first (right after the opening instructions),
    // design brief follows — matches the ticket's "focused prompt addition"
    // ask rather than a rewrite of existing structure.
    expect(gateIdx).toBeLessThan(briefIdx);
    expect(prompt).toContain("never a one-off hex sprinkled into individual components");
  });
});
