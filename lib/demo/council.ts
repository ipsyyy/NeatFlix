/**
 * The AI Executive Council: the demo's presentation layer over the five agents.
 *
 * Display-only. It deliberately does not change the server-side identity
 * specs: each is hashed into the Masky avatar ledger and Iris Vale's recorded
 * audio speaks its exact line, so editing it would orphan her real avatar.
 * Character names, archetypes, palettes, and lines are NativeFrame's own
 * originals and reference no real person, brand, or voice.
 */

export type CouncilSeat = {
  role: "content-curator" | "scene-scout" | "campaign-matcher" | "placement-director" | "release-governor";
  name: string;
  title: string;
  archetype: string;
  personality: string;
  voice: string;
  visualDirection: string;
  signatureLine: string;
  /** `accent` is legible on the dark surface (text, rings); `deep` carries gradients and glows. */
  palette: { accent: string; deep: string; label: string };
};

export const COUNCIL: readonly CouncilSeat[] = Object.freeze([
  {
    role: "content-curator",
    name: "Iris Vale",
    title: "Content Curator",
    archetype: "The Storyteller",
    personality: "Imaginative, emotionally intelligent, cinematic.",
    voice: "Warm, expressive, measured.",
    visualDirection: "Elegant editorial styling",
    signatureLine: "Let’s find the story people will remember.",
    palette: { accent: "#e6c27a", deep: "#5b2fa8", label: "Deep violet and warm gold" },
  },
  {
    role: "scene-scout",
    name: "Theo Park",
    title: "Scene Scout",
    archetype: "The Futurist",
    personality: "Curious, calm, technologically optimistic.",
    voice: "Thoughtful, clear, quietly enthusiastic.",
    visualDirection: "Minimalist futurism",
    signatureLine: "The next great scene is hiding in plain sight.",
    palette: { accent: "#8fb2ff", deep: "#1f4fd6", label: "Cobalt blue and cool silver" },
  },
  {
    role: "campaign-matcher",
    name: "Ana Reyes",
    title: "Campaign Matcher",
    archetype: "The Deal Architect",
    personality: "Charismatic, commercially sharp, decisive.",
    voice: "Energetic, confident, conversational.",
    visualDirection: "Bold editorial fashion",
    signatureLine: "Let’s match the moment with the audience.",
    palette: { accent: "#ff8f7e", deep: "#c2187a", label: "Coral and electric magenta" },
  },
  {
    role: "placement-director",
    name: "Jun Sato",
    title: "Placement Director",
    archetype: "The Systems Operator",
    personality: "Precise, composed, strategically analytical.",
    voice: "Concise, calm, highly deliberate.",
    visualDirection: "Structured modernism",
    signatureLine: "Right story. Right place. Right moment.",
    palette: { accent: "#4fd1a1", deep: "#0f6b4f", label: "Emerald and graphite" },
  },
  {
    role: "release-governor",
    name: "Ada Sterling",
    title: "Release Governor",
    archetype: "The Guardian",
    personality: "Authoritative, principled, protective.",
    voice: "Measured, trustworthy, firm.",
    visualDirection: "Refined institutional style",
    signatureLine: "Is it ready—and is it responsible?",
    palette: { accent: "#f5b13d", deep: "#16264a", label: "Amber and midnight navy" },
  },
]);

export const councilSeat = (role: string): CouncilSeat | undefined => COUNCIL.find((s) => s.role === role);

/**
 * The human host. The photo is the user's own, dropped in by hand; until it
 * exists the page shows a labelled placeholder and never a generated face.
 */
export const FOUNDER = Object.freeze({
  /** Set to your name to show it on the host card; null shows the title alone. */
  name: null as string | null,
  title: "Founder & CEO",
  role: "Host · Chair of the council",
  /** Public path, served from public/council/founder.jpg. */
  photo: "/council/founder.jpg",
  photoFile: ["public", "council", "founder.jpg"] as const,
});

export const COUNCIL_HEADLINE = "Meet your AI Executive Council";
export const COUNCIL_SUPPORT = "Five specialists. One coordinated path from story to responsible release.";
