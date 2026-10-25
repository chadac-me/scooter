/**
 * The AskUserQuestion card's answer rules: one pick or typed text per single-select question,
 * comma-joined picks plus text for multi-select, and nothing to send until every question has one.
 */

import { describe, it, expect } from "vitest";

import { answerOf, buildAnswers, questionsOf, toggle, type Question, type Selection } from "./QuestionCard.js";

const single: Question = { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] };
const multi: Question = {
  question: "Which features?",
  header: "Features",
  options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
  multiSelect: true,
};
const sel = (picked: string[], other = ""): Selection => ({ picked, other });

describe("toggle", () => {
  it("replaces the pick on a single-select question, and a second click clears it", () => {
    expect(toggle(sel(["Postgres"]), "SQLite", false).picked).toEqual(["SQLite"]);
    expect(toggle(sel(["SQLite"]), "SQLite", false).picked).toEqual([]);
  });
  it("toggles picks on a multi-select question", () => {
    expect(toggle(sel(["Auth"]), "Search", true).picked).toEqual(["Auth", "Search"]);
    expect(toggle(sel(["Auth", "Search"]), "Auth", true).picked).toEqual(["Search"]);
  });
});

describe("answerOf", () => {
  it("prefers typed text over a single pick", () => {
    expect(answerOf(single, sel(["Postgres"]))).toBe("Postgres");
    expect(answerOf(single, sel([], " DuckDB "))).toBe("DuckDB");
  });
  it("joins multi picks in option order, then the typed text", () => {
    expect(answerOf(multi, sel(["Search", "Auth"], "SSO"))).toBe("Auth, Search, SSO");
  });
  it("is empty when nothing is chosen", () => {
    expect(answerOf(single, undefined)).toBe("");
    expect(answerOf(multi, sel([], "  "))).toBe("");
  });
});

describe("buildAnswers", () => {
  it("is undefined until every question is answered @proves", () => {
    expect(buildAnswers([single, multi], { 0: sel(["SQLite"]) })).toBeUndefined();
    expect(buildAnswers([single, multi], { 0: sel(["SQLite"]), 1: sel(["Billing"]) })).toEqual({
      "Which DB?": "SQLite",
      "Which features?": "Billing",
    });
  });
});

describe("questionsOf", () => {
  it("reads the request data's questions, dropping malformed ones and label-less options", () => {
    expect(questionsOf({ questions: [single] })).toEqual([single]);
    expect(questionsOf({ questions: [{ question: "Q?", options: [{ label: "A" }, { nope: 1 }] }] })).toEqual([
      { question: "Q?", header: "", options: [{ label: "A" }] },
    ]);
  });

  it("is undefined when the data holds no usable question", () => {
    expect(questionsOf(undefined)).toBeUndefined();
    expect(questionsOf({ questions: [] })).toBeUndefined();
    expect(questionsOf({ questions: [{ question: "Q?", options: [] }] })).toBeUndefined();
  });
});
