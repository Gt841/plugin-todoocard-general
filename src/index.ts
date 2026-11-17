import { Plugin, Dialog, Setting, showMessage } from "siyuan";
import App from "./ui/App.svelte";
import { TodooService } from "./core/service";
import { resolveStateDir } from "./core/paths";
import { isImageFile } from "./core/image";
import { MIRROR_PRESETS } from "./core/mirror";
import fs from "fs";

declare const window: any;

const IMAGE_FILTER = [{ name: "图片", extensions: ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "bmp"] }];

export default class TodoocardPlugin extends Plugin {
  private service!: TodooService;
  private dialog: Dialog | null = null;
  private panel: any = null;
  private stateDir = "";
  private settingSource: HTMLInputElement | null = null;
  private settingMirror: HTMLSelectElement | null = null;
  private settingAutoProbe: HTMLInputElement | null = null;
  private pasteTarget: HTMLElement | null = null;

  async onload() {
    this.stateDir = this.computeStateDir();
    this.service = new TodooService({
      stateDir: this.stateDir,
      platform: process.platform,
      onUpdate: () => this.refresh(),
      notify: (message, level) => showMessage(message, 5000, level === "error" ? "error" : "info"),
    });
    // 先同步读一次状态，确保下面 SiYuan 插件设置面板显示的是已保存的源与开关；
    // init() 仍会在稍后完成环境检查和目录清理。
    this.service.store.load();

    this.addTopBar({
      icon: `<svg viewBox="0 0 24 24" width="16" height="16"><rect x="4" y="2" width="16" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="18" cy="18" r="3.5" fill="#e59a2f"/></svg>`,
      title: "土豆片通用 · TodooCard General",
      position: "right",
      callback: () => this.openPanel(),
    });

    this.setting = new Setting({
      confirmCallback: () => this.saveSettings(),
    });
    this.setting.addItem({
      title: "核心来源",
      description: "默认是通用核心仓库；保存后点面板里的「下载 / 更新核心」生效。",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.spellcheck = false;
        input.value = this.service.store.settings.coreSourceUrl;
        this.settingSource = input;
        return input;
      },
    });
    this.setting.addItem({
      title: "下载线路",
      description: "直连 GitHub 较慢时可使用第三方加速；固定 commit 来源会用预置 SHA-256 校验。",
      createActionElement: () => {
        const select = document.createElement("select");
        select.className = "b3-select fn__block";
        for (const item of MIRROR_PRESETS) {
          const option = document.createElement("option");
          option.value = item.value;
          option.textContent = item.label;
          select.appendChild(option);
        }
        select.value = this.service.store.settings.downloadMirror;
        this.settingMirror = select;
        return select;
      },
    });
    this.setting.addItem({
      title: "配对后自动探测",
      description: "配对成功后立即执行一次加密连接验证，确认系统绑定可用。",
      createActionElement: () => {
        const label = document.createElement("label");
        label.className = "fn__flex";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "b3-switch fn__flex-center";
        cb.checked = this.service.store.settings.autoProbeAfterPair;
        this.settingAutoProbe = cb;
        label.appendChild(cb);
        return label;
      },
    });
    this.setting.addItem({
      title: "数据目录（不参与思源同步）",
      description: this.stateDir,
      createActionElement: () => {
        const btn = document.createElement("button");
        btn.className = "b3-button b3-button--outline";
        btn.textContent = "打开目录";
        btn.addEventListener("click", () => this.openStateDir());
        return btn;
      },
    });

