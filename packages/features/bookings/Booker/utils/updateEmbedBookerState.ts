export type BookerState = "loading" | "selecting_date" | "selecting_time" | "booking";

export type SlotsQueryLike = {
  isLoading?: boolean;
  isPending?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
};

export type EmbedBookerState =
  | "initializing"
  | "slotsPending"
  | "slotsLoading"
  | "slotsDone"
  | "slotsLoadingError";

export const getEmbedBookerState = ({
  bookerState,
  slotsQuery,
}: {
  bookerState: BookerState;
  slotsQuery: SlotsQueryLike;
}): EmbedBookerState => {
  if (bookerState === "loading") {
    return "initializing";
  }

  if (slotsQuery.isLoading) {
    return "slotsLoading";
  }

  if (slotsQuery.isPending) {
    return "slotsDone";
  }

  if (slotsQuery.isSuccess) {
    return "slotsDone";
  }

  if (slotsQuery.isError) {
    return "slotsLoadingError";
  }

  return "slotsPending";
};

export const updateEmbedBookerState = ({
  bookerState,
  slotsQuery,
}: {
  bookerState: BookerState;
  slotsQuery: SlotsQueryLike;
}) => {
  if (typeof window === "undefined") {
    return;
  }

  const embedBookerState = getEmbedBookerState({ bookerState, slotsQuery });

  (window as typeof window & { _embedBookerState?: EmbedBookerState })._embedBookerState = embedBookerState;
};
