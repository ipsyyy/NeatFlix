import { createHash } from "node:crypto";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { visualClaims } from "@/agents/handoff/governor-review";
import { generationClaims, misleadingFrameTerms } from "@/agents/handoff/placement-plan";

/**
 * Masky identities for the five NativeFrame agents (PRODUCT_SOURCE_OF_TRUTH.md
 * §9: every agent has a distinct face, personality, and voice; each may deliver
 * one short result, with the Release Governor most prominent). These specs are
 * NativeFrame's own: names, personalities, portrait designs, voice preferences,
 * and the one spoken line. They do not change any agent's BAND identity,
 * responsibility, or workflow. Server-only.
 */

export type PortraitDesign = {
  background: [string, string];
  skin: string;
  hair: { color: string; style: "bob" | "short" | "bun" | "curly" | "swept" };
  outfit: string;
  accent: string;
  accessory: "glasses" | "headset" | "earrings" | "scarf" | "badge";
};

export type AgentIdentity = {
  role: AgentRole;
  characterName: string;
  title: string;
  personality: string;
  /** Voice names to prefer from Masky's preset list, in order (case-insensitive substring match). */
  voiceHints: readonly string[];
  /** When set, the chosen voice's name must contain one of these terms, or no voice is chosen (fail closed). */
  requiredVoiceTerms?: readonly string[];
  /** The one short spoken result. Spoken verbatim (textMode "literal"). */
  spokenLine: string;
  /** "audio" for most agents; the Release Governor's result is a talking-head video. */
  spokenOutput: "audio" | "video";
  /** UI weight: the Release Governor is the primary identity. */
  prominence: "primary" | "standard";
  portrait: PortraitDesign;
};

export const AGENT_IDENTITIES: Readonly<Record<AgentRole, AgentIdentity>> = Object.freeze({
  "content-curator": {
    role: "content-curator",
    characterName: "Iris Vale",
    title: "Content Curator",
    personality: "A calm, exacting catalogue archivist. Speaks in short, precise sentences, checks rights before anything else, and never overstates what a record says.",
    voiceHints: ["warm", "female", "calm"],
    spokenLine: "The LUV Hypothesis is owned, rights-cleared and eligible. I shortlisted it; titles still in rights review stay off the list.",
    spokenOutput: "audio",
    prominence: "standard",
    portrait: { background: ["#1f3a5f", "#4f7cac"], skin: "#c68863", hair: { color: "#2b1b14", style: "bob" }, outfit: "#24324a", accent: "#e3c58f", accessory: "glasses" },
  },
  "scene-scout": {
    role: "scene-scout",
    characterName: "Theo Park",
    title: "Scene Scout",
    personality: "A quick, curious location scout with a cinematographer's eye. Upbeat and concrete: timestamps, camera stability, and what is actually in frame.",
    voiceHints: ["young", "energetic", "male"],
    spokenLine: "Scene one, the café table conversation, has a steady camera, clear faces and a free table surface. It is my top candidate.",
    spokenOutput: "audio",
    prominence: "standard",
    portrait: { background: ["#16423c", "#3f8f7a"], skin: "#e0b48f", hair: { color: "#141414", style: "short" }, outfit: "#2e5a4e", accent: "#f2a65a", accessory: "headset" },
  },
  "campaign-matcher": {
    role: "campaign-matcher",
    characterName: "Ana Reyes",
    title: "Campaign Matcher",
    personality: "A pragmatic media strategist. Direct and numbers-minded, she names who is eligible and who is excluded before talking about fit.",
    voiceHints: ["analytical", "confident", "professional", "clear", "female"],
    requiredVoiceTerms: ["analytical", "confident", "professional"],
    spokenLine: "Daybreak Cold Brew fits the café scene. Only adult, ad-supported viewers qualify; premium and under-18 audiences are excluded.",
    spokenOutput: "audio",
    prominence: "standard",
    portrait: { background: ["#5a2a27", "#b5654a"], skin: "#a8673f", hair: { color: "#3a2416", style: "curly" }, outfit: "#6b3a2e", accent: "#f6d6a8", accessory: "earrings" },
  },
  "placement-director": {
    role: "placement-director",
    characterName: "Jun Sato",
    title: "Placement Director",
    personality: "A careful art director who cares about craft. Speaks plainly about what changes in the frame and, just as firmly, what must not change.",
    voiceHints: ["deep", "male", "calm"],
    spokenLine: "Plan version three rebrands the two existing cups. No new object, no hand interaction, and the actors stay untouched.",
    spokenOutput: "audio",
    prominence: "standard",
    portrait: { background: ["#3b2f5c", "#7a68b0"], skin: "#d9a982", hair: { color: "#1c1c22", style: "swept" }, outfit: "#2f2747", accent: "#c9bcf2", accessory: "scarf" },
  },
  "release-governor": {
    role: "release-governor",
    characterName: "Ada Sterling",
    title: "Release Governor",
    personality: "An impartial, authoritative release governor. Measured and concise; she states what passed, what is uncertain, and that release decisions belong to people.",
    voiceHints: ["authoritative", "commanding", "formal", "british", "confident", "deep"],
    requiredVoiceTerms: ["authoritative", "commanding", "formal"],
    spokenLine: "Plan version three passed every check, and the human owner approved it. Release decisions stay with people, not agents.",
    spokenOutput: "video",
    prominence: "primary",
    portrait: { background: ["#0d1b2a", "#1b4965"], skin: "#8d5a3b", hair: { color: "#d9d9d9", style: "bun" }, outfit: "#0b2239", accent: "#f5c542", accessory: "badge" },
  },
});

