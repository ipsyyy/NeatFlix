/**
 * Catalogue record shape. Field set follows PRODUCT_SOURCE_OF_TRUTH.md §3:
 * ownership, genre, tone, rating, actor restrictions, and placement metadata.
 * Video binaries live in object storage; records hold URLs only.
 */

export type Genre =
  | "Romance"
  | "Romantic comedy"
  | "Sports romance"
  | "Workplace comedy"
  | "Sports comedy"
  | "Crime dramedy"
  | "Fantasy satire"
  | "Action thriller"
  | "Survival thriller"
  | "True crime";

export type AudienceRating = "TV-G" | "TV-PG" | "TV-14" | "TV-MA";

/** Platform ownership or approved usage rights for placement work. */
export type RightsStatus = "cleared" | "pending-review" | "not-cleared";

/** "unknown" means restrictions have not been confirmed, which is not the same as "none". */
export type ActorRestrictionStatus = "none" | "restricted" | "unknown";

/**
 * Title-level tone and brand-safety assessment. A sensitive title must say
 * why, so the rejection is evidence-backed (PRODUCT_SOURCE_OF_TRUTH.md §7.1).
 */
export type ContentSensitivity =
  | { level: "standard" }
  | { level: "sensitive"; reason: string };

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
  /** Path under /public, e.g. "/artwork/title-hero.png". */
  src: string;
  alt: string;
  /** Painted beneath the image, and shown alone if the image fails to load. */
  fallback: PlaceholderArtwork;
  /**
   * CSS object-position values that keep the subjects in view.
   * "wide" is for landscape frames (cards, dialog, desktop hero);
   * "tall" is for the portrait mobile hero.
   */
  position: { wide: string; tall: string };
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
  contentSensitivity: ContentSensitivity;
  processingStatus: ProcessingStatus;
  /** Runtime in seconds; must be between 180 and 300 (3–5 minutes). */
  durationSeconds: number;
  artwork: ArtworkRef;
  /** Object-storage URL, or null until the video is uploaded. */
  videoUrl: string | null;
  /** Whether this title runs through the full generation workflow. */
  pipelineEnabled: boolean;
};
