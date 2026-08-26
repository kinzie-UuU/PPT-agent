import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import {
  buildDeckDesignContract,
  classifyDeckText,
  inferDeckPageRole,
  inferPageNumberPolicyFromOcrHints,
  isSemanticClosingText
} from "./workflowDeckDesignSystem.js";
import { buildDeckStyleConsistencyReport, STYLE_DRIFT_REASON_CODES } from "./workflowStyleConsistency.js";

const REPORT_NAME = "visual_text_quality_report.json";
const VISUAL_TEXT_QA_REASON_CODES = new Set([
  "placeholder-text-detected",
  "template-chrome-detected",
  "unexpected-page-number",
  "missing-page-number",
  "page-number-value-mismatch",
  "inconsistent-page-number-format",
  "inconsistent-page-number-position",
  "synthetic-closing-on-content-page",
  "closing-label-on-content-page",
  "severe-language-drift",
  "critical-data-or-contact-missing",
  "critical-brand-or-code-missing",
  "substantial-source-text-loss",
  "missing-critical-source-text",
  "invented-critical-text",
  "semantic-evidence-missing",
  "source-title-mismatch",
  "title-scale-outlier"
]);

export async function writeWorkflowVisualTextQualityReport(job = {}, options = {}) {
  const recordedSourceHints = readJson(job.artifacts?.ocrTextHints?.path || "");
  const sourceHints = job.artifacts?.source?.kind === "brief_source"
    ? { ...recordedSourceHints, pages: [] }
    : recordedSourceHints;
  const visualHints = readJson(job.artifacts?.visualOcrTextHints?.path || "");
  const outline = readJson(job.artifacts?.codexPptOutline?.path || "");
  const expectedPageIds = (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true)
    .map((image, index) => pageIdFor(image, index));
  const contract = buildDeckDesignContract({
    pageNumberPolicy: inferPageNumberPolicyFromOcrHints(sourceHints, options.pageNumberPolicy || "")
  });
  const report = buildVisualTextQualityReport({ sourceHints, visualHints, outline, contract, expectedPageIds });
  const reportPath = path.join(job.dirs.visualImages, REPORT_NAME);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const stat = await fs.stat(reportPath);
  const artifact = {
    kind: "visual_text_quality_report",
    path: reportPath,
    relativePath: path.relative(process.cwd(), reportPath),
    pageCount: report.summary.pageCount,
    blockedCount: report.summary.blockedCount,
    reviewCount: report.summary.reviewCount,
    status: report.status,
    summary: report.summary,
    pageEvidenceSha256ByPage: Object.fromEntries(report.pages.map((page) => [page.pageId, page.evidenceSha256 || ""])),
    size: stat.size,
    sha256: await hashFile(reportPath),
    evidenceSha256: hashJson({
      kind: report.kind,
      version: report.version,
      status: report.status,
      contract: report.contract,
      summary: report.summary,
      pages: report.pages
    }),
    createdAt: report.updatedAt
  };
  job.artifacts = { ...(job.artifacts || {}), visualTextQuality: artifact };
  await mergeIntoVisualQualityReport(job, report);
  reconcileImageDeckReviewEvidence(job, artifact, report.summary);
  return { path: reportPath, report, artifact };
}