export const MAX_SPOKEN_CHARS = 200;
export const MAX_PERSONALITY_CHARS = 400;
const UNSAFE = /https?:|www\.|mky_|sb_secret_|sk-ant-|token=|key=/i;
const HEX = /^#[0-9a-f]{6}$/i;

/** Why the identity set is not demo-ready: five roles, distinct names and designs, safe and honest text. */
export function validateIdentities(identities: Readonly<Record<AgentRole, AgentIdentity>> = AGENT_IDENTITIES): string[] {
  const e: string[] = [];
  const list = AGENT_ROLES.map((r) => identities[r]);
  if (list.some((i, k) => !i || i.role !== AGENT_ROLES[k])) return ["Every agent role needs exactly its own identity."];
  const distinct = (values: string[], what: string) => new Set(values).size === values.length || e.push(`Identity ${what} must be distinct.`);
  distinct(list.map((i) => i.characterName.toLowerCase()), "names");
  distinct(list.map((i) => i.spokenLine), "spoken lines");
  distinct(list.map((i) => JSON.stringify(i.portrait)), "portraits");
  distinct(list.map((i) => i.voiceHints.join("|")), "voice preferences");
  if (list.filter((i) => i.prominence === "primary").map((i) => i.role).join() !== "release-governor") e.push("The Release Governor must be the only primary identity.");
  for (const i of list) {
    const all = [i.characterName, i.title, i.personality, i.spokenLine, ...i.voiceHints].join("\n");
    if (UNSAFE.test(all)) e.push(`${i.role}: identity text must not contain URLs or credentials.`);
    if (!i.characterName.trim() || i.characterName.length > 60) e.push(`${i.role}: character name is required (≤60 chars).`);
    if (!i.personality.trim() || i.personality.length > MAX_PERSONALITY_CHARS) e.push(`${i.role}: personality is required (≤${MAX_PERSONALITY_CHARS} chars).`);
    if (!i.spokenLine.trim() || i.spokenLine.length > MAX_SPOKEN_CHARS) e.push(`${i.role}: spoken line is required (≤${MAX_SPOKEN_CHARS} chars).`);
    if (i.voiceHints.length === 0) e.push(`${i.role}: at least one voice preference is required.`);
    // The spoken result follows the same honesty rules as agent results.
    if (visualClaims(i.spokenLine).length || generationClaims(i.spokenLine).length || misleadingFrameTerms(i.spokenLine).length) e.push(`${i.role}: spoken line makes an unsupported claim.`);
    const p = i.portrait;
    if (![...p.background, p.skin, p.hair.color, p.outfit, p.accent].every((c) => HEX.test(c))) e.push(`${i.role}: portrait colours must be #rrggbb.`);
  }
  if (identities["release-governor"].spokenOutput !== "video") e.push("The Release Governor's result is the one talking-head video.");
  return e;
}

/** Rough speaking time, used only for cost estimates (≈2.5 words per second, rounded up). */
export function estimateSpeechSeconds(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).length / 2.5);
}

