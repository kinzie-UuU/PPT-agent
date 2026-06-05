import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import zlib from "zlib";
import pptxgen from "pptxgenjs";
import { outputDir } from "./store.js";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|[;,，；、]+/).map(cleanText).filter(Boolean);
}

function safeName(value = "") {
  return cleanText(value).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "visual-project";
}

function slideId(index) {
  return `slide_${String(index + 1).padStart(2, "0")}`;
}

export async function ensureVisualProjectForJob(job = {}, options = {}) {
  const deck = job.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const projectName = safeName(job.id || deck.title || "visual-project");
  const projectDir = path.join(outputDir, job.id || projectName, "visual-project");
  const promptsDir = path.join(projectDir, "prompts");
  const originImageDir = path.join(projectDir, "origin_image");
  const sceneGraphDir = path.join(projectDir, "scenegraph");
  await fs.mkdir(promptsDir, { recursive: true });
  await fs.mkdir(originImageDir, { recursive: true });
  await fs.mkdir(sceneGraphDir, { recursive: true });

  const styleSystem = buildStyleSystem(job);
  const outline = buildOutlineMarkdown(job, styleSystem);
  const deckSpec = buildDeckSpec(job, styleSystem);
  const promptJobs = buildPromptJobs(job, deckSpec);
  const runState = buildRunState(job, promptJobs);

  const outlinePath = path.join(projectDir, "outline.md");
  const deckSpecPath = path.join(projectDir, "deck_spec.json");
  const slideJobsPath = path.join(projectDir, "slide_jobs.json");
  const slideRunStatePath = path.join(projectDir, "slide_run_state.json");
  const slideSceneGraphManifestPath = path.join(projectDir, "slide_scenegraphs.json");
  const previousPromptJobs = await readJson(slideJobsPath);
  const previousRunState = await readJson(slideRunStatePath);
  mergeSlideJobState(promptJobs, previousPromptJobs);
  mergeRunState(runState, previousRunState);
  await fs.writeFile(outlinePath, outline, "utf8");
  await fs.writeFile(deckSpecPath, JSON.stringify(deckSpec, null, 2), "utf8");
  await fs.writeFile(slideJobsPath, JSON.stringify(promptJobs, null, 2), "utf8");
  await fs.writeFile(slideRunStatePath, JSON.stringify(runState, null, 2), "utf8");
  for (const promptJob of promptJobs.slides) {
    await fs.writeFile(path.join(promptsDir, `${promptJob.id}.json`), JSON.stringify(promptJob, null, 2), "utf8");
  }

  const targetImages = discoverOriginImages(originImageDir);
  const sceneGraphFiles = discoverSlideSceneGraphs(sceneGraphDir);
  const visualTargetPptxPath = targetImages.length ? await buildVisualTargetPptx({ projectDir, deckName: "visual-target", imagePaths: targetImages }) : null;
  const contactSheetPath = await writeContactSheet(projectDir, targetImages, slides);
  const status = targetImages.length === slides.length && slides.length ? "ready" : slides.length ? "pending-workers" : "empty";
  const visualProject = {
    version: 1,
    status,
    mode: "one-click-reviewable",
    deckName: deckSpec.deck_name,
    slideCount: slides.length,
    projectDir,
    outlinePath,
    deckSpecPath,
    promptsDir,
    originImageDir,
    sceneGraphDir,
    slideJobsPath,
    slideRunStatePath,
    slideSceneGraphManifestPath,
    contactSheetPath,
    visualTargetPptxPath,
    visualTargetPptxKind: visualTargetPptxPath ? "full-slide-image-intermediate" : "not-built",
    editable: false,
    intermediateOnly: true,
    sampleSlide: deckSpec.sample_slide || "",
    backend: job.visualTarget?.sample?.provider || "local-img2-first-cloud-fallback",
    generatedImages: targetImages.length,
    generatedSceneGraphs: sceneGraphFiles.length,
    editableWorkerStatus: sceneGraphFiles.length === slides.length && slides.length ? "ready" : sceneGraphFiles.length ? "partial" : "pending",
    warnings: [
      visualTargetPptxPath ? "visual-target-pptx-is-not-editable" : "",
      targetImages.length < slides.length ? `origin-images-pending:${targetImages.length}/${slides.length}` : "",
      sceneGraphFiles.length < slides.length ? `slide-scenegraphs-pending:${sceneGraphFiles.length}/${slides.length}` : ""
    ].filter(Boolean),
    workerPolicy: {
      visualWorker: "one prompt job per slide; worker may not edit outline/deck_spec/style_system/asset_manifest",
      editableWorker: "one slide_scenegraph per slide; parent merges and runs final QA",
      directorOwns: ["assetManifest", "outline", "styleSystem", "deckSpec", "finalQA", "exports"]
    },
    updatedAt: new Date().toISOString()
  };
  job.visualProject = mergeVisualProject(visualProject, job.visualProject);
  return job.visualProject;
}

