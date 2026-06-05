function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function statusFrom({ blockers = [], warnings = [] } = {}) {
  if (blockers.length) return "block";
  if (warnings.length) return "warn";
  return "pass";
}

export function buildHybridQa(job = {}, quality = {}, previewImages = []) {
  const assetManifest = job.assetManifest || {};
  const assetQa = job.assetManifestQa || {};
  const sceneQa = job.sceneGraphQa || quality.sceneGraphQa || {};
  const visualCompare = job.visualCompare || quality.visualCompare || {};
  const pptxEditability = quality.pptxEditability || job.quality?.pptxEditability || {};
  const visualProject = job.visualProject || {};
  const imagePlan = job.imageSupplementPlan || {};
  const repair = job.sceneGraphRepair || {};
  const renderQa = quality.renderImageQa || {};
  const localQa = quality.localImageQa || {};
  const slideCount = job.deck?.slides?.length || 0;
  const previewCount = list(previewImages).filter(Boolean).length;

  const contentBlockers = [];
  const contentWarnings = [...list(sceneQa.errors), ...list(sceneQa.warnings)];
  const missingEditableText = list(sceneQa.warnings).filter((item) => /expected editable text missing|missing title text box|no editable text boxes/i.test(item));
  if (slideCount && previewCount && previewCount !== slideCount) contentBlockers.push(`preview-count-mismatch:${previewCount}/${slideCount}`);
  if (missingEditableText.length) contentBlockers.push(`missing-editable-content:${missingEditableText.length}`);
  if (!assetQa.checks?.sourceRefsPresent) contentWarnings.push("source_refs missing or empty");

  const assetBlockers = [];
  const assetWarnings = [...list(assetQa.errors), ...list(assetQa.warnings), ...list(assetManifest.warnings)];
  const pendingGeneration = list(imagePlan.items).filter((item) => item.action === "need-remote-generation");
  const failedCutouts = list(job.files).filter((file) => file.needsCutout && /failed/i.test(file.mattingStatus || ""));
  const missingRequiredImages = list(sceneQa.warnings).filter((item) => /missing-required-image-object|required image missing/i.test(item));
  if (pendingGeneration.length) assetBlockers.push(`missing-or-generated-material:${pendingGeneration.length}`);
  if (failedCutouts.length) assetBlockers.push(`cutout-failed:${failedCutouts.length}`);
  if (missingRequiredImages.length) assetBlockers.push(`missing-required-independent-images:${missingRequiredImages.length}`);
  if (localQa.warnCount) assetWarnings.push(`local-image-qa-warnings:${localQa.warnCount}`);

  const editableBlockers = [];
  const editableWarnings = [
    ...list(sceneQa.errors),
    ...list(sceneQa.warnings).filter((item) => /full-slide|raster|background|native|text|shape|editable|visual target sample/i.test(item)),
    ...list(pptxEditability.warnings)
  ];
  if (sceneQa.status === "block") editableBlockers.push("scenegraph-blocked");
  if (pptxEditability.editable === false || pptxEditability.fullSlidePictures) editableBlockers.push("pptx-not-object-editable-or-full-slide-raster");
  const backgroundViolations = Number(sceneQa.backgroundViolationCount || 0);
  if (backgroundViolations) editableBlockers.push(`background-violations:${backgroundViolations}`);

  const visualBlockers = [];
  const visualWarnings = [...list(visualCompare.warnings)];
  if (visualCompare.status === "warn") visualWarnings.push(`visual-consistency-score:${visualCompare.score || 0}`);
  if (renderQa.warningCount) visualWarnings.push(`render-image-placement-warnings:${renderQa.warningCount}`);
  if (visualProject.status === "blocked") visualBlockers.push("visual-project-blocked");
  if (visualProject.slideCount && visualProject.generatedImages < visualProject.slideCount) visualWarnings.push(`origin-images-pending:${visualProject.generatedImages || 0}/${visualProject.slideCount}`);

  const categories = {
    content: qaCategory("content", contentBlockers, contentWarnings, {
      slideCount,
      previewCount,
      textBoxes: sceneQa.textBoxes || 0,
      sourceRefs: assetManifest.source_refs?.length || 0,
      missingEditableText: missingEditableText.length
    }),
    assets: qaCategory("assets", assetBlockers, assetWarnings, {
      assetCount: assetManifest.assets?.length || 0,
      criticalCount: assetManifest.criticalCount || 0,
      backgroundBlockedCount: assetManifest.backgroundBlockedCount || 0,
      pendingGeneration: pendingGeneration.length,
      failedCutouts: failedCutouts.length,
      missingRequiredImages: missingRequiredImages.length
    }),
    editable: qaCategory("editable", editableBlockers, editableWarnings, {
      sceneGraphSlides: sceneQa.slideCount || 0,
      pptxTextBoxes: pptxEditability.nativeTextBoxes || 0,
      pptxShapes: pptxEditability.nativeShapes || 0,
      pptxPictures: pptxEditability.nativePictures || 0,
      fullSlidePictures: pptxEditability.fullSlidePictures || 0,
      backgroundViolations
    }),
    visual: qaCategory("visual", visualBlockers, visualWarnings, {
      visualScore: visualCompare.score || 0,
      visualMethod: visualCompare.method || "",
      originImages: visualProject.generatedImages || 0,
      visualSlides: visualProject.slideCount || 0
    })
  };
  const all = Object.values(categories);
  const autoRepairLog = [
    ...list(repair.completed).map((item) => ({ type: "scenegraph", status: "done", ...item })),
    ...list(repair.actions).map((item) => ({ type: "scenegraph", status: item.status || "pending", ...item })),
    ...list(job.visualFixes).map((item) => ({ type: "visual", status: "done", stage: item.stage, changes: item.changes || [] }))
  ];
  return {
    version: 1,
    status: all.some((item) => item.status === "block") ? "block" : all.some((item) => item.status === "warn") ? "warn" : "pass",
    categories,
    autoRepairLog,
    facts: {
      slideCount,
      previewCount,
      assetCount: assetManifest.assets?.length || 0,
      originImages: visualProject.generatedImages || 0,
      editableWorkerSlides: visualProject.generatedSceneGraphs || 0,
      fullSlidePictures: pptxEditability.fullSlidePictures || 0
    }
  };
}

export function buildFinalExportGate({ formats = [], hybridQa = {}, allowBlockedExport = false } = {}) {
  const requestedFormats = list(formats).length ? list(formats) : ["pptx"];
  const finalFormats = requestedFormats.filter((format) => ["pdf", "png"].includes(String(format).toLowerCase()));
  const blocked = finalFormats.length > 0 && hybridQa.status === "block" && allowBlockedExport !== true;
  return {
    blocked,
    status: blocked ? "block" : "pass",
    reason: blocked ? "Final PDF/PNG export blocked by QA; editable PPTX remains available as a draft." : "",
    requestedFormats,
    requestedFinalFormats: finalFormats,
    qaStatus: hybridQa.status || "unknown"
  };
}

function qaCategory(id, blockers = [], warnings = [], metrics = {}) {
  return {
    id,
    status: statusFrom({ blockers, warnings }),
    blockers: [...new Set(blockers)].slice(0, 12),
    warnings: [...new Set(warnings)].slice(0, 12),
    metrics
  };
}
