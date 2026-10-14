import type { CatalogueTitle } from "./types";

export type Eligibility = {
  eligible: boolean;
  /** Plain-language reasons a title is held back. Empty when eligible. */
  reasons: string[];
};

/**
 * Catalogue-level eligibility for placement work (PRODUCT_SOURCE_OF_TRUTH.md §4.1).
 * Unconfirmed information blocks eligibility rather than passing silently.
 * Audience eligibility (adults, ad-supported) is applied per viewer later,
 * not per title, so rating is not a gate here.
 */
export function getEligibility(title: CatalogueTitle): Eligibility {
  const reasons: string[] = [];

  if (title.rightsStatus === "pending-review") {
    reasons.push("Usage rights are still in review.");
  } else if (title.rightsStatus === "not-cleared") {
    reasons.push("Usage rights do not permit placement work.");
  }

  if (title.actorRestriction === "restricted") {
    reasons.push("A cast member has a placement restriction.");
  } else if (title.actorRestriction === "unknown") {
    reasons.push("Actor restrictions have not been confirmed.");
  }

  return { eligible: reasons.length === 0, reasons };
}

export type CatalogueSummary = {
  total: number;
  eligible: number;
  rightsCleared: number;
  restricted: number;
  pipelineEnabled: number;
  reviewReady: number;
};

export function summarizeCatalogue(
  titles: readonly CatalogueTitle[],
): CatalogueSummary {
  return {
    total: titles.length,
    eligible: titles.filter((t) => getEligibility(t).eligible).length,
    rightsCleared: titles.filter((t) => t.rightsStatus === "cleared").length,
    restricted: titles.filter((t) => t.actorRestriction === "restricted").length,
    pipelineEnabled: titles.filter((t) => t.pipelineEnabled).length,
    reviewReady: titles.filter((t) => t.processingStatus === "review-ready")
      .length,
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDurationLong(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} minutes` : `${m} minutes ${s} seconds`;
}
