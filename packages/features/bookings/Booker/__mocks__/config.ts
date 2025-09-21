vi.mock("../config", () => ({
  getBookerSizeClassNames: () => [],
  extraDaysConfig: {
    mobile: { desktop: 0, tablet: 0 },
    month_view: { desktop: 0, tablet: 0 },
    week_view: { desktop: 0, tablet: 0 },
    column_view: { desktop: 0, tablet: 0 },
  },
}));
