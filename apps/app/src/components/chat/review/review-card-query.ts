import { queryOptions } from "@tanstack/react-query";
import type { SavedReview } from "@legalwork/types/reviews";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { reviewKey } from "@/react-app/domains/reviews/review-ui";

export function reviewCardQueryOptions(client: Pick<LegalworkServerClient, "getReview"> | null, workspaceId: string, reviewId: string, previous?: () => SavedReview | undefined) {
  return queryOptions({
    queryKey: reviewKey(workspaceId, reviewId),
    queryFn: () => {
      if (!client) throw new Error("A connected project is required.");
      return client.getReview(workspaceId, reviewId, previous?.());
    },
    enabled: !!client,
    // A create card may have cached a draft before the start tool finishes.
    // Reopening chat must also pick up runs started from the review page.
    refetchOnMount: "always",
    retry: (count, error) => !(error instanceof LegalworkServerError && error.code === "review_not_found") && count < 3,
    refetchInterval: query => query.state.error instanceof LegalworkServerError && query.state.error.code === "review_not_found" ? false : query.state.data?.status === "running" || !query.state.data ? 1000 : 15000,
  });
}