export function buildVisualTextQualityReport({ sourceHints = {}, visualHints = {}, outline = {}, contract = null, expectedPageIds = [] } = {}) {
  const designContract = contract || buildDeckDesignContract();
  const sourcePages = Array.isArray(sourceHints.pages) ? sourceHints.pages : [];
  const visualPages = Array.isArray(visualHints.pages) ? visualHints.pages : [];
  const outlineSequence = Array.isArray(outline.layoutSequence) ? outline.layoutSequence : [];
  const sourceByPage = new Map(sourcePages.map((page, index) => [pageIdFor(page, index), page]));
  const recurringSourceHeaderTexts = collectRecurringHeaderTexts(sourcePages);
  const recurringVisualHeaderTexts = collectRecurringHeaderTexts(visualPages);
  const confirmedDeckCriticalLines = collectConfirmedDeckCriticalLines(sourcePages);
  const scopedPageIds = [...new Set((Array.isArray(expectedPageIds) && expectedPageIds.length
    ? expectedPageIds
    : visualPages.map((page, index) => pageIdFor(page, index))).filter(Boolean))];
  const scopedPageIdSet = new Set(scopedPageIds);
  const scopedVisualPages = scopedPageIds.length
    ? visualPages.filter((page, index) => scopedPageIdSet.has(pageIdFor(page, index)))
    : visualPages;
  const totalPages = Math.max(sourcePages.length, visualPages.length, outlineSequence.length);
  let pages = scopedVisualPages.map((visualPage, index) => {
    const pageId = pageIdFor(visualPage, index);
    const sourcePage = sourceByPage.get(pageId) || {};
    const outlineStep = outlineSequence[Number(visualPage.pageNumber || index + 1) - 1] || {};
    return analyzePage({
      pageId,
      pageNumber: Number(visualPage.pageNumber || index + 1),
      totalPages,
      sourcePage,
      visualPage,
      outlineStep,
      contract: designContract,
      recurringSourceHeaderTexts,
      recurringVisualHeaderTexts,
      confirmedDeckCriticalLines
    });
  });
  const pageNumberFormatCounts = new Map();
  for (const format of pages.flatMap((page) => page.pageNumberTexts.map(normalizePageNumberFormat))) {
    pageNumberFormatCounts.set(format, (pageNumberFormatCounts.get(format) || 0) + 1);
  }
  const pageNumberFormats = [...pageNumberFormatCounts.keys()];
  const canonicalPageNumberFormat = [...pageNumberFormatCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const pageNumberAnchorCounts = new Map();
  for (const anchor of pages.flatMap((page) => page.pageNumberAnchors)) {
    pageNumberAnchorCounts.set(anchor, (pageNumberAnchorCounts.get(anchor) || 0) + 1);
  }
  const pageNumberAnchors = [...pageNumberAnchorCounts.keys()];
  const canonicalPageNumberAnchor = [...pageNumberAnchorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  if (designContract.master.pageNumberPolicy === "normalize" && pageNumberFormats.length > 1) {
    for (const page of pages) {
      const formats = page.pageNumberTexts.map(normalizePageNumberFormat);
      if (formats.length && formats.some((format) => format !== canonicalPageNumberFormat)) {
        page.blockingReasons = [...new Set([...page.blockingReasons, "inconsistent-page-number-format"])];
        page.status = "blocked";
      }
    }
  }
  if (designContract.master.pageNumberPolicy === "normalize" && pageNumberAnchors.length > 1) {
    for (const page of pages) {
      if (page.pageNumberAnchors.length && page.pageNumberAnchors.some((anchor) => anchor !== canonicalPageNumberAnchor)) {
        page.blockingReasons = [...new Set([...page.blockingReasons, "inconsistent-page-number-position"])];
        page.status = "blocked";
      }
    }
  }
  pages = pages.map((page) => ({
    ...page,
    evidenceSha256: hashJson({
      kind: "visual_text_quality_page_evidence",
      version: 1,
      contract: {
        version: designContract.version,
        pageNumberPolicy: designContract.master.pageNumberPolicy,
        typographyFamilyMode: designContract.typography.familyMode
      },
      page
    })
  }));
  const blockedPages = pages.filter((page) => page.blockingReasons.length);
  const reviewPages = pages.filter((page) => page.reviewReasons.length || page.blockingReasons.length);
  const sourceClosing = sourcePages.length
    ? inferDeckPageRole({
      pageNumber: sourcePages.length,
      ocrText: usableLines(sourcePages[sourcePages.length - 1]).map((line) => line.text)
    }, { totalPages: sourcePages.length }) === "closing"
    : false;
  const visualClosing = visualPages.length
    ? inferDeckPageRole({
      pageNumber: visualPages.length,
      ocrText: usableLines(visualPages[visualPages.length - 1]).map((line) => line.text)
    }, { totalPages: visualPages.length }) === "closing"
    : false;
  const roleTitleRanges = summarizeTitleRanges(pages);
  const report = {
    kind: "visual_text_quality_report",
    version: 1,
    updatedAt: new Date().toISOString(),
    status: blockedPages.length ? "fail" : reviewPages.length ? "review" : "pass",
    contract: {
      version: designContract.version,
      pageNumberPolicy: designContract.master.pageNumberPolicy,
      typographyFamilyMode: designContract.typography.familyMode
    },
    summary: {
      pageCount: pages.length,
      expectedPageCount: scopedPageIds.length,
      expectedPageIds: scopedPageIds,
      complete: Boolean(scopedPageIds.length > 0 && scopedPageIds.every((pageId) => pages.some((page) => page.pageId === pageId))),
      passCount: pages.filter((page) => page.status === "pass").length,
      reviewCount: reviewPages.length,
      blockedCount: blockedPages.length,
      blockedPageIds: blockedPages.map((page) => page.pageId),
      placeholderPageIds: pages.filter((page) => page.placeholderTexts.length).map((page) => page.pageId),
      pageNumberPageIds: pages.filter((page) => page.pageNumberTexts.length).map((page) => page.pageId),
      pageNumberFormats,
      canonicalPageNumberFormat,
      pageNumberConsistent: pageNumberFormats.length <= 1,
      pageNumberAnchors,
      canonicalPageNumberAnchor,
      pageNumberPositionConsistent: pageNumberAnchors.length <= 1,
      roleTitleRanges,
      sourceHasSemanticClosing: sourceClosing,
      visualHasSemanticClosing: visualClosing,
      closingRecommended: Boolean(totalPages >= 4 && !sourceClosing),
      closingAction: "recommend-only"
    },
    pages
  };
  return report;
}

function analyzePage({
  pageId,
  pageNumber,
  totalPages,
  sourcePage,
  visualPage,
  outlineStep,
  contract,
  recurringSourceHeaderTexts = new Set(),
  recurringVisualHeaderTexts = new Set(),
  confirmedDeckCriticalLines = []
}) {
  const sourceLines = usableLines(sourcePage);
  const approvedOutlineTitle = String(outlineStep.title || "").trim();
  if (!sourceLines.length && approvedOutlineTitle) {
    sourceLines.push({
      text: approvedOutlineTitle,
      confidence: 1,
      corrected: true,
      native_text: true,
      box_px: [80, 72, 1100, 72],
      font_pt_if_cjk: 42,
      source: "approved-outline-title"
    });
    for (const text of [outlineStep.evidence, outlineStep.purpose, outlineStep.visualIntent]) {
      const approvedOutlineEvidence = String(text || "").trim();
      if (!approvedOutlineEvidence) continue;
      sourceLines.push({
        text: approvedOutlineEvidence,
        confidence: 1,
        corrected: true,
        native_text: true,
        authority_only: true,
        box_px: [80, 520, 1100, 32],
        font_pt_if_cjk: 18,
        source: "approved-outline-evidence"
      });
    }
  }
  const visualLines = usableLines(visualPage);
  const sourceText = sourceLines.map((line) => line.text).join(" ");
  const visualText = visualLines.map((line) => line.text).join(" ");
  const role = inferDeckPageRole({
    pageNumber,
    layout: outlineStep.layout,
    storyRole: outlineStep.storyRole,
    outlineTitle: outlineStep.title,
    outlinePurpose: outlineStep.purpose,
    outlineEvidence: outlineStep.evidence,
    ocrText: sourceLines.map((line) => line.text)
  }, { totalPages, preferExplicitRole: false });
  const placeholderTexts = visualLines.filter((line) => classifyDeckText(line.text) === "placeholder").map((line) => line.text);
  const templateChromeTexts = visualLines.filter((line) => classifyDeckText(line.text) === "template_chrome").map((line) => line.text);
  const sourcePageNumberTexts = sourceLines.filter((line) => classifyDeckText(line.text) === "page_number").map((line) => line.text);
  const pageNumberLines = visualLines.filter((line) => classifyDeckText(line.text) === "page_number");
  const pageNumberTexts = pageNumberLines.map((line) => line.text);
  const titleCandidates = visualLines
    .filter((line) => Number(line.box_px?.[1] || 0) <= 864 * 0.42)
    .filter(isLikelyHorizontalTitleLine)
    .filter((line) => !recurringVisualHeaderTexts.has(cleanComparable(line.text)))
    .filter((line) => !["page_number", "placeholder", "template_chrome"].includes(classifyDeckText(line.text)))
    .sort((a, b) => Number(b.font_pt_if_cjk || b.box_px?.[3] || 0) - Number(a.font_pt_if_cjk || a.box_px?.[3] || 0));
  const titlePt = Number(titleCandidates[0]?.font_pt_if_cjk || 0);
  const visualTitleLines = titleCandidates.filter((line) => (
    Number(line.font_pt_if_cjk || line.box_px?.[3] || 0) >= titlePt * 0.72
  ));
  const visualTitleEvidenceLines = titleCandidates.filter((line) => (
    Number(line.font_pt_if_cjk || line.box_px?.[3] || 0) >= titlePt * 0.5
  ));
  const combinedVisualTitle = cleanComparable(visualTitleEvidenceLines.map((line) => line.text).join(""));
  const positionedSourceTitleCandidates = sourceLines
    .filter((line) => Number(line.box_px?.[1] || 0) <= 720 * 0.42)
    .filter((line) => Number(line.box_px?.[0] || 0) <= 720 || Number(line.box_px?.[2] || 0) >= 640)
    .filter((line) => Number(line.font_pt_if_cjk || line.box_px?.[3] || 0) > 0)
    .filter(isLikelyHorizontalTitleLine)
    .filter((line) => cleanComparable(line.text).length >= 4)
    .filter((line) => !recurringSourceHeaderTexts.has(cleanComparable(line.text)))
    .filter((line) => !["page_number", "placeholder", "template_chrome"].includes(classifyDeckText(line.text)));
  const sourceTitleMaxPt = Math.max(0, ...positionedSourceTitleCandidates.map((line) => Number(line.font_pt_if_cjk || line.box_px?.[3] || 0)));
  const outlineTitleComparable = cleanComparable(outlineStep.title || "");
  const outlineMatchedSourceTitle = outlineTitleComparable
    ? positionedSourceTitleCandidates.find((line) => {
      const lineComparable = cleanComparable(line.text);
      return lineComparable.includes(outlineTitleComparable) || outlineTitleComparable.includes(lineComparable);
    })
    : null;
  const nativeOutlineMatchedSourceTitle = !outlineMatchedSourceTitle && outlineTitleComparable
    ? sourceLines.find((line) => line.native_text === true && cleanComparable(line.text) === outlineTitleComparable)
    : null;
  const earlierProminentSourceTitles = outlineMatchedSourceTitle
    ? positionedSourceTitleCandidates.filter((line) => (
      Number(line.box_px?.[1] || 0) <= Number(outlineMatchedSourceTitle.box_px?.[1] || 0) - 20
      && Number(line.font_pt_if_cjk || line.box_px?.[3] || 0) >= Number(outlineMatchedSourceTitle.font_pt_if_cjk || outlineMatchedSourceTitle.box_px?.[3] || 0) * 0.72
    ))
    : [];
  const sourceTitleLines = earlierProminentSourceTitles.length
    ? earlierProminentSourceTitles
      .sort((a, b) => Number(a.box_px?.[1] || 0) - Number(b.box_px?.[1] || 0))
      .slice(0, 2)
    : outlineMatchedSourceTitle
      ? [outlineMatchedSourceTitle]
      : nativeOutlineMatchedSourceTitle
        ? [nativeOutlineMatchedSourceTitle]
        : positionedSourceTitleCandidates
          .filter((line) => Number(line.font_pt_if_cjk || line.box_px?.[3] || 0) >= sourceTitleMaxPt * 0.72)
          .sort((a, b) => Number(a.box_px?.[1] || 0) - Number(b.box_px?.[1] || 0))
          .slice(0, 3);
  const sourceTitleTexts = sourceTitleLines.map((line) => line.text);
  const missingSourceTitleLines = sourceTitleLines.filter((line) => {
    if (hasCriticalLineMatch(visualTitleEvidenceLines, line.text)) return false;
    const sourceTitle = cleanComparable(line.text);
    return !sourceTitle || (!combinedVisualTitle.includes(sourceTitle) && !sourceTitle.includes(combinedVisualTitle));
  });
  const missingSourceTitleTexts = missingSourceTitleLines.map((line) => line.text);
  const sourceTitleMismatchBlocks = missingSourceTitleLines.some((line) => isStrongOcrEvidence(line, "title"));
  const roleLimits = contract.typography.roles[role] || contract.typography.roles.content;
  const nativeStructuredSourceExists = sourceLines.some((line) => line.native_text === true && classifyDeckText(line.text) === "contact");
  const criticalSource = sourceLines.filter((line) => {
    if (line.authority_only === true) return false;
    const kind = classifyDeckText(line.text);
    if (!["data", "contact", "brand_or_code", "brand_candidate"].includes(kind) || cleanComparable(line.text).length < 3) return false;
    if (kind === "contact" && nativeStructuredSourceExists && line.native_text !== true) return false;
    return true;
  });
  const criticalVisual = visualLines.filter((line) => ["data", "contact", "brand_or_code"].includes(classifyDeckText(line.text)) && cleanComparable(line.text).length >= 3);
  const sourceBrandOrCodeTexts = criticalSource
    .filter((line) => classifyDeckText(line.text) === "brand_or_code")
    .map((line) => line.text);
  const meaningfulSource = sourceLines.filter((line) => line.authority_only !== true && ["content", "data", "contact", "brand_or_code", "brand_candidate"].includes(classifyDeckText(line.text)) && cleanComparable(line.text).length >= 2);
  const denseTableMatchOptions = { allowDenseTokenCoverage: ["table", "product", "comparison"].includes(role) };
  const sourceToVisualMatchOptions = { ...denseTableMatchOptions, allowContainingBrandFragment: true };
  const missingMeaningful = meaningfulSource.filter((line) => !hasCriticalLineMatch(visualLines, line.text, sourceToVisualMatchOptions));
  const missingSourceTexts = missingMeaningful.map((line) => line.text).slice(0, 20);
  const contentRetention = meaningfulSource.length
    ? Number(((meaningfulSource.length - missingMeaningful.length) / meaningfulSource.length).toFixed(3))
    : 1;
  const missingCriticalTexts = criticalSource
    .filter((line) => !hasCriticalLineMatch(visualLines, line.text, sourceToVisualMatchOptions))
    .map((line) => line.text)
    .slice(0, 12);
  const adjacentBrandEvidence = collectAdjacentBrandEvidence(visualLines, sourceBrandOrCodeTexts);
  const inventedCriticalLines = uniqueCriticalLines([
    ...criticalVisual.filter((line) => !adjacentBrandEvidence.exactMatchedLines.has(line) && !hasCriticalLineMatch(sourceLines, line.text, denseTableMatchOptions)),
    ...adjacentBrandEvidence.mutationLines
  ]).filter((line) => !matchesConfirmedDeckCriticalLine(line, confirmedDeckCriticalLines));
  const inventedCriticalTexts = inventedCriticalLines.map((line) => line.text).slice(0, 12);
  const inventedCriticalBlockingTexts = inventedCriticalLines
    .filter((line) => {
      const kind = line.combinedBrandText ? "brand_or_code" : classifyDeckText(line.text);
      if (!isStrongOcrEvidence(line, kind)) return false;
      if (["data", "contact"].includes(kind)) return true;
      return kind === "brand_or_code"
        && cleanComparable(line.combinedBrandText || line.text).length >= 5
        && isLikelyBrandMutation(line.combinedBrandText || line.text, sourceBrandOrCodeTexts);
    })
    .map((line) => line.text)
    .slice(0, 12);
  const sourceCjk = sourceLines.filter((line) => /[\u3400-\u9fff]/.test(line.text)).length;
  const visualCjk = visualLines.filter((line) => /[\u3400-\u9fff]/.test(line.text)).length;
  const visualLatin = visualLines.filter((line) => /[A-Za-z]{3}/.test(line.text)).length;
  const severeLanguageDrift = sourceCjk >= 4 && visualCjk <= Math.max(1, Math.floor(sourceCjk * 0.2)) && visualLatin >= 4;
  const closingEligiblePage = pageNumber === totalPages || role === "closing";
  const sourceIsClosing = closingEligiblePage && (sourceLines.some((line) => isSemanticClosingText(line.text)) || isSemanticClosingText(sourceText));
  const visualIsClosing = closingEligiblePage && (visualLines.some((line) => isSemanticClosingText(line.text)) || isSemanticClosingText(visualText));
  const visualRole = inferDeckPageRole({
    pageNumber,
    ocrText: visualLines.map((line) => line.text)
  }, { totalPages });
  const syntheticClosing = visualIsClosing && !sourceIsClosing;
  const closingLabelOnContentPage = visualIsClosing && !sourceIsClosing && visualRole !== "closing";
  const titleScaleOutlier = Boolean(titlePt && (titlePt < roleLimits.titlePt[0] * 0.72 || titlePt > roleLimits.titlePt[1] * 1.22));
  const missingCriticalData = criticalSource.some((line) => (
    ["data", "contact"].includes(classifyDeckText(line.text))
    && isStrongOcrEvidence(line)
    && !hasCriticalLineMatch(visualLines, line.text, sourceToVisualMatchOptions)
  ));
  const missingCriticalBrandOrCode = criticalSource.some((line) => (
    classifyDeckText(line.text) === "brand_or_code"
    && isStrongOcrEvidence(line, "brand_or_code")
    && !hasCriticalLineMatch(visualLines, line.text, sourceToVisualMatchOptions)
  ));
  const substantialTextLoss = !["cover", "section", "visual"].includes(role)
    && meaningfulSource.length >= 6
    && missingSourceTexts.length >= 4
    && contentRetention < 0.55;
  const blockingReasons = [];
  const reviewReasons = [];
  if (placeholderTexts.length) blockingReasons.push("placeholder-text-detected");
  if (templateChromeTexts.length) blockingReasons.push("template-chrome-detected");
  if (contract.master.pageNumberPolicy === "none" && pageNumberTexts.length) blockingReasons.push("unexpected-page-number");
  if (contract.master.pageNumberPolicy === "normalize" && sourcePageNumberTexts.length && !pageNumberTexts.length && role !== "cover") blockingReasons.push("missing-page-number");
  if (contract.master.pageNumberPolicy !== "none" && pageNumberTexts.some((text) => pageNumberValueMismatch(text, pageNumber, totalPages))) blockingReasons.push("page-number-value-mismatch");
  if (syntheticClosing) blockingReasons.push("synthetic-closing-on-content-page");
  if (closingLabelOnContentPage) blockingReasons.push("closing-label-on-content-page");
  if (severeLanguageDrift) blockingReasons.push("severe-language-drift");
  if (missingCriticalData) blockingReasons.push("critical-data-or-contact-missing");
  if (missingCriticalBrandOrCode) blockingReasons.push("critical-brand-or-code-missing");
  if (substantialTextLoss) blockingReasons.push("substantial-source-text-loss");
  if (missingCriticalTexts.length) reviewReasons.push("missing-critical-source-text");
  if (inventedCriticalBlockingTexts.length) blockingReasons.push("invented-critical-text");
  else if (inventedCriticalTexts.length) reviewReasons.push("invented-critical-text");
  if (missingSourceTitleTexts.length && sourceTitleMismatchBlocks) blockingReasons.push("source-title-mismatch");
  else if (missingSourceTitleTexts.length) reviewReasons.push("source-title-mismatch");
  if (titleScaleOutlier) reviewReasons.push("title-scale-outlier");
  return {
    pageId,
    pageNumber,
    visualImageSha256: String(visualPage.imageSha256 || ""),
    role,
    status: blockingReasons.length ? "blocked" : reviewReasons.length ? "review" : "pass",
    blockingReasons,
    reviewReasons,
    placeholderTexts,
    templateChromeTexts,
    pageNumberTexts,
    pageNumberAnchors: pageNumberLines.map((line) => normalizedAnchor(line.box_px)),
    missingCriticalTexts,
    missingSourceTexts,
    inventedCriticalTexts,
    inventedCriticalBlockingTexts,
    sourceTitleTexts,
    missingSourceTitleTexts,
    contentRetention,
    titleText: titleCandidates[0]?.text || "",
    titlePt,
    expectedTitlePt: roleLimits.titlePt,
    sourceIsClosing,
    visualRole,
    closingLabelOnContentPage,
    severeLanguageDrift
  };
}

async function mergeIntoVisualQualityReport(job, textReport) {
  const qualityPath = job.artifacts?.visualQuality?.path || "";
  if (!qualityPath || !fsSync.existsSync(qualityPath)) return;
  const quality = readJson(qualityPath);
  if (!Array.isArray(quality.pages)) return;
  const semanticByPage = new Map(textReport.pages.map((page) => [page.pageId, page]));
  const previousStyleConsistency = quality.summary?.styleConsistency || {};
  quality.version = Math.max(2, Number(quality.version || 1));
  quality.updatedAt = new Date().toISOString();
  quality.pages = quality.pages.map((page, index) => {
    const pageId = page.pageId || `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`;
    const semantic = semanticByPage.get(pageId);
    const semanticReasons = semantic ? [...semantic.blockingReasons, ...semantic.reviewReasons] : ["semantic-evidence-missing"];
    const previousSemanticReasons = new Set([
      ...(Array.isArray(page.semanticQuality?.blockingReasons) ? page.semanticQuality.blockingReasons : []),
      ...(Array.isArray(page.semanticQuality?.reviewReasons) ? page.semanticQuality.reviewReasons : [])
    ]);
    const keepNonSemantic = (reason) => (
      !VISUAL_TEXT_QA_REASON_CODES.has(reason)
      && !previousSemanticReasons.has(reason)
      && !STYLE_DRIFT_REASON_CODES.has(reason)
    );
    const nonSemanticManualReasons = (Array.isArray(page.manualReviewReasons) ? page.manualReviewReasons : []).filter(keepNonSemantic);
    const nonSemanticBlockingReasons = (Array.isArray(page.blockingReasons) ? page.blockingReasons : []).filter(keepNonSemantic);
    const visualOnlyStatus = page.visualQa?.status === "failed" || nonSemanticBlockingReasons.length
      ? "fail"
      : nonSemanticManualReasons.length
        ? "review"
        : "pass";
    const manualReviewReasons = [...new Set([...nonSemanticManualReasons, ...semanticReasons])];
    const blockingReasons = [...new Set([...nonSemanticBlockingReasons, ...(semantic?.blockingReasons || ["semantic-evidence-missing"])])];
    const { styleConsistency: _staleStyleConsistency, ...pageWithoutStaleStyle } = page;
    return {
      ...pageWithoutStaleStyle,
      role: semantic?.role || "content",
      visualOnlyStatus,
      status: blockingReasons.length || visualOnlyStatus === "fail"
        ? "fail"
        : manualReviewReasons.length || visualOnlyStatus === "review"
          ? "review"
          : "pass",
      manualReviewRequired: Boolean(manualReviewReasons.length || blockingReasons.length || visualOnlyStatus === "review"),
      manualReviewReasons,
      approvalBlocked: Boolean(blockingReasons.length || visualOnlyStatus === "fail"),
      blockingReasons,
      semanticQuality: semantic || {
        pageId,
        status: "blocked",
        blockingReasons: ["semantic-evidence-missing"],
        reviewReasons: []
      }
    };
  });
  const qualityPageIds = quality.pages.map((page, index) => page.pageId || `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`);
  const missingSemanticPageIds = quality.pages
    .filter((page) => page.semanticQuality?.blockingReasons?.includes("semantic-evidence-missing"))
    .map((page, index) => page.pageId || `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`);
  const mergedSemanticBlockedPageIds = [...new Set([
    ...(Array.isArray(textReport.summary?.blockedPageIds) ? textReport.summary.blockedPageIds : []),
    ...missingSemanticPageIds
  ])];
  const mergedSemanticQuality = {
    ...(textReport.summary || {}),
    expectedPageCount: qualityPageIds.length,
    expectedPageIds: qualityPageIds,
    complete: Boolean(textReport.summary?.complete && missingSemanticPageIds.length === 0 && semanticByPage.size === qualityPageIds.length),
    blockedCount: mergedSemanticBlockedPageIds.length,
    blockedPageIds: mergedSemanticBlockedPageIds,
    missingEvidencePageIds: missingSemanticPageIds
  };
  const approvedSampleMetrics = previousStyleConsistency.baselineSource === "approved-visual-sample"
    ? previousStyleConsistency.baseline
    : null;
  const styleConsistency = buildDeckStyleConsistencyReport(quality.pages, null, {
    approvedSampleMetrics,
    baselineSource: previousStyleConsistency.baselineSource || ""
  });
  styleConsistency.approvedSampleSha256 = previousStyleConsistency.approvedSampleSha256 || "";
  const styleDriftByPage = new Map((styleConsistency.driftPages || []).map((page) => [page.pageId, page]));
  quality.pages = quality.pages.map((page) => {
    const drift = styleDriftByPage.get(page.pageId);
    const retainedManualReviewReasons = (page.manualReviewReasons || [])
      .filter((reason) => reason !== "deck-style-drift" && !STYLE_DRIFT_REASON_CODES.has(reason));
    const manualReviewReasons = drift
      ? [...new Set([...retainedManualReviewReasons, "deck-style-drift", ...drift.reasons])]
      : retainedManualReviewReasons;
    const status = page.approvalBlocked === true
      ? "fail"
      : manualReviewReasons.length || page.visualOnlyStatus === "review"
        ? "review"
        : "pass";
    const { styleConsistency: _staleStyleConsistency, ...pageWithoutStaleStyle } = page;
    return {
      ...pageWithoutStaleStyle,
      status,
      manualReviewRequired: status !== "pass",
      manualReviewReasons,
      ...(drift ? {
        styleConsistency: {
          status: "review",
          reasons: drift.reasons,
          metrics: drift.metrics,
          deltas: drift.deltas
        }
      } : {})
    };
  });
  const approvalBlockedPageIds = quality.pages
    .filter((page) => page.approvalBlocked === true)
    .map((page, index) => page.pageId || `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`);
  const failedPages = quality.pages.filter((page) => page.status === "fail");
  const reviewPages = quality.pages.filter((page) => page.status === "review");
  const primaryReason = failedPages[0]?.blockingReasons?.[0]
    || reviewPages[0]?.manualReviewReasons?.[0]
    || "";
  quality.summary = {
    ...(quality.summary || {}),
    pageCount: quality.pages.length,
    passCount: quality.pages.filter((page) => page.status === "pass").length,
    reviewCount: reviewPages.length,
    failedCount: failedPages.length,
    manualReviewRequired: reviewPages.length > 0 || failedPages.length > 0,
    primaryReason,
    styleConsistency,
    semanticQuality: mergedSemanticQuality,
    approvalBlocked: approvalBlockedPageIds.length > 0,
    blockedPageIds: approvalBlockedPageIds
  };
  quality.status = failedPages.length ? "fail" : reviewPages.length ? "review" : "pass";
  await fs.writeFile(qualityPath, `${JSON.stringify(quality, null, 2)}\n`, "utf8");
  const qualityStat = await fs.stat(qualityPath);
  const qualitySha256 = await hashFile(qualityPath);
  if (job.artifacts?.visualQuality) {
    job.artifacts.visualQuality = {
      ...job.artifacts.visualQuality,
      ...quality.summary,
      summary: quality.summary,
      semanticQuality: mergedSemanticQuality,
      pageImageSha256ByPage: Object.fromEntries(quality.pages.map((page, index) => [
        page.pageId || `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`,
        String(page.sha256 || "").trim()
      ])),
      approvedSampleSha256: String(styleConsistency.approvedSampleSha256 || "").trim(),
      size: qualityStat.size,
      sha256: qualitySha256,
      evidenceSha256: hashJson({ kind: quality.kind, version: quality.version, status: quality.status, summary: quality.summary, pages: quality.pages }),
      createdAt: quality.updatedAt,
      updatedAt: quality.updatedAt
    };
  }
  if (job.artifacts?.imageDeckReview?.summary) {
    const driftPageIds = (styleConsistency.driftPages || []).map((page) => page.pageId).filter(Boolean);
    job.artifacts.imageDeckReview = {
      ...job.artifacts.imageDeckReview,
      summary: {
        ...job.artifacts.imageDeckReview.summary,
        styleDriftCount: driftPageIds.length,
        pendingStyleDriftPages: driftPageIds.filter((pageId) => {
          const mark = job.artifacts.imageDeckReview.marks?.[pageId] || {};
          return mark.status !== "accept" || mark.styleDriftAccepted !== true;
        })
      }
    };
  }
}

function summarizeTitleRanges(pages = []) {
  const grouped = new Map();
  for (const page of pages) {
    if (!page.titlePt) continue;
    if (!grouped.has(page.role)) grouped.set(page.role, []);
    grouped.get(page.role).push(page.titlePt);
  }
  return Object.fromEntries([...grouped.entries()].map(([role, values]) => [role, {
    min: Math.min(...values),
    max: Math.max(...values),
    spread: Number((Math.max(...values) - Math.min(...values)).toFixed(1)),
    pages: values.length
  }]));
}

function usableLines(page = {}) {
  return (Array.isArray(page.ocrLines) ? page.ocrLines : [])
    .filter((line) => line?.text && (line.low_confidence !== true || line.ensemble_agreement === false) && line.mojibake_suspect !== true)
    .filter((line) => line.native_text === true || Number(line.confidence ?? 1) >= 0.6)
    .map((line) => ({ ...line, text: String(line.text || "").replace(/\s+/g, " ").trim() }))
    .filter((line) => line.text);
}

function collectRecurringHeaderTexts(pages = []) {
  if (!Array.isArray(pages) || pages.length < 3) return new Set();
  const byText = new Map();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index] || {};
    const pageId = pageIdFor(page, index);
    for (const line of usableLines(page)) {
      const text = cleanComparable(line.text);
      const kind = classifyDeckText(line.text);
      if (text.length < 3 || text.length > 40) continue;
      if (Number(line.box_px?.[1] || 0) > 300) continue;
      if (["page_number", "placeholder", "template_chrome", "data", "contact"].includes(kind)) continue;
      if (!byText.has(text)) byText.set(text, new Set());
      byText.get(text).add(pageId);
    }
  }
  const minimumPages = Math.max(3, Math.ceil(pages.length * 0.35));
  return new Set([...byText.entries()]
    .filter(([, pageIds]) => pageIds.size >= minimumPages)
    .map(([text]) => text));
}