function mergeSlideJobState(nextJobs = {}, previousJobs = {}) {
  const previousById = new Map((previousJobs.slides || []).map((slide) => [slide.id, slide]));
  for (const slide of nextJobs.slides || []) {
    const previous = previousById.get(slide.id);
    if (!previous) continue;
    for (const key of ["status", "selected_source", "backend_used", "qa_note", "blocker"]) {
      if (previous[key]) slide[key] = previous[key];
    }
  }
  if ((nextJobs.slides || []).every((slide) => slide.status === "recorded") && nextJobs.slides?.length) nextJobs.status = "recorded";
  else if ((nextJobs.slides || []).some((slide) => slide.status === "blocked")) nextJobs.status = "blocked";
  else if ((nextJobs.slides || []).some((slide) => slide.status === "recorded")) nextJobs.status = "partial";
}

function mergeRunState(nextState = {}, previousState = {}) {
  const previousById = new Map((previousState.slides || []).map((slide) => [slide.id, slide]));
  for (const slide of nextState.slides || []) {
    const previous = previousById.get(slide.id);
    if (!previous) continue;
    Object.assign(slide, {
      status: previous.status || slide.status,
      worker: previous.worker || slide.worker,
      result: previous.result || slide.result,
      blocker: previous.blocker || slide.blocker
    });
  }
  if ((nextState.slides || []).every((slide) => slide.status === "recorded") && nextState.slides?.length) nextState.status = "recorded";
  else if ((nextState.slides || []).some((slide) => slide.status === "blocked")) nextState.status = "blocked";
  else if ((nextState.slides || []).some((slide) => slide.status === "recorded")) nextState.status = "partial";
}

