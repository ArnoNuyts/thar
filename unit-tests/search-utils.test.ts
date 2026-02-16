import { assertEquals } from "@std/assert";
import { extractTagsAndContextsFromSearch } from "../utils/search-utils.ts";

Deno.test("extractTagsAndContextsFromSearch: empty string returns empty", () => {
  assertEquals(extractTagsAndContextsFromSearch(""), "");
});

Deno.test("extractTagsAndContextsFromSearch: no tags returns empty", () => {
  assertEquals(extractTagsAndContextsFromSearch("just some text"), "");
});

Deno.test("extractTagsAndContextsFromSearch: extracts single context", () => {
  assertEquals(extractTagsAndContextsFromSearch("@home"), " @home ");
});

Deno.test("extractTagsAndContextsFromSearch: extracts single project", () => {
  assertEquals(extractTagsAndContextsFromSearch("+work"), " +work ");
});

Deno.test("extractTagsAndContextsFromSearch: extracts context from mixed text", () => {
  assertEquals(
    extractTagsAndContextsFromSearch("some text @home other text"),
    " @home ",
  );
});

Deno.test("extractTagsAndContextsFromSearch: extracts project from mixed text", () => {
  assertEquals(
    extractTagsAndContextsFromSearch("some text +work other text"),
    " +work ",
  );
});

Deno.test("extractTagsAndContextsFromSearch: extracts multiple contexts", () => {
  const result = extractTagsAndContextsFromSearch("@home @office");
  assertEquals(result, " @home @office ");
});

Deno.test("extractTagsAndContextsFromSearch: extracts multiple projects", () => {
  const result = extractTagsAndContextsFromSearch("+work +personal");
  assertEquals(result, " +work +personal ");
});

Deno.test("extractTagsAndContextsFromSearch: extracts mixed tags and contexts", () => {
  const result = extractTagsAndContextsFromSearch("+work @home @office +side");
  assertEquals(result, " +work +side @home @office ");
});

Deno.test("extractTagsAndContextsFromSearch: handles tags with underscores and dots", () => {
  const result = extractTagsAndContextsFromSearch("+work.project_1 @home_office");
  assertEquals(result, " +work.project_1 @home_office ");
});
