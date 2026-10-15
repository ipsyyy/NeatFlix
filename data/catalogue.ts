/**
 * NativeFrame catalogue — the single editable source for title content.
 *
 * The ten approved fictional titles (PRODUCT_SOURCE_OF_TRUTH.md §3).
 * All metadata is fictional. Artwork is a temporary CSS placeholder until
 * original, synthetic, or properly licensed thumbnails exist.
 */

import { getEligibility } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";

const MIN_DURATION_SECONDS = 180;
const MAX_DURATION_SECONDS = 300;
const EXPECTED_TITLE_COUNT = 10;
const MAX_PIPELINE_TITLES = 2;

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
    if (t.pipelineEnabled && !getEligibility(t).eligible) {
      throw new Error(`${t.id} is pipeline enabled but not eligible for placement work.`);
    }
  }
  const pipelineCount = titles.filter((t) => t.pipelineEnabled).length;
  if (pipelineCount < 1 || pipelineCount > MAX_PIPELINE_TITLES) {
    throw new Error(
      `Catalogue must have 1–${MAX_PIPELINE_TITLES} pipeline-enabled titles; found ${pipelineCount}.`,
    );
  }
  return Object.freeze(titles);
}

export const catalogue = defineCatalogue([
  {
    id: "early-sprung",
    title: "The Early Sprung",
    description:
      "Two rival event planners fall for each other while organising their company's spring offsite.",
    genre: "Romance",
    tone: "Warm, gentle",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "not-processed",
    durationSeconds: 236,
    artwork: {
      kind: "image",
      src: "/artwork/the-early-sprung-hero.png",
      titleInArtwork: true,
      alt: "Two colleagues sit apart on a bench under spring blossom, glancing at each other.",
      fallback: { kind: "placeholder", hues: [32, 205], focus: { x: 72, y: 34 } },
      // Title art sits left; the tall crop shows both faces and leaves the title out.
      position: { wide: "50% 35%", tall: "83% 30%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "luv-hypothesis",
    title: "The LUV Hypothesis",
    description:
      "A doctoral researcher sets out to prove her lab rival wrong about everything, including how she feels about him.",
    genre: "Romantic comedy",
    tone: "Witty, bright",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "review-ready",
    durationSeconds: 248,
    artwork: {
      kind: "image",
      src: "/artwork/the-luv-hypothesis-hero.png",
      titleInArtwork: true,
      alt: "Two rival researchers stand back to back in a lab, one holding a notebook, the other a flask.",
      fallback: { kind: "placeholder", hues: [168, 260], focus: { x: 28, y: 40 } },
      // Title art sits left; the tall crop shows both faces and leaves the title out.
      position: { wide: "50% 45%", tall: "78% 30%" },
    },
    videoUrl: null,
    pipelineEnabled: true,
  },
  {
    id: "the-day-agent",
    title: "The Day Agent",
    description:
      "A compliance analyst uncovers a cover-up and races across the city ahead of the people who buried it.",
    genre: "Action thriller",
    tone: "Tense, propulsive",
    rating: "TV-14",
    rightsStatus: "cleared",
    actorRestriction: "restricted",
    contentSensitivity: { level: "standard" },
    processingStatus: "not-processed",
    durationSeconds: 287,
    artwork: {
      kind: "image",
      src: "/artwork/the-day-agent-hero.png",
      titleInArtwork: true,
      alt: "An agent crouches on a rooftop at sunset, phone to her ear, clutching a folder.",
      fallback: { kind: "placeholder", hues: [210, 290], focus: { x: 40, y: 25 } },
      // Title art sits left; the tall crop keeps the agent's face and leaves the title out.
      position: { wide: "50% 40%", tall: "83% 30%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "moster",
    title: "Moster: The Lizzy Border Story",
    description:
      "A dark limited series about a fictional 1890s family murder and the trial that divided a small town.",
    genre: "True crime",
    tone: "Dark, unsettling",
    rating: "TV-MA",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: {
      level: "sensitive",
      reason:
        "Centres on a violent murder and its victims; a product placement would trivialise the subject and fails brand-safety review.",
    },
    processingStatus: "not-processed",
    durationSeconds: 294,
    artwork: {
      kind: "image",
      src: "/artwork/moster-the-lizzy-border-story-hero.png",
      titleInArtwork: true,
      alt: "A woman in a velvet cloak stands on courthouse steps at night beside a sealed red envelope.",
      fallback: { kind: "placeholder", hues: [345, 40], focus: { x: 60, y: 62 } },
      // Title art sits left; the tall crop keeps the woman's face and leaves the title out.
      position: { wide: "50% 40%", tall: "80% 30%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "money-hoist",
    title: "Money Hoist",
    description:
      "A crew of overqualified amateurs plans the politest bank job in history: lifting an entire vault off a city rooftop by crane before the morning shift arrives.",
    genre: "Heist caper",
    tone: "Slick, playful",
    rating: "TV-14",
    rightsStatus: "pending-review",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "not-processed",
    durationSeconds: 252,
    artwork: {
      kind: "image",
      src: "/artwork/money-hoist-hero.png",
      titleInArtwork: true,
      alt: "A crew gathers over plans in front of an open vault door, with two more on a walkway above.",
      fallback: { kind: "placeholder", hues: [12, 320], focus: { x: 80, y: 70 } },
      // Title art sits left; the tall crop starts just after it, on the crew.
      position: { wide: "50% 40%", tall: "57% 40%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "gentlewoman",
    title: "The Gentlewoman",
    description:
      "A polished estate heir quietly runs the family's less-than-legal business between garden parties.",
    genre: "Crime dramedy",
    tone: "Stylish, sly",
    rating: "TV-MA",
    rightsStatus: "cleared",
    actorRestriction: "unknown",
    contentSensitivity: { level: "standard" },
    processingStatus: "processing",
    durationSeconds: 263,
    artwork: {
      kind: "image",
      src: "/artwork/the-gentlewoman-hero.png",
      titleInArtwork: true,
      alt: "A woman in a green velvet suit leans on a billiard table in a grand estate, her family behind her.",
      fallback: { kind: "placeholder", hues: [48, 140], focus: { x: 22, y: 68 } },
      // Heads sit high; the tall crop keeps the lead's face and leaves the title out.
      position: { wide: "50% 30%", tall: "72% 25%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "not-suitable-for-professionals",
    title: "Not Suitable for Professionals",
    description:
      "Three first-year associates bluff their way through a chaotic open-plan office and a boss who loves the chaos.",
    genre: "Workplace comedy",
    tone: "Playful, irreverent",
    rating: "TV-14",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "review-ready",
    durationSeconds: 227,
    artwork: {
      kind: "image",
      src: "/artwork/not-suitable-for-professionals-hero.png",
      titleInArtwork: true,
      alt: "Five young colleagues lounge around a cluttered office table, seen from above.",
      fallback: { kind: "placeholder", hues: [230, 190], focus: { x: 50, y: 30 } },
      // Title art sits left; the tall crop keeps the right-hand faces and leaves the title out.
      position: { wide: "50% 40%", tall: "93% 40%" },
    },
    videoUrl: null,
    pipelineEnabled: true,
  },
  {
    id: "chat-powers",
    title: "Chat Powers",
    description:
      "An underdog amateur hockey team, coached entirely by group chat, chases one respectable win.",
    genre: "Sports comedy",
    tone: "Upbeat, scrappy",
    rating: "TV-PG",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "not-processed",
    durationSeconds: 199,
    artwork: {
      kind: "image",
      src: "/artwork/chat-powers-hero.png",
      titleInArtwork: true,
      alt: "Two hockey players slump on a locker-room bench either side of a glowing phone.",
      fallback: { kind: "placeholder", hues: [190, 28], focus: { x: 70, y: 55 } },
      // Title art is centred; the tall crop shows the whole title between the players.
      position: { wide: "50% 30%", tall: "53% 35%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "squid-gamed",
    title: "Squid Gamed",
    description:
      "Desperate contestants enter a secretive competition where elimination has deadly consequences.",
    genre: "Survival thriller",
    tone: "Intense, violent",
    rating: "TV-MA",
    rightsStatus: "cleared",
    actorRestriction: "none",
    contentSensitivity: {
      level: "sensitive",
      reason:
        "Lethal competition and graphic violence throughout; placing a consumer brand here creates unacceptable brand-safety risk.",
    },
    processingStatus: "not-processed",
    durationSeconds: 276,
    artwork: {
      kind: "image",
      src: "/artwork/squid-gamed-hero.png",
      titleInArtwork: true,
      alt: "Contestants in matching jumpsuits scramble across a neon-lit staircase arena.",
      fallback: { kind: "placeholder", hues: [275, 15], focus: { x: 35, y: 50 } },
      // Title art sits left; the tall crop keeps the lead contestant and leaves the title out.
      position: { wide: "50% 40%", tall: "75% 35%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
  {
    id: "game-of-tones",
    title: "GOT: Game of Tones",
    description:
      "Rival musical houses scheme, sing, and backstab their way toward a throne that may not be worth it.",
    genre: "Fantasy satire",
    tone: "Grand, irreverent",
    rating: "TV-14",
    rightsStatus: "not-cleared",
    actorRestriction: "none",
    contentSensitivity: { level: "standard" },
    processingStatus: "not-processed",
    durationSeconds: 299,
    artwork: {
      kind: "image",
      src: "/artwork/game-of-tones-hero.png",
      titleInArtwork: true,
      alt: "Two robed conductors face off from candlelit balconies above an orchestra.",
      fallback: { kind: "placeholder", hues: [120, 200], focus: { x: 55, y: 75 } },
      // Title art sits low left; the tall crop keeps the right conductor and leaves the title out.
      position: { wide: "50% 50%", tall: "88% 30%" },
    },
    videoUrl: null,
    pipelineEnabled: false,
  },
]);

/** The title shown in the featured area: the primary pipeline-enabled title. */
export const FEATURED_TITLE_ID = "luv-hypothesis";