export async function generateVisualProjectSlides(job = {}, {
  generateImage,
  maxSlides = Infinity,
  overwrite = false
} = {}) {
  if (typeof generateImage !== "function") throw new Error("generateVisualProjectSlides requires generateImage callback");
  await ensureVisualProjectForJob(job);
  const project = job.visualProject || {};
  const promptJobs = await readJson(project.slideJobsPath);
  const runState = await readJson(project.slideRunStatePath);
  const slides = Array.isArray(promptJobs.slides) ? promptJobs.slides : [];
  const runSlides = Array.isArray(runState.slides) ? runState.slides : [];
  const completed = [];
  const blockers = [];
  let generatedCount = 0;

  for (const slideJob of slides) {
    if (generatedCount >= maxSlides) break;
    const outputPath = path.join(project.projectDir, slideJob.out || `origin_image/${slideJob.id}.png`);
    let runSlide = runSlides.find((item) => item.id === slideJob.id);
    if (!runSlide) {
      runSlide = { id: slideJob.id, prompt_file: slideJob.prompt_file, out: slideJob.out, status: "pending" };
      runSlides.push(runSlide);
    }
    if (!overwrite && fsSync.existsSync(outputPath)) {
      slideJob.status = "recorded";
      runSlide.status = "recorded";
      runSlide.result = { outputPath, reused: true, at: new Date().toISOString() };
      completed.push({ id: slideJob.id, outputPath, reused: true });
      continue;
    }
    slideJob.status = "running";
    runSlide.status = "running";
    runSlide.worker = {
      id: `local_visual_worker_${slideJob.id}`,
      type: "single-slide-visual-worker",
      startedAt: new Date().toISOString()
    };
    try {
      const record = await generateImage(slideJob);
      if (!record?.path || !fsSync.existsSync(record.path)) throw new Error("image generator returned no file path");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.copyFile(record.path, outputPath);
      slideJob.status = "recorded";
      slideJob.selected_source = record.path;
      slideJob.backend_used = record.provider || record.source || "image-generator";
      slideJob.qa_note = record.visualQa?.status ? `visual QA ${record.visualQa.status}` : "generated";
      runSlide.status = "recorded";
      runSlide.result = {
        outputPath,
        selectedSource: record.path,
        backendUsed: slideJob.backend_used,
        qaNote: slideJob.qa_note,
        at: new Date().toISOString()
      };
      completed.push({ id: slideJob.id, outputPath, backendUsed: slideJob.backend_used });
      generatedCount += 1;
    } catch (error) {
      const reason = error.message || "visual slide generation failed";
      slideJob.status = "blocked";
      slideJob.blocker = reason;
      runSlide.status = "blocked";
      runSlide.blocker = { reason, at: new Date().toISOString() };
      blockers.push({ id: slideJob.id, reason });
    }
  }

  promptJobs.status = blockers.length ? "blocked" : slides.every((item) => item.status === "recorded") ? "recorded" : "partial";
  promptJobs.updatedAt = new Date().toISOString();
  runState.status = promptJobs.status;
  runState.updatedAt = promptJobs.updatedAt;
  await fs.writeFile(project.slideJobsPath, JSON.stringify(promptJobs, null, 2), "utf8");
  await fs.writeFile(project.slideRunStatePath, JSON.stringify(runState, null, 2), "utf8");
  await ensureVisualProjectForJob(job);
  job.visualProject = {
    ...(job.visualProject || {}),
    generation: {
      status: blockers.length ? "blocked" : completed.length ? "recorded" : "not-started",
      completedCount: completed.length,
      blockerCount: blockers.length,
      completed,
      blockers,
      updatedAt: new Date().toISOString()
    }
  };
  return job.visualProject.generation;
}

