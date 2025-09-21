import { BookerLayouts } from "@calcom/prisma/zod-utils";

import type { BookerLayout, BookerState } from "./types";

export const getBookerSizeClassNames = (
  layout: BookerLayout,
  bookerState: BookerState,
  hideEventTypeDetails = false
) => {
  const getBookerMetaClass = (className: string) => {
    if (hideEventTypeDetails) {
      return "";
    }
    return className;
  };

  return [
    // Size settings are abstracted on their own lines purely for readability.
    // General sizes, used always
    "[--booker-timeslots-width:240px] lg:[--booker-timeslots-width:280px]",
    // Small calendar defaults
    layout === BookerLayouts.MONTH_VIEW && getBookerMetaClass("[--booker-meta-width:240px]"),
    // Meta column gets wider in booking view to fit the full date on a single row in case
    // of a multi occurrence event. Also makes form less wide, which also looks better.
    layout === BookerLayouts.MONTH_VIEW &&
      bookerState === "booking" &&
      `[--booker-main-width:420px] ${getBookerMetaClass("lg:[--booker-meta-width:340px]")}`,
    // Smaller meta when not in booking view.
    layout === BookerLayouts.MONTH_VIEW &&
      bookerState !== "booking" &&
      `[--booker-main-width:480px] ${getBookerMetaClass("lg:[--booker-meta-width:280px]")}`,
    // Fullscreen view settings.
    layout !== BookerLayouts.MONTH_VIEW &&
      `[--booker-main-width:480px] [--booker-meta-width:340px] ${getBookerMetaClass(
        "lg:[--booker-meta-width:424px]"
      )}`,
  ];
};

/**
 * These configures the amount of days that are shown on top of the selected date.
 */
export const extraDaysConfig = {
  mobile: {
    // Desktop tablet feels weird on mobile layout,
    // but this is simply here to make the types a lot easier..
    desktop: 0,
    tablet: 0,
  },
  [BookerLayouts.MONTH_VIEW]: {
    desktop: 0,
    tablet: 0,
  },
  [BookerLayouts.WEEK_VIEW]: {
    desktop: 7,
    tablet: 4,
  },
  [BookerLayouts.COLUMN_VIEW]: {
    desktop: 6,
    tablet: 2,
  },
};
