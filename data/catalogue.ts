/**
 * NativeFrame catalogue — the single editable source for title content.
 *
 * TEMPORARY: these ten entries are placeholders. Titles, descriptions, and
 * metadata values will be replaced once the ten show concepts are decided.
 * Status values are varied only so every badge state is visible in the UI.
 */

import type { CatalogueTitle } from "@/lib/catalogue/types";

const MIN_DURATION_SECONDS = 180;
const MAX_DURATION_SECONDS = 300;
const EXPECTED_TITLE_COUNT = 10;

/** Fails the build if an edit breaks the catalogue rules in the spec (§3). */
function defineCatalogue(titles: CatalogueTitle[]): readonly CatalogueTitle[] {
  if (titles.length !== EXPECTED_TITLE_COUNT) {
    throw new Error(
      `Catalogue must contain ${EXPECTED_TITLE_COUNT} titles; found ${titles.length}.`,
    );
  }
  const ids = new Set<string>();
  for (const t of titles) {
    if (ids.has(t.id)) throw new Error(`Duplicate catalogue id: ${t.id}`);
    ids.add(t.id);
    if (
      t.durationSeconds < MIN_DURATION_SECONDS ||
      t.durationSeconds > MAX_DURATION_SECONDS
    ) {
      throw new Error(
        `${t.id} runs ${t.durationSeconds}s; titles must run 3–5 minutes.`,
      );
    }
  }
  return Object.freeze(titles);
}

export const catalogue = defineCatalogue([
  {
    id: "title-01",
    title: "Catalogue Title 01",
    description:
      "Placeholder entry. A light, everyday setting with a stable camera, reserved for the primary placement case.",
    genre: "Comedy",
    tone: "Light, warm",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    processingStatus: "review-ready",
    durationSeconds: 252,
    artwork: { kind: "placeholder", hues: [32, 205], focus: { x: 72, y: 34 } },
    videoUrl: null,
    pipelineEnabled: true,
  },
  {
    id: "title-02",
    title: "Catalogue Title 02",
    description:
      "Placeholder entry. Lifestyle format with long, steady shots of shared spaces.",
    genre: "Lifestyle",
    tone: "Relaxed, upbeat",
    rating: "TV-G",
    rightsStatus: "cleared",
    actorRestriction: "none",
    processingStatus: "review-ready",
    durationSeconds: 218,
    artwork: { kind: "placeholder", hues: [168, 260], focus: { x: 28, y: 40 } },
    videoUrl: null,
    pipelineEnabled: true,
  },
  {
    id: "title-03",
    title: "Catalogue Title 03",
    description: "Placeholder entry. Ensemble comedy set mostly indoors.",
    genre: "Comedy",
    tone: "Playful",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    processingStatus: "not-processed",
    durationSeconds: 196,
    artwork: { kind: "placeholder", hues: [345, 40], focus: { x: 60, y: 62 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-04",
    title: "Catalogue Title 04",
    description:
      "Placeholder entry. Usage rights are still being confirmed with the content owner.",
    genre: "Lifestyle",
    tone: "Calm, reflective",
    rating: "TV-G",
    rightsStatus: "pending-review",
    actorRestriction: "unknown",
    processingStatus: "not-processed",
    durationSeconds: 274,
    artwork: { kind: "placeholder", hues: [210, 290], focus: { x: 40, y: 25 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-05",
    title: "Catalogue Title 05",
    description:
      "Placeholder entry. Rights are cleared, but a cast member has a placement restriction.",
    genre: "Comedy",
    tone: "Dry, observational",
    rating: "TV-14",
    rightsStatus: "cleared",
    actorRestriction: "restricted",
    processingStatus: "not-processed",
    durationSeconds: 233,
    artwork: { kind: "placeholder", hues: [12, 320], focus: { x: 80, y: 70 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-06",
    title: "Catalogue Title 06",
    description: "Placeholder entry. Short-form lifestyle segments in a home kitchen.",
    genre: "Lifestyle",
    tone: "Bright, practical",
    rating: "TV-G",
    rightsStatus: "cleared",
    actorRestriction: "none",
    processingStatus: "processing",
    durationSeconds: 187,
    artwork: { kind: "placeholder", hues: [48, 140], focus: { x: 22, y: 68 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-07",
    title: "Catalogue Title 07",
    description:
      "Placeholder entry. Third-party licence does not permit placement work.",
    genre: "Comedy",
    tone: "Sharp, fast-paced",
    rating: "TV-14",
    rightsStatus: "not-cleared",
    actorRestriction: "none",
    processingStatus: "not-processed",
    durationSeconds: 291,
    artwork: { kind: "placeholder", hues: [230, 190], focus: { x: 50, y: 30 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-08",
    title: "Catalogue Title 08",
    description: "Placeholder entry. Travel-style lifestyle episode with outdoor scenes.",
    genre: "Lifestyle",
    tone: "Easygoing",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "unknown",
    processingStatus: "not-processed",
    durationSeconds: 262,
    artwork: { kind: "placeholder", hues: [190, 28], focus: { x: 70, y: 55 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-09",
    title: "Catalogue Title 09",
    description: "Placeholder entry. Workplace comedy with frequent wide shots.",
    genre: "Comedy",
    tone: "Light, awkward",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    processingStatus: "not-processed",
    durationSeconds: 205,
    artwork: { kind: "placeholder", hues: [275, 15], focus: { x: 35, y: 50 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "title-10",
    title: "Catalogue Title 10",
    description:
      "Placeholder entry. Rights renewal is in review before placement work can begin.",
    genre: "Lifestyle",
    tone: "Gentle, cosy",
    rating: "TV-G",
    rightsStatus: "pending-review",
    actorRestriction: "none",
    processingStatus: "not-processed",
    durationSeconds: 240,
    artwork: { kind: "placeholder", hues: [120, 200], focus: { x: 55, y: 75 } },
    videoUrl: null,
    pipelineEnabled: false,
  },
]);

/** The title shown in the featured area. */
export const FEATURED_TITLE_ID = "title-01";
