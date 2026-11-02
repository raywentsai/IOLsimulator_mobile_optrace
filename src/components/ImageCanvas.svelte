<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import BadgeTag from "./BadgeTag.svelte";
  import bookImageAsset from "../lib/assets/images/book.png";
  import backgroundImageAsset from "../lib/assets/images/background.png";
  import {
    blurSigma,
    compareBlurSigma,
    backgroundBlurSigma,
    compareBackgroundBlurSigma,
    currentVADecimal,
    compareVADecimal,
    displayImageMode,
    masterDefocus,
    effectiveCssPxPerMm,
    calibrationScale,
    currentViewportScale,
    viewingDistance,
    nsGrade,
    pscRadius,
    pscDensity,
    pscSoftness,
    simulationMode,
    presbyopiaProfile,
    presbyopiaCompareProfile,
    splitViewEnabled,
    renderTime,
    frameRate,
  } from "../lib/stores/app";
  import type { DisplayImageMode } from "../lib/stores/app";
  import { defocusToDistance } from "../lib/optics/formulas";
  import {
    DEFAULT_BOOK_BASELINE_WIDTH_M,
    DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M,
    DEFAULT_BOOK_REFERENCE_VIEWING_DISTANCE_M,
    calculateForegroundWidthCssPx
  } from "../lib/optics/calibration";
  import {
    BACKGROUND_BLUR_DOWNSAMPLE_FACTOR,
    resolveBlurPolicy
  } from "../lib/render/blur-policy";
  import { WebGLRenderer, type RenderConfig, type WebGLErrorInfo, WebGLErrorType } from "../lib/render/gl/renderer";
  import { AdaptiveQuality } from "../lib/utils/performance";

  let canvas: HTMLCanvasElement;
  let renderer: WebGLRenderer | null = null;
  let animationFrame: number | null = null;
  let renderFrameCallback: ((timestamp: number) => Promise<void> | void) | null = null;
  let renderScheduled = false;
  let renderInFlight = false;
  let renderInvalidated = false;
  let resizeObserver: ResizeObserver | null = null;
  let imageTextureId: string | null = null;
  let backgroundTextureId: string | null = null;
  let isInitialized = false;
  let errorMessage = "";
  let loadingMessage = "Initializing...";
  let errorInfo: WebGLErrorInfo | null = null;
  let showErrorDetails = false;
  let loadingProgress = 0;
  let loadingSteps: string[] = [];
  let currentStep = 0;
  let showProgressBar = false;
  let foregroundImageWidth = 800;
  let foregroundImageHeight = 600;
  let backgroundImageWidth = 800;
  let backgroundImageHeight = 600;
  let isMounted = false;
  let canvasContainer: HTMLDivElement;
  let adaptiveQuality: AdaptiveQuality;
  let fallbackMode = false;
  let canvas2dContext: CanvasRenderingContext2D | null = null;
  let fallbackImage: HTMLImageElement | HTMLCanvasElement | null = null;
  let fallbackBackgroundImage: HTMLImageElement | null = null;
  let bookBaseImage: HTMLImageElement | null = null;
  let foregroundTextureWidth = 800;
  let foregroundTextureHeight = 600;
  let loadedDisplayMode: DisplayImageMode | null = null;
  let cachedCanvasCssWidth = 1;
  let cachedCanvasCssHeight = 1;
  let bookComposeCanvas: HTMLCanvasElement | null = null;
  let bookComposeContext: CanvasRenderingContext2D | null = null;

  const FOREGROUND_BASELINE_WIDTH_M = DEFAULT_BOOK_BASELINE_WIDTH_M;
  const REFERENCE_HOLD_DISTANCE_M = DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M;
  const REFERENCE_VIEWING_DISTANCE_M = DEFAULT_BOOK_REFERENCE_VIEWING_DISTANCE_M;
  const INFINITY_HOLD_DISTANCE_M = 1000.0;
  const MIN_FOREGROUND_SCALE = 0.0001; // avoid zero-size edge cases
  const MAX_FOREGROUND_SCALE = 2.5;
  const BLUR_RENDER_SCALE = 1.0; // 1.0 = full-resolution blur pass
  const ZOOM_DRIFT_WARNING_THRESHOLD = 0.03;
  const ZOOM_BANNER_DURATION_MS = 2400;
  const BOOK_TEXTURE_UPDATE_INTERVAL_MS = 66; // ~15 Hz max while dragging
  const BOOK_TEXTURE_SIZE_QUANTIZATION_PX = 8;
  const UNIVERSAL_DPR_CAP = 3; // suitable for most smartphone displays
  const BOOK_TEXTURE_SAFE_FLOOR = 512;
  const BOOK_TEXTURE_HARD_CAP = 1536;
  const RESIZE_DEBOUNCE_MS = 200;
  const IMAGE_LOAD_TIMEOUT_MS = 30000;
  let zoomBannerVisible = false;
  let zoomBannerTimer: ReturnType<typeof setTimeout> | null = null;
  let bookTextureUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let bookTextureUpdateInFlight = false;
  let bookTextureUpdateQueued = false;
  let bookTextureForcePending = false;
  let bookTextureRequestVersion = 0;
  let bookTextureUpdateRaf: number | null = null;
  let bookTextureUpdateRafForce = false;
  let didBookTexturePrewarm = false;
  let sceneLoadRequestVersion = 0;
  let iolMonoLoadPromise: Promise<void> | null = null;

  function formatVABadge(decimalValue: number): string {
    if (!Number.isFinite(decimalValue) || decimalValue <= 0) {
      return "VA -";
    }

    const digits = decimalValue >= 1 ? 1 : 2;
    return `VA ~ ${decimalValue.toFixed(digits)}`;
  }

  function getHoldingDistanceBadge(distanceMeters: number): string {
    if (!Number.isFinite(distanceMeters)) {
      return "Intermediate";
    }

    const distanceCm = distanceMeters * 100;
    if (distanceCm < 30) {
      return "Near";
    }
    if (distanceCm <= 45) {
      return "Reading";
    }
    if (distanceCm <= 75) {
      return "Computer";
    }
    return "Intermediate";
  }

  function ensureIOLMonoLoaded(): Promise<void> {
    if (typeof document === "undefined" || !("fonts" in document)) {
      return Promise.resolve();
    }

    if (!iolMonoLoadPromise) {
      const fontSet = document.fonts;
      iolMonoLoadPromise = (async () => {
        try {
          await fontSet.load('400 16px "IOLMono"');
          await fontSet.ready;
        } catch {
          // Keep rendering path resilient if font loading fails.
        }
      })();
    }

    return iolMonoLoadPromise;
  }

  $: defocusLabel = `${$masterDefocus >= 0 ? "+" : ""}${$masterDefocus.toFixed(1)} D`;
  $: distanceMeters = defocusToDistance($masterDefocus);
  $: distanceLabel = Number.isFinite(distanceMeters) ? `${Math.round(distanceMeters * 100)} cm` : "∞";
  $: holdDistanceMeters = Number.isFinite(distanceMeters)
    ? Math.max(0.1, distanceMeters)
    : INFINITY_HOLD_DISTANCE_M;
  $: safeViewingDistance = Math.max(0.2, $viewingDistance);
  $: foregroundWidthCssPx = calculateForegroundWidthCssPx(
    FOREGROUND_BASELINE_WIDTH_M,
    $effectiveCssPxPerMm,
    safeViewingDistance,
    holdDistanceMeters,
    REFERENCE_VIEWING_DISTANCE_M,
    REFERENCE_HOLD_DISTANCE_M
  );
  $: foregroundScale = Math.max(
    MIN_FOREGROUND_SCALE,
    Math.min(
      MAX_FOREGROUND_SCALE,
      foregroundWidthCssPx / Math.max(1, foregroundImageWidth)
    )
  );
  $: foregroundDisplayWidthCssPx = Math.max(1, foregroundImageWidth * foregroundScale);
  $: foregroundDisplayHeightCssPx = Math.max(1, foregroundImageHeight * foregroundScale);
  $: zoomScaleDrift = Math.abs(($currentViewportScale / Math.max(0.0001, $calibrationScale)) - 1);
  $: overlayReadout = `${defocusLabel} / ${distanceLabel}`;
  $: vaBadgeText = formatVABadge($currentVADecimal);
  $: compareVABadgeText = formatVABadge($compareVADecimal);
  $: holdingDistanceBadgeText = getHoldingDistanceBadge(distanceMeters);

  async function flushRenderFrame(timestamp: number): Promise<void> {
    if (!renderFrameCallback || renderInFlight) {
      return;
    }

    renderInFlight = true;
    renderInvalidated = false;

    try {
      await renderFrameCallback(timestamp);
    } finally {
      renderInFlight = false;
      if (renderInvalidated) {
        requestRender();
      }
    }
  }

  function requestRender(): void {
    if (!renderFrameCallback) {
      return;
    }

    renderInvalidated = true;
    if (renderScheduled || renderInFlight) {
      return;
    }

    renderScheduled = true;
    animationFrame = requestAnimationFrame((timestamp) => {
      renderScheduled = false;
      void flushRenderFrame(timestamp);
    });
  }

  function requestBookTextureUpdate(force: boolean = false): void {
    if (!isMounted || !bookBaseImage || $displayImageMode !== "book") {
      return;
    }

    if (force) {
      bookTextureUpdateRafForce = true;
    }

    if (bookTextureUpdateRaf !== null) {
      return;
    }

    bookTextureUpdateRaf = requestAnimationFrame(() => {
      bookTextureUpdateRaf = null;
      const rafForce = bookTextureUpdateRafForce;
      bookTextureUpdateRafForce = false;
      queueBookTextureUpdate(rafForce);
    });
  }

  function updateCachedCanvasCssSize(width: number, height: number): boolean {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const changed = nextWidth !== cachedCanvasCssWidth || nextHeight !== cachedCanvasCssHeight;
    cachedCanvasCssWidth = nextWidth;
    cachedCanvasCssHeight = nextHeight;
    return changed;
  }

  function updateCachedCanvasCssSizeFromContainer(): void {
    if (!canvasContainer) {
      return;
    }

    updateCachedCanvasCssSize(canvasContainer.clientWidth, canvasContainer.clientHeight);
  }

  function quantizeBookTextureDimension(value: number): number {
    return Math.max(
      1,
      Math.round(value / BOOK_TEXTURE_SIZE_QUANTIZATION_PX) * BOOK_TEXTURE_SIZE_QUANTIZATION_PX
    );
  }

  function queueBookTextureUpdate(force: boolean = false): void {
    if (!isMounted || !bookBaseImage || $displayImageMode !== "book") {
      return;
    }

    bookTextureRequestVersion += 1;

    if (force) {
      bookTextureForcePending = true;
    }

    if (bookTextureUpdateInFlight) {
      bookTextureUpdateQueued = true;
      return;
    }

    const delay = force ? 0 : BOOK_TEXTURE_UPDATE_INTERVAL_MS;

    if (bookTextureUpdateTimer) {
      clearTimeout(bookTextureUpdateTimer);
      bookTextureUpdateTimer = null;
    }

    bookTextureUpdateTimer = setTimeout(() => {
      bookTextureUpdateTimer = null;
      void runBookTextureUpdate();
    }, delay);
  }

  async function runBookTextureUpdate(): Promise<void> {
    if (bookTextureUpdateInFlight) {
      bookTextureUpdateQueued = true;
      return;
    }

    bookTextureUpdateInFlight = true;
    const requestVersion = bookTextureRequestVersion;
    const force = bookTextureForcePending;
    bookTextureForcePending = false;

    try {
      const didApply = await updateBookTextureAtDisplaySize(force, requestVersion);
      if (didApply) {
        requestRender();
      }
    } finally {
      bookTextureUpdateInFlight = false;
    }

    if (
      bookTextureUpdateQueued ||
      bookTextureForcePending ||
      bookTextureRequestVersion > requestVersion
    ) {
      bookTextureUpdateQueued = false;
      queueBookTextureUpdate(bookTextureForcePending);
    }
  }

  function swapRendererTexture(newTextureId: string): void {
    const previousTextureId = imageTextureId;
    imageTextureId = newTextureId;

    if (renderer && previousTextureId && previousTextureId !== newTextureId) {
      renderer.releaseTexture(previousTextureId);
    }
  }

  function swapBackgroundTexture(newTextureId: string | null): void {
    const previousTextureId = backgroundTextureId;
    backgroundTextureId = newTextureId;

    if (renderer && previousTextureId && previousTextureId !== newTextureId) {
      renderer.releaseTexture(previousTextureId);
    }
  }
  async function applyImageDimensions(width: number, height: number): Promise<void> {
    if (width <= 0 || height <= 0) {
      return;
    }

    await tick();

    if (canvas) {
      handleResize();
    }
  }

  const TEST_PATTERN_BASE_WIDTH = 800;
  const TEST_PATTERN_BASE_HEIGHT = 600;
  const TEST_PATTERN_GRID_SPACING = 50;
  const IOL_MONO_STACK = '"IOLMono",ui-monospace,"SFMono-Regular","Menlo","Consolas","Liberation Mono","Courier New",monospace';
  const TEST_PATTERN_LINES = [
    { size: 87, text: 'C Z O L F' },
    { size: 65, text: 'E F L E O' },
    { size: 43, text: 'T Z D C D' },
    { size: 33, text: 'F T E F C' },
    { size: 21, text: 'D Z P O L' },
    { size: 15, text: 'T T Z O P' },
    { size: 9, text: 'C O P E F' }
  ];

  // Foreground text content rendered as explicit left/right columns.
  const BOOK_OVERLAY_TEXT_COLUMNS = {
    left: [
      "Book text",
      "책 글자 크기",
      "書本字體",
      "",
      "Can you read this line?",
    ],
    right: [
      "Book text",
      "책 글자 크기",
      "書本字體",
      "",
      "Defocus curves show how ",
      "vision changes with focus.",
      "Nice to see U!",
    ]
  } as const;

  // Minimal style controls for foreground text rendering.
  const BOOK_OVERLAY_TEXT_STYLE = {
    fontFamily: IOL_MONO_STACK,
    fontWeight: 500,
    fontSizeRatio: 0.055,     // font px = ratio * displayedBookWidthPx
    lineHeightRatio: 0.028,   // line height px = ratio * displayedBookWidthPx
    columnWidthRatio: 0.49,   // each text column width as ratio of displayed book width
    leftColumnXRatio: 0.03,   // left page anchor
    rightColumnXRatio: 0.52,  // right page anchor
    alignYRatio: 0.03,        // vertical alignment anchor
    color: "#000000"
  } as const;

  interface TestPatternOptions {
    includeFallbackIndicator?: boolean;
  }

  function renderTestPatternBase(
    ctx: CanvasRenderingContext2D,
    options: TestPatternOptions = {}
  ): void {
    const { includeFallbackIndicator = false } = options;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, TEST_PATTERN_BASE_WIDTH, TEST_PATTERN_BASE_HEIGHT);

    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 1;

    for (let x = 0; x <= TEST_PATTERN_BASE_WIDTH; x += TEST_PATTERN_GRID_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, TEST_PATTERN_BASE_HEIGHT);
      ctx.stroke();
    }

    for (let y = 0; y <= TEST_PATTERN_BASE_HEIGHT; y += TEST_PATTERN_GRID_SPACING) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(TEST_PATTERN_BASE_WIDTH, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';

    let yPos = 100;
    for (const line of TEST_PATTERN_LINES) {
      ctx.font = `400 ${line.size}px ${IOL_MONO_STACK}`;
      ctx.fillText(line.text, TEST_PATTERN_BASE_WIDTH / 2, yPos);
      yPos += line.size + 20;
    }

    if (includeFallbackIndicator) {
      ctx.fillStyle = '#ff6b35';
      ctx.font = '16px sans-serif';
      ctx.fillText(
        'Canvas2D Mode (WebGL not available)',
        TEST_PATTERN_BASE_WIDTH / 2,
        TEST_PATTERN_BASE_HEIGHT - 50
      );
    }
  }

  function wrapTextLine(
    ctx: CanvasRenderingContext2D,
    line: string,
    maxWidth: number
  ): string[] {
    const words = line.split(" ").filter((w) => w.length > 0);
    if (words.length <= 1) {
      return [line];
    }

    const rows: string[] = [];
    let current = words[0];

    for (let i = 1; i < words.length; i++) {
      const next = `${current} ${words[i]}`;
      if (ctx.measureText(next).width <= maxWidth) {
        current = next;
      } else {
        rows.push(current);
        current = words[i];
      }
    }

    rows.push(current);
    return rows;
  }

  function drawBookTextOverlay(
    ctx: CanvasRenderingContext2D,
    displayedBookWidthPx: number,
    displayedBookHeightPx: number
  ): void {
    const fontPx = Math.max(8, Math.round(displayedBookWidthPx * BOOK_OVERLAY_TEXT_STYLE.fontSizeRatio));
    const lineHeightPx = Math.max(fontPx * 1.05, displayedBookWidthPx * BOOK_OVERLAY_TEXT_STYLE.lineHeightRatio);
    const columnWidthPx = Math.max(1, displayedBookWidthPx * BOOK_OVERLAY_TEXT_STYLE.columnWidthRatio);
    const leftColumnX = displayedBookWidthPx * BOOK_OVERLAY_TEXT_STYLE.leftColumnXRatio;
    const rightColumnX = displayedBookWidthPx * BOOK_OVERLAY_TEXT_STYLE.rightColumnXRatio;
    const topY = displayedBookHeightPx * BOOK_OVERLAY_TEXT_STYLE.alignYRatio;

    ctx.save();
    ctx.fillStyle = BOOK_OVERLAY_TEXT_STYLE.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${BOOK_OVERLAY_TEXT_STYLE.fontWeight} ${fontPx}px ${BOOK_OVERLAY_TEXT_STYLE.fontFamily}`;

    const leftLines = BOOK_OVERLAY_TEXT_COLUMNS.left.flatMap((line) =>
      wrapTextLine(ctx, line, columnWidthPx)
    );
    const rightLines = BOOK_OVERLAY_TEXT_COLUMNS.right.flatMap((line) =>
      wrapTextLine(ctx, line, columnWidthPx)
    );

    // Keep a fixed top anchor so row edits do not shift the first line.
    let leftY = topY;
    for (const line of leftLines) {
      ctx.fillText(line, leftColumnX, leftY, columnWidthPx);
      leftY += lineHeightPx;
    }

    let rightY = topY;
    for (const line of rightLines) {
      ctx.fillText(line, rightColumnX, rightY, columnWidthPx);
      rightY += lineHeightPx;
    }

    ctx.restore();
  }

  function getRenderPixelScale(): number {
    if (canvas && cachedCanvasCssWidth > 0) {
      return Math.max(0.001, canvas.width / cachedCanvasCssWidth);
    }

    if (typeof window !== "undefined") {
      return Math.max(0.001, window.devicePixelRatio || 1);
    }

    return 1;
  }

  function getMaxBookTextureSize(): number {
    const adaptiveMaxTextureSize = adaptiveQuality
      ? adaptiveQuality.getQualityReport().maxTextureSize
      : BOOK_TEXTURE_HARD_CAP;
    return Math.max(
      BOOK_TEXTURE_SAFE_FLOOR,
      Math.min(adaptiveMaxTextureSize, BOOK_TEXTURE_HARD_CAP)
    );
  }

  function scheduleBookTexturePrewarm(): void {
    if (didBookTexturePrewarm || !isMounted || !renderer || !bookBaseImage || $displayImageMode !== "book") {
      return;
    }

    didBookTexturePrewarm = true;

    const run = async (): Promise<void> => {
      const activeRenderer = renderer;
      const activeBookImage = bookBaseImage;
      if (!isMounted || !activeRenderer || !activeBookImage || $displayImageMode !== "book") {
        return;
      }

      try {
        const maxTextureSize = getMaxBookTextureSize();
        const renderPixelScale = getRenderPixelScale();
        const requestedWidth = Math.max(1, Math.round(foregroundDisplayWidthCssPx * renderPixelScale));
        const targetWidth = quantizeBookTextureDimension(
          Math.min(maxTextureSize, Math.max(1024, requestedWidth))
        );
        const targetHeight = Math.max(
          1,
          Math.round((activeBookImage.height * targetWidth) / activeBookImage.width)
        );

        const prewarmCanvas = composeBookCanvasWithText(activeBookImage, targetWidth, targetHeight);
        const tempTextureId = await activeRenderer.loadImageTexture(prewarmCanvas);
        activeRenderer.releaseTexture(tempTextureId);
      } catch {
        // Ignore prewarm failures; interactive path remains unchanged.
      }
    };

    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };

    if (typeof win.requestIdleCallback === "function") {
      win.requestIdleCallback(() => {
        void run();
      }, { timeout: 1500 });
      return;
    }

    setTimeout(() => {
      void run();
    }, 0);
  }

  function composeBookCanvasWithText(
    baseImage: HTMLImageElement,
    width: number,
    height: number
  ): HTMLCanvasElement {
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));

    if (!bookComposeCanvas) {
      bookComposeCanvas = document.createElement("canvas");
    }
    if (bookComposeCanvas.width !== targetWidth || bookComposeCanvas.height !== targetHeight) {
      bookComposeCanvas.width = targetWidth;
      bookComposeCanvas.height = targetHeight;
      bookComposeContext = null;
    }

    if (!bookComposeContext) {
      bookComposeContext = bookComposeCanvas.getContext("2d");
    }

    const ctx = bookComposeContext;
    if (!ctx) {
      return bookComposeCanvas;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(baseImage, 0, 0, targetWidth, targetHeight);
    drawBookTextOverlay(ctx, targetWidth, targetHeight);
    return bookComposeCanvas;
  }

  async function updateBookTextureAtDisplaySize(
    force: boolean = false,
    requestVersion: number = bookTextureRequestVersion
  ): Promise<boolean> {
    if (!isMounted || !bookBaseImage || $displayImageMode !== "book") {
      return false;
    }

    const renderPixelScale = getRenderPixelScale();
    const maxTextureSize = getMaxBookTextureSize();
    const requestedWidth = Math.max(1, Math.round(foregroundDisplayWidthCssPx * renderPixelScale));
    const requestedHeight = Math.max(1, Math.round(foregroundDisplayHeightCssPx * renderPixelScale));

    let targetWidth = force ? requestedWidth : quantizeBookTextureDimension(requestedWidth);
    let targetHeight = Math.max(
      1,
      Math.round((requestedHeight * targetWidth) / Math.max(1, requestedWidth))
    );

    if (targetWidth > maxTextureSize || targetHeight > maxTextureSize) {
      const shrink = Math.min(maxTextureSize / targetWidth, maxTextureSize / targetHeight);
      targetWidth = Math.max(1, Math.round(targetWidth * shrink));
      targetHeight = Math.max(1, Math.round(targetHeight * shrink));
    }

    if (!force && targetWidth === foregroundTextureWidth && targetHeight === foregroundTextureHeight) {
      return false;
    }

    if (requestVersion < bookTextureRequestVersion) {
      return false;
    }

    const composedCanvas = composeBookCanvasWithText(bookBaseImage, targetWidth, targetHeight);
    if (requestVersion < bookTextureRequestVersion) {
      return false;
    }

    fallbackImage = composedCanvas;
    foregroundTextureWidth = targetWidth;
    foregroundTextureHeight = targetHeight;

    const activeRenderer = renderer;
    if (activeRenderer) {
      const canUpdateInPlace =
        loadedDisplayMode === "book" &&
        typeof imageTextureId === "string" &&
        activeRenderer.updateImageTexture(imageTextureId, composedCanvas);

      if (!canUpdateInPlace) {
        const composedTextureId = await activeRenderer.loadImageTexture(composedCanvas);
        if (
          requestVersion < bookTextureRequestVersion ||
          !isMounted ||
          activeRenderer !== renderer
        ) {
          activeRenderer.releaseTexture(composedTextureId);
          return false;
        }
        swapRendererTexture(composedTextureId);
      }
    }

    return true;
  }
  // Sample test image (we'll load a default image or allow user uploads)
  // Note: We'll generate a test pattern instead of relying on external URLs

  // Performance tracking
  let frameCount = 0;
  let fpsUpdateTime = 0;
  let viewport: VisualViewport | null = null;

  function updateFrameRate(timestamp: number): void {
    frameCount++;
    if (timestamp - fpsUpdateTime < 1000) {
      return;
    }

    frameRate.set(Math.round((frameCount * 1000) / (timestamp - fpsUpdateTime)));
    frameCount = 0;
    fpsUpdateTime = timestamp;
  }

  function readViewportScale(): number {
    if (typeof window === "undefined") {
      return 1;
    }
    return window.visualViewport?.scale ?? 1;
  }

  function updateViewportScaleState(showDriftBanner: boolean): void {
    const nextScale = readViewportScale();
    currentViewportScale.set(nextScale);

    if (showDriftBanner) {
      const drift = Math.abs((nextScale / Math.max(0.0001, $calibrationScale)) - 1);
      if (drift >= ZOOM_DRIFT_WARNING_THRESHOLD) {
        zoomBannerVisible = true;
        if (zoomBannerTimer) {
          clearTimeout(zoomBannerTimer);
        }
        zoomBannerTimer = setTimeout(() => {
          zoomBannerVisible = false;
          zoomBannerTimer = null;
        }, ZOOM_BANNER_DURATION_MS);
      }
    }
  }

  function drawImageCover(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    targetWidth: number,
    targetHeight: number
  ): void {
    const targetAspect = targetWidth / targetHeight;
    const imageAspect = image.width / image.height;

    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    if (targetAspect > imageAspect) {
      sourceHeight = image.width / targetAspect;
      sourceY = (image.height - sourceHeight) * 0.5;
    } else {
      sourceWidth = image.height * targetAspect;
      sourceX = (image.width - sourceWidth) * 0.5;
    }

    ctx.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      targetWidth,
      targetHeight
    );
  }

  function attachViewportListeners(): void {
    if (typeof window === "undefined") {
      return;
    }

    viewport = window.visualViewport ?? null;
    if (!viewport) {
      return;
    }

    viewport.addEventListener('resize', onViewportResize);
  }

  function detachViewportListeners(): void {
    if (!viewport) {
      return;
    }
    viewport.removeEventListener('resize', onViewportResize);
    viewport = null;
  }

  onMount(async () => {
    isMounted = true;
    
    if (typeof window === "undefined") {
      return;
    }

    updateViewportScaleState(false);
    attachViewportListeners();
    updateCachedCanvasCssSizeFromContainer();
    if (typeof ResizeObserver !== "undefined" && canvasContainer) {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }

        if (updateCachedCanvasCssSize(entry.contentRect.width, entry.contentRect.height)) {
          handleResize();
        }
      });
      resizeObserver.observe(canvasContainer);
    }

    // Initialize performance monitoring and adaptive quality.
    adaptiveQuality = new AdaptiveQuality();

    try {
      // Initialize loading steps
      loadingSteps = [
        "Initializing performance profile",
        "Setting up WebGL context", 
        "Compiling shaders",
        "Creating render targets",
        "Loading image",
        "Starting render loop"
      ];
      currentStep = 0;
      showProgressBar = true;
      
      updateLoadingProgress("Initializing performance profile...", 0);

      // Initialize WebGL renderer
      updateLoadingProgress("Setting up WebGL context...", 1);
      
      // Check WebGL support first
      if (!checkWebGLSupport()) {
        fallbackMode = true;
        await initializeCanvas2DFallback();
        return;
      }
      
      renderer = new WebGLRenderer(canvas);
      
      // Set up context loss handling
      renderer.setContextLossHandler((event) => {
        if (event.recoverable) {
          errorMessage = "";
          errorInfo = null;
          loadingMessage = "WebGL context lost, attempting to recover...";
        } else {
          errorMessage = event.errorMessage || "WebGL context lost and cannot be recovered";
          loadingMessage = "";
        }
      });

      // Set up enhanced error handling
      renderer.setErrorHandler((error: WebGLErrorInfo) => {
        errorInfo = error;
        errorMessage = error.userMessage;
        loadingMessage = "";
        
        // Auto-retry for recoverable errors
        if (error.recoverable && error.type !== WebGLErrorType.CONTEXT_LOST) {
          setTimeout(() => {
            if (isMounted) {
              attemptErrorRecovery(error);
            }
          }, 2000);
        }
      });
      
      updateLoadingProgress("Compiling shaders...", 2);
      await renderer.initialize();

      updateLoadingProgress("Creating render targets...", 3);
      // Small delay to show progress
      await new Promise(resolve => setTimeout(resolve, 100));

      updateLoadingProgress("Loading image...", 4);
      await loadSceneImage($displayImageMode, { initialLoad: true });

      updateLoadingProgress("Starting render loop...", 5);
      isInitialized = true;
      // Start render loop
      startRenderLoop();

      // Complete loading
      updateLoadingProgress("Ready!", 6);
      await new Promise(resolve => setTimeout(resolve, 500));

      loadingMessage = "";
      showProgressBar = false;
      scheduleBookTexturePrewarm();


    } catch (error) {
      errorMessage = `Initialization failed: ${error}`;
      loadingMessage = "";
    }
  });

  onDestroy(() => {
    // Cancel animation frame
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    renderScheduled = false;
    renderFrameCallback = null;
    
    // Clear resize timeout
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    if (bookTextureUpdateTimer) {
      clearTimeout(bookTextureUpdateTimer);
      bookTextureUpdateTimer = null;
    }
    if (bookTextureUpdateRaf !== null) {
      cancelAnimationFrame(bookTextureUpdateRaf);
      bookTextureUpdateRaf = null;
    }
    bookTextureUpdateRafForce = false;
    bookTextureUpdateInFlight = false;
    bookTextureUpdateQueued = false;
    bookTextureForcePending = false;
    bookTextureRequestVersion = 0;
    didBookTexturePrewarm = false;
    bookComposeContext = null;
    bookComposeCanvas = null;

    detachViewportListeners();
    if (zoomBannerTimer) {
      clearTimeout(zoomBannerTimer);
      zoomBannerTimer = null;
    }
    
    // Dispose WebGL renderer and clean up resources
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
    
    // Clear component state
    imageTextureId = null;
    backgroundTextureId = null;
    bookBaseImage = null;
    foregroundTextureWidth = 800;
    foregroundTextureHeight = 600;
    isInitialized = false;
    errorMessage = "";
    loadingMessage = "";
    isMounted = false;
    renderInFlight = false;
    renderInvalidated = false;
    

  });

  async function createLettersImageElement(): Promise<HTMLImageElement> {
    const testCanvas = document.createElement("canvas");
    testCanvas.width = TEST_PATTERN_BASE_WIDTH;
    testCanvas.height = TEST_PATTERN_BASE_HEIGHT;
    const ctx = testCanvas.getContext("2d")!;
    renderTestPatternBase(ctx);

    const image = new Image();
    image.src = testCanvas.toDataURL();
    await waitForImageLoad(image, "Letters image load timeout");
    return image;
  }

  async function createBookImageElement(): Promise<HTMLImageElement> {
    const image = new Image();
    image.src = bookImageAsset;
    await waitForImageLoad(image, "Book image load timeout");
    return image;
  }

  async function createBackgroundImageElement(): Promise<HTMLImageElement> {
    const image = new Image();
    image.src = backgroundImageAsset;
    await waitForImageLoad(image, "Background image load timeout");
    return image;
  }

  async function waitForImageLoad(image: HTMLImageElement, timeoutMessage: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, IMAGE_LOAD_TIMEOUT_MS);

      image.onload = () => {
        clearTimeout(timeout);
        resolve();
      };

      image.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Image failed to load"));
      };
    });
  }

  function isCurrentSceneLoad(requestVersion: number, mode: DisplayImageMode): boolean {
    return isMounted && requestVersion === sceneLoadRequestVersion && $displayImageMode === mode;
  }

  async function applyLettersScene(mode: DisplayImageMode, lettersImage: HTMLImageElement): Promise<void> {
    fallbackImage = lettersImage;
    fallbackBackgroundImage = null;
    bookBaseImage = null;
    loadedDisplayMode = mode;

    foregroundImageWidth = lettersImage.width;
    foregroundImageHeight = lettersImage.height;
    foregroundTextureWidth = lettersImage.width;
    foregroundTextureHeight = lettersImage.height;
    backgroundImageWidth = lettersImage.width;
    backgroundImageHeight = lettersImage.height;

    await applyImageDimensions(lettersImage.width, lettersImage.height);

    if (renderer) {
      const newTextureId = await renderer.loadImageTexture(lettersImage);
      swapRendererTexture(newTextureId);
      swapBackgroundTexture(null);
    } else if (fallbackMode && canvas2dContext) {
      drawFallbackScene();
    }

    requestRender();
  }

  async function applyBookScene(loadedBookBaseImage: HTMLImageElement, backgroundImage: HTMLImageElement): Promise<void> {
    bookBaseImage = loadedBookBaseImage;
    fallbackImage = loadedBookBaseImage;
    fallbackBackgroundImage = backgroundImage;
    loadedDisplayMode = "book";

    foregroundImageWidth = loadedBookBaseImage.width;
    foregroundImageHeight = loadedBookBaseImage.height;
    foregroundTextureWidth = loadedBookBaseImage.width;
    foregroundTextureHeight = loadedBookBaseImage.height;
    backgroundImageWidth = backgroundImage.width;
    backgroundImageHeight = backgroundImage.height;

    await applyImageDimensions(backgroundImage.width, backgroundImage.height);

    if (renderer) {
      const bgTextureId = await renderer.loadImageTexture(backgroundImage);
      swapBackgroundTexture(bgTextureId);
      requestBookTextureUpdate(true);
    } else if (fallbackMode && canvas2dContext) {
      requestBookTextureUpdate(true);
      drawFallbackScene();
    }

    requestRender();
  }

  function startBookSceneUpgrade(requestVersion: number): void {
    void (async () => {
      try {
        const [loadedBookBaseImage, backgroundImage] = await Promise.all([
          createBookImageElement(),
          createBackgroundImageElement()
        ]);

        if (!isCurrentSceneLoad(requestVersion, "book")) {
          return;
        }

        await applyBookScene(loadedBookBaseImage, backgroundImage);
      } catch {
        // Keep the simulator usable with the text-only scene if book assets time out or fail.
      }
    })();
  }

  async function loadLettersSceneIfCurrent(requestVersion: number, mode: DisplayImageMode): Promise<boolean> {
    const lettersImage = await createLettersImageElement();
    if (!isCurrentSceneLoad(requestVersion, mode)) {
      return false;
    }
    await applyLettersScene(mode, lettersImage);
    return isCurrentSceneLoad(requestVersion, mode);
  }

  async function loadSceneImage(
    mode: DisplayImageMode,
    options: { initialLoad?: boolean } = {}
  ): Promise<void> {
    if (!isMounted) return;

    await ensureIOLMonoLoaded();
    const requestVersion = ++sceneLoadRequestVersion;
    const initialLoad = options.initialLoad === true;

    try {
      if (mode === "book") {
        if (initialLoad) {
          try {
            const [loadedBookBaseImage, backgroundImage] = await Promise.all([
              createBookImageElement(),
              createBackgroundImageElement()
            ]);

            if (!isCurrentSceneLoad(requestVersion, mode)) {
              return;
            }

            await applyBookScene(loadedBookBaseImage, backgroundImage);
            return;
          } catch {
            const didApplyLetters = await loadLettersSceneIfCurrent(requestVersion, mode);
            if (didApplyLetters) {
              return;
            }
            return;
          }
        }

        const didApplyLetters = await loadLettersSceneIfCurrent(requestVersion, mode);
        if (!didApplyLetters) {
          return;
        }
        startBookSceneUpgrade(requestVersion);
        return;
      }

      await loadLettersSceneIfCurrent(requestVersion, mode);
    } catch (error) {
      if (isCurrentSceneLoad(requestVersion, mode)) {
        errorMessage = `Failed to load image: ${error}`;
        loadingMessage = "";
      }
    }
  }

  function startRenderLoop() {
    renderFrameCallback = async (timestamp: number) => {
      if (!renderer || !imageTextureId || !isInitialized) {
        return;
      }

      // Check WebGL context validity
      if (!renderer.isContextValid()) {
        return;
      }
      updateFrameRate(timestamp);

      try {
        const startTime = performance.now();

        const compareEnabled = $splitViewEnabled;
        const useBookOverlay = $displayImageMode === "book" && !!backgroundTextureId && !!bookBaseImage;
        const cataractEligibleMode = $simulationMode === "Presbyopia";
        const primaryCataractEnabled = cataractEligibleMode && $presbyopiaProfile === "presbyopia";
        const compareCataractEnabled =
          cataractEligibleMode &&
          compareEnabled &&
          $presbyopiaCompareProfile === "presbyopia";
        const primaryNsGrade = primaryCataractEnabled ? $nsGrade : 0;
        const primaryPscRadius = primaryCataractEnabled ? $pscRadius : 0;
        const primaryPscDensity = primaryCataractEnabled ? $pscDensity : 0;
        const primaryPscSoftness = primaryCataractEnabled ? $pscSoftness : 0.2;
        const compareNsGrade = compareEnabled
          ? (compareCataractEnabled ? $nsGrade : 0)
          : undefined;
        const comparePscRadius = compareEnabled
          ? (compareCataractEnabled ? $pscRadius : 0)
          : undefined;
        const comparePscDensity = compareEnabled
          ? (compareCataractEnabled ? $pscDensity : 0)
          : undefined;
        const comparePscSoftness = compareEnabled
          ? (compareCataractEnabled ? $pscSoftness : 0.2)
          : undefined;
        const cssWidth = Math.max(1, cachedCanvasCssWidth);
        const cssHeight = Math.max(1, cachedCanvasCssHeight);
        const renderPixelScale = Math.max(0.001, canvas.width / cssWidth);
        const foregroundCoverage = useBookOverlay
          ? Math.min(
              1,
              (foregroundDisplayWidthCssPx * foregroundDisplayHeightCssPx) /
                Math.max(1, cssWidth * cssHeight)
            )
          : 1;
        const mainBlurPolicy = resolveBlurPolicy({
          sigmaCssRaw: $blurSigma,
          deviceCssPxPerMm: $effectiveCssPxPerMm,
          viewingDistanceM: $viewingDistance,
          renderPixelScale,
          blurRenderScale: BLUR_RENDER_SCALE,
          dpr: renderPixelScale,
          foregroundCoverage
        });
        const compareBlurPolicy = compareEnabled
          ? resolveBlurPolicy({
              sigmaCssRaw: $compareBlurSigma,
              deviceCssPxPerMm: $effectiveCssPxPerMm,
              viewingDistanceM: $viewingDistance,
              renderPixelScale,
              blurRenderScale: BLUR_RENDER_SCALE,
              dpr: renderPixelScale,
              foregroundCoverage
            })
          : null;
        const mainBackgroundBlurPolicy = resolveBlurPolicy({
          sigmaCssRaw: useBookOverlay ? $backgroundBlurSigma : 0,
          deviceCssPxPerMm: $effectiveCssPxPerMm,
          viewingDistanceM: $viewingDistance,
          renderPixelScale,
          blurRenderScale: BLUR_RENDER_SCALE,
          dpr: renderPixelScale,
          foregroundCoverage: 1
        });
        const compareBackgroundBlurPolicy = compareEnabled
          ? resolveBlurPolicy({
              sigmaCssRaw: useBookOverlay ? $compareBackgroundBlurSigma : 0,
              deviceCssPxPerMm: $effectiveCssPxPerMm,
              viewingDistanceM: $viewingDistance,
              renderPixelScale,
              blurRenderScale: BLUR_RENDER_SCALE,
              dpr: renderPixelScale,
              foregroundCoverage: 1
            })
          : null;
        
        // Prepare render configuration with adaptive quality
        const config: RenderConfig = {
          width: canvas.width,
          height: canvas.height,
          blurSigma: mainBlurPolicy.sigmaTexelUsedFull,
          compareBlurSigma: compareEnabled
            ? (compareBlurPolicy?.sigmaTexelUsedFull ?? 0)
            : undefined,
          blurDownsampleFactor: mainBlurPolicy.downsampleFactor,
          compareBlurDownsampleFactor: compareBlurPolicy?.downsampleFactor,
          backgroundBlurSigma: useBookOverlay
            ? mainBackgroundBlurPolicy.sigmaTexelUsedFull
            : undefined,
          compareBackgroundBlurSigma: compareEnabled && useBookOverlay
            ? (compareBackgroundBlurPolicy?.sigmaTexelUsedFull ?? 0)
            : undefined,
          backgroundBlurDownsampleFactor: useBookOverlay
            ? BACKGROUND_BLUR_DOWNSAMPLE_FACTOR
            : undefined,
          compareBackgroundBlurDownsampleFactor: compareEnabled && useBookOverlay
            ? BACKGROUND_BLUR_DOWNSAMPLE_FACTOR
            : undefined,
          nsGrade: primaryNsGrade,
          pscRadius: primaryPscRadius,
          pscDensity: primaryPscDensity,
          pscSoftness: primaryPscSoftness,
          compareNsGrade,
          comparePscRadius,
          comparePscDensity,
          comparePscSoftness,
          splitView: compareEnabled,
          splitPosition: 0.5,
          backgroundTextureId: useBookOverlay ? (backgroundTextureId ?? undefined) : undefined,
          backgroundNativeWidth: useBookOverlay ? backgroundImageWidth : undefined,
          backgroundNativeHeight: useBookOverlay ? backgroundImageHeight : undefined,
          foregroundScale: useBookOverlay
            ? foregroundDisplayWidthCssPx / Math.max(1, foregroundTextureWidth)
            : undefined,
          foregroundNativeWidth: useBookOverlay ? foregroundTextureWidth : undefined,
          foregroundNativeHeight: useBookOverlay ? foregroundTextureHeight : undefined,
        };

        // Render frame
        await renderer.render(imageTextureId, config);

        const endTime = performance.now();
        const currentFrameTime = endTime - startTime;
        
        // Record performance metrics
        adaptiveQuality.recordFrameTime(currentFrameTime);
        
        renderTime.set(currentFrameTime);
      } catch (error) {
        errorMessage = `Render error: ${error}`;
      }
    };

    requestRender();
  }

  function handleResize() {
    if (!canvas || typeof window === "undefined") {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, UNIVERSAL_DPR_CAP);
    updateCachedCanvasCssSizeFromContainer();
    const canvasWidthCss = Math.max(1, cachedCanvasCssWidth || Math.round(window.innerWidth));
    const canvasHeightCss = Math.max(1, cachedCanvasCssHeight || Math.round(window.innerHeight));

    const scaledWidth = Math.max(1, Math.round(canvasWidthCss * dpr));
    const scaledHeight = Math.max(1, Math.round(canvasHeightCss * dpr));

    const pixelSizeChanged = canvas.width !== scaledWidth || canvas.height !== scaledHeight;
    if (pixelSizeChanged) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
    }

    const widthCss = `${canvasWidthCss}px`;
    const heightCss = `${canvasHeightCss}px`;
    if (canvas.style.width !== widthCss) {
      canvas.style.width = widthCss;
    }
    if (canvas.style.height !== heightCss) {
      canvas.style.height = heightCss;
    }

    if (renderer && pixelSizeChanged) {
      renderer.resize(canvas.width, canvas.height);
    }
    if ($displayImageMode === "book" && bookBaseImage) {
      requestBookTextureUpdate(true);
    }
    if (fallbackMode && canvas2dContext) {
      drawFallbackScene();
    }

    requestRender();
  }

  function attemptErrorRecovery(error: WebGLErrorInfo) {
    switch (error.type) {
      case WebGLErrorType.TEXTURE_CREATION:
      case WebGLErrorType.FRAMEBUFFER_CREATION:
        // Try to free up memory and retry
        if (renderer) {
          try {
            // Clear error state and retry initialization
            errorMessage = "";
            errorInfo = null;
            loadingMessage = "Recovering from error...";
            
            // Small delay to allow memory cleanup
            setTimeout(async () => {
              try {
                if (renderer) {
                  await renderer.initialize();
                  loadingMessage = "";
                }
              } catch {
                errorMessage = "Recovery failed. Please refresh the page.";
                loadingMessage = "";
              }
            }, 1000);
          } catch {
            errorMessage = "Recovery failed. Please refresh the page.";
            loadingMessage = "";
          }
        }
        break;
        
      case WebGLErrorType.RENDER_ERROR:
        // Try to restart the render loop
        if (renderer && imageTextureId) {
          errorMessage = "";
          errorInfo = null;
          startRenderLoop();
        }
        break;
      
      default:
        break;
    }
  }

  function clearError() {
    errorMessage = "";
    errorInfo = null;
    showErrorDetails = false;
  }

  function toggleErrorDetails() {
    showErrorDetails = !showErrorDetails;
  }

  function retryOperation() {
    if (errorInfo) {
      attemptErrorRecovery(errorInfo);
    } else {
      // General retry - reload the component
      location.reload();
    }
  }

  function updateLoadingProgress(message: string, step: number) {
    loadingMessage = message;
    currentStep = step;
    loadingProgress = Math.round((step / Math.max(loadingSteps.length - 1, 1)) * 100);
  }

  function checkWebGLSupport(): boolean {
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
      
      if (!gl) {
        return false;
      }
      
      // Check for required extensions and capabilities
      const webglContext = gl as WebGLRenderingContext;
      const requiredExtensions = ['OES_texture_float'];
      for (const ext of requiredExtensions) {
        webglContext.getExtension(ext);
      }
      
      // Check for minimum capabilities
      const maxTextureSize = webglContext.getParameter(webglContext.MAX_TEXTURE_SIZE);
      if (maxTextureSize < 1024) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  async function initializeCanvas2DFallback() {
    try {
      updateLoadingProgress("Setting up Canvas2D fallback...", 2);
      
      canvas2dContext = canvas.getContext('2d');
      if (!canvas2dContext) {
        throw new Error('Canvas2D not supported');
      }
      
      updateLoadingProgress("Loading image...", 4);
      await loadSceneImage($displayImageMode, { initialLoad: true });
      
      updateLoadingProgress("Starting render loop...", 5);
      isInitialized = true;
      startCanvas2DRenderLoop();
      
      updateLoadingProgress("Ready! (Canvas2D mode)", 6);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      loadingMessage = "";
      showProgressBar = false;
    } catch (error) {
      errorMessage = `Fallback initialization failed: ${error}`;
      loadingMessage = "";
      showProgressBar = false;
    }
  }

  function drawFallbackScene() {
    if (!canvas2dContext) return;

    const ctx = canvas2dContext;
    const width = canvas.width;
    const height = canvas.height;

    ctx.save();

    if ($displayImageMode === "book" && fallbackImage && fallbackBackgroundImage) {
      const cssWidth = Math.max(1, cachedCanvasCssWidth);
      const dpr = width / cssWidth;

      ctx.clearRect(0, 0, width, height);
      drawImageCover(ctx, fallbackBackgroundImage, width, height);

      const bookWidth = foregroundImageWidth * foregroundScale * dpr;
      const bookHeight = foregroundImageHeight * foregroundScale * dpr;
      const x = (width - bookWidth) * 0.5;
      const y = height - bookHeight;

      ctx.drawImage(fallbackImage, x, y, bookWidth, bookHeight);
      ctx.restore();
      return;
    }

    // Letters fallback mode.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const scale = Math.min(width / TEST_PATTERN_BASE_WIDTH, height / TEST_PATTERN_BASE_HEIGHT);
    const offsetX = (width - TEST_PATTERN_BASE_WIDTH * scale) / 2;
    const offsetY = (height - TEST_PATTERN_BASE_HEIGHT * scale) / 2;

    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    renderTestPatternBase(ctx, { includeFallbackIndicator: true });
    ctx.restore();
  }

  function startCanvas2DRenderLoop() {
    renderFrameCallback = (timestamp: number) => {
      if (!canvas2dContext || !isInitialized) {
        return;
      }
      updateFrameRate(timestamp);
      
      try {
        const startTime = performance.now();
        
        // Simple blur simulation using Canvas2D
        renderCanvas2DWithBlur();
        
        const endTime = performance.now();
        renderTime.set(endTime - startTime);
      } catch (error) {
        errorMessage = `Canvas2D render error: ${error}`;
      }
    };

    requestRender();
  }

  function renderCanvas2DWithBlur() {
    if (!canvas2dContext) return;
    
    const ctx = canvas2dContext;
    const renderPixelScale = Math.max(0.001, canvas.width / Math.max(1, cachedCanvasCssWidth));
    const blurPolicy = resolveBlurPolicy({
      sigmaCssRaw: $blurSigma,
      deviceCssPxPerMm: $effectiveCssPxPerMm,
      viewingDistanceM: $viewingDistance,
      renderPixelScale,
      blurRenderScale: BLUR_RENDER_SCALE
    });
    const blurAmount = blurPolicy.sigmaTexelUsedFull;
    const backgroundBlurAmount = resolveBlurPolicy({
      sigmaCssRaw: $backgroundBlurSigma,
      deviceCssPxPerMm: $effectiveCssPxPerMm,
      viewingDistanceM: $viewingDistance,
      renderPixelScale,
      blurRenderScale: BLUR_RENDER_SCALE,
      foregroundCoverage: 1
    }).sigmaTexelUsedFull;

    if ($displayImageMode === "book" && fallbackImage && fallbackBackgroundImage) {
      const width = canvas.width;
      const height = canvas.height;
      const cssWidth = Math.max(1, cachedCanvasCssWidth);
      const dpr = width / cssWidth;

      const bookWidth = foregroundImageWidth * foregroundScale * dpr;
      const bookHeight = foregroundImageHeight * foregroundScale * dpr;
      const x = (width - bookWidth) * 0.5;
      const y = height - bookHeight;

      ctx.clearRect(0, 0, width, height);
      ctx.save();
      if (backgroundBlurAmount > 1) {
        ctx.filter = `blur(${backgroundBlurAmount}px)`;
      }
      drawImageCover(ctx, fallbackBackgroundImage, width, height);
      ctx.restore();

      ctx.save();
      if (blurAmount > 1) {
        ctx.filter = `blur(${blurAmount}px)`;
      }
      ctx.drawImage(fallbackImage, x, y, bookWidth, bookHeight);
      ctx.restore();
      return;
    }

    // Letters fallback behavior.
    drawFallbackScene();
    if (blurAmount > 1) {
      ctx.filter = `blur(${blurAmount}px)`;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      ctx.filter = 'none';
    }
  }

  // Handle window resize and orientation change
  let resizeTimeout: number;
  function onViewportResize() {
    updateViewportScaleState(true);
    handleResize();
  }

  function onWindowResize() {
    clearTimeout(resizeTimeout);
    updateViewportScaleState(true);
    resizeTimeout = setTimeout(handleResize, RESIZE_DEBOUNCE_MS);
  }

  function onOrientationChange() {
    // Handle orientation change with a short settle delay.
    setTimeout(() => {
      updateViewportScaleState(true);
      handleResize();
    }, 300);
  }

  $: if (canvas && isInitialized) {
    handleResize();
  }

  $: if (isMounted && isInitialized && renderFrameCallback) {
    const _renderDeps = [
      $displayImageMode,
      $simulationMode,
      $presbyopiaProfile,
      $presbyopiaCompareProfile,
      $splitViewEnabled,
      $masterDefocus,
      $blurSigma,
      $compareBlurSigma,
      $backgroundBlurSigma,
      $compareBackgroundBlurSigma,
      $nsGrade,
      $pscRadius,
      $pscDensity,
      $pscSoftness,
      $viewingDistance,
      $effectiveCssPxPerMm,
      foregroundDisplayWidthCssPx,
      foregroundDisplayHeightCssPx,
      foregroundTextureWidth,
      foregroundTextureHeight,
      imageTextureId ?? "",
      backgroundTextureId ?? ""
    ];
    _renderDeps;
    requestRender();
  }

  $: if (isMounted && isInitialized && $displayImageMode === "book" && bookBaseImage && canvas) {
    const renderPixelScale = getRenderPixelScale();
    const quantStep = BOOK_TEXTURE_SIZE_QUANTIZATION_PX;
    const requestedWidthTex = Math.max(1, Math.round(foregroundDisplayWidthCssPx * renderPixelScale));
    const requestedHeightTex = Math.max(1, Math.round(foregroundDisplayHeightCssPx * renderPixelScale));
    const _bookTextureDeps = [
      Math.round(requestedWidthTex / quantStep),
      Math.round(requestedHeightTex / quantStep),
      canvas.width,
      canvas.height
    ];
    _bookTextureDeps;
    requestBookTextureUpdate(false);
    scheduleBookTexturePrewarm();
  }

  $: if (
    isMounted &&
    isInitialized &&
    $displayImageMode !== loadedDisplayMode
  ) {
    void loadSceneImage($displayImageMode);
  }
</script>

<svelte:window on:resize={onWindowResize} on:orientationchange={onOrientationChange} />

<div class="canvas-root">
  <div class="canvas-container" bind:this={canvasContainer}>
    <canvas
      bind:this={canvas}
      class="canvas-element {fallbackMode ? 'fallback-mode' : ''}"
      style="object-fit: contain;"
      aria-label={fallbackMode ? 'Vision simulation canvas (Canvas2D fallback mode)' : 'Vision simulation canvas (WebGL mode)'}
    ></canvas>

    <!-- Loading overlay -->
    {#if loadingMessage}
      <div
        class="absolute inset-0 bg-white bg-opacity-95 flex items-center justify-center p-4"
      >
        <div class="text-center max-w-sm w-full">
          <div
            class="animate-spin rounded-full h-8 w-8 border-b-2 border-medical-blue mx-auto mb-4"
          ></div>
          
          <p class="text-sm text-gray-700 font-medium mb-3">{loadingMessage}</p>
          
          {#if showProgressBar}
            <!-- Progress bar -->
            <div class="w-full bg-gray-200 rounded-full h-2 mb-3">
              <div 
                class="bg-medical-blue h-2 rounded-full transition-all duration-300 ease-out"
                style="width: {loadingProgress}%"
              ></div>
            </div>
            
            <!-- Progress percentage -->
            <p class="text-xs text-gray-500 mb-3">{loadingProgress}%</p>
            
            <!-- Loading steps -->
            {#if loadingSteps.length > 0}
              <div class="text-left">
                <p class="text-xs text-gray-600 mb-2">Progress:</p>
                <div class="space-y-1">
                  {#each loadingSteps as step, index}
                    <div class="flex items-center text-xs">
                      {#if index < currentStep}
                        <svg class="w-3 h-3 text-green-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path>
                        </svg>
                        <span class="text-green-600">{step}</span>
                      {:else if index === currentStep}
                        <div class="w-3 h-3 mr-2">
                          <div class="animate-spin rounded-full h-3 w-3 border border-medical-blue border-t-transparent"></div>
                        </div>
                        <span class="text-medical-blue font-medium">{step}</span>
                      {:else}
                        <div class="w-3 h-3 bg-gray-300 rounded-full mr-2"></div>
                        <span class="text-gray-400">{step}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
          
          <!-- Timeout warning -->
          {#if loadingMessage && !showProgressBar}
            <p class="text-xs text-gray-400 mt-2">
              If loading takes too long, try refreshing the page
            </p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Error overlay -->
    {#if errorMessage}
      <div
        class="absolute inset-0 bg-red-50 bg-opacity-95 flex items-center justify-center p-4"
      >
        <div class="bg-white rounded-lg shadow-lg p-6 max-w-md w-full">
          <div class="flex items-center mb-4">
            <svg
              class="w-6 h-6 text-red-500 mr-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.464 0L4.35 16.5c-.77.833.192 2.5 1.732 2.5z"
              ></path>
            </svg>
            <h3 class="text-lg font-medium text-red-800">Graphics Error</h3>
          </div>
          
          <p class="text-sm text-red-700 mb-4">{errorMessage}</p>
          
          {#if errorInfo && errorInfo.suggestions.length > 0}
            <div class="mb-4">
              <p class="text-xs font-medium text-gray-700 mb-2">Suggestions:</p>
              <ul class="text-xs text-gray-600 space-y-1">
                {#each errorInfo.suggestions as suggestion}
                  <li class="flex items-start">
                    <span class="text-blue-500 mr-2">•</span>
                    {suggestion}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          
          <div class="flex flex-wrap gap-2">
            {#if errorInfo && errorInfo.recoverable}
              <button
                class="px-3 py-1 bg-blue-100 text-blue-700 rounded text-xs hover:bg-blue-200 touch-manipulation"
                on:click={retryOperation}
              >
                Try Again
              </button>
            {/if}
            
            <button
              class="px-3 py-1 bg-gray-100 text-gray-700 rounded text-xs hover:bg-gray-200 touch-manipulation"
              on:click={clearError}
            >
              Dismiss
            </button>
            
            <button
              class="px-3 py-1 bg-red-100 text-red-700 rounded text-xs hover:bg-red-200 touch-manipulation"
              on:click={() => location.reload()}
            >
              Reload Page
            </button>
            
            {#if errorInfo}
              <button
                class="px-3 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200 touch-manipulation"
                on:click={toggleErrorDetails}
              >
                {showErrorDetails ? 'Hide' : 'Show'} Details
              </button>
            {/if}
          </div>
          
          {#if showErrorDetails && errorInfo}
            <div class="mt-4 p-3 bg-gray-50 rounded text-xs">
              <p class="font-medium text-gray-700 mb-1">Technical Details:</p>
              <p class="text-gray-600 mb-1">Type: {errorInfo.type}</p>
              <p class="text-gray-600 mb-1">Time: {new Date(errorInfo.timestamp).toLocaleTimeString()}</p>
              <p class="text-gray-600 break-all">Message: {errorInfo.message}</p>
              {#if errorInfo.context}
                <p class="text-gray-600 mt-2 break-all">Context: {JSON.stringify(errorInfo.context)}</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if $splitViewEnabled}
      <BadgeTag text={vaBadgeText} styleText="top: 0.5rem; left: 0.5rem;" />
      <BadgeTag text={compareVABadgeText} styleText="top: 0.5rem; left: calc(50% + 0.5rem);" />
    {:else}
      <BadgeTag text={vaBadgeText} styleText="top: 0.5rem; left: 0.5rem;" />
    {/if}
    <BadgeTag text={holdingDistanceBadgeText} styleText="left: 0.5rem; bottom: 0.5rem;" />
    <BadgeTag text={overlayReadout} styleText="right: 0.5rem; bottom: 0.5rem;" />
    {#if zoomBannerVisible && zoomScaleDrift >= ZOOM_DRIFT_WARNING_THRESHOLD}
      <div class="zoom-banner">Zoom changed - size adjusted</div>
    {/if}


  </div>
</div>

<style>
  .canvas-root {
    height: 100%;
    background: #111827;
  }

  .canvas-container {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 100%;
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .canvas-element {
    width: 100%;
    height: 100%;
    display: block;
    background: #111827;
    max-width: 100%;
    max-height: 100%;
  }

  .canvas-element {
    image-rendering: -webkit-optimize-contrast;
    image-rendering: -moz-crisp-edges;
    image-rendering: crisp-edges;
  }

  .zoom-banner {
    position: absolute;
    left: 50%;
    top: 0.5rem;
    transform: translateX(-50%);
    padding: 0.26rem 0.5rem;
    border-radius: 0.45rem;
    background: rgba(17, 24, 39, 0.85);
    color: #f9fafb;
    font-size: 0.68rem;
    line-height: 1;
    pointer-events: none;
  }
  
  /* Improve touch targets on mobile */
  @media (max-width: 768px) {
    .touch-manipulation {
      touch-action: manipulation;
      min-height: 44px; /* iOS recommended minimum touch target */
      min-width: 44px;
    }
  }
  
  /* Browser-specific canvas optimizations */
  
  /* Chrome/Blink specific */
  @supports (image-rendering: -webkit-optimize-contrast) {
    .canvas-element {
      image-rendering: -webkit-optimize-contrast;
    }
  }
  
  /* Firefox specific */
  @supports (image-rendering: -moz-crisp-edges) {
    .canvas-element {
      image-rendering: -moz-crisp-edges;
    }
  }
  
  /* Safari specific */
  @supports (-webkit-appearance: none) {
    .canvas-element {
      -webkit-transform: translateZ(0);
      transform: translateZ(0);
      -webkit-backface-visibility: hidden;
      backface-visibility: hidden;
    }
  }
  
  /* Fallback mode styling */
  .fallback-mode {
    border: 2px dashed #ff6b35;
    background: linear-gradient(45deg, #fff 25%, #fef7f0 25%, #fef7f0 50%, #fff 50%, #fff 75%, #fef7f0 75%);
    background-size: 20px 20px;
  }
  
  /* Cross-browser animation support */
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  .animate-spin {
    animation: spin 1s linear infinite;
  }
  
  /* Ensure consistent box-sizing across browsers */
  *, *::before, *::after {
    box-sizing: border-box;
  }
  
  /* Fix for older browsers that don't support CSS custom properties */
  @supports not (--css: variables) {
    .bg-medical-blue {
      background-color: #0066cc;
    }
    
    .text-medical-blue {
      color: #0066cc;
    }
    
    .border-medical-blue {
      border-color: #0066cc;
    }
  }
</style>

