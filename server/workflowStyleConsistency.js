export const STYLE_DRIFT_REASON_CODES = new Set([
  "deck-style-drift",
  "style-brightness-drift",
  "style-color-drift",
  "style-hue-drift",
  "style-density-drift",
  "style-text-density-drift",
  "style-title-density-drift"
]);

export function buildDeckStyleConsistencyReport(pages = [], approvedSampleQa = null, options = {}) {
  const candidates = (Array.isArray(pages) ? pages : [])
    .map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      role: page.role || "content",
      metrics: extractStyleMetrics(page.visualQa)
    }))
    .filter((page) => page.metrics);
  const approvedSampleMetrics = extractStyleMetrics(approvedSampleQa)
    || normalizeStyleMetrics(options.approvedSampleMetrics);
  if (!approvedSampleMetrics && candidates.length < 3) {
    return {
      status: "insufficient-data",
      checkedPages: candidates.length,
      driftCount: 0,
      driftPages: [],
      message: "Need at least 3 generated pages for deck-level style consistency QA."
    };
  }
  const deckBaseline = {
    brightness: median(candidates.map((page) => page.metrics.brightness)),
    saturationDensity: median(candidates.map((page) => page.metrics.saturationDensity)),
    hueCoverage: median(candidates.map((page) => page.metrics.hueCoverage)),
    hueHistogram: medianHistogram(candidates.map((page) => page.metrics.hueHistogram)),
    edgeDensity: median(candidates.map((page) => page.metrics.edgeDensity)),
    textLikeScore: median(candidates.map((page) => page.metrics.textLikeScore)),
    titleEdgeDensity: median(candidates.map((page) => page.metrics.titleEdgeDensity))
  };
  const roleBaselines = Object.fromEntries([...new Set(candidates.map((page) => page.role))].map((role) => {
    const rolePages = candidates.filter((page) => page.role === role);
    return [role, rolePages.length >= 2 ? {
      edgeDensity: median(rolePages.map((page) => page.metrics.edgeDensity)),
      textLikeScore: median(rolePages.map((page) => page.metrics.textLikeScore)),
      titleEdgeDensity: median(rolePages.map((page) => page.metrics.titleEdgeDensity))
    } : null];
  }));
  const baseline = approvedSampleMetrics || deckBaseline;
  const driftPages = candidates
    .map((page) => {
      const roleBaseline = roleBaselines[page.role];
      const comparisonBaseline = roleBaseline ? { ...baseline, ...roleBaseline } : baseline;
      const deltas = {
        brightness: round(Math.abs(page.metrics.brightness - comparisonBaseline.brightness)),
        saturationDensity: round(Math.abs(page.metrics.saturationDensity - comparisonBaseline.saturationDensity)),
        hueDistance: round(hueHistogramDistance(page.metrics.hueHistogram, comparisonBaseline.hueHistogram)),
        edgeDensity: round(Math.abs(page.metrics.edgeDensity - comparisonBaseline.edgeDensity)),
        textLikeScore: round(Math.abs(page.metrics.textLikeScore - comparisonBaseline.textLikeScore)),
        titleEdgeDensity: round(Math.abs(page.metrics.titleEdgeDensity - comparisonBaseline.titleEdgeDensity))
      };
      const reasons = [
        ...(deltas.brightness > 0.22 ? ["style-brightness-drift"] : []),
        ...(deltas.saturationDensity > 0.35 ? ["style-color-drift"] : []),
        ...(page.metrics.hueCoverage > 0.12 && baseline.hueCoverage > 0.12 && deltas.hueDistance > 0.55 ? ["style-hue-drift"] : []),
        ...(deltas.edgeDensity > 0.085 ? ["style-density-drift"] : []),
        ...(deltas.textLikeScore > 0.04 ? ["style-text-density-drift"] : []),
        ...(deltas.titleEdgeDensity > 0.08 ? ["style-title-density-drift"] : [])
      ];
      return {
        pageId: page.pageId,
        pageNumber: page.pageNumber,
        role: page.role,
        reasons,
        metrics: page.metrics,
        deltas
      };
    })
    .filter((page) => page.reasons.length);
  return {
    status: driftPages.length ? "review" : "pass",
    checkedPages: candidates.length,
    driftCount: driftPages.length,
    driftPages,
    baseline,
    roleBaselines,
    baselineSource: options.baselineSource || (approvedSampleMetrics ? "approved-visual-sample" : "deck-median"),
    thresholds: {
      brightness: 0.22,
      saturationDensity: 0.35,
      hueDistance: 0.55,
      edgeDensity: 0.085,
      textLikeScore: 0.04,
      titleEdgeDensity: 0.08
    },
    message: driftPages.length
      ? `${driftPages.length} page(s) visually drift from the approved deck style and need human review or rerun.`
      : "Deck-level pixel consistency QA did not detect obvious style drift from the approved sample."
  };
}

function extractStyleMetrics(qa = null) {
  if (!qa || qa.status === "failed" || !qa.full) return null;
  return normalizeStyleMetrics({
    brightness: qa.full.brightness,
    saturationDensity: qa.full.saturationDensity,
    hueCoverage: qa.full.hueCoverage,
    hueHistogram: qa.full.hueHistogram,
    dominantHue: qa.full.dominantHue,
    edgeDensity: qa.full.edgeDensity,
    textLikeScore: qa.full.textLikeScore,
    titleEdgeDensity: qa.titleArea?.edgeDensity
  });
}

function normalizeStyleMetrics(value = null) {
  if (!value || typeof value !== "object") return null;
  const metrics = {
    brightness: Number(value.brightness || 0),
    saturationDensity: Number(value.saturationDensity || 0),
    hueCoverage: Number(value.hueCoverage || 0),
    hueHistogram: Array.isArray(value.hueHistogram) ? value.hueHistogram.map(Number) : [],
    dominantHue: value.dominantHue !== null && value.dominantHue !== undefined && Number.isFinite(Number(value.dominantHue))
      ? Number(value.dominantHue)
      : null,
    edgeDensity: Number(value.edgeDensity || 0),
    textLikeScore: Number(value.textLikeScore || 0),
    titleEdgeDensity: Number(value.titleEdgeDensity || 0)
  };
  return Object.values(metrics).some((entry) => Array.isArray(entry) ? entry.length > 0 : Number(entry) !== 0)
    ? metrics
    : null;
}

function hueHistogramDistance(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
  const smooth = (values) => values.map((value, index) => (
    Number(value || 0) * 0.5
    + Number(values[(index - 1 + values.length) % values.length] || 0) * 0.25
    + Number(values[(index + 1) % values.length] || 0) * 0.25
  ));
  const smoothLeft = smooth(left);
  const smoothRight = smooth(right);
  return smoothLeft.reduce((sum, value, index) => sum + Math.abs(value - smoothRight[index]), 0) / 2;
}

function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : round((numbers[middle - 1] + numbers[middle]) / 2);
}

function medianHistogram(histograms = []) {
  const valid = histograms.filter((value) => Array.isArray(value) && value.length);
  if (!valid.length) return [];
  const size = valid[0].length;
  if (!valid.every((value) => value.length === size)) return [];
  return Array.from({ length: size }, (_item, index) => median(valid.map((value) => value[index])));
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
