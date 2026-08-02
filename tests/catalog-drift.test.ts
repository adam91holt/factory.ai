import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getCard, listCards } from "../src/catalog.ts";

// Catalog-drift guard (audit improvement #3). A card's {{token}}s are filled
// in by whatever object the CALL SITE passes to renderPrompt(name, vars, …) —
// the card and the call site are two files edited independently, so nothing
// stops them drifting apart: a call site can stop passing a var the card still
// references (the token then leaks into the model's prompt VERBATIM as literal
// "{{token}}" text — renderPrompt only substitutes keys present in `vars`),
// or a card can lose a protocol string ("## Depends-on", "VERDICT:", …) that
// downstream code parses, silently breaking that stage's contract. This is
// exactly the shape of two real bugs this suite would have caught:
//   - B1: decomposer.md lost "## Depends-on"/"## Touches" while dag.ts kept
//     parsing them.
//   - B2: intake-author's re-prompt built an `answersBlock` but never passed
//     it to renderPrompt (and the card had no {{answers}} token), so a human's
//     answers never reached a re-run of the intake author.
// Both are pure text/text-vs-text mismatches — no SDK call needed to catch
// them, which is what makes this a cheap, always-on regression guard.

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// ---- a small tokenizer that finds renderPrompt(name, { ...vars }, …) call
// sites in a TS source string and returns the top-level keys of the vars
// object, correctly skipping braces that appear inside string/template
// literals (including `${expr}` interpolations, which nest their own braces).
// Deliberately NOT a full JS parser — just enough to survive the prompt-
// building idioms actually used in src/*.ts (untrusted(`...${x}...`), etc).

type StrCtx = "sq" | "dq" | "tmpl" | { type: "exprInTmpl"; enterDepth: number };

/** Scan `src` starting at `openIdx` (which must be a `{`) and return the index
 * of its matching `}`, treating string/template-literal contents as opaque
 * except for `${...}` interpolations (whose braces DO nest normally). */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  const stack: StrCtx[] = [];
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === "sq" || top === "dq") {
      if (c === "\\") { i++; continue; }
      if ((top === "sq" && c === "'") || (top === "dq" && c === '"')) stack.pop();
      continue;
    }
    if (top === "tmpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && src[i + 1] === "{") { depth++; stack.push({ type: "exprInTmpl", enterDepth: depth }); i++; continue; }
      continue;
    }
    if (c === "'") { stack.push("sq"); continue; }
    if (c === '"') { stack.push("dq"); continue; }
    if (c === "`") { stack.push("tmpl"); continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      if (typeof top === "object" && top.type === "exprInTmpl" && depth === top.enterDepth) { stack.pop(); depth--; continue; }
      depth--;
      if (depth === 0) return i;
      continue;
    }
  }
  return -1;
}

/** Split a `{ ... }` object-literal source (braces included) into its
 * top-level entries and return each entry's KEY (bare identifier, or the
 * identifier before `:` in `key: expr`). Nested braces/parens/brackets and
 * string/template contents never fool the top-level comma split. */
function topLevelKeys(objSrc: string): string[] {
  const inner = objSrc.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  const stack: StrCtx[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const top = stack[stack.length - 1];
    if (top === "sq" || top === "dq") {
      cur += c;
      if (c === "\\") { cur += inner[i + 1]; i++; continue; }
      if ((top === "sq" && c === "'") || (top === "dq" && c === '"')) stack.pop();
      continue;
    }
    if (top === "tmpl") {
      cur += c;
      if (c === "\\") { cur += inner[i + 1]; i++; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && inner[i + 1] === "{") { depth++; stack.push({ type: "exprInTmpl", enterDepth: depth }); cur += inner[i + 1]; i++; continue; }
      continue;
    }
    if (c === "'") { stack.push("sq"); cur += c; continue; }
    if (c === '"') { stack.push("dq"); cur += c; continue; }
    if (c === "`") { stack.push("tmpl"); cur += c; continue; }
    if (c === "{" || c === "(" || c === "[") { depth++; cur += c; continue; }
    if (c === "}" || c === ")" || c === "]") {
      if (typeof top === "object" && top.type === "exprInTmpl" && depth === top.enterDepth) { stack.pop(); depth--; cur += c; continue; }
      depth--; cur += c; continue;
    }
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("...")) return "..."; // spread — not a fixed token name, ignored below
      const keyed = p.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (keyed?.[1]) return keyed[1];
      const bare = p.match(/^([A-Za-z_$][\w$]*)$/);
      if (bare?.[1]) return bare[1];
      return `???${p}`; // unparseable entry — surfaced so a broken scan fails loudly, not silently
    });
}

