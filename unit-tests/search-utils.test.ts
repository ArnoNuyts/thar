import { expect, test } from "vitest";

import {
  extractSearchTerms,
  extractTagsAndContextsFromSearch,
} from "../utils/search-utils.ts";

test("extractTagsAndContextsFromSearch: empty string returns empty", () => {
  expect(extractTagsAndContextsFromSearch("")).toEqual("");
});

test("extractTagsAndContextsFromSearch: no tags returns empty", () => {
  expect(extractTagsAndContextsFromSearch("just some text")).toEqual("");
});

test("extractTagsAndContextsFromSearch: extracts single context", () => {
  expect(extractTagsAndContextsFromSearch("@home")).toEqual(" @home ");
});

test("extractTagsAndContextsFromSearch: extracts single project", () => {
  expect(extractTagsAndContextsFromSearch("+work")).toEqual(" +work ");
});

test("extractTagsAndContextsFromSearch: extracts context from mixed text", () => {
  expect(
    extractTagsAndContextsFromSearch("some text @home other text"),
  ).toEqual(" @home ");
});

test("extractTagsAndContextsFromSearch: extracts project from mixed text", () => {
  expect(
    extractTagsAndContextsFromSearch("some text +work other text"),
  ).toEqual(" +work ");
});

test("extractTagsAndContextsFromSearch: extracts multiple contexts", () => {
  const result = extractTagsAndContextsFromSearch("@home @office");
  expect(result).toEqual(" @home @office ");
});

test("extractTagsAndContextsFromSearch: extracts multiple projects", () => {
  const result = extractTagsAndContextsFromSearch("+work +personal");
  expect(result).toEqual(" +work +personal ");
});

test("extractTagsAndContextsFromSearch: extracts mixed tags and contexts", () => {
  const result = extractTagsAndContextsFromSearch("+work @home @office +side");
  expect(result).toEqual(" +work +side @home @office ");
});

test("extractTagsAndContextsFromSearch: handles tags with underscores and dots", () => {
  const result = extractTagsAndContextsFromSearch(
    "+work.project_1 @home_office",
  );
  expect(result).toEqual(" +work.project_1 @home_office ");
});

test("extractSearchTerms: splits by whitespace", () => {
  expect(extractSearchTerms("buy milk")).toEqual(["buy", "milk"]);
});

test("extractSearchTerms: preserves context and project prefixes", () => {
  expect(extractSearchTerms("@work +bug")).toEqual(["@work", "+bug"]);
});

test("extractSearchTerms: strips wrapper punctuation", () => {
  expect(extractSearchTerms("/@work +bug/")).toEqual(["@work", "+bug"]);
});

test("extractTagsAndContextsFromSearch: extracts tags without a preceding space", () => {
  expect(extractTagsAndContextsFromSearch("foo+bar baz@home")).toEqual(
    " +bar @home ",
  );
});

test("extractTagsAndContextsFromSearch: preserves backslashes in tag names", () => {
  expect(extractTagsAndContextsFromSearch("+foo\\bar @home\\office")).toEqual(
    " +foo\\bar @home\\office ",
  );
});