function collectConfirmedDeckCriticalLines(pages = []) {
  const byText = new Map();
  for (let index = 0; index < (Array.isArray(pages) ? pages.length : 0); index += 1) {
    const page = pages[index] || {};
    const pageId = pageIdFor(page, index);
    for (const line of usableLines(page)) {
      const kind = classifyDeckText(line.text);
      if (!["brand_or_code", "brand_candidate", "contact"].includes(kind)) continue;
      const key = cleanComparable(line.text);
      if (key.length < 4) continue;
      if (!byText.has(key)) byText.set(key, { line, pageIds: new Set(), onCover: false });
      const record = byText.get(key);
      record.pageIds.add(pageId);
      if (index === 0 || Number(page.pageNumber || index + 1) === 1) record.onCover = true;
    }
  }
  return [...byText.values()]
    .filter((record) => record.onCover || record.pageIds.size >= 2)
    .map((record) => record.line);
}

function matchesConfirmedDeckCriticalLine(line = {}, confirmedLines = []) {
  const candidate = line.combinedBrandText || line.text || "";
  const kind = line.combinedBrandText ? "brand_or_code" : classifyDeckText(candidate);
  if (!["brand_or_code", "brand_candidate", "contact"].includes(kind)) return false;
  if (["brand_or_code", "brand_candidate"].includes(kind)) {
    const target = cleanAsciiComparable(candidate) || cleanComparable(candidate);
    return Boolean(target && confirmedLines.some((confirmed) => (
      (cleanAsciiComparable(confirmed.text) || cleanComparable(confirmed.text)) === target
    )));
  }
  return hasCriticalLineMatch(confirmedLines, candidate);
}

