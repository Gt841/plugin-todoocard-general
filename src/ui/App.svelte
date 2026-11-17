<script lang="ts">
  import { createEventDispatcher, onMount, afterUpdate } from "svelte";
  import type { DeviceRow, Filters, ImageMode, PanelView } from "../types";
  import { PANEL_HEIGHT, PANEL_WIDTH } from "../types";
  import { decodePayloadBin } from "../core/preview";
  import { computeCropGeometry, panCropCenter } from "../core/crop";
  import { MIRROR_PRESETS } from "../core/mirror";
  import {
    CARD_LAYOUTS,
    MAX_CARD_IMAGES,
    cardStyleFor,
    formatCardDate,
    todayCardDate,
    type CardFields,
    type CardLayout,
    type CardStyle,
  } from "../core/layout";
  import { renderCard, type CardImage } from "./card";

  export let view: PanelView;
  const dispatch = createEventDispatcher();

  let tab: "devices" | "image" | "settings" = "image";
  let logOpen = false;
  let toastMessage = "";
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastedNoImage = false;
  let aliasFor = "";
  let aliasDraft = "";
  let pairConfirm = false;
  let sendConfirm = false;
  let targetIds: string[] = [];
  let targetKey = "";
  let selectedTargets: DeviceRow[] = [];
  let previewMode: "original" | "payload" = "original";
  let imageMode: ImageMode = view.imageMode;
  let cardFields: CardFields = { title: "", date: todayCardDate(), note: "" };
  let showText = true;
  let cardStyle: CardStyle = cardStyleFor(view.cardLayout || "immersive");
  let cardCanvasEl: HTMLCanvasElement | null = null;
  let loadedCardImages: Record<string, HTMLImageElement> = {};
  let cardImageKey = "";
  let cardDrawQueued = false;
  let cardBusy = false;
  let sourceDraft = "";
  let sourceFor = "";
  let canvasEl: HTMLCanvasElement | null = null;
  let lastDrawn = -1;
  let rootEl: HTMLElement;
  let lastJob = "";
  let copiedId = "";
  let dropActive = false;

  // 取景裁剪：界面里始终以 2:3 框显示，生成时再按 528×792 输出。
  let cropCanvasEl: HTMLCanvasElement | null = null;
  let cropW = 0;
  let cropH = 0;
  let cropZoom = 1;
  let cropCx = 0.5;
  let cropCy = 0.5;
  let cropImg: HTMLImageElement | null = null;
  let cropImageKey = "";
  let cropDragging = false;
  let cropDragStart: { x: number; y: number; cx: number; cy: number } | null = null;
  let cropBusy = false;
  let cropError = "";
  let cropDrawQueued = false;
  let cropInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRotate = false;
  let envReady = false;
  let canInstallCore = false;

  $: envReady = view.prereq.checked && view.prereq.errors.length === 0;
  $: canInstallCore = envReady && !view.job.running;
  $: platformLabel = view.platform === "win32" ? "Windows" : view.platform === "darwin" ? "macOS" : view.platform;
  $: envHint = view.platform === "win32"
    ? "会打开 python.org 下载页；安装时请勾选 Add python.exe to PATH，装完插件会自动复查。"
    : "会打开 macOS 的 Xcode Command Line Tools 安装窗口，仍需在系统弹窗中确认。";
  $: canAutoInstallEnv = view.platform === "darwin" || view.platform === "win32";
  $: bingBusy = view.job.running && view.job.kind === "bing";
  $: isWall = cardStyle.layout === "wall";
  $: neededImages = isWall ? view.images : view.images.slice(0, 1);
  $: cardImagesReady = neededImages.length > 0 && neededImages.every((image) => {
    const el = loadedCardImages[image.path];
    return !!el && el.complete && el.naturalWidth > 0;
  });
  $: canPrepare = imageMode === "layout" ? view.images.length > 0 && cardImagesReady : !!view.image && !!cropImg;
  $: prepareBusy = imageMode === "layout" ? cardBusy : cropBusy;
  $: layoutName = CARD_LAYOUTS.find((item) => item.id === cardStyle.layout)?.name || "卡片排版";
  // 关闭文字时不改动用户已填内容，只让卡片渲染忽略它们。
  $: cardRenderFields = showText ? cardFields : { title: "", date: "", note: "" };
  $: bingLabel = view.bingIndex > 0 ? "换一张壁纸" : "Bing 每日壁纸";

  const PALETTE: Record<number, [number, number, number]> = {
    0: [23, 23, 23],
    1: [247, 247, 242],
    2: [255, 206, 20],
    3: [228, 52, 58],
    4: [204, 204, 204],
    5: [45, 108, 223],
    6: [46, 158, 91],
    7: [204, 204, 204],
  };

  onMount(() => {
    rootEl?.focus();
    // 主进程的全局粘贴/拖入靠这个标记判断追加还是替换；面板重建时同步一次当前版式。
    dispatch("cardlayout", cardStyle.layout);
  });

  $: if (view.image || view.images.length) toastedNoImage = false;
  $: if (view.core.installed && tab === "image" && !view.image && !view.images.length && !toastedNoImage) {
    toastedNoImage = true;
    showToast("尚未选择图片：拖入、粘贴截图，或点「选择图片」");
  }

  $: if (view.job.kind && view.job.kind !== lastJob) {
    lastJob = view.job.kind;
    if (["scan", "pair", "probe"].includes(view.job.kind)) tab = "devices";
    else if (view.job.kind === "prepare" || view.job.kind === "send") tab = "image";
  }
  $: {
    const key = view.pairedDevices.map((d) => d.id).join("|");
    if (key !== targetKey) {
      targetKey = key;
      const valid = targetIds.filter((id) => view.pairedDevices.some((d) => d.id === id));
      if (valid.length) {
        targetIds = valid;
      } else {
        const preferred = view.selected?.paired ? view.selected.id : view.pairedDevices[0]?.id || "";
        targetIds = preferred ? [preferred] : [];
      }
      sendConfirm = false;
    }
  }
  $: selectedTargets = view.pairedDevices.filter((d) => targetIds.includes(d.id));
  $: if (view.selected && view.selected.id !== aliasFor) {
    aliasFor = view.selected.id;
    aliasDraft = view.selected.alias;
    pairConfirm = false;
  }
  $: if (view.settings.coreSourceUrl !== sourceFor) {
    sourceFor = view.settings.coreSourceUrl;
    sourceDraft = view.settings.coreSourceUrl;
  }
  $: if (previewMode === "original") lastDrawn = -1;
  $: if ((view.image?.dataUrl || "") !== cropImageKey) {
    cropImageKey = view.image?.dataUrl || "";
    cropImg = null;
    cropError = "";
    resetCrop(false);
    if (cropImageKey) {
      const img = new Image();
      img.onload = () => {
        if (img.src !== cropImageKey) return;
        cropImg = img;
        resetCrop(false);
        queueCropDraw();
      };
      img.src = cropImageKey;
    }
  }
  $: if (view.settings.rotateRight90 !== lastRotate) {
    lastRotate = view.settings.rotateRight90;
    resetCrop(false);
  }
  $: {
    const key = view.images.map((image) => `${image.path}:${image.dataUrl.length}`).join("|");
    if (key !== cardImageKey) {
      cardImageKey = key;
      syncCardImages(view.images);
    }
  }

  afterUpdate(() => {
    if (tab === "image") {
      if (imageMode === "layout") queueCardDraw();
      else queueCropDraw();
    }
    if (!canvasEl || !view.prepared || previewMode !== "payload") return;
    if (lastDrawn === view.prepared.at) return;
    lastDrawn = view.prepared.at;
    drawPayload(canvasEl, view.prepared.binBase64, view.prepared.width, view.prepared.height);
  });

  function drawPayload(canvas: HTMLCanvasElement, base64: string, width: number, height: number) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(width, height);
    image.data.set(decodePayloadBin(base64, width, height, PALETTE));
    ctx.putImageData(image, 0, 0);
  }

  function syncCardImages(images: PanelView["images"]) {
    const next: Record<string, HTMLImageElement> = {};
    for (const image of images) {
      const existing = loadedCardImages[image.path];
      if (existing) {
        next[image.path] = existing;
        continue;
      }
      const el = new Image();
      el.onload = () => {
        loadedCardImages = { ...loadedCardImages, [image.path]: el };
        queueCardDraw();
      };
      el.onerror = () => {
        loadedCardImages = { ...loadedCardImages };
        queueCardDraw();
      };
      el.src = image.dataUrl;
      next[image.path] = el;
    }
    loadedCardImages = next;
    queueCardDraw();
  }

  function queueCardDraw() {
    if (cardDrawQueued) return;
    cardDrawQueued = true;
    requestAnimationFrame(() => {
      cardDrawQueued = false;
      drawCardPreview();
    });
  }

  function cardImagesAtCurrentOrder(): CardImage[] {
    const result: CardImage[] = [];
    for (const image of view.images) {
      const el = loadedCardImages[image.path];
      if (el && el.complete && el.naturalWidth > 0) {
        result.push({ el, width: el.naturalWidth, height: el.naturalHeight });
      }
    }
    return result;
  }

  function drawCardPreview() {
    const canvas = cardCanvasEl;
    if (!canvas) return;
    if (canvas.width !== PANEL_WIDTH) canvas.width = PANEL_WIDTH;
    if (canvas.height !== PANEL_HEIGHT) canvas.height = PANEL_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderCard(ctx, PANEL_WIDTH, PANEL_HEIGHT, cardImagesAtCurrentOrder(), cardRenderFields, cardStyle);
  }

  function renderCardPng(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (!view.images.length) { reject(new Error("尚未选择图片")); return; }
      const loaded = cardImagesAtCurrentOrder();
      const required = isWall ? view.images.length : 1;
      if (loaded.length < required) {
        reject(new Error("图片尚未加载完成，请稍后再试"));
        return;
      }
      const images = isWall ? loaded : loaded.slice(0, 1);
      const canvas = document.createElement("canvas");
      canvas.width = PANEL_WIDTH;
      canvas.height = PANEL_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("无法创建画布")); return; }
      renderCard(ctx, PANEL_WIDTH, PANEL_HEIGHT, images, cardRenderFields, cardStyle);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("无法生成排版卡片")); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, "image/png");
    });
  }

  function setImageMode(mode: ImageMode) {
    if (imageMode === mode) return;
    imageMode = mode;
    previewMode = "original";
    sendConfirm = false;
    dispatch("mode", mode);
    dispatch("crop");
    if (mode === "layout") queueCardDraw();
  }

  /** 照片墙追加图片；单图版式直接替换当前图片。 */
  function addImagesAction() {
    dispatch("addimages", { append: isWall });
  }

  function bingAction() {
    dispatch("bing", { append: isWall });
  }

  function pasteAction() {
    dispatch("paste", { append: isWall });
  }

  function applyCardLayout(layout: CardLayout) {
    cardStyle = cardStyleFor(layout);
    previewMode = "original";
    dispatch("cardlayout", layout);
    dispatch("crop");
    queueCardDraw();
  }

  function patchCardStyle(patch: Partial<CardStyle>, immediate = true) {
    cardStyle = { ...cardStyle, ...patch };
    queueCardDraw();
    notifyCropChanged(immediate);
  }

  function onCardFieldsChanged() {
    previewMode = "original";
    queueCardDraw();
    notifyCropChanged();
  }

  function onTextToggle(e: Event) {
    showText = (e.currentTarget as HTMLInputElement).checked;
    previewMode = "original";
    queueCardDraw();
    notifyCropChanged(true);
  }

  function onCardRadius(e: Event) {
    patchCardStyle({ radius: (e.currentTarget as HTMLInputElement).checked ? 22 : 0 });
  }

  function onCardBorder(e: Event) {
    patchCardStyle({ border: (e.currentTarget as HTMLInputElement).checked });
  }

  function onCardInfoBand(e: Event) {
    patchCardStyle({ infoBand: (e.currentTarget as HTMLInputElement).checked });
  }

  function onCardMargin(e: Event) {
    patchCardStyle({ margin: Number((e.currentTarget as HTMLInputElement).value) || 0 }, false);
  }

  function preparedInputLabel(kind: "original" | "crop" | "layout"): string {
    if (kind === "layout") return "排版卡片";
    if (kind === "crop") return "2:3 取景裁剪";
    return "原图（按卡片比例裁切）";
  }

  function cropGeometryAt(centerX = cropCx, centerY = cropCy) {
    if (!cropImg) return null;
    return computeCropGeometry({
      sourceWidth: cropImg.naturalWidth,
      sourceHeight: cropImg.naturalHeight,
      rotated: view.settings.rotateRight90,
      zoom: cropZoom,
      centerX,
      centerY,
      frameAspect: PANEL_WIDTH / PANEL_HEIGHT,
    });
  }

  function resetCrop(notify = true) {
    cropZoom = 1;
    cropCx = 0.5;
    cropCy = 0.5;
    queueCropDraw();
    if (notify) notifyCropChanged(true);
  }

  function queueCropDraw() {
    if (cropDrawQueued) return;
    cropDrawQueued = true;
    requestAnimationFrame(() => {
      cropDrawQueued = false;
      drawCrop();
    });
  }

  function drawCropOnto(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const g = cropGeometryAt();
    if (!g || !cropImg) return;
    const scale = width / g.cropWidth;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.translate(-g.sourceX * scale, -g.sourceY * scale);
    ctx.scale(scale, scale);
    if (view.settings.rotateRight90) {
      ctx.translate(g.effectiveWidth, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(cropImg, 0, 0, cropImg.naturalWidth, cropImg.naturalHeight);
    ctx.restore();
  }

  function drawCrop() {
    const canvas = cropCanvasEl;
    if (!canvas || !cropImg || !cropW || !cropH) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(cropW * dpr));
    const height = Math.max(1, Math.round(cropH * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cropW, cropH);
    drawCropOnto(ctx, cropW, cropH);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(cropW * f, 0);
      ctx.lineTo(cropW * f, cropH);
      ctx.moveTo(0, cropH * f);
      ctx.lineTo(cropW, cropH * f);
    }
    ctx.stroke();
    ctx.restore();
  }

  function onCropPointerDown(e: PointerEvent) {
    const g = cropGeometryAt();
    if (!g) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDragging = true;
    cropDragStart = { x: e.clientX, y: e.clientY, cx: g.centerX, cy: g.centerY };
    e.preventDefault();
  }

  function onCropPointerMove(e: PointerEvent) {
    if (!cropDragging || !cropDragStart) return;
    const g = cropGeometryAt(cropDragStart.cx, cropDragStart.cy);
    if (!g) return;
    const moved = panCropCenter(g, e.clientX - cropDragStart.x, e.clientY - cropDragStart.y, cropW, cropH);
    cropCx = moved.centerX;
    cropCy = moved.centerY;
    queueCropDraw();
  }

  function onCropPointerUp() {
    if (!cropDragging) return;
    cropDragging = false;
    cropDragStart = null;
    notifyCropChanged(true);
  }

  function onCropWheel(e: WheelEvent) {
    if (!cropImg) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(1, cropZoom * (e.deltaY < 0 ? 1.08 : 0.92)));
    if (Math.abs(next - cropZoom) < 0.001) return;
    cropZoom = next;
    const g = cropGeometryAt();
    if (g) { cropCx = g.centerX; cropCy = g.centerY; }
    queueCropDraw();
    notifyCropChanged();
  }

  function onCropScale(e: Event) {
    cropZoom = Math.min(5, Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1));
    const g = cropGeometryAt();
    if (g) { cropCx = g.centerX; cropCy = g.centerY; }
    queueCropDraw();
    notifyCropChanged();
  }

  function notifyCropChanged(immediate = false) {
    if (cropInvalidateTimer) clearTimeout(cropInvalidateTimer);
    cropInvalidateTimer = null;
    if (immediate) {
      dispatch("crop");
      return;
    }
    cropInvalidateTimer = setTimeout(() => {
      cropInvalidateTimer = null;
      dispatch("crop");
    }, 120);
  }

  function renderCropPng(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (!cropImg) { reject(new Error("图片尚未加载")); return; }
      const canvas = document.createElement("canvas");
      canvas.width = PANEL_WIDTH;
      canvas.height = PANEL_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("无法创建画布")); return; }
      drawCropOnto(ctx, PANEL_WIDTH, PANEL_HEIGHT);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("无法生成裁剪图")); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, "image/png");
    });
  }

  async function onPrepare() {
    if (view.job.running || cropBusy || cardBusy) return;
    if (imageMode === "layout") {
      if (!view.images.length) {
        showToast("请先添加图片，或获取一张 Bing 每日壁纸");
        return;
      }
      if (!cardImagesReady) {
        showToast("图片仍在加载，请稍后再生成");
        return;
      }
      cardBusy = true;
      cropError = "";
      try {
        const bytes = await renderCardPng();
        dispatch("prepare", { bytes, name: "card.png", kind: "layout" });
      } catch (e) {
        cropError = e instanceof Error ? e.message : String(e);
      } finally {
        cardBusy = false;
      }
      return;
    }
    if (!view.image || !cropImg) {
      showToast("尚未选择图片：拖入、粘贴截图，或点「选择图片」");
      return;
    }
    cropBusy = true;
    cropError = "";
    try {
      const bytes = await renderCropPng();
      const base = (view.image.name || "image").replace(/\.[^.]+$/, "");
      dispatch("prepare", { bytes, name: `${base}-crop.png`, kind: "crop" });
    } catch (e) {
      cropError = e instanceof Error ? e.message : String(e);
    } finally {
      cropBusy = false;
    }
  }

  function toggleTarget(id: string) {
    if (view.job.running) return;
    targetIds = targetIds.includes(id) ? targetIds.filter((x) => x !== id) : [...targetIds, id];
    sendConfirm = false;
  }

  function selectAllTargets() {
    if (view.job.running) return;
    targetIds = view.pairedDevices.map((d) => d.id);
    sendConfirm = false;
  }

  function clearTargets() {
    if (view.job.running) return;
    targetIds = [];
    sendConfirm = false;
  }

  function showToast(message: string, ms = 2800) {
    toastMessage = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastMessage = "";
    }, ms);
  }

  function requestSend() {
    if (view.job.running) return;
    if (imageMode === "layout" ? !view.images.length : !view.image) {
      showToast(imageMode === "layout" ? "请先添加图片并生成排版预览" : "尚未选择图片：拖入、粘贴截图，或点「选择图片」");
      return;
    }
    if (!view.prepared) {
      showToast("请先生成并校验预览，再发送");
      return;
    }
    if (view.prepared.inputKind !== (imageMode === "layout" ? "layout" : "crop")) {
      showToast("当前预览已过期，请按当前模式重新生成");
      return;
    }
    if (!view.pairedDevices.length) {
      showToast("还没有已配对的卡片，请先到「设备」页扫描并配对");
      return;
    }
    if (!targetIds.length) {
      showToast("请至少选择一台已配对卡片");
      return;
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    toastMessage = "";
    sendConfirm = true;
  }

  function confirmSend() {
    sendConfirm = false;
    dispatch("send", targetIds);
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && sendConfirm) {
      e.preventDefault();
      sendConfirm = false;
    }
  }

  function nameOf(d: { alias?: string; name?: string; id: string } | null | undefined): string {    if (!d) return "未选择设备";
    return d.alias || d.name || d.id.slice(0, 8);
  }

  function shortId(id: string): string {
    return id ? id.slice(0, 8).toUpperCase() : "";
  }

  function fwLabel(fw: number | null): string {
    if (fw == null) return "固件未知";
    return `v${fw} / 0x${fw.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  function fmtBytes(n: number): string {
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtTime(ts: number | null): string {
    if (!ts) return "从未";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function copy(text: string, id = "") {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = id;
      setTimeout(() => { copiedId = ""; }, 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); copiedId = id; } catch {}
      ta.remove();
    }
  }

  function applyFilters(patch: Partial<Filters>) {
    dispatch("filters", patch);
  }

  function onSearch(e: Event) {
    applyFilters({ q: (e.currentTarget as HTMLInputElement).value });
  }

  function onSort(e: Event) {
    applyFilters({ sort: (e.currentTarget as HTMLSelectElement).value as Filters["sort"] });
  }

  function onRotate(e: Event) {
    dispatch("rotate", (e.currentTarget as HTMLInputElement).checked);
  }

  function onAutoProbe(e: Event) {
    dispatch("settings", { autoProbeAfterPair: (e.currentTarget as HTMLInputElement).checked });
  }

  function onMirror(e: Event) {
    dispatch("settings", { downloadMirror: (e.currentTarget as HTMLSelectElement).value });
  }

  function installEnvironment() {
    dispatch("installenv");
  }

  function saveAlias() {
    if (!view.selected) return;
    dispatch("alias", { id: view.selected.id, alias: aliasDraft });
  }

  function saveSource() {
    dispatch("settings", { coreSourceUrl: sourceDraft });
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dropActive = false;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    if (imageMode === "layout") {
      const selected = files.slice(0, isWall ? MAX_CARD_IMAGES : 1);
      const payload = await Promise.all(selected.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      dispatch("dropimages", { files: payload, append: isWall });
      return;
    }
    const file = files[0];
    const bytes = new Uint8Array(await file.arrayBuffer());
    dispatch("dropimage", { name: file.name, bytes, append: false });
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dropActive = true;
  }
</script>

<div class="tc-app" bind:this={rootEl} tabindex="-1" on:keydown={onRootKeydown}>
  <header class="hero">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="28" height="28">
          <rect x="5" y="3" width="22" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/>
          <path d="M10 10h12M10 16h12M10 22h7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="24" cy="24" r="5" fill="var(--tc-accent)" stroke="var(--b3-theme-background)" stroke-width="2"/>
        </svg>
      </div>
      <div class="brand-text">
        <div class="title">土豆片通用 <span class="sub">TodooCard General</span></div>
        <div class="statusline">
          {#if view.core.ready}
            <span class="dot ok"></span>核心就绪
            <span class="sep">·</span>
            <button class="link" on:click={() => dispatch("install")} disabled={!canInstallCore}
              title={canInstallCore ? "重新下载核心" : "请先在环境检查中完成运行环境安装"}>重新下载</button>
          {:else if view.core.installed}
            <span class="dot warn"></span>核心待完成 Python 环境
          {:else}
            <span class="dot warn"></span>核心未安装
          {/if}
          {#if view.prereq.checked && view.prereq.errors.length}
            <span class="sep">·</span><span class="warn-text">环境待处理</span>
          {/if}
        </div>
      </div>
    </div>
    <div class="hero-actions">
      <button class="b3-button b3-button--outline small" on:click={() => dispatch("opendir")} title={view.stateDir}>数据目录</button>
      <button class="b3-button b3-button--outline small" on:click={() => dispatch("recheck")} disabled={view.job.running}>环境复检</button>
    </div>
  </header>

  {#if view.job.running}
    <div class="jobbar" class:busy={view.job.canCancel}>
      <span class="spinner" aria-hidden="true"></span>
      <span class="job-message">{view.job.message || "处理中…"}</span>
      {#if view.job.canCancel}
        <button class="b3-button b3-button--text small" on:click={() => dispatch("cancel")}>取消</button>
      {/if}
    </div>
  {/if}

  {#if !view.core.installed}
    <div class="body onboard">
      <div class="onboard-card">
        <h2>首次使用：下载通用核心</h2>
        <p>
          本插件不内置发送逻辑，核心来自
          <a href="https://github.com/Gt841/plugin-todoocard-general-core" target="_blank" rel="noreferrer">Gt841/plugin-todoocard-general-core</a>。
          点击下载后会保存到思源同步范围之外的目录，并从核心自带的 Python 代码创建虚拟环境；
          之后扫描、配对、传图都调用这份通用核心。
        </p>
        <div class="checklist">
          <div class:ok={view.prereq.python || view.prereq.venvReady} class="check">
            <span class="check-dot"></span>Python 3.9+{#if view.prereq.pythonVersion} · {view.prereq.pythonVersion}{/if}
          </div>
          <div class:ok={view.prereq.platformSupported} class="check">
            <span class="check-dot"></span>{platformLabel}
          </div>
          <div class:ok={view.prereq.venvReady} class="check">
            <span class="check-dot"></span>核心依赖（安装核心时自动创建）
          </div>
        </div>
        {#if !view.prereq.checked}
          <p class="fineprint">正在检查运行环境…</p>
        {/if}
        {#if view.prereq.errors.length}
          <ul class="errors">
            {#each view.prereq.errors as err}<li>{err}</li>{/each}
          </ul>
        {/if}
        {#if view.envInstalling}
          <p class="fineprint">正在等待系统安装完成，插件会自动复查…</p>
        {/if}
        {#if !envReady && canAutoInstallEnv}
          <div class="env-actions">
            <button class="b3-button b3-button--outline accent" on:click={installEnvironment}
              disabled={view.envInstalling || view.job.running}>
              {view.envInstalling ? "等待安装完成…" : "安装运行环境"}
            </button>
            <button class="b3-button b3-button--outline small" on:click={() => dispatch("recheck")}
              disabled={view.job.running}>重新检查</button>
          </div>
          <p class="fineprint">{envHint}</p>
        {/if}
        <div class="source-line">
          <span>核心来源</span>
          <input class="b3-text-field" bind:value={sourceDraft} spellcheck="false" />
        </div>
        <div class="source-line">
          <span>下载线路</span>
          <select class="b3-select" value={view.settings.downloadMirror} on:change={onMirror}>
            {#each MIRROR_PRESETS as m}<option value={m.value}>{m.label}</option>{/each}
          </select>
        </div>
        <p class="fineprint">国内网络较慢或无法访问 GitHub 时可选择第三方加速；固定 commit 来源会用预置 SHA-256 校验，不匹配就拒绝安装。</p>
        <div class="onboard-actions">
          <button class="b3-button b3-button--text small" on:click={saveSource} disabled={view.job.running}>保存源</button>
          <button class="b3-button b3-button--outline" on:click={() => dispatch("install")} disabled={!canInstallCore}>
            下载核心
          </button>
        </div>
        {#if !envReady}
          <p class="fineprint">核心下载已锁定：请先完成上方运行环境检查与安装。</p>
        {/if}
        <p class="fineprint">下载与安装只写本地目录；插件与配对信息不会进入思源数据同步。</p>
      </div>
    </div>
  {:else}
    {#if view.prereq.errors.length}
      <div class="prereq-warn">
        {#each view.prereq.errors as err}<div>{err}</div>{/each}
      </div>
    {/if}

    <nav class="tabs">
      <button class="tab" class:active={tab === "image"} on:click={() => (tab = "image")}>
        图片{#if view.prepared}<span class="badge ok">✓</span>{/if}
      </button>
      <button class="tab" class:active={tab === "devices"} on:click={() => (tab = "devices")}>
        设备
        {#if view.compatibleCount}<span class="badge">{view.compatibleCount}</span>{/if}
      </button>
      <button class="tab" class:active={tab === "settings"} on:click={() => (tab = "settings")}>设置</button>
    </nav>

    <div class="body" class:image-body={tab === "image"}>
      {#if tab === "devices"}
        <div class="device-layout">
          <section class="devices">
            <div class="tc-toolbar">
              <input class="b3-text-field search" placeholder="搜索名称 / ID / 备注" value={view.filters.q}
                on:input={onSearch} />
              <button class="b3-button b3-button--outline scan-btn" class:scanning={view.scan.running}
                on:click={() => dispatch(view.scan.running ? "stopscan" : "scan")} disabled={view.job.running && !view.scan.running}>
                {#if view.scan.running}
                  停止{view.scan.secondsLeft ? ` (${view.scan.secondsLeft}s)` : ""}
                {:else}
                  扫描设备
                {/if}
              </button>
            </div>
            <div class="filters">
              <button class="chip" class:active={view.filters.onlyCompatible} on:click={() => applyFilters({ onlyCompatible: !view.filters.onlyCompatible })}>仅兼容</button>
              <button class="chip" class:active={view.filters.onlyPairing} on:click={() => applyFilters({ onlyPairing: !view.filters.onlyPairing })}>配对窗口</button>
              <button class="chip" class:active={view.filters.onlyPaired} on:click={() => applyFilters({ onlyPaired: !view.filters.onlyPaired })}>已配对</button>
              <select class="b3-select sort" value={view.filters.sort} on:change={onSort}>
                <option value="rssi">按信号</option>
                <option value="name">按名称</option>
              </select>
              <span class="count">{view.devices.length} / {view.allDeviceCount}</span>
            </div>

            <div class="list">
              {#if view.devices.length === 0}
                <div class="empty">
                  {#if view.scan.running}
                    正在搜索…发现兼容设备会立即出现在这里
                  {:else if view.allDeviceCount === 0}
                    还没有扫描结果。点击「扫描设备」，并让卡片处于附近。
                  {:else}
                    当前筛选条件下没有设备。可放宽筛选或重新扫描。
                  {/if}
                </div>
              {:else}
                {#each view.devices as d (d.id)}
                  <button class="device-row" class:selected={d.id === view.selectedId} on:click={() => dispatch("select", d.id)}>
                    <span class="signal" title={d.live ? `RSSI ${d.rssi}` : "不在附近"}>
                      {#if d.live}
                        <i style={`height:${Math.max(3, Math.min(12, Math.round((100 + d.rssi) / 4)))}px`}></i>
                      {:else}
                        <i class="offline"></i>
                      {/if}
                    </span>
                    <span class="device-main">
                      <span class="device-name">
                        {nameOf(d)}
                        {#if d.paired}<span class="tag paired">已配对</span>{/if}
                        {#if d.pairingOpen}<span class="tag pairing">配对窗口</span>{/if}
                        {#if d.recovery}<span class="tag danger">恢复模式</span>{/if}
                      </span>
                      <span class="device-sub">
                        <code>{shortId(d.id)}…</code>
                        {#if d.live}<span>{d.rssi} dBm</span>{/if}
                        {#if d.firmware != null}<span>{fwLabel(d.firmware)}</span>{/if}
                        {#if !d.compatible}<span class="tag muted">非 TodooCard</span>{/if}
                      </span>
                    </span>
                    <span class="chev">›</span>
                  </button>
                {/each}
              {/if}
            </div>
            <p class="hint">默认只显示 TodooCard 兼容设备（0x5053 / 0x134C）；关闭「仅兼容」可查看周围所有 BLE 设备。</p>
          </section>

          <section class="detail">
            {#if view.selected}
              <div class="detail-head">
                <div>
                  <h3>{nameOf(view.selected)}</h3>
                  <div class="uuid">
                    <code>{view.selected.id}</code>
                    <button class="link" on:click={() => copy(view.selected.id, "uuid")}>
                      {copiedId === "uuid" ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
                <span class="pill" class:live={view.selected.live}>{view.selected.live ? "在附近" : "不在附近"}</span>
              </div>

              <dl class="facts">
                <div><dt>固件</dt><dd>{fwLabel(view.selected.firmware)}</dd></div>
                <div><dt>安全协议</dt><dd>{view.selected.secure ? "是（加密 GATT）" : "否 / 未知"}</dd></div>
                <div><dt>配对窗口</dt><dd>{view.selected.pairingOpen ? "已打开" : "关闭"}</dd></div>
                <div><dt>Turbo</dt><dd>{view.selected.turbo ? "支持" : "不支持"}</dd></div>
                <div><dt>上次配对</dt><dd>{fmtTime(view.selected.lastPairedAt)}</dd></div>
                <div><dt>上次发送</dt><dd>{fmtTime(view.selected.lastSendAt)}</dd></div>
              </dl>

              <div class="alias-edit">
                <label for="tc-alias">备注名</label>
                <div class="alias-line">
                  <input id="tc-alias" class="b3-text-field" bind:value={aliasDraft} placeholder="例如：书桌卡片" maxlength="24" />
                  <button class="b3-button b3-button--outline small" on:click={saveAlias} disabled={view.job.running}>保存</button>
                </div>
              </div>

              {#if !view.selected.live}
                <div class="notice">
                  {#if view.selected.paired}
                    该设备当前不在附近。已配对设备可直接探测，也可按设备 ID 发送。
                  {:else}
                    该设备当前不在附近。配对前请先重新扫描。
                  {/if}
                </div>
              {/if}
              {#if view.selected.recovery}
                <div class="notice danger">设备处于 OTA 恢复模式（能力位 0x08），上游协议会拒绝传图。</div>
              {/if}

              {#if pairConfirm}
                <div class="confirm-box">
                  <div class="confirm-title">准备与这台卡片建立系统配对</div>
                  <ol>
                    <li>长按卡片背面按钮 <b>{view.selected.firmware != null && view.selected.firmware >= 0x98 ? "5" : "10"} 秒</b>，直到正面灯快闪。</li>
                    <li>点击下方「开始配对」，本插件会等待配对窗口打开。</li>
                    <li>若系统弹出蓝牙配对提示，请点「允许 / 配对」。</li>
                  </ol>
                  <p class="fineprint">配对会改变系统蓝牙绑定。窗口最长 60 秒。</p>
                  <div class="confirm-actions">
                    <button class="b3-button b3-button--outline" on:click={() => (pairConfirm = false)}>取消</button>
                    <button class="b3-button b3-button--outline accent" on:click={() => { pairConfirm = false; dispatch("pair", view.selected.id); }}>开始配对</button>
                  </div>
                </div>
              {:else}
                <div class="detail-actions">
                  <button class="b3-button b3-button--outline accent" disabled={!view.selected.live || view.job.running}
                    on:click={() => (pairConfirm = true)}>配对</button>
                  <button class="b3-button b3-button--outline"
                    disabled={(!view.selected.live && !view.selected.paired) || view.job.running}
                    title={view.selected.paired && !view.selected.live ? "已配对设备可直接按设备 ID 探测，无需重新扫描" : ""}
                    on:click={() => dispatch("probe", view.selected.id)}>探测</button>
                  <button class="b3-button b3-button--text small danger-text"
                    on:click={() => dispatch("forget", view.selected.id)}>移除记录</button>
                </div>
              {/if}
            {:else}
              <div class="empty detail-empty">
                <div class="empty-art">◫</div>
                从左侧选择一台设备。首次使用先扫描，再按设备 ID 配对。
              </div>
            {/if}
          </section>
        </div>
      {/if}

      {#if tab === "image"}
        <div class="image-layout">
          <section class="preview">
            <div class="preview-frame" class:drop={dropActive}
              on:dragover={onDragOver} on:dragleave={() => (dropActive = false)} on:drop={onDrop}>
              {#if view.prepared && previewMode === "payload" && (view.image || view.images.length)}
                <canvas bind:this={canvasEl} class="shot payload-canvas"></canvas>
              {:else if imageMode === "layout" && view.images.length}
                <canvas bind:this={cardCanvasEl} class="shot card-canvas"></canvas>
              {:else if imageMode === "direct" && view.image}
                <canvas bind:this={cropCanvasEl} bind:clientWidth={cropW} bind:clientHeight={cropH}
                  class="shot crop-canvas" class:dragging={cropDragging}
                  on:pointerdown={onCropPointerDown}
                  on:pointermove={onCropPointerMove}
                  on:pointerup={onCropPointerUp}
                  on:pointercancel={onCropPointerUp}
                  on:wheel|nonpassive={onCropWheel}></canvas>
              {:else}
                <div class="dropzone">
                  <div class="drop-icon">＋</div>
                  {#if imageMode === "layout"}
                    <div>{isWall ? "拖入一张或多张图片" : "拖入一张图片"}</div>
                    <div class="fineprint">
                      {isWall ? `最多 ${MAX_CARD_IMAGES} 张` : "单图版式"} · JPG / PNG / HEIC
                    </div>
                  {:else}
                    <div>拖入图片，或从剪贴板粘贴截图</div>
                    <div class="fineprint">JPG / PNG / HEIC，最大 100 MB / 5000 万像素</div>
                  {/if}
                </div>
              {/if}
            </div>
            {#if imageMode === "direct" && view.image && !(view.prepared && previewMode === "payload")}
              <div class="crop-controls">
                <span class="crop-label">缩放</span>
                <input type="range" min="1" max="5" step="0.02" value={cropZoom}
                  on:input={onCropScale} aria-label="取景缩放" />
                <span class="crop-scale">{Math.round(cropZoom * 100)}%</span>
                <button class="link" on:click={() => resetCrop()}>重置构图</button>
              </div>
            {/if}
            {#if cropError}<p class="crop-error">{cropError}</p>{/if}
            {#if imageMode === "layout"}
              {#if view.images.length}
                <div class="preview-meta">
                  <span>528×792</span>
                  <span>{isWall ? `${view.images.length} 张图片` : "单图版式"}</span>
                  <span class="ellipsis">{layoutName}</span>
                </div>
              {/if}
              {#if isWall && view.images.length}
                <div class="source-strip left-strip">
                  {#each view.images as img, i (img.path)}
                    <div class="source-thumb">
                      <img src={img.dataUrl} alt="" />
                      <button class="thumb-remove" title="移除" on:click={() => dispatch("removeimage", img.path)}
                        disabled={view.job.running}>×</button>
                      {#if i > 0}
                        <button class="thumb-move left" title="前移" on:click={() => dispatch("moveimage", { path: img.path, delta: -1 })}
                          disabled={view.job.running}>‹</button>
                      {/if}
                      {#if i < view.images.length - 1}
                        <button class="thumb-move right" title="后移" on:click={() => dispatch("moveimage", { path: img.path, delta: 1 })}
                          disabled={view.job.running}>›</button>
                      {/if}
                    </div>
                  {/each}
                  {#if view.images.length < MAX_CARD_IMAGES}
                    <button class="source-add" title="添加图片" on:click={addImagesAction}
                      disabled={view.job.running}>＋</button>
                  {/if}
                </div>
              {/if}
              <div class="source-actions left-actions">
                <button class="b3-button b3-button--outline small" on:click={addImagesAction}
                  disabled={view.job.running || (isWall && view.images.length >= MAX_CARD_IMAGES)}>
                  {view.images.length && !isWall ? "更换图片" : "添加图片"}
                </button>
                <button class="b3-button b3-button--outline small" on:click={bingAction}
                  title="Bing 最近 8 天的壁纸；获取后再次点击可切换"
                  disabled={view.job.running || (isWall && view.images.length >= MAX_CARD_IMAGES)}>
                  {bingBusy ? "获取中…" : bingLabel}
                </button>
                <button class="b3-button b3-button--text small" on:click={pasteAction}
                  disabled={view.job.running || (isWall && view.images.length >= MAX_CARD_IMAGES)}>粘贴截图</button>
                <button class="b3-button b3-button--text small" on:click={() => dispatch("clearimage")}
                  disabled={view.job.running || !view.images.length}>清空</button>
              </div>
              <p class="crop-hint">
                {isWall ? "照片墙可放 2–6 张，左右箭头调整顺序。" : "当前版式只使用第 1 张图片。"}
                预览即发送画面；改字段或版式后需重新生成。
              </p>
            {:else if imageMode === "direct" && view.image}
              <div class="preview-meta">
                <span>{view.image.width}×{view.image.height}</span>
                <span>{fmtBytes(view.image.bytes)}</span>
                <span class="ellipsis">{view.image.name}</span>
              </div>
              <p class="crop-hint">取景框即发送画面，改动后需重新生成。</p>
            {/if}
          </section>

          <section class="image-controls">
            <div class="mode-seg">
              <button class:active={imageMode === "direct"} on:click={() => setImageMode("direct")}>直接发送</button>
              <button class:active={imageMode === "layout"} on:click={() => setImageMode("layout")}>卡片排版</button>
            </div>

            {#if imageMode === "direct"}
              <div class="button-grid">
                <button class="b3-button b3-button--outline" on:click={() => dispatch("pickimage")} disabled={view.job.running}>选择图片</button>
                <button class="b3-button b3-button--outline" on:click={() => dispatch("paste", { append: false })} disabled={view.job.running}>粘贴截图</button>
                <button class="b3-button b3-button--text" on:click={() => dispatch("clearimage")} disabled={view.job.running || !view.image}>清空</button>
              </div>

              <label class="checkline" title="屏幕方向由上游固定为 TodooCard/T3 面板校准，不提供屏幕方向覆盖。">
                <input type="checkbox" checked={view.settings.rotateRight90}
                  on:change={onRotate} />
                源图横竖方向不对（向右旋转 90°）
              </label>
            {:else}
              <div class="layout-block">
                <div class="prepare-title">版式</div>
                <div class="layout-presets">
                  {#each CARD_LAYOUTS as preset (preset.id)}
                    <button class="preset" class:active={cardStyle.layout === preset.id}
                      on:click={() => applyCardLayout(preset.id)} disabled={view.job.running}>
                      <span class="preset-name">{preset.name}</span>
                      <span class="preset-hint">{preset.hint}</span>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="layout-block">
                <div class="text-head">
                  <div class="prepare-title">文字</div>
                  <label class="text-switch" title="关闭后卡片只保留图片，标题、日期和一句话不会出现在画面上">
                    <input type="checkbox" checked={showText} on:change={onTextToggle} disabled={view.job.running} />
                    显示文字
                  </label>
                </div>
                {#if showText}
                  <div class="field-row">
                    <label for="tc-card-title">标题</label>
                    <input id="tc-card-title" class="b3-text-field" bind:value={cardFields.title}
                      on:input={onCardFieldsChanged} maxlength="24" placeholder="例如：山间的清晨" />
                  </div>
                  <div class="field-row">
                    <label for="tc-card-date">日期</label>
                    <input id="tc-card-date" type="date" class="b3-text-field" bind:value={cardFields.date}
                      on:input={onCardFieldsChanged} />
                    <span class="field-note">{formatCardDate(cardFields.date) || "不显示"}</span>
                  </div>
                  <div class="field-row">
                    <label for="tc-card-note">一句话</label>
                    <input id="tc-card-note" class="b3-text-field" bind:value={cardFields.note}
                      on:input={onCardFieldsChanged} maxlength="60" placeholder="例如：把今天的光景留在卡片上" />
                  </div>
                {:else}
                  <p class="fineprint">已关闭：标题、日期和一句话不显示，重新打开后保留已填内容。</p>
                {/if}
              </div>

              <div class="layout-block">
                <div class="prepare-title">样式</div>
                <div class="style-grid">
                  <label class="checkline">
                    <input type="checkbox" checked={cardStyle.radius > 0} on:change={onCardRadius} />
                    圆角
                  </label>
                  <label class="checkline">
                    <input type="checkbox" checked={cardStyle.border} on:change={onCardBorder} />
                    边框
                  </label>
                  <label class="checkline" class:muted={!showText} title={showText ? "" : "文字关闭时信息带不会显示"}>
                    <input type="checkbox" checked={cardStyle.infoBand} on:change={onCardInfoBand}
                      disabled={!showText} />
                    底部信息带
                  </label>
                </div>
                <div class="field-row">
                  <label for="tc-card-margin">留白</label>
                  <input id="tc-card-margin" type="range" min="0" max="48" step="4"
                    value={cardStyle.margin} on:input={onCardMargin} />
                  <span class="field-note">{cardStyle.margin}px</span>
                </div>
              </div>
            {/if}

            <div class="prepare-block">
              <div class="prepare-title">生成并校验</div>
              {#if view.prepared}
                <div class="ok-line">
                  <span class="dot ok"></span>
                  已通过上游转换与校验（{fmtTime(view.prepared.at)}）
                </div>
                <dl class="facts compact">
                  <div><dt>控制器位图</dt><dd>{fmtBytes(view.prepared.bytes)}</dd></div>
                  <div><dt>输入画面</dt><dd>{preparedInputLabel(view.prepared.inputKind)}</dd></div>
                  <div><dt>v157+ payload</dt><dd>{fmtBytes(view.prepared.qlzBytes)}</dd></div>
                  <div><dt>legacy payload</dt><dd>{fmtBytes(view.prepared.legacyBytes)}</dd></div>
                </dl>
                <div class="seg">
                  <button class:active={previewMode === "original"} on:click={() => (previewMode = "original")}>构图</button>
                  <button class:active={previewMode === "payload"} on:click={() => (previewMode = "payload")}>卡片效果</button>
                </div>
              {/if}
              <button class="b3-button b3-button--outline block" class:dim={!canPrepare}
                on:click={onPrepare} disabled={prepareBusy || view.job.running}>
                {prepareBusy
                  ? (imageMode === "layout" ? "正在生成排版卡片…" : "正在生成裁剪图…")
                  : view.prepared ? "重新生成" : "生成预览"}
              </button>
            </div>

            <div class="send-block">
              <div class="send-head">
                <span class="prepare-title">发送目标</span>
                <span class="send-count">{targetIds.length} / {view.pairedDevices.length} 台</span>
                {#if view.pairedDevices.length > 1}
                  <span class="send-actions">
                    <button class="link" on:click={selectAllTargets}
                      disabled={view.job.running || targetIds.length === view.pairedDevices.length}>全选</button>
                    <button class="link" on:click={clearTargets}
                      disabled={view.job.running || targetIds.length === 0}>清空</button>
                  </span>
                {/if}
              </div>

              {#if view.pairedDevices.length === 0}
                <div class="notice">
                  还没有已配对的卡片。
                  <button class="link" on:click={() => (tab = "devices")}>去设备页配对</button>
                </div>
              {:else}
                <div class="target-list">
                  {#each view.pairedDevices as d (d.id)}
                    <button type="button" class="target-row" class:selected={targetIds.includes(d.id)}
                      aria-pressed={targetIds.includes(d.id)} disabled={view.job.running}
                      on:click={() => toggleTarget(d.id)}>
                      <span class="target-check" class:on={targetIds.includes(d.id)} aria-hidden="true">✓</span>
                      <span class="target-main">
                        <span class="target-name">
                          {nameOf(d)}
                          <span class="target-live" class:live={d.live}>{d.live ? "已发现" : "未扫描"}</span>
                        </span>
                        <code class="target-id">{shortId(d.id)}…</code>
                      </span>
                      {#if d.recovery}<span class="tag danger">恢复</span>{/if}
                    </button>
                  {/each}
                </div>
                <button class="b3-button b3-button--outline accent send-btn block"
                  class:dim={!(imageMode === "layout" ? view.images.length : view.image) || !view.prepared || targetIds.length === 0}
                  on:click={requestSend} disabled={view.job.running}>
                  {targetIds.length > 1 ? `发送到 ${targetIds.length} 台卡片` : "发送到卡片"}
                </button>
              {/if}
            </div>
          </section>
        </div>
      {/if}

      {#if tab === "settings"}
        <div class="settings">
          <section>
            <h4>核心来源</h4>
            <p class="fineprint">默认是通用核心仓库；需要更新时把地址改成新的 commit 或 <code>main</code>，再点下方「下载 / 更新核心」。核心以 MIT 协议发布，会安装到本机数据目录。</p>
            <div class="source-line">
              <input class="b3-text-field" bind:value={sourceDraft} spellcheck="false" />
              <button class="b3-button b3-button--outline small" on:click={saveSource} disabled={view.job.running}>保存</button>
            </div>
            <div class="source-line">
              <span>下载线路</span>
              <select class="b3-select" value={view.settings.downloadMirror} on:change={onMirror}>
                {#each MIRROR_PRESETS as m}<option value={m.value}>{m.label}</option>{/each}
              </select>
            </div>
            <p class="fineprint">第三方加速仅改变下载地址；固定 commit 来源会用预置 SHA-256 校验，不匹配就拒绝安装。</p>
            <div class="kv">
              <span>已安装</span>
              <span>{view.core.ready ? "已就绪" : view.core.installed ? "缺少 Python 环境" : "未安装"}</span>
            </div>
            {#if view.core.installed}
              <div class="kv"><span>版本</span><span>{view.core.ref || "本地目录"}</span></div>
            {/if}
            {#if view.core.sha256}
              <div class="kv"><span>包 SHA-256</span><code>{view.core.sha256.slice(0, 16)}…</code></div>
            {/if}
            {#if view.core.installedAt}
              <div class="kv"><span>安装时间</span><span>{fmtTime(view.core.installedAt)}</span></div>
            {/if}
            {#if view.core.venvReady}
              <div class="kv"><span>Python 环境</span><code>{view.core.venvPython}</code></div>
            {/if}
            <button class="b3-button b3-button--outline accent" on:click={() => dispatch("install")} disabled={!canInstallCore}
              title={canInstallCore ? "下载 / 更新核心" : "请先完成运行环境检查与安装"}>下载 / 更新核心</button>
            {#if !envReady}
              <p class="fineprint">核心下载已锁定：请先在下方「环境」中完成检查与安装。</p>
            {/if}
          </section>

          <section>
            <h4>存储位置</h4>
            <p class="fineprint">核心、Python 虚拟环境、设备备注、配对记录、上次选择都存放在思源 <code>data/</code> 之外，不参与思源数据同步。</p>
            <code class="block-code">{view.stateDir}</code>
            <button class="b3-button b3-button--outline small" on:click={() => dispatch("opendir")}>打开目录</button>
          </section>

          <section>
            <h4>环境</h4>
            <div class="checklist inline">
              <div class:ok={view.prereq.python || view.prereq.venvReady} class="check">
                <span class="check-dot"></span>Python 3.9+{#if view.prereq.pythonVersion} · {view.prereq.pythonVersion}{/if}
              </div>
              <div class:ok={view.prereq.platformSupported} class="check"><span class="check-dot"></span>{platformLabel}</div>
              <div class:ok={view.prereq.venvReady} class="check"><span class="check-dot"></span>核心依赖</div>
            </div>
            {#if !view.prereq.checked}
              <p class="fineprint">正在检查运行环境…</p>
            {/if}
            {#if view.prereq.errors.length}
              <ul class="errors">{#each view.prereq.errors as err}<li>{err}</li>{/each}</ul>
            {/if}
            {#if view.envInstalling}
              <p class="fineprint">正在等待系统安装完成，插件会自动复查…</p>
            {/if}
            <div class="env-actions">
              {#if !envReady && canAutoInstallEnv}
                <button class="b3-button b3-button--outline accent" on:click={installEnvironment}
                  disabled={view.envInstalling || view.job.running}>
                  {view.envInstalling ? "等待安装完成…" : "安装运行环境"}
                </button>
              {/if}
              <button class="b3-button b3-button--outline small" on:click={() => dispatch("recheck")} disabled={view.job.running}>重新检查</button>
            </div>
            {#if !envReady && canAutoInstallEnv}
              <p class="fineprint">{envHint}</p>
            {/if}
          </section>

          <section>
            <h4>发送偏好</h4>
            <label class="checkline">
              <input type="checkbox" checked={view.settings.autoProbeAfterPair}
                on:change={onAutoProbe} />
              配对成功后自动探测验证
            </label>
            <p class="fineprint">配对成功后自动跑一次探测，确认固件与能力位。</p>
          </section>

          <section>
            <h4>使用说明</h4>
            <ol class="tips">
              <li>打开卡片附近，点「扫描设备」；默认只列出兼容的 TodooCard。</li>
              <li>首次连接：选中设备 → 配对 → 长按背面按钮 5 秒（旧固件 10 秒）→ 允许系统配对提示。</li>
              <li>选择图片或直接粘贴截图，生成预览确认六色效果后，勾选已配对卡片发送（支持多选，逐台写入）。</li>
              <li>发送成功以卡片的 <code>0x05/0x08</code> 刷新确认为准；断连不代表成功。</li>
            </ol>
          </section>
        </div>
      {/if}
    </div>
  {/if}

  {#if sendConfirm}
    <div class="confirm-overlay" role="dialog" aria-modal="true" aria-label="确认发送"
      on:click|self={() => (sendConfirm = false)}
      on:keydown|self={(e) => { if (e.key === "Escape") sendConfirm = false; }}>
      <div class="confirm-modal">
        <div class="confirm-title">确认发送到 {targetIds.length} 台卡片？</div>
        <p>发送会依次替换这些卡片的当前画面，直到下一次成功发送：</p>
        <ul class="target-confirm">
          {#each selectedTargets as d (d.id)}
            <li>
              <span class="target-confirm-name">{nameOf(d)}</span>
              <code>{d.id}</code>
              {#if !d.live}<span class="tag muted">未扫描</span>{/if}
              {#if d.recovery}<span class="tag danger">恢复模式</span>{/if}
            </li>
          {/each}
        </ul>
        <p class="fineprint">发送过程中请保持卡片在附近、蓝牙开启，不要关闭面板。只有收到 0x05/0x08 显影确认才算成功。</p>
        <div class="confirm-actions">
          <button class="b3-button b3-button--outline" on:click={() => (sendConfirm = false)}>取消</button>
          <button class="b3-button b3-button--outline accent" on:click={confirmSend}>确认发送</button>
        </div>
      </div>
    </div>
  {/if}

  {#if toastMessage}
    <div class="toast" role="status" aria-live="polite">{toastMessage}</div>
  {/if}

  <div class="logbar" class:open={logOpen}>
    <div class="log-head">
      <button class="log-title" on:click={() => (logOpen = !logOpen)}>
        <span class="chev-up" class:open={logOpen}>›</span>
        运行日志
        {#if view.log.length}<span class="log-last">{view.log[view.log.length - 1]}</span>{/if}
      </button>
      <div class="log-actions">
        {#if view.job.running && view.job.canCancel}
          <button class="link danger-text" on:click={() => dispatch("cancel")}>取消任务</button>
        {/if}
        <button class="link" on:click={() => dispatch("clearLog")}>清空</button>
      </div>
    </div>
    {#if logOpen}
      <pre class="log-body">{view.log.join("\n") || "暂无日志"}</pre>
    {/if}
  </div>
</div>

<style>
  .tc-app {
    position: relative;
    --tc-accent: #e59a2f;
    --tc-accent-strong: #c97f16;
    --tc-green: #3a9b63;
    --tc-red: #d05353;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    font-size: 13px;
    outline: none;
  }
  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--b3-border-color);
    background: linear-gradient(180deg, color-mix(in srgb, var(--tc-accent) 7%, var(--b3-theme-background)), var(--b3-theme-background));
  }
  .brand { display: flex; gap: 10px; align-items: center; }
  .logo { color: var(--b3-theme-on-background); display: flex; }
  .title { font-size: 17px; font-weight: 650; letter-spacing: 0.02em; }
  .sub { font-size: 11px; font-weight: 500; opacity: 0.55; margin-left: 4px; letter-spacing: 0.08em; }
  .statusline { display: flex; align-items: center; gap: 5px; font-size: 12px; opacity: 0.85; margin-top: 3px; }
  .sep { opacity: 0.4; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--b3-theme-on-surface); display: inline-block; }
  .dot.ok { background: var(--tc-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tc-green) 18%, transparent); }
  .dot.warn { background: var(--tc-accent); }
  .warn-text { color: var(--tc-accent-strong); }
  .hero-actions { display: flex; gap: 6px; }
  .small { font-size: 12px; padding: 3px 8px; }
  .link { background: none; border: none; color: var(--tc-accent-strong); cursor: pointer; padding: 0; font-size: 12px; }
  .link:disabled { opacity: 0.4; cursor: default; }
  .jobbar {
    display: flex; align-items: center; gap: 9px; padding: 8px 18px;
    background: color-mix(in srgb, var(--tc-accent) 12%, var(--b3-theme-background));
    border-bottom: 1px solid var(--b3-border-color); font-size: 12px;
  }
  .job-message { flex: 1; }
  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--tc-accent) 30%, transparent);
    border-top-color: var(--tc-accent); animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px; }
  /* 图片页固定为面板高度：左右两栏各自滚动，设备再多也不会把页面拉长。 */
  .body.image-body { display: flex; flex-direction: column; overflow: hidden; }
  .onboard { display: flex; align-items: flex-start; justify-content: center; }
  .onboard-card {
    max-width: 560px; width: 100%; border: 1px solid var(--b3-border-color);
    border-radius: 10px; padding: 18px 20px; background: var(--b3-theme-surface);
    box-shadow: 0 6px 24px rgba(0,0,0,0.06);
  }
  .onboard-card h2 { margin: 0 0 8px; font-size: 16px; }
  .onboard-card p { margin: 0 0 12px; line-height: 1.6; opacity: 0.85; }
  .onboard-card a { color: var(--tc-accent-strong); }
  .checklist { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 14px; margin: 12px 0; }
  .checklist.inline { grid-template-columns: repeat(4, auto); justify-content: start; gap: 10px 16px; }
  .check { display: flex; align-items: center; gap: 7px; font-size: 12px; opacity: 0.9; }
  .check-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--tc-red); }
  .check.ok .check-dot { background: var(--tc-green); }
  .errors { margin: 8px 0; padding-left: 18px; color: var(--tc-red); font-size: 12px; line-height: 1.6; }
  .source-line { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
  .source-line span { font-size: 12px; opacity: 0.7; white-space: nowrap; }
  .source-line input { flex: 1; font-size: 12px; }
  .source-line select { flex: 1; min-width: 190px; font-size: 12px; }
  .env-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 6px; }
  .onboard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .fineprint { font-size: 11px; opacity: 0.55; line-height: 1.5; }
  .prereq-warn {
    margin: 0 18px 8px; padding: 9px 12px; border-radius: 6px; font-size: 12px;
    background: color-mix(in srgb, var(--tc-red) 10%, var(--b3-theme-background));
    border: 1px solid color-mix(in srgb, var(--tc-red) 35%, transparent);
  }
  .tabs { display: flex; gap: 2px; padding: 0 18px; border-bottom: 1px solid var(--b3-border-color); }
  .tab {
    background: none; border: none; border-bottom: 2px solid transparent; padding: 9px 12px 8px;
    color: var(--b3-theme-on-background); opacity: 0.65; cursor: pointer; font-size: 13px;
    display: flex; align-items: center; gap: 5px;
  }
  .tab.active { opacity: 1; border-bottom-color: var(--tc-accent); font-weight: 600; }
  .badge {
    font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 8px;
    background: color-mix(in srgb, var(--b3-theme-on-surface) 12%, transparent);
  }
  .badge.ok { color: var(--tc-green); background: color-mix(in srgb, var(--tc-green) 15%, transparent); }
  .device-layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 16px; }
  .devices, .detail { min-width: 0; }
  /* 不要命名为 .toolbar：思源在隐藏标题栏模式下有 `body.body--toolbar-hide .toolbar`
     全局规则，会把这里变成绝对定位的窗口工具栏并遮住整页内容。 */
  .tc-toolbar { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .search { flex: 1 1 auto; min-width: 0; width: auto; font-size: 12px; }
  .scan-btn { flex: none; white-space: nowrap; }
  .scan-btn.scanning { border-color: var(--tc-accent); color: var(--tc-accent-strong); }
  .filters { display: flex; align-items: center; gap: 6px; margin: 9px 0; flex-wrap: wrap; }
  .chip {
    border: 1px solid var(--b3-border-color); background: transparent; color: var(--b3-theme-on-background);
    border-radius: 999px; padding: 3px 10px; font-size: 11px; cursor: pointer; opacity: 0.75;
  }
  .chip.active {
    opacity: 1; border-color: var(--tc-accent);
    background: color-mix(in srgb, var(--tc-accent) 14%, transparent);
  }
  .sort { width: 90px; font-size: 11px; padding: 2px 6px; }
  .count { margin-left: auto; font-size: 11px; opacity: 0.55; }
  .list { display: flex; flex-direction: column; gap: 5px; max-height: 46vh; overflow: auto; padding-right: 2px; }
  .device-row {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    border: 1px solid var(--b3-border-color); background: var(--b3-theme-surface);
    border-radius: 8px; padding: 9px 11px; color: var(--b3-theme-on-background); cursor: pointer;
  }
  .device-row:hover { border-color: color-mix(in srgb, var(--tc-accent) 45%, var(--b3-border-color)); }
  .device-row.selected { border-color: var(--tc-accent); box-shadow: 0 0 0 1px var(--tc-accent) inset; }
  .signal { width: 18px; display: flex; align-items: flex-end; justify-content: center; height: 18px; }
  .signal i { width: 6px; border-radius: 2px; background: var(--tc-green); display: block; }
  .signal i.offline { height: 6px; background: var(--b3-theme-on-surface); opacity: 0.25; }
  .device-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .device-name { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device-sub { display: flex; align-items: center; gap: 10px; font-size: 11px; opacity: 0.65; }
  .device-sub code { font-size: 10px; }
  .chev { opacity: 0.35; font-size: 16px; }
  .tag {
    font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 999px;
    background: color-mix(in srgb, var(--b3-theme-on-surface) 10%, transparent); opacity: 0.9;
  }
  .tag.paired { color: var(--tc-green); background: color-mix(in srgb, var(--tc-green) 14%, transparent); }
  .tag.pairing { color: var(--tc-accent-strong); background: color-mix(in srgb, var(--tc-accent) 16%, transparent); }
  .tag.danger { color: var(--tc-red); background: color-mix(in srgb, var(--tc-red) 14%, transparent); }
  .tag.muted { opacity: 0.5; }
  .hint { font-size: 11px; opacity: 0.55; line-height: 1.5; margin: 9px 0 0; }
  .empty {
    border: 1px dashed var(--b3-border-color); border-radius: 8px; padding: 28px 16px;
    text-align: center; font-size: 12px; opacity: 0.6; line-height: 1.6;
  }
  .detail {
    border: 1px solid var(--b3-border-color); border-radius: 10px; padding: 14px;
    background: var(--b3-theme-surface); align-self: start;
  }
  .detail-empty { border: none; background: none; padding-top: 60px; }
  .empty-art { font-size: 30px; opacity: 0.25; margin-bottom: 8px; }
  .detail-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
  .detail-head h3 { margin: 0 0 5px; font-size: 15px; }
  .uuid { display: flex; align-items: center; gap: 8px; font-size: 10px; opacity: 0.7; flex-wrap: wrap; }
  .uuid code { font-size: 10px; word-break: break-all; }
  .pill { font-size: 10px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--b3-theme-on-surface) 10%, transparent); white-space: nowrap; }
  .pill.live { color: var(--tc-green); background: color-mix(in srgb, var(--tc-green) 14%, transparent); }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; margin: 14px 0; }
  .facts.compact { margin: 8px 0; }
  .facts > div { min-width: 0; }
  .facts dt { font-size: 10px; opacity: 0.55; margin-bottom: 1px; }
  .facts dd { margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alias-edit { margin-top: 4px; }
  .alias-edit label { font-size: 11px; opacity: 0.6; }
  .alias-line { display: flex; gap: 6px; margin-top: 4px; }
  .alias-line input { flex: 1; font-size: 12px; }
  .notice {
    margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 11px; line-height: 1.6;
    background: color-mix(in srgb, var(--tc-accent) 10%, var(--b3-theme-background));
    border: 1px solid color-mix(in srgb, var(--tc-accent) 30%, transparent);
  }
  .notice.danger { background: color-mix(in srgb, var(--tc-red) 10%, var(--b3-theme-background)); border-color: color-mix(in srgb, var(--tc-red) 30%, transparent); color: var(--tc-red); }
  .detail-actions { display: flex; gap: 7px; margin-top: 14px; align-items: center; flex-wrap: wrap; }
  .accent { border-color: var(--tc-accent); color: var(--tc-accent-strong); }
  .danger-text { color: var(--tc-red); }
  .confirm-box {
    margin-top: 12px; border: 1px solid color-mix(in srgb, var(--tc-accent) 45%, var(--b3-border-color));
    border-radius: 8px; padding: 12px; background: color-mix(in srgb, var(--tc-accent) 7%, var(--b3-theme-background));
  }
  .confirm-title { font-weight: 600; margin-bottom: 7px; }
  .confirm-box ol { margin: 6px 0; padding-left: 18px; line-height: 1.7; font-size: 12px; }
  .confirm-box p { line-height: 1.6; margin: 6px 0; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .block-code { display: block; padding: 7px 9px; background: var(--b3-theme-background); border-radius: 5px; font-size: 10px; word-break: break-all; margin: 6px 0; }
  .image-layout {
    display: grid; grid-template-columns: minmax(220px, 0.75fr) minmax(280px, 1fr); gap: 18px;
    flex: 1 1 auto; min-height: 0;
  }
  .preview { min-width: 0; min-height: 0; overflow: auto; padding-right: 2px; }
  .preview-frame {
    position: relative; width: 100%; max-width: 300px; margin: 0 auto;
    aspect-ratio: 2 / 3; border: 1px dashed var(--b3-border-color); border-radius: 10px;
    overflow: hidden; background: color-mix(in srgb, var(--b3-theme-on-surface) 4%, var(--b3-theme-background));
    display: flex; align-items: center; justify-content: center;
  }
  .preview-frame.drop { border-color: var(--tc-accent); background: color-mix(in srgb, var(--tc-accent) 10%, var(--b3-theme-background)); }
  .shot { width: 100%; height: 100%; object-fit: contain; image-rendering: auto; display: block; }
  canvas.payload-canvas { image-rendering: pixelated; }
  .crop-canvas { touch-action: none; cursor: grab; user-select: none; }
  .crop-canvas.dragging { cursor: grabbing; }
  .crop-controls {
    display: flex; align-items: center; gap: 7px; width: 100%; max-width: 300px;
    margin: 8px auto 0; font-size: 11px;
  }
  .crop-controls input[type="range"] { flex: 1; min-width: 0; accent-color: var(--tc-accent); }
  .crop-label { opacity: 0.55; }
  .crop-scale { width: 38px; text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .crop-hint { max-width: 300px; margin: 6px auto 0; font-size: 10px; line-height: 1.5; opacity: 0.5; text-align: center; }
  .crop-error { max-width: 300px; margin: 6px auto 0; font-size: 11px; color: var(--tc-red); text-align: center; }
  .dropzone { text-align: center; padding: 18px; font-size: 12px; line-height: 1.8; opacity: 0.7; }
  .drop-icon {
    width: 42px; height: 42px; margin: 0 auto 8px; border-radius: 50%;
    border: 1px dashed currentColor; display: flex; align-items: center; justify-content: center; font-size: 22px;
  }
  .preview-meta { display: flex; gap: 10px; font-size: 11px; opacity: 0.6; margin-top: 7px; flex-wrap: wrap; }
  .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .image-controls { min-width: 0; min-height: 0; overflow-y: auto; padding-right: 4px; }
  .button-grid { display: grid; grid-template-columns: 1fr 1fr auto; gap: 7px; }
  .mode-seg {
    display: flex; gap: 3px; padding: 3px; border-radius: 8px;
    background: color-mix(in srgb, var(--b3-theme-on-surface) 6%, var(--b3-theme-background));
    border: 1px solid var(--b3-border-color); margin-bottom: 12px;
  }
  .mode-seg button {
    flex: 1; border: none; background: none; color: inherit; cursor: pointer;
    padding: 6px 8px; border-radius: 6px; font-size: 12px; opacity: 0.6;
  }
  .mode-seg button.active {
    background: var(--b3-theme-background); opacity: 1; font-weight: 600;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  .layout-block { margin-top: 14px; }
  .source-strip { display: flex; flex-wrap: wrap; gap: 7px; }
  .left-strip { max-width: 300px; margin: 8px auto 0; justify-content: center; }
  .source-thumb {
    position: relative; width: 56px; height: 56px; border-radius: 7px; overflow: hidden;
    border: 1px solid var(--b3-border-color); flex: none;
    background: color-mix(in srgb, var(--b3-theme-on-surface) 5%, var(--b3-theme-background));
  }
  .source-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-remove {
    position: absolute; right: 2px; top: 2px; width: 16px; height: 16px; padding: 0;
    border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff;
    font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .thumb-move {
    position: absolute; bottom: 2px; width: 16px; height: 16px; padding: 0;
    border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff;
    font-size: 11px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .thumb-move.left { left: 2px; }
  .thumb-move.right { right: 2px; }
  .source-add {
    width: 56px; height: 56px; flex: none; border-radius: 7px; cursor: pointer;
    border: 1px dashed var(--b3-border-color); background: none; color: inherit;
    font-size: 18px; opacity: 0.6;
  }
  .source-add:hover { border-color: var(--tc-accent); opacity: 1; }
  .source-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .left-actions { max-width: 300px; margin: 8px auto 0; justify-content: center; }
  .layout-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .preset {
    display: flex; flex-direction: column; gap: 3px; text-align: left;
    padding: 8px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--b3-border-color); background: var(--b3-theme-background); color: inherit;
  }
  .preset:hover:not(:disabled) { border-color: color-mix(in srgb, var(--tc-accent) 45%, var(--b3-border-color)); }
  .preset.active {
    border-color: var(--tc-accent);
    background: color-mix(in srgb, var(--tc-accent) 8%, var(--b3-theme-background));
  }
  .preset:disabled { opacity: 0.6; cursor: default; }
  .preset-name { font-size: 12px; font-weight: 600; }
  .preset-hint { font-size: 10px; opacity: 0.55; line-height: 1.4; }
  .field-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
  .field-row > label { width: 38px; flex: none; font-size: 12px; opacity: 0.65; }
  .field-row .b3-text-field { flex: 1; min-width: 0; }
  .field-row input[type="range"] { flex: 1; min-width: 0; accent-color: var(--tc-accent); }
  .field-note { font-size: 11px; opacity: 0.55; min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; }
  .style-grid { display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .style-grid .checkline { margin: 0; }
  .checkline { display: flex; align-items: center; gap: 7px; font-size: 12px; margin: 10px 0 2px; }
  .prepare-block { margin-top: 16px; border-top: 1px solid var(--b3-border-color); padding-top: 12px; }
  .prepare-title { font-weight: 600; margin-bottom: 7px; }
  .text-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
  .text-head .prepare-title { margin-bottom: 0; }
  .text-switch { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.72; cursor: pointer; }
  .text-switch input { accent-color: var(--tc-accent); }
  .checkline.muted { opacity: 0.45; }
  .ok-line { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tc-green); margin: 5px 0; }
  .seg { display: inline-flex; border: 1px solid var(--b3-border-color); border-radius: 6px; overflow: hidden; margin: 7px 0; }
  .seg button { background: none; border: none; padding: 3px 10px; font-size: 11px; cursor: pointer; color: inherit; opacity: 0.6; }
  .seg button.active { background: var(--b3-theme-surface); opacity: 1; font-weight: 600; }
  .block { width: 100%; margin-top: 8px; }
  .send-block { margin-top: 16px; border-top: 1px solid var(--b3-border-color); padding-top: 12px; }
  .send-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .send-head .prepare-title { margin-bottom: 0; }
  .send-count { font-size: 11px; opacity: 0.55; }
  .send-actions { margin-left: auto; display: flex; gap: 10px; }
  .target-list {
    display: flex; flex-direction: column; gap: 5px; max-height: 126px;
    overflow: auto; padding-right: 2px;
  }
  .target-row {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    border: 1px solid var(--b3-border-color); background: var(--b3-theme-background);
    color: inherit; border-radius: 8px; padding: 8px 10px; cursor: pointer;
  }
  .target-row:hover:not(:disabled) { border-color: color-mix(in srgb, var(--tc-accent) 45%, var(--b3-border-color)); }
  .target-row.selected {
    border-color: var(--tc-accent);
    background: color-mix(in srgb, var(--tc-accent) 8%, var(--b3-theme-background));
  }
  .target-row:disabled { opacity: 0.6; cursor: default; }
  .target-check {
    width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--b3-border-color);
    display: flex; align-items: center; justify-content: center; font-size: 11px;
    color: transparent; flex: none;
  }
  .target-check.on { background: var(--tc-accent); border-color: var(--tc-accent); color: #fff; }
  .target-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .target-name {
    display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .target-live {
    font-size: 10px; font-weight: 400; padding: 1px 6px; border-radius: 999px;
    background: color-mix(in srgb, var(--b3-theme-on-surface) 10%, transparent); opacity: 0.6;
    flex: none;
  }
  .target-live.live { color: var(--tc-green); background: color-mix(in srgb, var(--tc-green) 14%, transparent); opacity: 1; }
  .target-id { font-size: 10px; opacity: 0.5; }
  .send-btn { padding: 10px; font-size: 14px; font-weight: 600; margin-top: 8px; }
  .send-btn.dim { opacity: 0.55; }
  .b3-button.dim { opacity: 0.6; }
  .toast {
    position: absolute; left: 50%; bottom: 54px; transform: translateX(-50%);
    z-index: 25; max-width: min(86%, 460px);
    padding: 9px 14px; border-radius: 8px;
    background: color-mix(in srgb, var(--b3-theme-on-background) 88%, transparent);
    color: var(--b3-theme-background); font-size: 12px; line-height: 1.5;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
    pointer-events: none; text-align: center;
    animation: toast-in 0.16s ease-out;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translate(-50%, 6px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  .target-confirm { margin: 6px 0; padding-left: 16px; display: flex; flex-direction: column; gap: 5px; font-size: 11px; }
  .target-confirm li { line-height: 1.5; }
  .target-confirm code { display: block; font-size: 10px; opacity: 0.6; word-break: break-all; }
  .target-confirm-name { font-weight: 600; margin-right: 5px; }
  .confirm-overlay {
    position: absolute; inset: 0; z-index: 30; padding: 22px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.36);
  }
  .confirm-modal {
    width: min(460px, 100%); max-height: 100%; overflow: auto;
    padding: 16px; border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--tc-red) 45%, var(--b3-border-color));
    background: var(--b3-theme-background);
    box-shadow: 0 22px 60px rgba(0, 0, 0, 0.35);
  }
  .confirm-modal p { line-height: 1.6; margin: 6px 0; }
  .confirm-modal .confirm-title { font-size: 14px; }
  .settings { display: flex; flex-direction: column; gap: 18px; max-width: 700px; }
  .settings section { border-bottom: 1px solid var(--b3-border-color); padding-bottom: 15px; }
  .settings h4 { margin: 0 0 7px; font-size: 13px; }
  .settings p { margin: 0 0 8px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; padding: 3px 0; }
  .kv > span:first-child { opacity: 0.6; }
  .kv code { font-size: 11px; }
  .tips { margin: 6px 0 0; padding-left: 18px; line-height: 1.8; font-size: 12px; opacity: 0.8; }
  .logbar { border-top: 1px solid var(--b3-border-color); background: var(--b3-theme-surface); flex: none; }
  .log-head { display: flex; align-items: center; gap: 8px; padding: 4px 14px; }
  .log-title {
    flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0;
    background: none; border: none; color: inherit; font-size: 11px; cursor: pointer; text-align: left; opacity: 0.75;
  }
  .chev-up { display: inline-block; transform: rotate(90deg); transition: transform 0.15s; opacity: 0.6; }
  .chev-up.open { transform: rotate(-90deg); }
  .log-last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.5; font-family: var(--b3-font-family-code); }
  .log-actions { display: flex; gap: 10px; }
  .log-body {
    max-height: 170px; overflow: auto; margin: 0; padding: 8px 14px 12px;
    font-family: var(--b3-font-family-code); font-size: 10.5px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-all; background: var(--b3-theme-background);
  }
  @media (max-width: 720px) {
    .body.image-body { display: block; overflow: auto; }
    .device-layout, .image-layout { grid-template-columns: 1fr; }
    .preview, .image-controls { overflow: visible; }
    .list { max-height: 32vh; }
  }
</style>