export async function writeEditableSceneGraphArtifacts(job = {}) {
  await ensureVisualProjectForJob(job);
  const project = job.visualProject || {};
  const slides = Array.isArray(job.sceneGraph?.slides) ? job.sceneGraph.slides : [];
  if (!slides.length) {
    return {
      status: "empty",
      completedCount: 0,
      blockerCount: 1,
      blockers: [{ id: "scenegraph", reason: "job.sceneGraph has no slides" }],
      updatedAt: new Date().toISOString()
    };
  }
  await fs.mkdir(project.sceneGraphDir, { recursive: true });
  const originImages = discoverOriginImages(project.originImageDir || "");
  const assetManifest = job.assetManifest || {};
  const completed = [];
  for (const slide of slides) {
    const id = slide.id || slideId(Number(slide.index || completed.length + 1) - 1);
    const slideIndex = Number(slide.index || completed.length + 1);
    const outputPath = path.join(project.sceneGraphDir, `${id}.json`);
    const slideAssets = (assetManifest.assets || []).filter((asset) => !asset.sourceSlide || Number(asset.sourceSlide) === slideIndex);
    const visualTargetImage = originImages[slideIndex - 1] || null;
    const payload = {
      version: 1,
      id,
      slide: slideIndex,
      worker: {
        type: "single-slide-editable-worker",
        status: "recorded",
        constraints: [
          "read visual target image as reference only",
          "use assetManifest for facts and critical material identity",
          "emit editable text/shape/image objects, never a full-slide raster"
        ],
        updatedAt: new Date().toISOString()
      },
      inputs: {
        visualTargetImage,
        assetIds: slideAssets.map((asset) => asset.id),
        sourceRefs: (assetManifest.source_refs || []).filter((ref) => !ref.sourceSlide || Number(ref.sourceSlide) === slideIndex).map((ref) => ref.id)
      },
      output: {
        slide_scenegraph: slide
      },
      qa: {
        editable: true,
        noFullSlideRaster: slide.constraints?.noFullSlideRaster !== false,
        textObjects: slide.texts?.length || 0,
        shapeObjects: (slide.shapes?.length || 0) + (slide.decorations?.length || 0),
        imageObjects: slide.images?.length || 0,
        backgroundSafe: !slide.layers?.background?.containsCriticalText && !slide.layers?.background?.containsLogo && !slide.layers?.background?.containsProductHero && !slide.layers?.background?.containsKeyData
      }
    };
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
    completed.push({ id, slide: slideIndex, path: outputPath, visualTargetImage, textObjects: payload.qa.textObjects, shapeObjects: payload.qa.shapeObjects, imageObjects: payload.qa.imageObjects });
  }
  const manifest = {
    version: 1,
    status: completed.length === slides.length ? "recorded" : "partial",
    parent_job_id: job.id || "",
    policy: "Parent agent owns final merge and QA; workers cannot modify outline, deck_spec, style_system, or assetManifest.",
    completedCount: completed.length,
    blockers: [],
    slides: completed,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(project.slideSceneGraphManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await ensureVisualProjectForJob(job);
  job.visualProject = {
    ...(job.visualProject || {}),
    editableWorker: manifest
  };
  return manifest;
}

function mergeVisualProject(nextProject, previous = null) {
  if (!previous) return nextProject;
  return {
    ...nextProject,
    history: [...(previous.history || []), {
      status: previous.status,
      updatedAt: previous.updatedAt,
      generatedImages: previous.generatedImages || 0
    }].slice(-6)
  };
}

function buildStyleSystem(job = {}) {
  const routePlan = job.input?.routePlan || {};
  const target = job.visualTarget || {};
  const palette = target.palette || {};
  return {
    version: 1,
    name: routePlan.recommendedTheme || job.input?.style || "asset-first hybrid proposal",
    deckType: routePlan.deckType || "presentation",
    colors: {
      background: palette.bg || "F7F8FC",
      paper: palette.paper || "FFFFFF",
      accent: palette.accent || "2D5BD7",
      ink: palette.ink || "172033",
      muted: palette.muted || "647087"
    },
    typography: "native editable Chinese text boxes; strong title hierarchy; concise body",
    backgroundStyle: "main visual may carry atmosphere only; no key text, logo, price, chart, or product hero in background",
    shapeLanguage: "editable cards, lines, labels, dividers, and independent image objects",
    density: target.density || "balanced",
    imageTreatment: target.imagePolicy?.priority === "high" ? "image-led layouts with independent assets" : "structured editable layout"
  };
}

function buildOutlineMarkdown(job = {}, styleSystem = {}) {
  const deck = job.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const lines = [
    `# ${cleanText(deck.title || "Visual Project Outline")}`,
    "",
    `- Deck type: ${styleSystem.deckType}`,
    `- Style system: ${styleSystem.name}`,
    "- Output note: visual-target.pptx is an intermediate full-slide-image target; editable-final.pptx remains the final delivery.",
    ""
  ];
  slides.forEach((slide, index) => {
    lines.push(`## Slide ${index + 1}: ${cleanText(slide.title || `Slide ${index + 1}`)}`);
    lines.push(`- Role: ${slide.layout || "section"}`);
    lines.push(`- Intent: ${cleanText(slide.visualIntent || slide.subtitle || "")}`);
    const points = [...toList(slide.bullets), ...toList(slide.dataPoints)].slice(0, 5);
    if (points.length) lines.push(`- Key points: ${points.join(" / ")}`);
    const slots = toList(slide.imageSlots);
    if (slots.length) lines.push(`- Required images: ${slots.join(" / ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

function buildDeckSpec(job = {}, styleSystem = {}) {
  const deck = job.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const sample = job.visualTarget?.sample || {};
  const manifest = job.assetManifest || {};
  return {
    version: 1,
    deck_name: safeName(deck.title || job.id || "visual-target"),
    slide_count: slides.length,
    output_contract: {
      visual_target_pptx: "full-slide-image intermediate; not editable",
      editable_final_pptx: "SceneGraph-rendered final delivery",
      fact_source: "assetManifest/materialBrief/userInput"
    },
    asset_manifest: {
      status: manifest.status || "missing",
      asset_count: manifest.assets?.length || 0,
      critical_count: manifest.criticalCount || 0,
      background_blocked_count: manifest.backgroundBlockedCount || 0,
      source_refs: manifest.source_refs || []
    },
    style_system: styleSystem,
    sample_slide: sample.imagePath ? "deck_sample" : "",
    sample_generation_method: sample.imagePath ? {
      backend_used: sample.provider || "local/cloud image",
      tool_name: "local-image-or-cloud-image",
      mode: "generate",
      approved_sample_path: sample.imagePath,
      handoff_rule: "Slide workers must use the same style system and must not paste visual targets into final editable PPTX."
    } : null,
    slides: slides.map((slide, index) => ({
      slide: index + 1,
      id: slideId(index),
      title: cleanText(slide.title || `Slide ${index + 1}`),
      key_points: [...toList(slide.bullets), ...toList(slide.dataPoints)].slice(0, 5),
      role: slide.layout || "section",
      composition: slide.visualIntent || "choose layout by page role; keep style identity but vary composition",
      source_reference: "",
      required_assets: toList(slide.imageSlots)
    }))
  };
}

function buildPromptJobs(job = {}, deckSpec = {}) {
  const assetManifest = job.assetManifest || {};
  const visualTarget = job.visualTarget || {};
  const slides = deckSpec.slides || [];
  return {
    version: 1,
    status: slides.length ? "prepared" : "empty",
    selected_backend: "cloud-image-first-local-fallback",
    parent_job_id: job.id || "",
    worker_constraints: [
      "Generate one 16:9 full-slide visual target image with the selected image backend.",
      "Use supplied assets as references but do not invent factual content.",
      "Do not create visual targets with local drawing, HTML screenshots, SVG, canvas, Pillow, PptxGenJS, or manual compositing.",
      "Do not modify outline, deck_spec, style_system, or asset_manifest.",
      "Visual target is not the final editable PPT background."
    ],
    slides: slides.map((slide, index) => {
      const id = slide.id || slideId(index);
      const slideAssets = assetsForPromptSlide(assetManifest, slide, index).slice(0, 16);
      return {
        id,
        slide: index + 1,
        status: "pending",
        out: `origin_image/${id}.png`,
        prompt_file: `prompts/${id}.json`,
        title: slide.title,
        role: slide.role,
        visual_quality_gate: "must reach codex-ppt casebook / premium editorial level before editable reconstruction",
        prompt: buildSlidePrompt({ slide, deckSpec, slideAssets, visualTarget }),
        input_images: slideAssets.filter((asset) => asset.path && asset.editableRole !== "textBox").map((asset) => ({
          id: asset.id,
          path: asset.path,
          role: asset.kind,
          fidelity: asset.priority === "must_keep" ? "strict input asset; preserve identity" : "style/content reference"
        })),
        asset_rules: {
          forbidden_in_background: slideAssets.filter((asset) => asset.canEnterBackground === false).map((asset) => asset.id),
          editable_text_source: "deck_spec + asset_manifest text assets"
        }
      };
    })
  };
}

function buildSlidePrompt({ slide = {}, deckSpec = {}, slideAssets = [], visualTarget = {} } = {}) {
  const role = slide.role || "section";
  const keyPoints = (slide.key_points || []).slice(0, 4);
  const imageHeavy = ["cover", "case", "gallery", "product-detail", "bundle", "visual"].includes(role) || slideAssets.some((asset) => ["product", "chart"].includes(asset.kind));
  const imageArea = imageHeavy ? "45-65%" : role === "matrix" ? "25-40%" : "15-30%";
  const payload = {
    type: "16:9 full-slide PowerPoint visual target image",
    language: "Chinese deck, but avoid rendering long readable text in the image because final PPT text will be editable",
    canvas: {
      aspect_ratio: "16:9",
      use_full_canvas: true,
      slide_number: "do not render a slide number"
    },
    style: {
      name: deckSpec.style_system?.name || "premium proposal casebook",
      visual_direction: [
        "codex-ppt quality",
        "premium editorial casebook / proposal portfolio",
        "large confident imagery",
        "crafted background atmosphere",
        "strong title safe area",
        "not a generic office template"
      ].join("; "),
      color_palette: deckSpec.style_system?.colors || {},
      typography: "reserve clear native text zones with strong hierarchy; do not make tiny dense body text inside the image",
      texture_and_finish: "premium printed casebook, refined product catalog, art-directed presentation visual",
      deck_consistency: "same palette, typography mood, spacing, icon/decor language across the deck while varying page composition"
    },
    layout: {
      role,
      intent: slide.composition || "choose layout by page role",
      composition: compositionInstructionForRole(role, imageArea),
      image_area_target: imageArea,
      content_zones: "dominant visual zone, title/body safe zones, small supporting accents; avoid uniform card templates",
      variation_rule: "same visual identity, but do not repeat the same card layout on adjacent slides",
      relationship_to_previous_slide: "new composition unless this slide is part of a deliberate repeated sequence",
      spacing: "clear hierarchy, no overlaps, no clutter"
    },
    text: {
      title: slide.title || "",
      key_points: keyPoints,
      text_quality: "If any Chinese text is rendered, it must be short, readable, and exact; prefer abstract text blocks for long content."
    },
    source_assets: slideAssets.filter((asset) => asset.path && asset.editableRole !== "textBox").map((asset) => ({
      id: asset.id,
      path: asset.path,
      kind: asset.kind,
      source_slide: asset.sourceSlide || null,
      usage: asset.priority === "must_keep" ? "strict input asset; preserve identity and keep it visually important" : "style/supporting reference",
      fidelity: asset.priority === "must_keep" ? "do not replace with a similar invented object" : "can influence atmosphere"
    })),
    visual_elements: {
      main_visual: imageHeavy
        ? "Create a new art-directed hero scene/visual target using the page-bound product/customer/chart assets as strict references; the main visual must dominate the slide."
        : "Create a high-quality editorial composition with meaningful visual hierarchy, not plain text boxes.",
      supporting_elements: "native-editable later: accent bars, shapes, callouts, labels, dividers; visual target may suggest them but not rely on screenshots"
    },
    constraints: [
      "This visual target must reach codex-ppt generated-image quality before SceneGraph reconstruction.",
      "Use the selected cloud image model or approved image backend; do not simulate the slide with local drawing or PPT layout.",
      "Do not use a generic blue-white business template, repeated tiny cards, weak title strip, or placeholder stock layout.",
      "Critical facts, logos, product identities, charts, prices, and long text must remain rebuildable as editable PPT objects later.",
      "Visual target is not the final editable PPT background.",
      "If page-bound assets are provided, keep them large and recognizable; do not shrink key images into small thumbnails.",
      "No watermark, no unrelated logo, no fake slide number."
    ],
    visual_target_sample: visualTarget.sample?.imagePath || null
  };
  return JSON.stringify(payload, null, 2);
}

function assetsForPromptSlide(assetManifest = {}, slide = {}, index = 0) {
  const assets = Array.isArray(assetManifest.assets) ? assetManifest.assets : [];
  const binding = (assetManifest.slideBindings || []).find((item) => Number(item.slide || 0) === index + 1) || {};
  const bindingIds = new Set([...(binding.assetIds || []), ...(binding.criticalImageIds || []), ...(binding.visualAssetIds || [])]);
  const slots = toList(slide.required_assets || slide.imageSlots).map((item) => String(item || "").toLowerCase());
  return assets.filter((asset) => {
    if (bindingIds.has(asset.id)) return true;
    if (!asset.sourceSlide && ["logo", "icon"].includes(asset.kind)) return true;
    if (Number(asset.sourceSlide || 0)) return false;
    if (["product", "chart"].includes(asset.kind)) {
      const name = String(asset.name || asset.id || "").toLowerCase();
      return slots.some((slot) => name.includes(slot) || slot.includes(name));
    }
    return asset.kind === "text" && Number(asset.sourceSlide || 0) === index + 1;
  });
}

function compositionInstructionForRole(role = "", imageArea = "45-65%") {
  if (role === "cover") return `cover/editorial opener: one dominant hero scene or product stage occupies ${imageArea}; title safe area is bold and uncluttered`;
  if (role === "case") return `case-study spread: source/product/customer image is the protagonist, ${imageArea} of canvas; concise text zones support credibility`;
  if (role === "gallery") return `portfolio/gallery spread: large product collage or visual wall, ${imageArea} of canvas; varied scale and art-directed grouping`;
  if (role === "matrix") return `premium matrix: structured but visual, avoid spreadsheet look; keep any key image at ${imageArea} if present`;
  if (role === "closing") return "closing page: memorable visual finish, calm whitespace, brand-safe editable text zone";
  return `editorial section page: strong visual hierarchy and refined atmosphere; visual zone around ${imageArea} if assets exist`;
}

function buildRunState(job = {}, promptJobs = {}) {
  return {
    version: 1,
    parent_job_id: job.id || "",
    status: promptJobs.slides?.length ? "prepared" : "empty",
    max_concurrent_slides: 4,
    updatedAt: new Date().toISOString(),
    slides: (promptJobs.slides || []).map((slide) => ({
      id: slide.id,
      status: slide.status,
      prompt_file: slide.prompt_file,
      out: slide.out,
      worker: null,
      result: null,
      blocker: null
    }))
  };
}

function discoverOriginImages(originImageDir) {
  if (!fsSync.existsSync(originImageDir)) return [];
  return fsSync.readdirSync(originImageDir)
    .filter((name) => /^slide_\d+\.(png|jpe?g|webp)$/i.test(name))
    .sort()
    .map((name) => path.join(originImageDir, name));
}

function discoverSlideSceneGraphs(sceneGraphDir) {
  if (!fsSync.existsSync(sceneGraphDir)) return [];
  return fsSync.readdirSync(sceneGraphDir)
    .filter((name) => /^slide_\d+\.json$/i.test(name))
    .sort()
    .map((name) => path.join(sceneGraphDir, name));
}

async function buildVisualTargetPptx({ projectDir, deckName, imagePaths }) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "PPT Design Tool";
  pptx.subject = "Visual target intermediate; not editable";
  pptx.title = deckName;
  for (const imagePath of imagePaths) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ path: imagePath, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H });
    slide.addNotes("Visual target only. This full-slide image PPTX is not the final editable delivery.");
  }
  const outputPath = path.join(projectDir, `${deckName}.pptx`);
  await pptx.writeFile({ fileName: outputPath });
  return outputPath;
}

async function writeContactSheet(projectDir, imagePaths = [], slides = []) {
  const manifestPath = path.join(projectDir, "redesign_contact_sheet.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    note: "PNG contact sheet summarizes generated visual targets; thumbnail rendering can be upgraded later without API changes.",
    imageCount: imagePaths.length,
    images: imagePaths.map((imagePath, index) => ({
      slide: index + 1,
      title: cleanText(slides[index]?.title || ""),
      path: imagePath
    }))
  }, null, 2), "utf8");
  const outputPath = path.join(projectDir, "redesign_contact_sheet.png");
  await fs.writeFile(outputPath, await buildContactSheetPng(imagePaths, slides));
  return outputPath;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function buildContactSheetPng(imagePaths = [], slides = []) {
  const width = 1200;
  const height = 675;
  const columns = 5;
  const rows = Math.max(1, Math.ceil(Math.max(imagePaths.length, slides.length, 1) / columns));
  const tileW = Math.floor(width / columns);
  const tileH = Math.floor(height / Math.min(rows, 3));
  const data = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    data[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      data[offset] = 248;
      data[offset + 1] = 250;
      data[offset + 2] = 252;
      data[offset + 3] = 255;
    }
  }
  const count = Math.max(imagePaths.length, slides.length, 1);
  for (let index = 0; index < count; index += 1) {
    const col = index % columns;
    const row = Math.floor(index / columns) % 3;
    const x = col * tileW + 18;
    const y = row * tileH + 18;
    const w = tileW - 36;
    const h = tileH - 36;
    const color = imagePaths[index] ? hashColor(imagePaths[index]) : [226, 232, 240];
    fillRect(data, width, height, x, y, w, h, color);
    fillRect(data, width, height, x, y, w, 8, [45, 91, 215]);
    const thumb = imagePaths[index] ? await readPngRgba(imagePaths[index]).catch(() => null) : null;
    if (thumb) {
      drawImageContain(data, width, height, thumb, x + 8, y + 14, w - 16, h - 24);
    }
    if (!imagePaths[index]) fillRect(data, width, height, x + 10, y + 28, w - 20, Math.max(8, h - 56), [241, 245, 249]);
  }
  return encodePng(width, height, data);
}

async function readPngRgba(filePath) {
  const buffer = await fs.readFile(filePath);
  return decodePngRgba(buffer);
}

function decodePngRgba(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error(`unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(width * height * channels);
  let sourceOffset = 0;
  let targetOffset = 0;
  const prev = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset++];
    inflated.copy(current, 0, sourceOffset, sourceOffset + stride);
    sourceOffset += stride;
    unfilterScanline(current, prev, filter, channels);
    current.copy(raw, targetOffset);
    current.copy(prev, 0);
    targetOffset += stride;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = channels === 4 ? raw[i + 3] : 255;
  }
  return { width, height, data: rgba };
}

function unfilterScanline(line, prev, filter, channels) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= channels ? line[i - channels] : 0;
    const up = prev[i] || 0;
    const upLeft = i >= channels ? prev[i - channels] || 0 : 0;
    if (filter === 1) line[i] = (line[i] + left) & 255;
    else if (filter === 2) line[i] = (line[i] + up) & 255;
    else if (filter === 3) line[i] = (line[i] + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) line[i] = (line[i] + paethPredictor(left, up, upLeft)) & 255;
    else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function drawImageContain(canvas, canvasW, canvasH, image, x, y, w, h) {
  const scale = Math.min(w / image.width, h / image.height);
  const drawW = Math.max(1, Math.floor(image.width * scale));
  const drawH = Math.max(1, Math.floor(image.height * scale));
  const startX = Math.floor(x + (w - drawW) / 2);
  const startY = Math.floor(y + (h - drawH) / 2);
  for (let yy = 0; yy < drawH; yy += 1) {
    const srcY = Math.min(image.height - 1, Math.floor(yy / scale));
    const dstY = startY + yy;
    if (dstY < 0 || dstY >= canvasH) continue;
    const rowStart = dstY * (canvasW * 4 + 1);
    for (let xx = 0; xx < drawW; xx += 1) {
      const srcX = Math.min(image.width - 1, Math.floor(xx / scale));
      const dstX = startX + xx;
      if (dstX < 0 || dstX >= canvasW) continue;
      const src = (srcY * image.width + srcX) * 4;
      const dst = rowStart + 1 + dstX * 4;
      const alpha = image.data[src + 3] / 255;
      canvas[dst] = Math.round(image.data[src] * alpha + canvas[dst] * (1 - alpha));
      canvas[dst + 1] = Math.round(image.data[src + 1] * alpha + canvas[dst + 1] * (1 - alpha));
      canvas[dst + 2] = Math.round(image.data[src + 2] * alpha + canvas[dst + 2] * (1 - alpha));
      canvas[dst + 3] = 255;
    }
  }
}

function fillRect(data, width, height, x, y, w, h, color) {
  const [r, g, b] = color;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.floor(x + w));
  const y1 = Math.min(height, Math.floor(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    const rowStart = yy * (width * 4 + 1);
    for (let xx = x0; xx < x1; xx += 1) {
      const offset = rowStart + 1 + xx * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
}

function hashColor(value = "") {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return [180 + (hash % 48), 195 + ((hash >> 8) % 42), 215 + ((hash >> 16) % 36)];
}

function encodePng(width, height, rawData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(rawData)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