function isStrongOcrEvidence(line = {}, kind = classifyDeckText(line.text)) {
  if (line.native_text === true || line.corrected === true) return true;
  if (line.low_confidence === true || line.ensemble_agreement === false) return false;
  const confidence = Number(line.confidence ?? 1);
  const providers = new Set((Array.isArray(line.ocr_sources) ? line.ocr_sources : []).filter(Boolean));
  if (kind === "brand_or_code" && cleanComparable(line.text).length < 5) return false;
  if (providers.size >= 2) return confidence >= 0.65;
  if (kind === "title") return confidence >= 0.9;
  if (["data", "contact"].includes(kind)) return confidence >= 0.85;
  if (kind === "brand_or_code") return confidence >= 0.88;
  return confidence >= 0.9;
}

function isLikelyHorizontalTitleLine(line = {}) {
  const width = Number(line.box_px?.[2] || 0);
  const height = Number(line.box_px?.[3] || 0);
  if (!width || !height) return false;
  return width >= Math.max(40, height * 1.55);
}

function textForPage(page = {}) {
  return usableLines(page).map((line) => line.text).join(" ");
}

function cleanComparable(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff%¥￥$€£]+/g, "");
}

function containsComparable(haystack = "", needle = "") {
  const left = cleanComparable(haystack);
  const right = cleanComparable(needle);
  return Boolean(right && left.includes(right));
}

