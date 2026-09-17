/**
 * Directives 7-10 target the diagnosed multi-session failures: over-counting with full
 * evidence (60472f9c answered 4 and 3 against a gold of 2), refusing arithmetic the table
 * supports (4adc0475 would not add 3 goals and 2 assists), double-counting one event across
 * sessions (gpt4_2f8be40d's "three, possibly four"), and reading the When column as the event
 * date (51c32626 answered the session date, May 22, with "submission date was February 1st"
 * sitting at rank 2).
 *
 * Every one of those pushes toward answering MORE, which is the same dial as hallucinating on
 * an unanswerable question — already dem's worst metric against Strata (26.7% vs 20.0%). So
 * the contract these tests defend is: each directive is gated on the evidence being present,
 * directive 3 keeps the last word on abstention, and NOTHING changes when the flag is off.
 */
import { describe, expect, it } from "vitest";
import { buildReflectSystemPrompt } from "../src/engine/reflect.js";

const table = "| Network | When | Statement |\n| :---- | :---- | :---- |\n| [FACT] | 2023-05-25 | user x: y |";

describe("groundedCounting is off by default", () => {
  it("adds nothing to the prompt unless asked", () => {
    const off = buildReflectSystemPrompt(table, undefined, { asOf: "2023-05-30T00:00:00.000Z" });
    const on = buildReflectSystemPrompt(table, undefined, {
      asOf: "2023-05-30T00:00:00.000Z",
      groundedCounting: true,
    });
    expect(off).not.toContain("do the arithmetic");
    expect(off).not.toContain("commit to ONE number");
    expect(on.length).toBeGreaterThan(off.length);
    // The base prompt is untouched — the flag only appends.
    for (const line of off.split("\n")) expect(on).toContain(line);
  });
});

describe("every directive is gated on the evidence being present", () => {
  const prompt = buildReflectSystemPrompt(table, undefined, { groundedCounting: true });

  it("arithmetic is conditioned on the operands being in the table", () => {
    expect(prompt).toContain("When the quantities are present in the table, do the arithmetic");
    expect(prompt).toContain("Do not decline arithmetic whose operands are all in");
    // The failure mode to avoid: inventing a missing operand to complete a sum.
    expect(prompt).toContain("If an operand is missing, say which one — do not guess it.");
  });

  it("count commitment hands the zero case back to the abstention directive", () => {
    expect(prompt).toContain("commit to ONE number supported by the table");
    expect(prompt).toContain("If the table substantiates no");
    expect(prompt).toContain("directive 3 governs and you abstain");
  });

  it("forbids hedged counts specifically, since that is the observed failure", () => {
    expect(prompt).toContain("Do not answer");
    expect(prompt).toContain('("three, possibly four")');
  });

  it("coreference rule says separate rows are not separate occurrences", () => {
    expect(prompt).toContain("Count each underlying event, project, or item ONCE");
    expect(prompt).toContain("separate");
    expect(prompt).toContain("rows are not separate occurrences");
  });
});

describe("directive numbering stays ordered", () => {
  it("places 7-10 AFTER directive 6, which is what defines the When column", () => {
    const prompt = buildReflectSystemPrompt(table, undefined, { groundedCounting: true });
    const six = prompt.indexOf("6. The When column");
    const seven = prompt.indexOf("7. When the quantities");
    const ten = prompt.indexOf("10. A row's When column");
    expect(six).toBeGreaterThan(-1);
    // Directive 10 qualifies the column directive 6 introduces; reading 10 first is incoherent.
    expect(seven).toBeGreaterThan(six);
    expect(ten).toBeGreaterThan(seven);
  });
});

describe("directive 10 does not undermine the When column", () => {
  const prompt = buildReflectSystemPrompt(table, undefined, {
    asOf: "2023-05-30T00:00:00.000Z",
    groundedCounting: true,
  });

  it("scopes the override to statements that NAME a date, not to the column in general", () => {
    expect(prompt).toContain("A row's When column dates the STATEMENT");
    expect(prompt).toContain("the statement's own text names a date");
  });

  it("never tells the model the When column is mere conversation metadata", () => {
    // temporal-reasoning is 90.2% BECAUSE the model trusts this column. Describing it as
    // "when the conversation occurred" would be both inaccurate (validStart comes from
    // extraction; 16.5% of facts are dated ahead of their session) and a direct attack on
    // the highest-scoring type.
    expect(prompt).not.toContain("when the conversation occurred");
    expect(prompt).not.toContain("session timestamp");
    // Directive 6 still stands unqualified.
    expect(prompt).toContain("The When column is when each statement became true");
  });
});

describe("the abstention directive keeps the last word", () => {
  const prompt = buildReflectSystemPrompt(table, undefined, { groundedCounting: true });

  it("retains directive 3 verbatim", () => {
    expect(prompt).toContain("Output exactly [DATA_ABSENT] ONLY when nothing in the table bears");
  });

  it("adds no unconditional instruction to always produce an answer", () => {
    for (const banned of [
      "always answer",
      "at all costs",
      "never abstain",
      "never say the table lacks",
      "always commit to an exact count",
    ]) {
      expect(prompt.toLowerCase()).not.toContain(banned);
    }
  });
});