const HAIR: Record<PortraitDesign["hair"]["style"], (c: string) => string> = {
  bob: (c) => `<path d="M322 470 Q312 250 512 232 Q712 250 702 470 L702 600 Q660 560 650 420 Q512 360 374 420 Q364 560 322 600 Z" fill="${c}"/>`,
  short: (c) => `<path d="M352 420 Q350 262 512 250 Q674 262 672 420 Q640 330 512 322 Q384 330 352 420 Z" fill="${c}"/>`,
  bun: (c) => `<circle cx="512" cy="222" r="70" fill="${c}"/><path d="M350 430 Q348 262 512 254 Q676 262 674 430 Q630 330 512 326 Q394 330 350 430 Z" fill="${c}"/>`,
  curly: (c) => [300, 360, 420, 480, 540, 600, 660, 720].map((x, k) => `<circle cx="${x}" cy="${330 + (k % 2) * 30 + Math.abs(k - 3.5) * 22}" r="62" fill="${c}"/>`).join(""),
  swept: (c) => `<path d="M346 440 Q330 250 540 240 Q700 250 690 380 Q600 300 470 330 Q390 350 346 440 Z" fill="${c}"/>`,
};
const ACCESSORY: Record<PortraitDesign["accessory"], (a: string) => string> = {
  glasses: (a) => `<g fill="none" stroke="${a}" stroke-width="10"><circle cx="452" cy="470" r="44"/><circle cx="572" cy="470" r="44"/><path d="M496 470 H528"/></g>`,
  headset: (a) => `<path d="M352 470 Q352 300 512 300 Q672 300 672 470" fill="none" stroke="${a}" stroke-width="18"/><rect x="330" y="450" width="40" height="80" rx="16" fill="${a}"/><path d="M350 530 Q380 620 470 610" fill="none" stroke="${a}" stroke-width="8"/>`,
  earrings: (a) => `<circle cx="372" cy="560" r="16" fill="${a}"/><circle cx="652" cy="560" r="16" fill="${a}"/>`,
  scarf: (a) => `<path d="M400 720 Q512 790 624 720 L640 790 Q512 850 384 790 Z" fill="${a}"/>`,
  badge: (a) => `<circle cx="512" cy="880" r="54" fill="${a}"/><path d="M512 846 L524 872 L552 874 L530 892 L538 920 L512 904 L486 920 L494 892 L472 874 L500 872 Z" fill="#0b2239"/>`,
};

/** A deterministic, original illustrated portrait (1024×1024 SVG). The primary identity gets a gold frame ring. */
export function portraitSvg(identity: AgentIdentity): string {
  const p = identity.portrait;
  const ring = identity.prominence === "primary" ? `<circle cx="512" cy="512" r="492" fill="none" stroke="${p.accent}" stroke-width="28"/>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.background[0]}"/><stop offset="1" stop-color="${p.background[1]}"/></linearGradient></defs>`,
    `<rect width="1024" height="1024" fill="url(#bg)"/>`,
    `<path d="M212 1024 Q232 760 512 730 Q792 760 812 1024 Z" fill="${p.outfit}"/>`,
    `<rect x="462" y="620" width="100" height="120" rx="30" fill="${p.skin}"/>`,
    `<ellipse cx="512" cy="480" rx="160" ry="196" fill="${p.skin}"/>`,
    HAIR[p.hair.style](p.hair.color),
    `<circle cx="452" cy="470" r="14" fill="#1a1a1a"/><circle cx="572" cy="470" r="14" fill="#1a1a1a"/>`,
    `<path d="M426 430 Q452 418 478 430 M546 430 Q572 418 598 430" fill="none" stroke="${p.hair.color}" stroke-width="9" stroke-linecap="round"/>`,
    `<path d="M512 488 Q502 540 520 548" fill="none" stroke="#00000033" stroke-width="7" stroke-linecap="round"/>`,
    `<path d="M466 588 Q512 618 558 588" fill="none" stroke="#7a2e2e" stroke-width="10" stroke-linecap="round"/>`,
    ACCESSORY[p.accessory](p.accent),
    ring,
    `</svg>`,
  ].join("");
}

/** sha256 hex of a role's identity spec, so a generated asset can be tied to the exact spec it came from. */
export function identitySpecSha256(identity: AgentIdentity): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
