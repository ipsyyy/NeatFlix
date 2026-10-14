/**
 * Catalogue record shape. Field set follows PRODUCT_SOURCE_OF_TRUTH.md §3:
 * ownership, genre, tone, rating, actor restrictions, and placement metadata.
 * Video binaries live in object storage; records hold URLs only.
 */

export type Genre = "Comedy" | "Lifestyle";

export type AudienceRating = "TV-G" | "TV-PG" | "TV-14" | "TV-MA";

/** Platform ownership or approved usage rights for placement work. */
export type RightsStatus = "cleared" | "pending-review" | "not-cleared";

/** "unknown" means restrictions have not been confirmed, which is not the same as "none". */
export type ActorRestrictionStatus = "none" | "restricted" | "unknown";

export type ProcessingStatus = "not-processed" | "processing" | "review-ready";

/** Original CSS-rendered placeholder until real, licensed artwork exists. */
export type PlaceholderArtwork = {
  kind: "placeholder";
  /** Two hues (0–360) blended into a dark gradient composition. */
  hues: [number, number];
  /** Where the light source sits, as percentages of the frame. */
  focus: { x: number; y: number };
};

export type ImageArtwork = {
  kind: "image";
  src: string;
  alt: string;
};

export type ArtworkRef = PlaceholderArtwork | ImageArtwork;

export type CatalogueTitle = {
  id: string;
  title: string;
  description: string;
  genre: Genre;
  tone: string;
  rating: AudienceRating;
  rightsStatus: RightsStatus;
  actorRestriction: ActorRestrictionStatus;
  processingStatus: ProcessingStatus;
  /** Runtime in seconds; must be between 180 and 300 (3–5 minutes). */
  durationSeconds: number;
  artwork: ArtworkRef;
  /** Object-storage URL, or null until the video is uploaded. */
  videoUrl: string | null;
  /** Whether this title runs through the full generation workflow. */
  pipelineEnabled: boolean;
};
