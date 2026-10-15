import type { AdvertiserCategory, SubscriptionTier } from "./types";

/** Shared by the build-time campaign guard and the matcher, so both enforce the same rules. */
export const ADULT_MIN_AGE = 18;
export const PLACEMENT_MIN_SECONDS = 3;
export const PLACEMENT_MAX_SECONDS = 5;
export const SUPPORTED_TIERS: readonly SubscriptionTier[] = ["ad-supported"];

/** Markets the MVP can place campaigns in. */
export const SUPPORTED_MARKETS: readonly string[] = ["United States"];

/** Advertising categories that are out of scope (PRODUCT_SOURCE_OF_TRUTH.md §13). */
export const OUT_OF_SCOPE_CATEGORIES: readonly AdvertiserCategory[] = [
  "pharmaceutical",
  "political",
  "gambling",
  "alcohol",
  "child-directed",
];

export const categoryLabel: Record<AdvertiserCategory, string> = {
  "quick-service-food-beverage": "Quick-service food and beverage",
  "consumer-electronics": "Consumer electronics",
  pharmaceutical: "Pharmaceutical",
  political: "Political",
  gambling: "Gambling",
  alcohol: "Alcohol",
  "child-directed": "Child-directed",
};
