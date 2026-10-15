import { getEligibility } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { formatTimecode } from "@/lib/scenes/format";
import type { CheckOutcome, GuardrailId, SceneCandidate } from "@/lib/scenes/types";
import {
  ADULT_MIN_AGE,
  categoryLabel,
  OUT_OF_SCOPE_CATEGORIES,
  SUPPORTED_MARKETS,
  SUPPORTED_TIERS,
} from "./rules";
import type { Campaign } from "./types";

export type MatchCheck = { label: string; outcome: CheckOutcome; evidence: string };

export type MatchDecision = "recommended" | "needs-review" | "not-recommended";

export type CampaignMatch = {
  campaignId: string;
  sceneId: string;
  decision: MatchDecision;
  /** One-sentence summary of the decision, built from the checks. */
  summary: string;
  audienceRules: MatchCheck[];
  fitChecks: MatchCheck[];
  safetyChecks: MatchCheck[];
  /** Plain-language reasons the product belongs in the scene. Empty when it doesn't. */
  whyItFits: string[];
  limitations: string[];
};

/**
 * Rule-based campaign matching. Deterministic: the same title, scene, and
 * campaign always produce the same result. Any failed check blocks the
 * recommendation (harmlessness is a hard gate, §7.1); cautions or unassessed
 * checks downgrade it to "needs review".
 */