function containsCriticalComparable(haystack = "", needle = "") {
  if (classifyDeckText(needle) !== "brand_or_code") return containsComparable(haystack, needle);
  const left = ` ${String(haystack || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const right = String(needle || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return Boolean(right && left.includes(` ${right} `));
}

function hasCriticalLineMatch(lines = [], needle = "", options = {}) {
  const evidenceLines = (Array.isArray(lines) ? lines : []).filter(Boolean);
  const candidateTextGroups = evidenceLines.map(ocrCandidateTexts);
  const candidateLines = candidateTextGroups.flatMap((texts, index) => texts.map((text) => ({
    ...evidenceLines[index],
    text
  })));
  if (hasStructuredIdentifierMatch(candidateLines, needle)) return true;
  if (classifyDeckText(needle) !== "brand_or_code") {
    const target = cleanComparable(needle);
    if (!target) return false;
    if (candidateLines.some((line) => containsComparable(line.text, needle))) return true;
    for (let index = 0; index < candidateTextGroups.length; index += 1) {
      let combinedCandidates = [""];
      for (let offset = 0; offset < 4 && index + offset < candidateTextGroups.length; offset += 1) {
        combinedCandidates = combineOcrCandidates(combinedCandidates, candidateTextGroups[index + offset], cleanComparable, target.length);
        if (combinedCandidates.some((combined) => combined.includes(target))) return true;
        if (target.length >= 12 && combinedCandidates.some((combined) => combined.length <= target.length * 1.6 && isOrderedSubsequence(target, combined))) return true;
        if (combinedCandidates.every((combined) => combined.length > target.length * 1.6)) break;
      }
    }
    if (
      options.allowDenseTokenCoverage === true
      && target.length >= 8
      && /[\u3400-\u9fff]/.test(needle)
      && characterMultisetCoverage(target, cleanComparable(evidenceLines.map((line) => line.text || "").join(" "))) >= 0.96
    ) return true;
    return false;
  }
  if (/[\u3400-\u9fff]/.test(needle)) {
    return candidateLines.some((line) => containsComparable(line.text, needle))
      || containsComparable(evidenceLines.map((line) => line.text || "").join(" "), needle);
  }
  const target = cleanAsciiComparable(needle);
  if (!target) return false;
  const fragmentGroups = candidateTextGroups.map((texts) => texts.map(cleanAsciiComparable).filter(Boolean));
  const fragments = fragmentGroups.flat();
  if (options.allowContainingBrandFragment === true && target.length >= 5 && fragments.some((fragment) => (
    fragment.includes(target)
    && target.length / fragment.length >= 0.55
  ))) return true;
  if (fragments.some((fragment) => fragment === target)) return true;
  for (let index = 0; index < fragmentGroups.length; index += 1) {
    let combinedCandidates = [""];
    for (let offset = 0; offset < 4 && index + offset < fragmentGroups.length; offset += 1) {
      combinedCandidates = combineOcrCandidates(combinedCandidates, fragmentGroups[index + offset], (value) => value, target.length);
      if (combinedCandidates.some((combined) => combined === target)) return true;
      if (combinedCandidates.every((combined) => combined.length > target.length * 1.5)) break;
    }
  }
  return false;
}

function ocrCandidateTexts(line = {}) {
  return [...new Set([
    line.text,
    ...(Array.isArray(line.ocr_alternatives) ? line.ocr_alternatives : [])
  ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function combineOcrCandidates(prefixes = [], values = [], normalize = (value) => value, targetLength = 0) {
  const normalizedValues = (Array.isArray(values) ? values : []).map(normalize).filter(Boolean);
  if (!normalizedValues.length) return prefixes;
  const limit = Math.max(32, normalizedValues.length * 8);
  const maxLength = Math.max(16, Number(targetLength || 0) * 1.8);
  return [...new Set(prefixes.flatMap((prefix) => normalizedValues.map((value) => `${prefix}${value}`)))]
    .filter((value) => value.length <= maxLength)
    .slice(0, limit);
}

function hasStructuredIdentifierMatch(lines = [], needle = "") {
  const raw = String(needle || "").trim();
  if (!/(?:https?:\/\/|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.test(raw)) return false;
  const target = cleanAsciiComparable(raw);
  if (target.length < 8) return false;
  let cursor = 0;
  let matched = 0;
  for (const line of lines) {
    const fragment = cleanAsciiComparable(line?.text || "");
    if (fragment.length < 3 || !target.includes(fragment)) continue;
    const index = target.indexOf(fragment, cursor);
    if (index !== cursor) continue;
    cursor = index + fragment.length;
    matched += fragment.length;
    if (cursor === target.length) return true;
  }
  return matched / target.length >= 0.96;
}

function characterMultisetCoverage(target = "", candidate = "") {
  if (!target || !candidate) return 0;
  const available = new Map();
  for (const character of candidate) available.set(character, (available.get(character) || 0) + 1);
  let matched = 0;
  for (const character of target) {
    const count = available.get(character) || 0;
    if (!count) continue;
    matched += 1;
    available.set(character, count - 1);
  }
  return matched / target.length;
}

function isOrderedSubsequence(target = "", candidate = "") {
  if (!target || !candidate || target.length > candidate.length) return false;
  let targetIndex = 0;
  for (const character of candidate) {
    if (character === target[targetIndex]) targetIndex += 1;
    if (targetIndex === target.length) return true;
  }
  return false;
}

function collectAdjacentBrandEvidence(lines = [], sourceValues = []) {
  const exactMatchedLines = new Set();
  for (let start = 0; start < lines.length; start += 1) {
    let combined = "";
    const partLines = [];
    for (let offset = 0; offset < 4 && start + offset < lines.length; offset += 1) {
      const line = lines[start + offset];
      if (!isBrandFragmentText(line.text)) break;
      const fragment = cleanAsciiComparable(line.text);
      if (!fragment) break;
      combined += fragment;
      partLines.push(line);
      if (sourceValues.some((sourceValue) => cleanAsciiComparable(sourceValue) === combined)) {
        partLines.forEach((partLine) => exactMatchedLines.add(partLine));
        break;
      }
    }
  }
  const mutations = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (exactMatchedLines.has(lines[start])) continue;
    let combined = "";
    const parts = [];
    let confidence = 1;
    const ocrSources = new Set();
    for (let offset = 0; offset < 4 && start + offset < lines.length; offset += 1) {
      const line = lines[start + offset];
      if (exactMatchedLines.has(line)) break;
      if (!isBrandFragmentText(line.text)) break;
      const fragment = cleanAsciiComparable(line.text);
      if (!fragment) break;
      if (sourceValues.some((sourceValue) => cleanAsciiComparable(sourceValue) === fragment)) break;
      combined += fragment;
      parts.push(line.text);
      confidence = Math.min(confidence, Number(line.confidence ?? 1));
      for (const source of Array.isArray(line.ocr_sources) ? line.ocr_sources : []) ocrSources.add(source);
      if (offset === 0 || combined.length < 5) continue;
      if (sourceValues.some((sourceValue) => cleanAsciiComparable(sourceValue) === combined)) break;
      if (!isLikelyBrandMutation(combined, sourceValues)) continue;
      mutations.push({ text: parts.join(" "), confidence, combinedBrandText: combined, ocr_sources: [...ocrSources] });
    }
  }
  return { exactMatchedLines, mutationLines: uniqueCriticalLines(mutations) };
}

function isBrandFragmentText(value = "") {
  const text = String(value || "").trim();
  return classifyDeckText(text) === "brand_or_code" || /^[A-Z0-9][A-Z0-9&+._-]{0,11}$/.test(text);
}

function uniqueCriticalLines(lines = []) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = cleanAsciiComparable(line.combinedBrandText || line.text) || cleanComparable(line.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLikelyBrandMutation(value = "", sourceValues = []) {
  const target = cleanAsciiComparable(value);
  if (target.length < 5) return false;
  return sourceValues.some((sourceValue) => {
    const source = cleanAsciiComparable(sourceValue);
    if (source.length < 4 || source === target) return false;
    const shorter = Math.min(source.length, target.length);
    const longer = Math.max(source.length, target.length);
    if ((source.includes(target) || target.includes(source)) && shorter / longer >= 0.6) return true;
    const similarity = 1 - levenshteinDistance(source, target) / longer;
    if (similarity >= 0.68) return true;
    const suffixLength = commonSuffixLength(source, target);
    return shorter >= 5 && suffixLength >= Math.max(4, Math.ceil(shorter * 0.7));
  });
}

function cleanAsciiComparable(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function commonSuffixLength(left = "", right = "") {
  let count = 0;
  while (count < left.length && count < right.length && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function levenshteinDistance(left = "", right = "") {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function pageNumberValueMismatch(value = "", pageNumber = 0, totalPages = 0) {
  const numbers = String(value || "").match(/\d+/g)?.map(Number) || [];
  if (!numbers.length) return false;
  if (numbers[0] !== Number(pageNumber)) return true;
  return numbers.length > 1 && Number(totalPages) > 0 && numbers[numbers.length - 1] !== Number(totalPages);
}

function normalizedAnchor(box = []) {
  const x = Number(box?.[0] || 0);
  const y = Number(box?.[1] || 0);
  return `${Math.round(x / 154) * 10}:${Math.round(y / 86) * 10}`;
}

function normalizePageNumberFormat(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\d+/g, "n")
    .replace(/\s+/g, "")
    .trim();
}

function pageIdFor(page = {}, index = 0) {
  if (page.pageId) return page.pageId;
  return `page_${String(Number(page.pageNumber || index + 1)).padStart(3, "0")}`;
}

function readJson(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return {};
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function reconcileImageDeckReviewEvidence(job = {}, artifact = {}, semanticSummary = {}) {
  const previous = job.artifacts?.imageDeckReview;
  if (!previous?.marks || !artifact.evidenceSha256) return;
  const visualImages = (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true);
  const marks = previous.marks || {};
  const pageEvidenceSha256ByPage = artifact.pageEvidenceSha256ByPage || {};
  const visualQualityEvidenceSha256 = String(job.artifacts?.visualQuality?.evidenceSha256 || job.artifacts?.visualQuality?.sha256 || "").trim();
  const currentMarks = visualImages.map((image, index) => {
    const pageId = image.pageId || `page_${String(Number(image.pageNumber || index + 1)).padStart(3, "0")}`;
    const mark = marks[pageId];
    const pageEvidenceSha256 = pageEvidenceSha256ByPage[pageId] || "";
    return mark
      && pageEvidenceSha256
      && visualQualityEvidenceSha256
      && mark.visualTextQualityPageEvidenceSha256 === pageEvidenceSha256
      && mark.visualQualityEvidenceSha256 === visualQualityEvidenceSha256
      && (!image.sha256 || mark.visualImageSha256 === image.sha256)
      ? { ...mark, pageId }
      : null;
  }).filter(Boolean);
  const allMarksCurrent = Boolean(visualImages.length && currentMarks.length === visualImages.length);
  const rerunCount = currentMarks.filter((mark) => mark.status === "rerun").length;
  const semanticBlockedPageIds = new Set(Array.isArray(semanticSummary.blockedPageIds) ? semanticSummary.blockedPageIds : []);
  const styleConsistency = job.artifacts?.visualQuality?.summary?.styleConsistency
    || job.artifacts?.visualQuality?.styleConsistency
    || {};
  const styleDriftPageIds = new Set((Array.isArray(styleConsistency.driftPages) ? styleConsistency.driftPages : [])
    .map((page) => page.pageId || (Number.isFinite(Number(page.pageNumber)) ? `page_${String(Number(page.pageNumber)).padStart(3, "0")}` : ""))
    .filter(Boolean));
  const reviewedAndAccepted = Boolean(allMarksCurrent && currentMarks.every((mark) => {
    if (!["pass", "accept"].includes(mark.status)) return false;
    if (semanticBlockedPageIds.has(mark.pageId) && (mark.status !== "accept" || mark.semanticRiskAccepted !== true)) return false;
    if (styleDriftPageIds.has(mark.pageId) && (mark.status !== "accept" || mark.styleDriftAccepted !== true)) return false;
    return true;
  }));
  const readyForApproval = Boolean(
    reviewedAndAccepted
    && rerunCount === 0
  );
  job.artifacts.imageDeckReview = {
    ...previous,
    status: readyForApproval ? previous.status : "in_progress",
    visualTextQualityEvidenceSha256: artifact.evidenceSha256,
    visualQualityEvidenceSha256,
    summary: {
      ...(previous.summary || {}),
      markedCount: currentMarks.length,
      passCount: currentMarks.filter((mark) => mark.status === "pass").length,
      acceptCount: currentMarks.filter((mark) => mark.status === "accept").length,
      rerunCount,
      semanticBlockedCount: Number(semanticSummary.blockedCount || 0),
      semanticBlockedPages: Array.isArray(semanticSummary.blockedPageIds) ? semanticSummary.blockedPageIds : [],
      pendingStyleDriftPages: [...styleDriftPageIds].filter((pageId) => {
        const mark = marks[pageId] || {};
        return mark.status !== "accept" || mark.styleDriftAccepted !== true;
      }),
      allPagesReviewed: readyForApproval,
      allMarksCurrent,
      readyForApproval
    }
  };
}
