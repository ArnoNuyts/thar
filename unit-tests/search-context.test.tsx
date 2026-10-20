import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { useEffect } from "react";
import { waitFor } from "./test-utils.ts";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  return <SearchProvider>{children}</SearchProvider>;
};

test("SearchContext: should update search query", async () => {
  let capturedQuery = "";

  const QuerySetter = ({ query }: { query: string }) => {
    const { setSearchQuery } = useSearch();
    useEffect(() => {
      setSearchQuery(query);
    }, [query, setSearchQuery]);
    return null;
  };

  const QueryReader = () => {
    const { searchQuery } = useSearch();
    capturedQuery = searchQuery;
    return null;
  };

  const { unmount } = render(
    <TestWrapper>
      <QuerySetter query="test query" />
      <QueryReader />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(capturedQuery).toEqual("test query");
  });

  unmount();
});

test("SearchContext: should call focus callback when focusRef.current is called", async () => {
  let focusCalled = false;

  const FocusListener = () => {
    const { focusRef } = useSearch();
    useEffect(() => {
      focusRef.current = () => {
        focusCalled = true;
      };
      focusRef.current();
    }, [focusRef]);
    return null;
  };

  const { unmount } = render(
    <TestWrapper>
      <FocusListener />
    </TestWrapper>,
  );

  await waitFor(() => {
    expect(focusCalled).toEqual(true);
  });

  unmount();
});
