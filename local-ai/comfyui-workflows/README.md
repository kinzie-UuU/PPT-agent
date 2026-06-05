# PPT Design Tool ComfyUI Workflows

These files are stable workflow assets for the PPT aesthetic system.

They separate three jobs:

- `ppt-background-zimage.workflow.json`: generate editable-slide backgrounds and atmosphere images. This is the same node shape used by `server/localImage.js`.
- `ppt-foreground-cutout-rembg.workflow.json`: remove background for foreground/product materials. It is a template because the exact node name depends on the installed ComfyUI matting plugin.
- `ppt-element-decompose.workflow.json`: a registry/spec workflow for slide element decomposition. The current production path is code-based SlideIR in `server/pptAesthetic.js`; ComfyUI can later take over visual segmentation when a segmentation model is installed.

Install/sync to the local ComfyUI workspace:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-comfy-workflows.ps1
```

Default target:

`F:\PPT工具\ZImageLocal\ComfyUI_windows_portable\ComfyUI\user\default\workflows\ppt-design-tool`

Runtime policy:

- Background generation is automatic when local Z-Image is available.
- Foreground cutout is only required for real foreground/product assets, not for background images.
- Element decomposition is first done by PPTX parsing; image segmentation is a future optional ComfyUI workflow.
