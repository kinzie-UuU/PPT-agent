const ROLE_REQUIREMENTS = {
  cover: [["ctrTitle", "title"], ["subTitle", "body", "obj"]],
  toc: [["title", "ctrTitle"], ["body", "obj"]],
  visual: [["title", "ctrTitle"], ["pic", "media", "clipArt"]],
  pricing: [["title", "ctrTitle"], ["body", "obj"]],
  "product-detail": [["title", "ctrTitle"], ["body", "obj", "pic", "media"]],
  cards: [["title", "ctrTitle"], ["body", "obj"]],
  compare: [["title", "ctrTitle"], ["body", "obj"]],
  bundle: [["title", "ctrTitle"], ["body", "obj"]],
  timeline: [["title", "ctrTitle"], ["body", "obj"]],
  quote: [["title", "ctrTitle", "body", "obj"]],
  "risk-checklist": [["title", "ctrTitle"], ["body", "obj"]],
  closing: [["title", "ctrTitle", "body", "obj"]]
};

const ROLE_HINTS = {
  cover: ["cover", "title"],
  toc: ["toc", "agenda", "content"],
  visual: ["visual", "picture", "image", "photo"],
  pricing: ["pricing", "price", "cost"],
  "product-detail": ["product", "detail", "picture"],
  cards: ["card", "content", "section"],
  compare: ["compare", "matrix", "table"],
  bundle: ["bundle", "package", "solution"],
  timeline: ["timeline", "process", "roadmap"],
  quote: ["quote", "statement", "section"],
  "risk-checklist": ["risk", "checklist", "content"],
  closing: ["closing", "thanks", "end"]
};

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRole(layout = "") {
  if (ROLE_REQUIREMENTS[layout]) return layout;
  if (layout === "section" || layout === "kpi") return "cards";
  return "cards";
}

function placeholderTypes(layout = {}) {
  return new Set((layout.placeholders || []).map((item) => item.type).filter(Boolean));
}

function hasRequirement(types, alternatives = []) {
  return alternatives.some((type) => types.has(type));
}

function scoreLayoutForStep(layout = {}, step = {}) {
  const role = normalizeRole(step.layout);
  const types = placeholderTypes(layout);
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.cards;
  const matchedGroups = requirements.filter((group) => hasRequirement(types, group)).length;
  const requiredScore = matchedGroups / Math.max(1, requirements.length);
  const name = cleanText(`${layout.name || ""} ${layout.role || ""}`).toLowerCase();
  const hintScore = (ROLE_HINTS[role] || []).some((hint) => name.includes(hint)) ? 0.18 : 0;
  const usageScore = Math.min(0.18, Number(layout.useCount || 0) * 0.04);
  const roleScore = layout.role === role ? 0.18 : layout.role === "structured" && role !== "cover" ? 0.08 : 0;
  const placeholderScore = Math.min(0.18, Number(layout.placeholderCount || 0) * 0.03);
  const score = requiredScore * 0.46 + hintScore + usageScore + roleScore + placeholderScore;
  return Math.round(Math.min(1, score) * 100) / 100;
}

function reusableLayouts(templateProfile = {}) {
  return (templateProfile.layouts || [])
    .filter((layout) => layout.role !== "system")
    .filter((layout) => Number(layout.placeholderCount || 0) > 0)
    .sort((a, b) => Number(b.useCount || 0) - Number(a.useCount || 0) || Number(b.placeholderCount || 0) - Number(a.placeholderCount || 0));
}

function matchStep(step = {}, layouts = []) {
  const candidates = layouts
    .map((layout) => ({ layout, score: scoreLayoutForStep(layout, step) }))
    .filter((item) => item.score >= 0.42)
    .sort((a, b) => b.score - a.score || Number(b.layout.useCount || 0) - Number(a.layout.useCount || 0));
  const best = candidates[0];
  if (!best) {
    return {
      status: "redraw",
      reason: "no-placeholder-layout-match"
    };
  }
  return {
    status: best.score >= 0.68 ? "reuse-candidate" : "reference-only",
    score: best.score,
    layoutId: best.layout.id,
    layoutName: best.layout.name,
    layoutPath: best.layout.path,
    layoutRole: best.layout.role,
    placeholderTypes: [...placeholderTypes(best.layout)],
    usedBy: best.layout.usedBy || [],
    reason: best.score >= 0.68 ? "placeholder-match" : "weak-placeholder-match"
  };
}

export function buildTemplateReusePlan(layoutSequence = [], sourceReport = {}) {
  const templateProfile = sourceReport?.templateProfile || null;
  if (!templateProfile) {
    return {
      available: false,
      status: "no-template-profile",
      matches: [],
      warnings: []
    };
  }
  const layouts = reusableLayouts(templateProfile);
  const matches = (layoutSequence || []).map((step) => ({
    index: step.index,
    layout: step.layout,
    title: step.title,
    ...matchStep(step, layouts)
  }));
  const reusableMatches = matches.filter((item) => item.status === "reuse-candidate");
  const referenceOnly = matches.filter((item) => item.status === "reference-only");
  const redraw = matches.filter((item) => item.status === "redraw");
  return {
    available: true,
    status: reusableMatches.length ? "has-reuse-candidates" : referenceOnly.length ? "reference-only" : "redraw-only",
    deckNames: templateProfile.deckNames || [templateProfile.deckName].filter(Boolean),
    slideCount: templateProfile.slideCount || 0,
    layoutCount: templateProfile.layoutCount || 0,
    reusableLayoutCount: templateProfile.reusableLayoutCount || layouts.length,
    reuseCandidateCount: reusableMatches.length,
    referenceOnlyCount: referenceOnly.length,
    redrawCount: redraw.length,
    warnings: templateProfile.warnings || [],
    matches
  };
}

export function applyTemplateReusePlan(layoutSequence = [], plan = {}) {
  if (!plan?.available) return layoutSequence;
  const matchByIndex = new Map((plan.matches || []).map((match) => [Number(match.index), match]));
  return layoutSequence.map((step) => {
    const match = matchByIndex.get(Number(step.index));
    if (!match) return step;
    return {
      ...step,
      templateReuse: {
        status: match.status,
        score: match.score || 0,
        layoutId: match.layoutId || "",
        layoutName: match.layoutName || "",
        layoutRole: match.layoutRole || "",
        reason: match.reason || ""
      }
    };
  });
}