/** For every `renderPrompt("name", { vars }, …)` call site across src/*.ts,
 * the set of var keys that call site supplies. When a card name has MULTIPLE
 * call sites (e.g. reviewer-repo is used by both the primary and the Codex-
 * down fallback leg), the guarantee is the INTERSECTION of what every call
 * site supplies — a token only some call sites pass would still leak as
 * literal "{{token}}" text on the call sites that don't. */

// ---- agent routing (routing.ts) made the FIRST argument of renderPrompt
// dynamic: loop.ts now calls renderPrompt(implRoute.card, …), where
// `implRoute` came from route("<stage>", "<role>"). A card name is therefore
// no longer a literal at the call site, and a scanner that only understood
// literals would quietly find NO call site for implementer/fixer/tester/… and
// pass vacuously — the exact failure mode this suite exists to prevent.
//
// So resolve the routed form too: map each `const <var> = route("stage",
// "role")` to its role, then to EVERY card that role can resolve to (the
// role's default card `agents/<role>.md`, plus any specialist card whose
// frontmatter declares `role: <role>`). Each of those cards must have its
// {{token}}s supplied by that call site — a new specialist that references a
// token the call site doesn't pass fails here, exactly like a drifted default
// card does.

/** `const implRoute = route("implementer", "implementer");` → var → role. */
function scanRouteVars(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*route\(\s*(['"])[\w-]+\2\s*,\s*(['"])([\w-]+)\3\s*\)/g;
  for (const file of readdirSync(SRC_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(SRC_DIR, file), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.set(m[1]!, m[4]!);
  }
  return out;
}

/** Every card a role can resolve to: its default card, plus specialists. */
function cardsForRole(role: string): string[] {
  const out = new Set<string>([role]);
  for (const name of listCards()) {
    if ((getCard(name)?.frontmatter.role ?? "").trim() === role) out.add(name);
  }
  return [...out];
}

function scanRenderPromptCallSites(): Map<string, Set<string>> {
  const routeVars = scanRouteVars();
  const perCardKeySets = new Map<string, Set<string>[]>();
  // First arg: a string literal, OR a `<var>.card` produced by route(...).
  const callSiteRe = /renderPrompt\(\s*(?:(['"])([\w-]+)\1|([A-Za-z_$][\w$]*)\.card)\s*,/g;
  // Every renderPrompt( occurrence must be recognized by the pattern above —
  // a new call-site idiom must fail loudly, never silently go unscanned.
  const anyCallRe = /renderPrompt\(/g;
  for (const file of readdirSync(SRC_DIR)) {
    if (!file.endsWith(".ts")) continue;
    if (file === "catalog.ts") continue; // renderPrompt's own definition
    const src = readFileSync(join(SRC_DIR, file), "utf8");
    const recognized = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = callSiteRe.exec(src))) {
      recognized.add(m.index);
      let names: string[];
      if (m[2] !== undefined) {
        names = [m[2]];
      } else {
        const role = routeVars.get(m[3]!);
        if (role === undefined) {
          throw new Error(`catalog-drift scan: renderPrompt(${m[3]}.card, …) in ${file} — no \`const ${m[3]} = route("<stage>", "<role>")\` found; scanner needs updating`);
        }
        names = cardsForRole(role);
      }
      let i = callSiteRe.lastIndex;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] !== "{") {
        throw new Error(`catalog-drift scan: renderPrompt(${names.join("|")}, …) in ${file} is not followed by a { vars } object literal — scanner needs updating`);
      }
      const close = findMatchingBrace(src, i);
      if (close < 0) throw new Error(`catalog-drift scan: unbalanced vars object for renderPrompt(${names.join("|")}) in ${file}`);
      const keys = topLevelKeys(src.slice(i, close + 1)).filter((k) => k !== "..." && !k.startsWith("???"));
      for (const name of names) {
        if (!perCardKeySets.has(name)) perCardKeySets.set(name, []);
        perCardKeySets.get(name)!.push(new Set(keys));
      }
    }
    let a: RegExpExecArray | null;
    while ((a = anyCallRe.exec(src))) {
      if (!recognized.has(a.index)) {
        throw new Error(`catalog-drift scan: unrecognized renderPrompt(...) call form in ${file} at offset ${a.index} — scanner needs updating`);
      }
    }
  }
  const intersected = new Map<string, Set<string>>();
  for (const [name, sets] of perCardKeySets) {
    const [first, ...rest] = sets;
    const acc = new Set(first ?? []);
    for (const s of rest) for (const k of [...acc]) if (!s.has(k)) acc.delete(k);
    intersected.set(name, acc);
  }
  return intersected;
}

const callSiteVars = scanRenderPromptCallSites();
const cardNames = listCards();

// Sanity on the scanner itself: it must have found the real call sites we
// know exist, or the whole test is vacuous (asserting nothing).
test("sanity: the call-site scanner actually found renderPrompt(...) usages", () => {
  expect(callSiteVars.size).toBeGreaterThan(5);
  expect(callSiteVars.get("decomposer")).toEqual(new Set(["repo", "spec", "brief"]));
  expect(callSiteVars.get("intake-author")).toEqual(new Set(["spec", "brief", "answers"]));
  // Routed call sites (renderPrompt(implRoute.card, …)) resolve through
  // route("implementer", "implementer") to the default card AND every
  // specialist declaring that role — so a specialist is covered by this guard
  // the moment it lands, without anyone remembering to add it here.
  expect(callSiteVars.get("implementer")).toEqual(new Set(["repo", "spec"]));
  expect(callSiteVars.get("implementer-ui")).toEqual(new Set(["repo", "spec"]));
});

describe("every {{token}} in an agent card is supplied by its renderPrompt call site(s)", () => {
  for (const name of cardNames) {
    test(name, () => {
      const card = getCard(name);
      if (!card) throw new Error(`listCards() returned "${name}" but getCard() could not load it`);
      const tokens = new Set([...card.prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
      if (tokens.size === 0) return; // no placeholders — nothing to drift

      const supplied = callSiteVars.get(name);
      expect(supplied, `agents/${name}.md uses {{token}}s but no src/*.ts renderPrompt("${name}", …) call site was found`).toBeDefined();

      for (const token of tokens) {
        expect(supplied!.has(token),
          `agents/${name}.md references {{${token}}} but its renderPrompt("${name}", …) call site(s) only supply [${[...supplied!].join(", ")}] — the token will render as literal "{{${token}}}" text`,
        ).toBe(true);
      }
    });
  }
});

describe("load-bearing protocol strings are present in the cards downstream code depends on", () => {
  // name -> substrings that MUST appear in the card body. Each entry mirrors a
  // real parser/regex elsewhere in src/ that would silently stop matching if
  // the card's wording drifted (this is what caught B1 for decomposer/dag.ts).
  const required: Record<string, string[]> = {
    // dag.ts parses "## Depends-on" and "## Touches" sections out of child
    // ticket bodies the decomposer writes.
    decomposer: ["## Touches", "## Depends-on"],
    // intake.ts's extractQuestions() keys off "QUESTIONS:"; {{answers}} is the
    // B2 fix — without it, re-prompts never see the human's answers.
    "intake-author": ["QUESTIONS:", "{{answers}}"],
    // loop.ts's tastePasses() matches /TASTE:\s*fail/i on the design reviewer's output.
    "design-reviewer": ["TASTE:"],
    // loop.ts's mapBrowserEvidence() matches /VERDICT:\s*(pass|partial|fail)/i on the tester's output.
    tester: ["VERDICT:"],
    // loop.ts's parseSecurityVerdict() matches /SECURITY:\s*fail/i on the security reviewer's output.
    "security-reviewer": ["SECURITY:"],
  };

  for (const [name, needles] of Object.entries(required)) {
    test(name, () => {
      const card = getCard(name);
      if (!card) throw new Error(`agents/${name}.md is missing — its downstream parser has nothing to match against`);
      for (const needle of needles) {
        expect(card.prompt.includes(needle), `agents/${name}.md is missing the load-bearing protocol string "${needle}"`).toBe(true);
      }
    });
  }

  test("every card named above actually exists in agents/ (guards against a silent rename/delete)", () => {
    for (const name of Object.keys(required)) expect(cardNames).toContain(name);
  });
});
