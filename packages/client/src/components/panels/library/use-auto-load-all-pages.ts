import { useEffect } from "react";

type InfinitePages = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  fetchNextPage: () => Promise<unknown>;
  data?: { pages: unknown[] };
};

/** Views that need every item (like grouping by campaign) keep fetching pages up to a safety cap. */
export function useAutoLoadAllPages(query: InfinitePages, enabled: boolean, maxPages = 50) {
  const pageCount = query.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = query;
  useEffect(() => {
    if (!enabled || !hasNextPage || isFetchingNextPage || isFetching || pageCount >= maxPages) return;
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, maxPages, pageCount]);
}
