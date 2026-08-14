async (page) => {
  const baseUrl = "http://127.0.0.1:4180/";
  const jobId = "workflow_20260804-094558Z_162643";
  const readyJobId = page.url().match(/[?&]readyJobId=([^&]+)/)?.[1] || "";
  if (!readyJobId) throw new Error("Strict UI E2E requires a synthetic readyJobId bootstrap parameter.");
  const outputRoot = "E:/PPT工具/workspace/delivery-evidence/strict-ui-e2e";
  const runtimeErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) runtimeErrors.push({ type: message.type(), text: message.text() });
  });
  page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || "request failed" }));

  await page.goto(`${baseUrl}?strict-e2e=${Date.now()}`, { waitUntil: "networkidle" });
  await page.locator('section[class*="workspace"]').waitFor({ state: "visible", timeout: 20000 });
  const browserVersion = page.context().browser()?.version() || "unknown";

  const jobResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${jobId}`);
  if (!jobResponse.ok()) throw new Error(`Evidence job ${jobId} is unavailable: HTTP ${jobResponse.status()}`);
  const job = await jobResponse.json();
  const jobTitle = (job.input?.sourceOriginalName || "").replace(/\.[^.]+$/, "")
    || job.input?.projectName
    || job.sourceName
    || "";
  if (!jobTitle) throw new Error(`Evidence job ${jobId} has no user-visible title.`);
  const search = page.locator('[class*="searchBox"] input');
  await search.fill(jobTitle);
  const filteredTaskCount = await page.locator('button[class*="taskRowMain"]').count();
  const matchingTask = page.locator('button[class*="taskRowMain"]').first();
  await matchingTask.waitFor({ state: "visible", timeout: 10000 });
  await matchingTask.click();
  await page.waitForTimeout(150);
  await page.waitForFunction((button) => !button.disabled, await matchingTask.elementHandle(), { timeout: 20000 });
  const selectedTaskTitleVisible = await page.locator("h1").filter({ hasText: jobTitle }).count() === 1;

  const newTaskButton = page.locator('button[class*="newTaskButton"]');
  let releaseOutlineResponse = null;
  const outlineRequestStarted = new Promise((resolve) => {
    page.route("**/api/workflow-outline/plan", async (route) => {
      resolve();
      await new Promise((release) => { releaseOutlineResponse = release; });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          outlinePlan: {
            title: "严格 E2E 大纲",
            layoutSequence: [
              { layout: "cover", title: "严格 E2E 封面", purpose: "验证新建任务主流程" },
              { layout: "closing", title: "结束页", purpose: "验证结构完整性" }
            ]
          },
          materialBrief: { inputStrength: "brief", productCount: 0, priceCount: 0, imageCount: 0 }
        })
      });
    }, { times: 1 });
  });
  await newTaskButton.click();
  const createPanel = page.locator('div[class*="createWorkspace"]');
  await createPanel.waitFor({ state: "visible" });
  const newTaskPanelOpens = await createPanel.isVisible();
  const createBrief = createPanel.locator("textarea");
  await createBrief.fill("验证新建任务大纲与输入锁定，不调用外部模型。");
  await createPanel.locator('div[class*="createSubmit"] button').click();
  await outlineRequestStarted;
  const outlineRequestLocksInputs = await createBrief.isDisabled()
    && await createPanel.locator('input[type="file"]').isDisabled();
  const taskSidebarRemainsNavigableWhilePlanning = !(await matchingTask.isDisabled());
  releaseOutlineResponse();
  await createPanel.locator('section[aria-label="大纲摘要"]').waitFor({ state: "visible", timeout: 10000 });
  const outlineResultStaysInWorkspace = await createPanel.isVisible();
  const compactOutlineSummaryVisible = await createPanel.getByText("大纲已生成", { exact: true }).isVisible();
  await matchingTask.click();
  await page.waitForTimeout(150);
  await page.waitForFunction((button) => !button.disabled, await matchingTask.elementHandle(), { timeout: 20000 });
  await createPanel.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  const existingTaskClosesNewTaskPanel = !(await createPanel.isVisible().catch(() => false));

  await page.setViewportSize({ width: 1600, height: 1000 });
  const visualButton = page.getByRole("button", { name: "图片版", exact: true });
  await visualButton.click();
  const visualThumbnails = page.locator('button[class*="thumbnail"]');
  const visualPageCount = await visualThumbnails.count();
  const routeBHistoricalDraftVisible = await page.getByText(/历史草稿/).evaluateAll((nodes) => nodes.some((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().width > 0;
  }));
  const routeBReviewLockVisible = await page.getByText(/图片版复核完成前暂停可编辑重建|图片复核完成后开放|等待图片复核/).evaluateAll((nodes) => nodes.some((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().width > 0;
  }));
  await page.screenshot({ path: `${outputRoot}/workspace-desktop-latest.png`, fullPage: true });

  const reviewButton = page.locator('button[class*="reviewButton"]');
  await reviewButton.click();
  const imageReviewDialog = page.getByRole("dialog");
  await imageReviewDialog.waitFor({ state: "visible", timeout: 120000 });
  const imageReviewImages = await imageReviewDialog.locator("img").count();
  const imageReviewImagesLoaded = await imageReviewDialog.locator("img").evaluateAll((images) => images.filter((image) => image.complete && image.naturalWidth > 0).length);
  const imageReviewConfirmButtons = await imageReviewDialog.getByRole("button", { name: /通过本页|确认内容无误|确认正常变化/ }).count();
  const imageReviewRerunButtons = await imageReviewDialog.getByRole("button", { name: /标记重做/ }).count();
  const imageReviewRiskFilterVisible = await imageReviewDialog.getByRole("button", { name: /风险页/ }).isVisible();
  const imageReviewPendingFilterVisible = await imageReviewDialog.getByRole("button", { name: /待复核/ }).isVisible();
  const reviewFilterButtons = imageReviewDialog.locator(".image-deck-review-filters button");
  const reviewAllFilter = reviewFilterButtons.nth(0);
  const reviewRiskFilter = reviewFilterButtons.nth(1);
  const reviewPendingFilter = reviewFilterButtons.nth(2);
  const filterCount = (value) => Number(String(value || "").match(/\d+/)?.[0] || 0);
  const imageReviewAllFilterDeclaredCount = filterCount(await reviewAllFilter.textContent());
  const imageReviewRiskFilterDeclaredCount = filterCount(await reviewRiskFilter.textContent());
  const imageReviewPendingFilterDeclaredCount = filterCount(await reviewPendingFilter.textContent());
  await reviewRiskFilter.click();
  await page.waitForTimeout(80);
  const imageReviewRiskFilteredRows = await imageReviewDialog.locator("article.image-deck-review-row").count();
  const imageReviewRiskFilterWorks = imageReviewRiskFilterDeclaredCount > 0
    && imageReviewRiskFilteredRows === imageReviewRiskFilterDeclaredCount;
  await reviewPendingFilter.click();
  await page.waitForTimeout(80);
  const imageReviewPendingFilteredRows = await imageReviewDialog.locator("article.image-deck-review-row").count();
  const imageReviewPendingFilterWorks = imageReviewPendingFilteredRows === imageReviewPendingFilterDeclaredCount;
  await reviewAllFilter.click();
  await page.waitForTimeout(80);
  const imageReviewAllFilteredRows = await imageReviewDialog.locator("article.image-deck-review-row").count();
  const imageReviewAllFilterRestoresRows = imageReviewAllFilteredRows === imageReviewAllFilterDeclaredCount;
  const imageReviewStaleEvidenceMessageVisible = await imageReviewDialog.getByText(/质检证据已经更新.*旧复核记录已失效/).evaluateAll((nodes) => nodes.some((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().width > 0;
  }));
  const imageReviewConcreteDiffCount = await imageReviewDialog.locator(".image-deck-semantic-diff span").count();
  const imageReviewConcreteDiffTexts = await imageReviewDialog.locator(".image-deck-semantic-diff span").allTextContents();
  const imageReviewTruncatedDiffsAbsent = !imageReviewConcreteDiffTexts.some((text) => (
    /(?:^|[\s：、])[A-Za-z0-9]{2,}[-–—](?:$|[\s、])/.test(String(text || ""))
  ));
  const imageReviewSemanticConfirmations = await imageReviewDialog.getByLabel(/逐字核对原稿/).count();
  const imageReviewStyleConfirmations = await imageReviewDialog.getByLabel(/单独核对风格差异/).count();
  const imageReviewRiskAcceptButtons = imageReviewDialog.getByRole("button", { name: "确认并通过本页", exact: true });
  const imageReviewRiskAcceptButtonCount = await imageReviewRiskAcceptButtons.count();
  const imageReviewRiskAcceptButtonsDisabled = await imageReviewRiskAcceptButtons.evaluateAll((buttons) => buttons.filter((button) => button.disabled).length);
  const imageReviewSubmit = imageReviewDialog.locator('footer[class*="image-deck-review-actions"] button.primary').last();
  const imageReviewSubmitDisabledUntilReviewed = await imageReviewSubmit.isDisabled();
  await page.screenshot({ path: `${outputRoot}/image-review-latest.png`, fullPage: true });
  await imageReviewDialog.getByRole("button", { name: /关闭/ }).first().click();
  await imageReviewDialog.waitFor({ state: "detached", timeout: 5000 });

  const editableButton = page.getByRole("button", { name: "可编辑版", exact: true });
  const editableAvailable = !(await editableButton.isDisabled());
  if (editableAvailable) {
    await editableButton.click();
    await page.locator('button[class*="reviewButton"]').filter({ hasText: "复核可编辑版" }).waitFor({ state: "visible", timeout: 10000 });
  }
  const editablePageCount = await page.locator('button[class*="thumbnail"]').count();
  let editableReviewPassButtons = 0;
  let editableReviewPassButtonsDisabled = 0;
  if (editableAvailable) {
    await page.locator('button[class*="reviewButton"]').click();
    const editableDialog = page.getByRole("dialog");
    await editableDialog.waitFor({ state: "visible", timeout: 20000 });
    const passButtons = editableDialog.getByRole("button", { name: "通过", exact: true });
    editableReviewPassButtons = await passButtons.count();
    editableReviewPassButtonsDisabled = await passButtons.evaluateAll((buttons) => buttons.filter((button) => button.disabled).length);
    await editableDialog.getByRole("button", { name: /关闭/ }).first().click();
    await editableDialog.waitFor({ state: "detached", timeout: 5000 });
  }

  const editableDeliverable = page.locator('[class*="deliverable"]').filter({ hasText: "可编辑 PPT" });
  const finalDownloadExposed = await editableDeliverable.locator("a").count() > 0;
  const deliveryResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${jobId}/delivery-status`);
  const delivery = await deliveryResponse.json();
  const deliveryProductReady = delivery?.finalGate?.productReady === true;
  const deliveryDownloadable = delivery?.finalGate?.downloadable === true;
  const liveDeliveryBlocked = deliveryResponse.ok()
    && delivery?.status?.level === "blocked"
    && !deliveryProductReady
    && !deliveryDownloadable;
  const deliveryBlockedUiVisible = routeBReviewLockVisible || await page.getByText(/交付被阻断|等待图片复核|图片版有\s*\d+\s*页存在自动内容风险/).evaluateAll((nodes) => nodes.some((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().width > 0;
  }));
  const blockedFinalDownloadResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${jobId}/artifacts/final-pptx?download=1`);
  const blockedFinalDownloadStatus = blockedFinalDownloadResponse.status();
  const blockedFinalDownloadRejected = blockedFinalDownloadStatus === 409;

  const backToWorkbench = page.getByRole("button", { name: "回到工作台", exact: true });
  await backToWorkbench.click();
  await page.locator('[data-ui-version="2"]').waitFor({ state: "visible", timeout: 10000 });
  const editableReviewReturnsToWorkspace = await page.locator('[class*="searchBox"] input').isVisible();

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(100);
  const medium1200DocumentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const medium1200InspectorVisible = await page.locator('aside[class*="inspector"]').isVisible();
  await page.setViewportSize({ width: 1181, height: 900 });
  await page.waitForTimeout(100);
  const medium1181DocumentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const medium1181InspectorVisible = await page.locator('aside[class*="inspector"]').isVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileDocumentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  await page.screenshot({ path: `${outputRoot}/workspace-mobile-latest.png`, fullPage: true });

  await page.setViewportSize({ width: 1600, height: 1000 });
  const readyJobResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${readyJobId}`);
  if (!readyJobResponse.ok()) throw new Error(`Ready fixture ${readyJobId} is unavailable: HTTP ${readyJobResponse.status()}`);
  const readyJob = await readyJobResponse.json();
  const readySearch = page.locator('[class*="searchBox"] input');
  const readyTitle = (readyJob.input?.sourceOriginalName || "").replace(/\.[^.]+$/, "")
    || readyJob.input?.projectName
    || readyJob.sourceName
    || "严格 E2E 成功态验证（合成）";
  await readySearch.fill(readyTitle);
  const readyTask = page.locator('button[class*="taskRowMain"]').first();
  await readyTask.waitFor({ state: "visible", timeout: 10000 });
  await readyTask.click();
  const readyHeading = page.locator("h1").filter({ hasText: readyTitle });
  await readyHeading.waitFor({ state: "visible", timeout: 20000 });
  const readyWorkflowVisible = await readyHeading.count() === 1;
  const readyDeliveryResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${readyJobId}/delivery-status`);
  const readyDelivery = await readyDeliveryResponse.json();
  const readyDeliveryProductReady = readyDelivery?.finalGate?.productReady === true;
  const readyDeliveryDownloadable = readyDelivery?.finalGate?.downloadable === true;
  const readyEditableDeliverable = page.locator('[class*="deliverable"]').filter({ hasText: "可编辑 PPT" });
  const readyFinalDownload = readyEditableDeliverable.locator("a").first();
  await readyFinalDownload.waitFor({ state: "visible", timeout: 20000 });
  const readyFinalDownloadExposed = await readyFinalDownload.count() === 1 && await readyFinalDownload.isVisible();
  const readyCompletedGuidanceVisible = await page.getByText("可编辑 PPT 已通过交付门禁，可直接下载。", { exact: true }).isVisible();
  const readyStaleGenerationActionAbsent = await page.getByRole("button", { name: /准备.*样张|生成.*样张|先完成图片版/ }).count() === 0;
  const readyCompletedStageCount = await page.locator('aside[class*="inspector"] [class*="doneStage"]').count();
  const readyCompleteFilter = page.locator('div[class*="taskFilters"] button').filter({ hasText: "已完成" });
  const readyTaskCountedComplete = Number(await readyCompleteFilter.locator("em").textContent()) >= 1;
  let readyFinalDownloadClicked = false;
  if (readyFinalDownloadExposed) {
    const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
    await readyFinalDownload.click();
    const download = await downloadPromise;
    readyFinalDownloadClicked = Boolean(download.suggestedFilename());
  }
  const readyFinalDownloadResponse = await page.request.get(`${baseUrl}api/workflow-jobs/${readyJobId}/artifacts/final-pptx?download=1`);
  const readyFinalDownloadStatus = readyFinalDownloadResponse.status();
  const readyFinalDownloadAccepted = readyFinalDownloadStatus === 200;
  await page.screenshot({ path: `${outputRoot}/workspace-ready-latest.png`, fullPage: true });
  const expectedDownloadAborts = failedRequests.filter((request) => (
    readyFinalDownloadClicked
    && request.url.includes(`/api/workflow-jobs/${readyJobId}/artifacts/final-pptx`)
    && request.error === "net::ERR_ABORTED"
  ));
  const unexpectedFailedRequests = failedRequests.filter((request) => !expectedDownloadAborts.includes(request));
  const loadedAssets = await page.evaluate(() => Array.from(new Set([
    ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ...Array.from(document.querySelectorAll('script[src],link[rel="stylesheet"][href]')).map((element) => element.src || element.href)
  ])));

  return {
    version: 3,
    capturedAt: new Date().toISOString(),
    baseUrl,
    jobId,
    readyJobId,
    browser: { name: "Chromium via @playwright/cli", version: browserVersion },
    loadedAssets,
    workflow: {
      sourcePages: Number(job.artifacts?.renderedPages?.length || 0),
      visualPages: Number(job.artifacts?.visualImages?.length || 0),
      editablePages: Number((job.artifacts?.editableWorkerTasks || []).filter((task) => task.status === "recorded").length),
      closureStatus: deliveryProductReady && deliveryDownloadable ? "ready" : "blocked",
      readyFixture: {
        sourcePages: Number(readyJob.artifacts?.renderedPages?.length || 0),
        visualPages: Number(readyJob.artifacts?.visualImages?.length || 0),
        editablePages: Number((readyJob.artifacts?.editableWorkerTasks || []).filter((task) => task.status === "recorded").length),
        closureStatus: readyDeliveryProductReady && readyDeliveryDownloadable ? "ready" : "blocked"
      }
    },
    checks: {
      taskCount: filteredTaskCount,
      taskSearchFiltersRows: filteredTaskCount === 1 && selectedTaskTitleVisible,
      newTaskPanelOpens,
      outlineRequestLocksInputs,
      taskSidebarRemainsNavigableWhilePlanning,
      outlineResultStaysInWorkspace,
      compactOutlineSummaryVisible,
      existingTaskClosesNewTaskPanel,
      visualModeShowsTwentyPages: visualPageCount === 20,
      editableModeShowsTwentyPagePlan: editablePageCount === 20,
      imageReviewDialogOpens: true,
      imageReviewImages,
      imageReviewImagesLoaded,
      imageReviewConfirmButtons,
      imageReviewRerunButtons,
      imageReviewRiskFilterVisible,
      imageReviewPendingFilterVisible,
      imageReviewAllFilterDeclaredCount,
      imageReviewRiskFilterDeclaredCount,
      imageReviewPendingFilterDeclaredCount,
      imageReviewAllFilteredRows,
      imageReviewRiskFilteredRows,
      imageReviewPendingFilteredRows,
      imageReviewRiskFilterWorks,
      imageReviewPendingFilterWorks,
      imageReviewAllFilterRestoresRows,
      imageReviewStaleEvidenceMessageVisible,
      imageReviewConcreteDiffCount,
      imageReviewTruncatedDiffsAbsent,
      imageReviewSemanticConfirmations,
      imageReviewStyleConfirmations,
      imageReviewRiskAcceptButtonCount,
      imageReviewRiskAcceptButtonsDisabled,
      imageReviewSubmitDisabledUntilReviewed,
      expectedSemanticBlockedPages: Number(job.artifacts?.visualTextQuality?.summary?.blockedCount || 0),
      expectedStyleDriftPages: Number(job.artifacts?.visualQuality?.summary?.styleConsistency?.driftCount || 0),
      routeBHistoricalDraftVisible,
      routeBReviewLockVisible,
      editableReviewPassButtons,
      editableReviewPassButtonsDisabled,
      editableReviewReturnsToWorkspace,
      finalDownloadExposed,
      deliveryProductReady,
      deliveryDownloadable,
      deliveryBlockedMessageVisible: liveDeliveryBlocked && deliveryBlockedUiVisible,
      blockedFinalDownloadStatus,
      blockedFinalDownloadRejected,
      medium1200DocumentOverflow,
      medium1200InspectorVisible,
      medium1181DocumentOverflow,
      medium1181InspectorVisible,
      mobileViewport: "390x844",
      mobileDocumentOverflow,
      readyWorkflowVisible,
      readyDeliveryProductReady,
      readyDeliveryDownloadable,
      readyFinalDownloadExposed,
      readyCompletedGuidanceVisible,
      readyStaleGenerationActionAbsent,
      readyCompletedStageCount,
      readyTaskCountedComplete,
      readyFinalDownloadClicked,
      readyFinalDownloadStatus,
      readyFinalDownloadAccepted,
      expectedDownloadAborts: expectedDownloadAborts.length,
      consoleErrors: runtimeErrors.filter((entry) => entry.type === "error").length,
      consoleWarnings: runtimeErrors.filter((entry) => entry.type === "warning").length,
      failedNetworkRequests: unexpectedFailedRequests.length
    },
    runtimeErrors,
    failedRequests: unexpectedFailedRequests,
    expectedNetworkAborts: expectedDownloadAborts,
    screenshots: [
      "workspace/delivery-evidence/strict-ui-e2e/workspace-desktop-latest.png",
      "workspace/delivery-evidence/strict-ui-e2e/image-review-latest.png",
      "workspace/delivery-evidence/strict-ui-e2e/workspace-mobile-latest.png",
      "workspace/delivery-evidence/strict-ui-e2e/workspace-ready-latest.png"
    ]
  };
}
