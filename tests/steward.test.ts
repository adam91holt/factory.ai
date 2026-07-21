import { describe, expect, test } from "bun:test";
import { childrenAllTerminal } from "../src/steward.ts";

type Detail = Parameters<typeof childrenAllTerminal>[0];
type Child = Detail["children"][number];

const child = (over: Partial<Child> = {}): Child => ({
  identifier: "FAC-2", title: "child", stateName: "Todo", stateType: "unstarted", labels: [],
  ...over,
});

const detail = (children: Child[]): Detail => ({
  identifier: "FAC-1", title: "epic", description: "", url: "",
  stateName: "In Progress", labels: [], parent: null, children, siblings: [],
});

describe("childrenAllTerminal", () => {
  test("no children → false (nothing to steward)", () => {
    expect(childrenAllTerminal(detail([]))).toBe(false);
  });

  test("an executing child is never terminal — even in a review-named state", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Review", labels: ["Factory-Executing"] }),
    ]))).toBe(false);
  });

  test("parked and needs-human labels are terminal", () => {
    expect(childrenAllTerminal(detail([
      child({ labels: ["Factory-Parked"] }),
      child({ labels: ["Factory-Needs-Human"] }),
    ]))).toBe(true);
  });

  test("completed and canceled states are terminal", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "completed", stateName: "Done" }),
      child({ stateType: "canceled", stateName: "Canceled" }),
    ]))).toBe(true);
  });

  test("started + review-named state counts as terminal (PR open)", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Review" }),
      child({ stateType: "started", stateName: "Code review" }),
    ]))).toBe(true);
  });

  test("started but NOT review-named is still in flight", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "started", stateName: "In Progress" }),
    ]))).toBe(false);
  });

  test("queued children block: one straggler flips the whole epic to false", () => {
    expect(childrenAllTerminal(detail([
      child({ stateType: "completed", stateName: "Done" }),
      child({ stateType: "unstarted", stateName: "Todo" }),
    ]))).toBe(false);
  });

  test("missing labels array is tolerated", () => {
    const c = child({ stateType: "completed", stateName: "Done" });
    delete (c as { labels?: string[] }).labels;
    expect(childrenAllTerminal(detail([c]))).toBe(true);
  });
});
