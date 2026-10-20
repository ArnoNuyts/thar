import { assertEquals } from "@std/assert";
import {
  CONTEXT_PATTERN,
  CONTEXT_REGEX,
  matchContexts,
  matchProjects,
  matchTagWordStart,
  PROJECT_PATTERN,
  PROJECT_REGEX,
} from "../logic/patterns.ts";

Deno.test("patterns: extracts project names", () => {
  assertEquals(matchProjects("Fix +work +home.project @home +work"), [
    "work",
    "home.project",
    "work",
  ]);
});

Deno.test("patterns: extracts context names", () => {
  assertEquals(matchContexts("Fix +work @home @home_office @home"), [
    "home",
    "home_office",
    "home",
  ]);
});

Deno.test("patterns: matchAll does not mutate global regex state", () => {
  assertEquals(matchProjects("+work"), ["work"]);
  assertEquals(PROJECT_REGEX.lastIndex, 0);
  assertEquals(matchProjects("+work"), ["work"]);
  assertEquals(PROJECT_REGEX.lastIndex, 0);

  assertEquals(matchContexts("@home"), ["home"]);
  assertEquals(CONTEXT_REGEX.lastIndex, 0);
  assertEquals(matchContexts("@home"), ["home"]);
  assertEquals(CONTEXT_REGEX.lastIndex, 0);
});

Deno.test("patterns: non-global copies can be tested repeatedly", () => {
  assertEquals(PROJECT_PATTERN.test("+work"), true);
  assertEquals(PROJECT_PATTERN.test("+work"), true);
  assertEquals(PROJECT_PATTERN.test("work"), false);

  assertEquals(CONTEXT_PATTERN.test("@home"), true);
  assertEquals(CONTEXT_PATTERN.test("@home"), true);
  assertEquals(CONTEXT_PATTERN.test("home"), false);
});

Deno.test("patterns: matches a project at a word start", () => {
  assertEquals(matchTagWordStart("buy +pro"), {
    word: "+pro",
    startIndex: 4,
    type: "project",
    searchTerm: "pro",
  });
  assertEquals(matchTagWordStart("+pro"), {
    word: "+pro",
    startIndex: 0,
    type: "project",
    searchTerm: "pro",
  });
});

Deno.test("patterns: matches a context at a word start", () => {
  assertEquals(matchTagWordStart("buy @con"), {
    word: "@con",
    startIndex: 4,
    type: "context",
    searchTerm: "con",
  });
  assertEquals(matchTagWordStart("@con"), {
    word: "@con",
    startIndex: 0,
    type: "context",
    searchTerm: "con",
  });
});

Deno.test("patterns: handles dots, underscores and dashes in tags", () => {
  assertEquals(matchTagWordStart("buy +work.project_1-2"), {
    word: "+work.project_1-2",
    startIndex: 4,
    type: "project",
    searchTerm: "work.project_1-2",
  });
});

Deno.test("patterns: does not match tags in the middle of a word", () => {
  assertEquals(matchTagWordStart("email@con"), null);
  assertEquals(matchTagWordStart("buy pro"), null);
});
