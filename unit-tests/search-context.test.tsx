import { render } from "ink-testing-library";
import { assertEquals } from "@std/assert";
import { useEffect } from "react";
import { waitFor } from "./test-utils.ts";
import { SearchProvider, useSearch } from "../contexts/search-context.tsx";

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  return <SearchProvider>{children}</SearchProvider>;
};

Deno.test(
  "SearchContext: should update search query",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
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
      assertEquals(capturedQuery, "test query");
    });

    unmount();
  },
);

Deno.test(
  "SearchContext: should call focus callback when focusRef.current is called",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    let focusCalled = false;

    const FocusListener = () => {
      const { focusRef } = useSearch();
      useEffect(() => {
        focusRef.current = () => {
          focusCalled = true;
        };
        setTimeout(() => focusRef.current?.(), 50);
      }, [focusRef]);
      return null;
    };

    const { unmount } = render(
      <TestWrapper>
        <FocusListener />
      </TestWrapper>,
    );

    await waitFor(() => {
      assertEquals(focusCalled, true);
    });

    unmount();
  },
);
