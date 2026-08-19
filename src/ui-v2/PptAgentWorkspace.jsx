import React from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FolderOpen,
  Images,
  ListFilter,
  LoaderCircle,
  PanelRight,
  Plus,
  Presentation,
  Search,
  Settings2,
  Sparkles,
  Upload,
  X
} from "lucide-react";
import styles from "./PptAgentWorkspace.module.css";

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

function Action({ action, compact = false, primary = false }) {
  if (!action) return null;
  const className = cx(styles.action, primary && styles.primaryAction, compact && styles.compactAction);
  const content = (
    <>
      {action.href ? <Download size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
      <span>{action.label}</span>
    </>
  );
  return action.href ? (
    <a className={className} href={action.href}>{content}</a>
  ) : (
    <button className={className} type="button" onClick={action.onClick} disabled={action.disabled}>{content}</button>
  );
}

function TaskSidebar({ taskList, onCreate }) {
  return (
    <aside className={styles.taskSidebar} aria-label="PPT 任务">
      <div className={styles.sidebarBrand}>
        <span className={styles.brandMark}><Presentation size={17} aria-hidden="true" /></span>
        <div><b>任务</b><small>制作记录</small></div>
      </div>

      <button className={styles.newTaskButton} type="button" onClick={onCreate} disabled={taskList.busy} title="新建任务" aria-label="新建任务">
        <Plus size={16} aria-hidden="true" />
        <span>新建任务</span>
      </button>

      <div className={styles.taskTools}>
        <label className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索任务"
            value={taskList.search}
            onChange={(event) => taskList.onSearchChange(event.target.value)}
            placeholder="搜索文件或任务"
          />
        </label>
        <div className={styles.taskFilters} role="group" aria-label="任务状态筛选">
          {taskList.filters.map((filter) => (
            <button
              className={filter.id === taskList.selectedFilter ? styles.activeFilter : ""}
              type="button"
              aria-pressed={filter.id === taskList.selectedFilter}
              onClick={() => taskList.onFilterChange(filter.id)}
              key={filter.id}
            >
              <span>{filter.label}</span><em>{filter.count}</em>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.taskList}>
        <div className={styles.taskListLabel}><span>最近任务</span><ListFilter size={13} aria-hidden="true" /></div>
        {taskList.rows.length ? taskList.rows.map((task) => (
          <div className={cx(styles.taskRow, task.active && styles.activeTask)} key={task.id}>
            <button className={styles.taskRowMain} type="button" onClick={task.onSelect} disabled={taskList.busy}>
              <span className={styles.taskFileIcon}><Presentation size={15} aria-hidden="true" /></span>
              <span className={styles.taskCopy}>
                <b>{task.title}</b>
                <small>{task.summary}</small>
                <em>{task.status}</em>
              </span>
            </button>
            <button className={styles.archiveTask} type="button" onClick={task.onRemove} disabled={taskList.mutationBusy} title="移除任务" aria-label={`移除任务 ${task.title}`}>
              <Archive size={14} aria-hidden="true" />
            </button>
          </div>
        )) : (
          <div className={styles.emptyTasks}>
            <FolderOpen size={21} aria-hidden="true" />
            <span>{taskList.emptyMessage}</span>
          </div>
        )}
        {taskList.hasMore ? (
          <button className={styles.moreTasks} type="button" onClick={taskList.onToggleMore}>{taskList.moreLabel}</button>
        ) : null}
      </div>
    </aside>
  );
}

function WorkspaceHeader({ header, onCreate }) {
  const metaItems = [header.createdLabel, header.sourceLabel].filter(Boolean);
  return (
    <header className={styles.workspaceHeader}>
      <div className={styles.headerTitle}>
        <h1>{header.title}</h1>
        <div className={styles.headerMeta}>
          {metaItems.map((item) => <span key={item}>{item}</span>)}
        </div>
      </div>
      <div className={styles.headerActions}>
        <span className={cx(styles.jobStatus, styles[`${header.statusTone}Status`])}>
          <i aria-hidden="true" />{header.statusLabel}
        </span>
        <button className={styles.headerNewTask} type="button" onClick={onCreate} disabled={header.busy} title="新建任务" aria-label="新建任务">
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function SlideStudio({ preview }) {
  const currentIndex = Math.max(0, preview.images.findIndex((image) => image.id === preview.selectedPageId));
  const currentPage = preview.images[currentIndex] || null;
  const editableMode = preview.mode === "editable";
  const progressVerb = editableMode ? "重建" : "生成";
  const activeThumbnailRef = React.useRef(null);
  React.useEffect(() => {
    activeThumbnailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [preview.selectedPageId]);
  const selectAdjacent = (offset) => {
    const image = preview.images[currentIndex + offset];
    if (image) preview.onSelectPage(image.id);
  };
  return (
    <section className={styles.slideStudio} aria-label="PPT 页面预览">
      <header className={styles.previewToolbar}>
        <div className={styles.versionSwitch} role="group" aria-label="预览版本">
          <button type="button" className={preview.mode === "visual" ? styles.activeVersion : ""} aria-pressed={preview.mode === "visual"} onClick={() => preview.onModeChange("visual")}>图片版</button>
          <button type="button" className={preview.mode === "editable" ? styles.activeVersion : ""} aria-pressed={preview.mode === "editable"} onClick={() => preview.onModeChange("editable")} disabled={!preview.editableAvailable}>可编辑版</button>
        </div>
        <span className={styles.pageCounter}>{currentPage ? `${currentPage.pageNumber} / ${preview.totalPages || preview.images.length}` : "等待页面"}</span>
        <div className={styles.pageNavigation}>
          <button type="button" onClick={() => selectAdjacent(-1)} disabled={!preview.images.length || currentIndex === 0} title="上一页" aria-label="上一页"><ChevronLeft size={17} /></button>
          <button type="button" onClick={() => selectAdjacent(1)} disabled={!preview.images.length || currentIndex >= preview.images.length - 1} title="下一页" aria-label="下一页"><ChevronRight size={17} /></button>
        </div>
      </header>

      <div className={cx(styles.canvas, preview.loading && styles.loadingCanvas)}>
        {preview.href && !preview.failed ? (
          <img src={preview.href} alt={preview.mode === "editable" ? "当前页可编辑版预览" : "当前页图片版预览"} onLoad={preview.onImageLoad} onError={preview.onImageError} />
        ) : (
          <div className={styles.emptyCanvas}>
            <span>{currentPage?.status === "running" ? <LoaderCircle size={26} className={styles.spin} aria-hidden="true" /> : currentPage?.status === "failed" || preview.failed ? <CircleAlert size={26} aria-hidden="true" /> : <Images size={26} aria-hidden="true" />}</span>
            <b>{currentPage?.status === "running"
              ? `第 ${currentPage.pageNumber} 页正在${progressVerb}`
              : currentPage?.status === "failed" || preview.failed
                ? `第 ${currentPage?.pageNumber || ""} 页${progressVerb}失败`
                : currentPage
                  ? `第 ${currentPage.pageNumber} 页等待${progressVerb}`
                  : preview.emptyTitle || "页面将在这里生成"}</b>
            <small>{currentPage?.status === "failed"
              ? currentPage.error || "已完成页面不会受影响，可在右侧查看恢复建议"
              : currentPage?.status === "running"
                ? "完成后会立即显示在这里"
                : preview.failed
                  ? "切换页面或在右侧查看恢复建议"
                  : preview.emptyMessage || "创建任务后，Agent 会先生成一页视觉样张"}</small>
          </div>
        )}
        {preview.loading ? <span className={styles.loadingLabel}><LoaderCircle size={14} className={styles.spin} />正在加载页面</span> : null}
      </div>

      <div className={styles.filmstrip} aria-label="页面缩略图">
        {preview.images.length ? preview.images.map((image) => (
          <button
            className={cx(styles.thumbnail, styles[`${image.status || "pending"}Thumbnail`], image.id === preview.selectedPageId && styles.activeThumbnail)}
            type="button"
            onClick={() => preview.onSelectPage(image.id)}
            key={image.id}
            ref={image.id === preview.selectedPageId ? activeThumbnailRef : null}
            aria-label={`查看第 ${image.pageNumber} 页，${image.status === "ready" ? (editableMode ? "已重建" : "已生成") : image.status === "sample" ? "样张" : image.status === "running" ? `${progressVerb}中` : image.status === "failed" ? `${progressVerb}失败` : `等待${progressVerb}`}`}
          >
            {image.thumbHref ? <img src={image.thumbHref} alt="" loading="lazy" decoding="async" /> : (
              <span className={styles.thumbnailState}>
                {image.status === "running" ? <LoaderCircle size={16} className={styles.spin} /> : image.status === "failed" ? <CircleAlert size={16} /> : <span aria-hidden="true" />}
              </span>
            )}
            <span>{image.pageNumber}</span>
          </button>
        )) : <span className={styles.filmstripEmpty}>{editableMode ? "重建页面后可在这里逐页切换" : "生成页面后可在这里逐页切换"}</span>}
      </div>

      {preview.images.length && preview.onOpenReview ? (
        <button className={styles.reviewButton} type="button" onClick={preview.onOpenReview}>
          <Images size={14} aria-hidden="true" />{preview.reviewLabel}
        </button>
      ) : null}
    </section>
  );
}

function StageRail({ stages }) {
  return (
    <ol className={styles.stageRail} aria-label="PPT 制作进度">
      {stages.map((stage, index) => (
        <li className={cx(styles.stage, styles[`${stage.state}Stage`])} key={stage.label}>
          <span className={styles.stageIndex}>{stage.state === "done" ? <Check size={14} /> : index + 1}</span>
          <div><b>{stage.label}</b><small>{stage.detail}</small></div>
        </li>
      ))}
    </ol>
  );
}

function Deliverable({ item }) {
  return (
    <div className={cx(styles.deliverable, item.ready && styles.readyDeliverable)}>
      <span className={styles.deliverableIcon}>{item.kind === "visual" ? <Images size={15} /> : <Presentation size={15} />}</span>
      <div><b>{item.title}</b><small>{item.detail}</small></div>
      {item.href ? <a href={item.href} title={`下载${item.title}`} aria-label={`下载${item.title}`}><Download size={15} /></a> : <em>{item.status}</em>}
    </div>
  );
}

function AgentInspector({ workflow, advanced }) {
  const primary = workflow.actions.find((action) => action.primary) || workflow.actions[0];
  const secondary = workflow.actions.filter((action) => action !== primary).slice(0, 1);
  return (
    <aside className={styles.inspector} aria-label="Agent 工作流">
      <div className={styles.inspectorHead}>
        <span className={styles.inspectorIcon}><Sparkles size={16} aria-hidden="true" /></span>
        <div><small>Agent 当前任务</small><b>{workflow.nextAction}</b></div>
      </div>
      <p className={styles.inspectorMessage}>{workflow.message}</p>
      {workflow.errorMessage ? (
        <div className={cx(styles.runtimeNotice, styles.errorNotice)} role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{workflow.errorMessage}</span>
        </div>
      ) : workflow.busy ? (
        <div className={styles.runtimeNotice} role="status" aria-live="polite">
          <LoaderCircle size={14} className={styles.spin} aria-hidden="true" />
          <span>{workflow.statusMessage || "Agent 正在处理当前步骤..."}</span>
        </div>
      ) : workflow.statusMessage ? (
        <div className={styles.runtimeNotice} role="status" aria-live="polite">
          <Check size={14} aria-hidden="true" />
          <span>{workflow.statusMessage}</span>
        </div>
      ) : null}
      <div className={styles.inspectorActions}>
        <Action action={primary} primary />
        {secondary.map((action) => <Action action={action} compact key={action.label} />)}
      </div>

      <StageRail stages={workflow.stages} />

      <section className={styles.outputs}>
        <div className={styles.sectionLabel}><span>交付文件</span><Download size={13} aria-hidden="true" /></div>
        {workflow.deliverables.map((item) => <Deliverable item={item} key={item.kind} />)}
      </section>

      {workflow.onOpenArtifacts ? (
        <button className={styles.artifactButton} type="button" onClick={workflow.onOpenArtifacts}><FolderOpen size={14} />查看全部产物与记录</button>
      ) : null}

      <details className={styles.advanced} open={advanced.open} onToggle={(event) => advanced.onToggle(event.currentTarget.open)}>
        <summary><span><Settings2 size={14} />高级详情</span><ChevronDown size={14} /></summary>
        <div className={styles.advancedBody}>{advanced.content}</div>
      </details>
    </aside>
  );
}

function CreateWorkspace({ create }) {
  const [removeError, setRemoveError] = React.useState("");
  const removingFileId = create.removingFileId || "";

  const removeFile = async (file) => {
    if (!file?.id || !create.onRemoveFile || removingFileId || create.removalDisabled) return;
    setRemoveError("");
    const result = await create.onRemoveFile(file);
    if (result?.ok === false && !result.cancelled) {
      setRemoveError(result.error || "删除失败，请稍后重试。");
    }
  };

  return (
    <div className={styles.createWorkspace}>
      <section className={styles.createForm}>
        <header>
          <div><small>新任务</small><h2>创建一份 PPT</h2><p>上传材料或说明需求。系统会先完成图片版，确认视觉后再按需转成可编辑版。</p></div>
          <button type="button" onClick={create.onClose} title="关闭" aria-label="关闭新建任务"><X size={18} /></button>
        </header>

        <label className={cx(styles.uploadArea, create.inputLocked && styles.inputLocked)} aria-disabled={create.inputLocked}>
          <input type="file" multiple onChange={create.onUploadFiles} disabled={create.inputLocked} />
          <span><Upload size={22} aria-hidden="true" /></span>
          <b>上传 PPT、PDF、图片或文档</b>
          <small>{create.files.length ? `已选择 ${create.files.length} 个文件` : "点击选择文件，可一次上传多个材料"}</small>
        </label>

        <label className={styles.briefField}>
          <span>告诉 Agent 你要做什么</span>
          <textarea value={create.notes} onChange={(event) => create.onNotesChange(event.target.value)} disabled={create.inputLocked} placeholder="例如：把这份中秋提案重做成统一、克制、高级的图片版 PPT，确认后继续制作可编辑版本。" />
        </label>

        {create.outline.length ? (
          <section className={styles.outlineSummary} aria-label="大纲摘要">
            <div><span><Check size={14} aria-hidden="true" />大纲已生成</span><b>{create.outline.length} 页</b></div>
            <ol>
              {create.outline.slice(0, 6).map((step, index) => (
                <li key={`${step.title || step.layout || "page"}-${index}`}><em>{String(index + 1).padStart(2, "0")}</em><span>{step.title || step.purpose || `第 ${index + 1} 页`}</span></li>
              ))}
            </ol>
            {create.outline.length > 6 ? <small>其余 {create.outline.length - 6} 页已收起，创建任务后可继续查看。</small> : null}
          </section>
        ) : null}

        {create.files.length ? (
          <div className={styles.fileList} aria-label="已上传文件">
            {create.files.map((file) => {
              const fileName = file.originalName || file.id;
              const removing = removingFileId === file.id;
              return (
                <div className={styles.fileItem} key={file.id || file.originalName}>
                  <Presentation size={13} aria-hidden="true" />
                  <span title={fileName}>{fileName}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(file)}
                    disabled={Boolean(removingFileId) || create.removalDisabled}
                    title={create.removalDisabled ? "任务处理期间不能删除源文件" : `删除 ${fileName}`}
                    aria-label={`删除已上传文件 ${fileName}`}
                  >
                    {removing ? <LoaderCircle size={13} className={styles.spin} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {removeError || create.errorMessage ? (
          <div className={styles.createError} role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{removeError || create.errorMessage}</span>
          </div>
        ) : null}
      </section>

      <aside className={styles.createInspector}>
        <div className={styles.sectionLabel}><span>交付目标</span><PanelRight size={13} /></div>
        <div className={styles.deliveryChoices} role="group" aria-label="选择交付目标">
          <button className={create.deliveryMode === "visual" ? styles.activeChoice : ""} type="button" aria-pressed={create.deliveryMode === "visual"} onClick={() => create.onDeliveryModeChange("visual")} disabled={create.inputLocked}>
            <Images size={18} /><span><b>图片版 PPT</b><small>先完成视觉统一版本</small></span>
          </button>
          <button className={create.deliveryMode === "editable" ? styles.activeChoice : ""} type="button" aria-pressed={create.deliveryMode === "editable"} onClick={() => create.onDeliveryModeChange("editable")} disabled={create.inputLocked}>
            <Presentation size={18} /><span><b>图片版 + 可编辑版</b><small>确认图片版后继续对象级重建</small></span>
          </button>
        </div>

        <ol className={styles.createSteps}>
          {create.steps.map((step, index) => <li key={step}><span>{index + 1}</span><b>{step}</b></li>)}
        </ol>

        {create.deliveryMode === "editable" ? <div className={styles.costNote}><CircleAlert size={15} /><span>可编辑重建会增加耗时和模型调用，真实执行前仍需确认。</span></div> : null}
        {create.outline.length ? (
          <div className={cx(styles.costPreview, create.costPreview?.predictability?.ready ? styles.readyCostPreview : styles.blockedCostPreview)}>
            <div><b>任务费用上限</b><span>{create.costPreviewLoading ? "计算中" : create.costPreview?.upperBoundUsd !== null && create.costPreview?.upperBoundUsd !== undefined ? `$${Number(create.costPreview.upperBoundUsd).toFixed(2)}` : "待配置"}</span></div>
            <small>{create.costPreviewLoading
              ? "正在按页数和交付目标计算费用。"
              : create.costPreview?.predictability?.reason || "费用报价包含 20% 风险缓冲。"}</small>
            {create.costPreview?.plannedImageCalls ? <em>最多 {create.costPreview.plannedImageCalls} 次图片调用，达到上限自动停止</em> : null}
          </div>
        ) : null}

        <div className={styles.createSubmit}>
          <small>{removingFileId ? "正在删除文件，请稍候..." : create.hint}</small>
          <button type="button" onClick={create.onSubmit} disabled={!create.canSubmit || Boolean(removingFileId) || create.inputLocked}>{create.submitLabel}</button>
        </div>
      </aside>
    </div>
  );
}

export function PptAgentWorkspace({ advanced, create, header, preview, taskList, workflow }) {
  const workspaceHeader = create.open ? {
    ...header,
    title: "新建任务",
    createdLabel: "选择资料与交付目标",
    sourceLabel: "先完成图片版，再按需生成可编辑版",
    statusLabel: "待提交",
    statusTone: "idle",
    busy: workflow.busy
  } : { ...header, busy: workflow.busy };
  return (
    <div className={`${styles.root} ppt-agent-v2`} data-ui-version="2">
      <TaskSidebar taskList={taskList} onCreate={create.onOpen} />
      <section className={styles.workspace}>
        <WorkspaceHeader header={workspaceHeader} onCreate={create.onOpen} />
        {create.open ? <CreateWorkspace create={create} /> : (
          <div className={styles.productionDesk}>
            <SlideStudio preview={preview} />
            <AgentInspector workflow={workflow} advanced={advanced} />
          </div>
        )}
      </section>
    </div>
  );
}