export function matchCampaignToScene(
  campaign: Campaign,
  scene: SceneCandidate,
  title: CatalogueTitle,
): CampaignMatch {
  const sceneCheck = (id: GuardrailId) => scene.checks.find((c) => c.id === id);
  const fromScene = (id: GuardrailId, label: string, passEvidence: string): MatchCheck => {
    const c = sceneCheck(id);
    if (!c) return { label, outcome: "not-assessed", evidence: "No scene evidence recorded for this check." };
    return { label, outcome: c.outcome, evidence: c.outcome === "pass" ? passEvidence : c.evidence };
  };

  const { minAge, maxAge, eligibleTiers, exclusions } = campaign.audience;
  const object = campaign.placementObject.toLowerCase();
  const audienceRules: MatchCheck[] = [
    {
      label: "Age range",
      outcome: minAge >= ADULT_MIN_AGE ? "pass" : "fail",
      evidence: `Ages ${minAge}–${maxAge} only. Every eligible viewer is an adult.`,
    },
    {
      label: "Subscription tier",
      outcome: eligibleTiers.every((t) => SUPPORTED_TIERS.includes(t)) ? "pass" : "fail",
      evidence: "Ad-supported tier only. Placements never reach ad-free plans.",
    },
    {
      label: "Premium exclusion",
      outcome: exclusions.includes("premium-ad-free") ? "pass" : "fail",
      evidence: "Premium ad-free subscribers are excluded.",
    },
    {
      label: "Minor exclusion",
      outcome: exclusions.includes("under-18") ? "pass" : "fail",
      evidence: "Users under 18 are excluded.",
    },
    {
      label: "Market",
      outcome: SUPPORTED_MARKETS.includes(campaign.market) ? "pass" : "fail",
      evidence: SUPPORTED_MARKETS.includes(campaign.market)
        ? `${campaign.market} only.`
        : `${campaign.market} is not a supported market; the MVP runs in ${SUPPORTED_MARKETS.join(", ")} only.`,
    },
  ];

  const sceneSeconds = scene.endSeconds - scene.startSeconds;
  const objectInScene = scene.opportunities.includes(campaign.placementObject);
  const fitChecks: MatchCheck[] = [
    {
      label: "Object belongs in scene",
      outcome: objectInScene ? "pass" : "fail",
      evidence: objectInScene
        ? `Scene evidence lists a ${object} among its natural opportunities (${scene.opportunities.join(", ").toLowerCase()}).`
        : `A ${object} is not among this scene's natural opportunities.`,
    },
    fromScene("placement-surface", "Surface to hold it", `${scene.surface}. The ${object} can rest there without being held.`),
    fromScene("tone", "Tone match", `${scene.tone} tone. An everyday drink doesn't undercut the moment.`),
    fromScene("camera-motion", "Stable framing", `${scene.camera}. A stationary object stays put for the whole shot.`),
    fromScene("face-framing", "Clear of faces", "No close-ups, so the product sits away from the actors' faces."),
    {
      label: "Placement length",
      outcome:
        sceneSeconds >= campaign.placementSeconds.min && sceneSeconds <= campaign.placementSeconds.max
          ? "pass"
          : "fail",
      evidence: `Scene runs ${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)} (${sceneSeconds} seconds); the campaign needs ${campaign.placementSeconds.min}–${campaign.placementSeconds.max} seconds.`,
    },
  ];

  const titleEligible = getEligibility(title).eligible;
  const safetyChecks: MatchCheck[] = [
    {
      label: "Advertiser category",
      outcome: OUT_OF_SCOPE_CATEGORIES.includes(campaign.category) ? "fail" : "pass",
      evidence: OUT_OF_SCOPE_CATEGORIES.includes(campaign.category)
        ? `${categoryLabel[campaign.category]} advertising is out of scope.`
        : `${categoryLabel[campaign.category]}. Not ${OUT_OF_SCOPE_CATEGORIES.map((c) => categoryLabel[c].toLowerCase()).join(", ")}.`,
    },
    {
      label: "Campaign risk level",
      outcome: campaign.brandSafetyRisk === "low" ? "pass" : "fail",
      evidence: `Brand-safety risk is rated ${campaign.brandSafetyRisk}.`,
    },
    {
      label: "Title sensitivity",
      outcome: title.contentSensitivity.level === "standard" ? "pass" : "fail",
      evidence:
        title.contentSensitivity.level === "standard"
          ? `${title.title} is not flagged for sensitive tone or brand-safety risk.`
          : title.contentSensitivity.reason,
    },
    {
      label: "Title eligibility",
      outcome: titleEligible ? "pass" : "fail",
      evidence: titleEligible
        ? "Rights cleared and no actor restrictions recorded in the catalogue."
        : "Title is not eligible for placement work.",
    },
    fromScene("actor-restrictions", "Actor restrictions", "No actor restriction recorded for anyone in the shot."),
  ];

  const all = [...audienceRules, ...fitChecks, ...safetyChecks];
  const decision: MatchDecision = all.some((c) => c.outcome === "fail")
    ? "not-recommended"
    : all.some((c) => c.outcome !== "pass")
      ? "needs-review"
      : "recommended";

  const whyItFits =
    decision === "not-recommended"
      ? []
      : [
          `The scene already lists a ${object} as a natural opportunity, and its surface (${scene.surface.toLowerCase()}) gives it somewhere to sit.`,
          campaign.naturalUse,
          `The ${scene.tone.toLowerCase()} tone and ${scene.camera.toLowerCase()} let a stationary ${object} sit in frame without drawing attention away from the actors.`,
        ];

  const summary = {
    recommended: `${campaign.product} fits ${scene.name}: every audience, fit, and brand-safety check passes.`,
    "needs-review": `${campaign.product} may fit ${scene.name}, but some checks need review before it can be recommended.`,
    "not-recommended": `${campaign.product} is not recommended for ${scene.name}: at least one check fails.`,
  }[decision];

  return {
    campaignId: campaign.id,
    sceneId: scene.id,
    decision,
    summary,
    audienceRules,
    fitChecks,
    safetyChecks,
    whyItFits,
    limitations: campaign.assumptions,
  };
}

const decisionOrder: Record<MatchDecision, number> = {
  recommended: 0,
  "needs-review": 1,
  "not-recommended": 2,
};

/** Matches every campaign against the scene and returns the strongest first. */
export function rankCampaignMatches(
  campaigns: readonly Campaign[],
  scene: SceneCandidate,
  title: CatalogueTitle,
): { campaign: Campaign; match: CampaignMatch }[] {
  return campaigns
    .map((campaign) => ({ campaign, match: matchCampaignToScene(campaign, scene, title) }))
    .sort((a, b) => decisionOrder[a.match.decision] - decisionOrder[b.match.decision]);
}

export const matchDecisionLabel: Record<MatchDecision, string> = {
  recommended: "Recommended",
  "needs-review": "Needs review",
  "not-recommended": "Not recommended",
};
