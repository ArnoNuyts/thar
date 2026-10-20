import { expect, test } from "vitest";

import {
  CONTEXT_PATTERN,
  CONTEXT_REGEX,
  matchContexts,
  matchProjects,
  matchTagWordStart,
  PROJECT_PATTERN,
  PROJECT_REGEX,
} from "../logic/patterns.ts";

test("patterns: extracts project names", () => {
  expect(matchProjects("Fix +work +home.project @home +work")).toEqual([
    "work",
    "home.project",
    "work",
  ]);
});

test("patterns: extracts context names", () => {
  expect(matchContexts("Fix +work @home @home_office @home")).toEqual([
    "home",
    "home_office",
    "home",
  ]);
});

test("patterns: matchAll does not mutate global regex state", () => {
  expect(matchProjects("+work")).toEqual(["work"]);
  expect(PROJECT_REGEX.lastIndex).toEqual(0);
  expect(matchProjects("+work")).toEqual(["work"]);
  expect(PROJECT_REGEX.lastIndex).toEqual(0);

  expect(matchContexts("@home")).toEqual(["home"]);
  expect(CONTEXT_REGEX.lastIndex).toEqual(0);
  expect(matchContexts("@home")).toEqual(["home"]);
  expect(CONTEXT_REGEX.lastIndex).toEqual(0);
});

test("patterns: non-global copies can be tested repeatedly", () => {
  expect(PROJECT_PATTERN.test("+work")).toEqual(true);
  expect(PROJECT_PATTERN.test("+work")).toEqual(true);
  expect(PROJECT_PATTERN.test("work")).toEqual(false);

  expect(CONTEXT_PATTERN.test("@home")).toEqual(true);
  expect(CONTEXT_PATTERN.test("@home")).toEqual(true);
  expect(CONTEXT_PATTERN.test("home")).toEqual(false);
});

test("patterns: matches a project at a word start", () => {
  expect(matchTagWordStart("buy +pro")).toEqual({
    word: "+pro",
    startIndex: 4,
    type: "project",
    searchTerm: "pro",
  });
  expect(matchTagWordStart("+pro")).toEqual({
    word: "+pro",
    startIndex: 0,
    type: "project",
    searchTerm: "pro",
  });
});

test("patterns: matches a context at a word start", () => {
  expect(matchTagWordStart("buy @con")).toEqual({
    word: "@con",
    startIndex: 4,
    type: "context",
    searchTerm: "con",
  });
  expect(matchTagWordStart("@con")).toEqual({
    word: "@con",
    startIndex: 0,
    type: "context",
    searchTerm: "con",
  });
});

test("patterns: handles dots, underscores and dashes in tags", () => {
  expect(matchTagWordStart("buy +work.project_1-2")).toEqual({
    word: "+work.project_1-2",
    startIndex: 4,
    type: "project",
    searchTerm: "work.project_1-2",
  });
});

test("patterns: does not match tags in the middle of a word", () => {
  expect(matchTagWordStart("email@con")).toEqual(null);
  expect(matchTagWordStart("buy pro")).toEqual(null);
});
