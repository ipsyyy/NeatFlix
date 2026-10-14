/**
 * Campaign model for campaign matching (PRODUCT_SOURCE_OF_TRUTH.md §4.3).
 */

import type { PlacementObject } from "@/lib/scenes/types";

export type SubscriptionTier = "ad-supported" | "premium-ad-free";

/** Audiences that must always be excluded (§4.3, §7.1 Harmless). */
export type AudienceExclusion = "premium-ad-free" | "under-18";

/**
 * Advertiser categories. The last five are out of scope (§13) and can never
 * pass the build-time guard.
 */
export type AdvertiserCategory =
  | "quick-service-food-beverage"
  | "consumer-electronics"
  | "pharmaceutical"
  | "political"
  | "gambling"
  | "alcohol"
  | "child-directed";

export type BrandSafetyRisk = "low" | "medium" | "high";

export type Campaign = {
  id: string;
  advertiser: string;
  product: string;
  /** What appears on screen, e.g. a branded takeaway cup. */
  productFormat: string;
  category: AdvertiserCategory;
  /** The scene object this product would appear as. */
  placementObject: PlacementObject;
  market: string;
  audience: {
    minAge: number;
    maxAge: number;
    eligibleTiers: SubscriptionTier[];
    exclusions: AudienceExclusion[];
  };
  objective: string;
  brandSafetyRisk: BrandSafetyRisk;
  /** Placement length on screen, in seconds. */
  placementSeconds: { min: number; max: number };
  /** Why this kind of object belongs in everyday scenes. Used as fit evidence. */
  naturalUse: string;
  /** Known limits of this fixture that the recommendation must disclose. */
  assumptions: string[];
  source: "demo-fixture";
};