    this.service.init().catch((e) => showMessage(`初始化失败：${String(e)}`, 6000, "error"));
  }

  /**
   * 目录放在工作区根下的 `todoocard-general/`（`data/` 的上一级），思源同步只
   * 覆盖 data，因此核心、虚拟环境、设备备注和配对记录都不会被云端旧副本覆盖。
   */
  private computeStateDir(): string {
    const override = process.env.SIYUAN_TODOOCARD_GENERAL_HOME;
    if (override) return override;
    const dataDir = window.siyuan?.config?.system?.dataDir || "";
    let userData = "";
    try {
      userData = window.require?.("@electron/remote")?.app?.getPath?.("userData") || "";
    } catch {}
    return resolveStateDir({ dataDir, userData });
  }

  private saveSettings() {
    const patch: { coreSourceUrl?: string; downloadMirror?: string; autoProbeAfterPair?: boolean } = {};
    if (this.settingSource) patch.coreSourceUrl = this.settingSource.value;
    if (this.settingMirror) patch.downloadMirror = this.settingMirror.value;
    if (this.settingAutoProbe) patch.autoProbeAfterPair = this.settingAutoProbe.checked;
    this.service.updateSettings(patch);
    this.refresh();
    showMessage("设置已保存到同步范围之外的目录", 3000, "info");
  }

  private openPanel() {
    // 用户可能用右上角关闭面板；Dialog 关闭后插件侧不能继续持有失效引用，
    // 否则再次点顶栏时会被 `if (this.dialog && this.panel)` 挡在门外。
    if (this.dialog && this.panel && this.dialog.element?.isConnected) {
      try { (this.dialog.element.querySelector(".tc-app") as HTMLElement)?.focus(); } catch {}
      return;
    }
    this.panel?.$destroy();
    this.dialog?.destroy();
    this.panel = null;
    this.dialog = null;
    this.dialog = new Dialog({
      title: "土豆片通用 · TodooCard General",
      width: "940px",
      height: "740px",
      content: `<div id="tcMount" style="display:flex;height:100%;min-height:560px;flex-direction:column;"></div>`,
      destroyCallback: () => {
        this.panel?.$destroy();
        this.panel = null;
        this.dialog = null;
      },
    });
    const target = this.dialog.element.querySelector("#tcMount") as HTMLElement;
    this.panel = new App({ target, props: { view: this.service.getView() } });

    this.panel.$on("install", () => this.service.install(true));
    this.panel.$on("installenv", () => this.service.installEnvironment());
    this.panel.$on("recheck", () => this.service.recheckPrereq());
    this.panel.$on("scan", () => this.service.scanDevices());
    this.panel.$on("stopscan", () => this.service.cancelJob());
    this.panel.$on("cancel", () => this.service.cancelJob());
    this.panel.$on("select", (e: CustomEvent) => this.service.selectDevice(e.detail));
    this.panel.$on("pair", (e: CustomEvent) => this.service.pair(e.detail));
    this.panel.$on("probe", (e: CustomEvent) => this.service.probe(e.detail));
    this.panel.$on("forget", (e: CustomEvent) => this.service.forgetDevice(e.detail));
    this.panel.$on("alias", (e: CustomEvent) => this.service.setAlias(e.detail.id, e.detail.alias));
    this.panel.$on("filters", (e: CustomEvent) => this.service.setFilters(e.detail));
    this.panel.$on("pickimage", () => this.pickImage());
    this.panel.$on("addimages", (e: CustomEvent<{ append?: boolean } | undefined>) => this.pickImages(e.detail?.append !== false));
    this.panel.$on("bing", (e: CustomEvent<{ append?: boolean } | undefined>) => this.service.loadBingWallpaper(e.detail?.append !== false));
    this.panel.$on("paste", (e: CustomEvent<{ append?: boolean } | undefined>) => this.pasteFromClipboard(!!e.detail?.append));
    this.panel.$on("dropimage", (e: CustomEvent) => {
      this.service.setDroppedImage(Buffer.from(e.detail.bytes), e.detail.name, !!e.detail.append).catch((err) => showMessage(String(err), 5000, "error"));
    });
    this.panel.$on("dropimages", (e: CustomEvent<{ files: { bytes: Uint8Array; name: string }[]; append?: boolean }>) => {
      const files = (e.detail?.files || []).map((file) => ({
        bytes: Buffer.from(file.bytes),
        name: file.name,
      }));
      this.service.addDroppedImages(files, e.detail?.append !== false).catch((err) => showMessage(String(err), 5000, "error"));
    });
    this.panel.$on("removeimage", (e: CustomEvent<string>) => this.service.removeImage(e.detail));
    this.panel.$on("moveimage", (e: CustomEvent<{ path: string; delta: number }>) => this.service.moveImage(e.detail.path, e.detail.delta));
    this.panel.$on("clearimage", () => this.service.clearImage());
    this.panel.$on("rotate", (e: CustomEvent) => this.service.setRotate(!!e.detail));
    this.panel.$on("crop", () => this.service.invalidatePrepared());
    this.panel.$on("prepare", (e: CustomEvent<{ bytes?: Uint8Array; name?: string; kind?: "crop" | "layout" } | undefined>) => {
      const detail = e.detail;
      this.service.prepare(detail?.bytes?.length ? Buffer.from(detail.bytes) : null, detail?.name, detail?.kind);
    });
    this.panel.$on("send", (e: CustomEvent<string[] | undefined>) => this.service.send(e.detail));
    this.panel.$on("settings", (e: CustomEvent) => this.service.updateSettings(e.detail));
    this.panel.$on("clearLog", () => this.service.clearLog());
    this.panel.$on("opendir", () => this.openStateDir());
    this.panel.$on("mode", (e: CustomEvent<"direct" | "layout">) => {
      this.service.setImageMode(e.detail === "layout" ? "layout" : "direct");
    });
    this.panel.$on("cardlayout", (e: CustomEvent<"immersive" | "framed" | "wall">) => {
      this.service.setCardLayout(e.detail === "wall" ? "wall" : e.detail === "framed" ? "framed" : "immersive");
    });

    this.pasteTarget = target;
    target.addEventListener("paste", this.handlePaste, true);
    setTimeout(() => (target.querySelector(".tc-app") as HTMLElement)?.focus(), 60);
  }

  private refresh() {
    if (!this.panel) return;
    try { this.panel.$set({ view: this.service.getView() }); } catch {}
  }

  private handlePaste = async (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data) return;
    let file: File | null = null;
    for (const item of Array.from(data.items || [])) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        file = item.getAsFile();
        if (file) break;
      }
    }
    if (!file && data.files?.length) {
      const first = data.files[0];
      if (first.type.startsWith("image/")) file = first;
    }
    if (file) {
      e.preventDefault();
      e.stopPropagation();
      const bytes = Buffer.from(await file.arrayBuffer());
      await this.service.setPastedPng(bytes, this.service.imageMode === "layout" && this.service.cardWall);
      return;
    }
    const text = data.getData("text/plain")?.trim();
    if (text && isImageFile(text) && fs.existsSync(text)) {
      e.preventDefault();
      e.stopPropagation();
      if (this.service.imageMode === "layout" && this.service.cardWall) await this.service.addImages([text]);
      else await this.service.setImage(text);
    }
  };

  /** 从系统剪贴板取截图；Electron 的 clipboard 在 macOS / Windows 上都可用。 */
  private readClipboardImage(): Buffer | null {
    try {
      const electron = window.require?.("electron");
      const remote = window.require?.("@electron/remote");
      const clipboard = electron?.clipboard || remote?.clipboard;
      const image = clipboard?.readImage?.();
      if (image && !image.isEmpty()) {
        const png = image.toPNG();
        if (png?.length) return Buffer.from(png);
      }
    } catch {}
    return null;
  }

  private async pasteFromClipboard(append = this.service.imageMode === "layout" && this.service.cardWall) {
    const png = this.readClipboardImage();
    if (png) {
      await this.service.setPastedPng(png, append);
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            await this.service.setPastedPng(Buffer.from(await blob.arrayBuffer()), append);
            return;
          }
        }
      }
    } catch {}
    let text = "";
    try {
      const electron = window.require?.("electron");
      const remote = window.require?.("@electron/remote");
      const clipboard = electron?.clipboard || remote?.clipboard;
      text = clipboard?.readText?.() || "";
    } catch {}
    if (text.trim() && isImageFile(text.trim()) && fs.existsSync(text.trim())) {
      if (append) await this.service.addImages([text.trim()]);
      else await this.service.setImage(text.trim());
      return;
    }
    showMessage("剪贴板里没有图片。请先截屏（Windows：Win+Shift+S，macOS：⌘⇧⌃4）或复制一张图片后再试。", 5000, "info");
  }

  private async pickImage() {
    try {
      const remote = window.require?.("@electron/remote");
      if (remote?.dialog) {
        const r = await remote.dialog.showOpenDialog({
          title: "选择要发送到卡片的图片",
          properties: ["openFile"],
          filters: IMAGE_FILTER,
        });
        if (r.canceled || !r.filePaths?.length) return;
        await this.service.setImage(r.filePaths[0]);
        return;
      }
    } catch {}
    const manual = window.prompt?.("输入图片的本地路径：")?.trim();
    if (manual) await this.service.setImage(manual);
  }

  private async pickImages(append = true) {
    try {
      const remote = window.require?.("@electron/remote");
      if (remote?.dialog) {
        const r = await remote.dialog.showOpenDialog({
          title: append ? "选择排版图片（最多 6 张）" : "选择一张图片",
          properties: append ? ["openFile", "multiSelections"] : ["openFile"],
          filters: IMAGE_FILTER,
        });
        if (r.canceled || !r.filePaths?.length) return;
        if (append) await this.service.addImages(r.filePaths);
        else await this.service.setImage(r.filePaths[0]);
        return;
      }
    } catch {}
    const manual = window.prompt?.(append ? "输入图片的本地路径（多张可用逗号分隔）：" : "输入图片的本地路径：")?.trim();
    if (!manual) return;
    const paths = manual.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    if (!paths.length) return;
    if (append) await this.service.addImages(paths);
    else await this.service.setImage(paths[0]);
  }

  private async openStateDir() {
    try {
      const remote = window.require?.("@electron/remote");
      if (remote?.shell?.openPath) {
        const err = await remote.shell.openPath(this.stateDir);
        if (err) showMessage(`打开目录失败：${err}`, 5000, "error");
        return;
      }
    } catch {}
    showMessage(`数据目录：${this.stateDir}`, 7000, "info");
  }

  onunload() {
    try { this.pasteTarget?.removeEventListener("paste", this.handlePaste, true); } catch {}
    this.service?.dispose();
    this.panel?.$destroy();
    this.dialog?.destroy();
    this.panel = null;
    this.dialog = null;
  }
}
