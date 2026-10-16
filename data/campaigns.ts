/**
 * Campaign records — the single editable source for advertiser campaigns.
 *
 * DEMO FIXTURES: Daybreak Coffee is a fictional advertiser. Campaign,
 * audience, and matching data are hand-authored and labelled as fixtures in the UI.
 */

import {
  ADULT_MIN_AGE,
  OUT_OF_SCOPE_CATEGORIES,
  PLACEMENT_MAX_SECONDS,
  PLACEMENT_MIN_SECONDS,
  SUPPORTED_MARKETS,
  SUPPORTED_TIERS,
} from "@/lib/campaigns/rules";
import type { Campaign } from "@/lib/campaigns/types";

const MAX_REASONABLE_AGE = 100;

/** Fails the build if a campaign breaks the audience or brand-safety rules (§4.3, §7.1, §13). */
function defineCampaign(c: Campaign): Campaign {
  const { minAge, maxAge, eligibleTiers, exclusions } = c.audience;
  const fail = (msg: string) => {
    throw new Error(`Campaign ${c.id}: ${msg}`);
  };

  if (!Number.isInteger(minAge) || !Number.isInteger(maxAge)) fail("audience ages must be whole numbers.");
  if (minAge < ADULT_MIN_AGE) fail(`audience must be adults (${ADULT_MIN_AGE}+); got ${minAge}.`);
  if (maxAge < minAge || maxAge > MAX_REASONABLE_AGE) fail(`invalid audience range ${minAge}–${maxAge}.`);

  if (eligibleTiers.length === 0) fail("at least one subscription tier must be eligible.");
  for (const tier of eligibleTiers) {
    if (!SUPPORTED_TIERS.includes(tier)) fail(`subscription tier "${tier}" cannot receive placements.`);
  }
  for (const required of ["premium-ad-free", "under-18"] as const) {
    if (!exclusions.includes(required)) fail(`missing required exclusion "${required}".`);
  }

  if (!SUPPORTED_MARKETS.includes(c.market)) fail(`market "${c.market}" is not supported in the MVP.`);
  if (OUT_OF_SCOPE_CATEGORIES.includes(c.category)) fail(`category "${c.category}" is out of scope.`);
  if (c.brandSafetyRisk !== "low") fail(`brand-safety risk "${c.brandSafetyRisk}" is not allowed in the MVP.`);

  const { min, max } = c.placementSeconds;
  if (min < PLACEMENT_MIN_SECONDS || max > PLACEMENT_MAX_SECONDS || min > max) {
    fail(`placement must last ${PLACEMENT_MIN_SECONDS}–${PLACEMENT_MAX_SECONDS} seconds; got ${min}–${max}.`);
  }
  return c;
}

export const campaigns: readonly Campaign[] = Object.freeze([
  defineCampaign({
    id: "daybreak-cold-brew",
    advertiser: "Daybreak Coffee",
    product: "Daybreak Cold Brew",
    productFormat: "Branded takeaway coffee cup",
    category: "quick-service-food-beverage",
    placementObject: "Coffee cup",
    market: "United States",
    audience: {
      minAge: 25,
      maxAge: 45,
      eligibleTiers: ["ad-supported"],
      exclusions: ["premium-ad-free", "under-18"],
    },
    objective: "Increase unaided brand recall without reducing scene naturalness.",
    brandSafetyRisk: "low",
    placementSeconds: { min: 3, max: 5 },
    naturalUse:
      "The two actors already have one takeaway coffee each, so rebranding those two cups places the product without adding anything to the scene.",
    assumptions: [
      "Audience rules are defined but not yet applied to subscriber records; no viewers have been counted or targeted.",
      "The title is assumed to be available in the United States; the catalogue has no territory metadata yet.",
      "Placement rebrands the two existing takeaway cups on the café table, and only their exterior branding changes: exactly two cups before and after, no cup or other object added, each cup's size, shape, position, and lid unchanged, the woman's straw unchanged, and no change to the actors, their clothing, or the background, matching the demo-safety rules.",
      "Brand recall, viewer acceptance, and generation quality are unknown until later stages; nothing here predicts them.",
    ],
    source: "demo-fixture",
  }),
]);
