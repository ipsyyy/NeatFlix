/** The demo story, in presentation order. Section ids are stable anchors for the step navigation and browser tests. */
export const DEMO_STEPS = [
  { id: "step-case", short: "Case" },
  { id: "step-workforce", short: "Agents" },
  { id: "step-plan", short: "Plan & scene" },
  { id: "step-visuals", short: "Approved visuals" },
  { id: "step-reactor", short: "Reactor" },
  { id: "step-governor", short: "Governor checks" },
  { id: "step-human", short: "Human approval" },
  { id: "step-masky", short: "Masky" },
  { id: "step-langsmith", short: "LangSmith" },
  { id: "step-reliability", short: "Reliability & security" },
  { id: "step-value", short: "Business value" },
] as const;
