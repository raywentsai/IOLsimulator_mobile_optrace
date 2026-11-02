/**
 * WebGL renderer for the IOL Vision Simulator
 * Handles Gaussian blur, cataract effects, and rendering pipeline
 */

import {
  createProgram,
  createTextureFromImage,
  createFramebuffer,
  createFullscreenQuad,
  setupFullscreenQuadAttributes,
  renderFullscreenQuad,
  UniformSetter,
  cleanupResources
} from './webgl-utils';

import { shaderPrograms } from './shaders';
import { KernelCache } from './gaussian';

type DownsampleFactor = 1 | 2 | 4 | 8 | 16;
type BlurPath = 'full-res' | 'downsample-2x' | 'downsample-4x' | 'downsample-8x' | 'downsample-16x' | 'copy';

/**
 * Rendering configuration
 */
export interface RenderConfig {
  width: number;
  height: number;
  blurSigma: number;
  compareBlurSigma?: number;
  blurDownsampleFactor?: DownsampleFactor;
  compareBlurDownsampleFactor?: DownsampleFactor;
  backgroundBlurSigma?: number;
  compareBackgroundBlurSigma?: number;
  backgroundBlurDownsampleFactor?: DownsampleFactor;
  compareBackgroundBlurDownsampleFactor?: DownsampleFactor;
  nsGrade: number;
  pscRadius: number;
  pscDensity: number;
  pscSoftness: number;
  compareNsGrade?: number;
  comparePscRadius?: number;
  comparePscDensity?: number;
  comparePscSoftness?: number;
  splitView: boolean;
  splitPosition: number;
  backgroundTextureId?: string;
  backgroundNativeWidth?: number;
  backgroundNativeHeight?: number;
  foregroundScale?: number;
  foregroundNativeWidth?: number;
  foregroundNativeHeight?: number;
}

export interface BlurExecutionDiagnostics {
  outputFramebufferId: string;
  path: BlurPath;
  requestedSigma: number;
  sigmaTexelUsed: number;
  sigmaPerPass: number;
  passCount: number;
  kernelTapCount: number;
  kernelMaxOffset: number;
  downsampleFactor: DownsampleFactor;
  width: number;
  height: number;
}

/**
 * WebGL resources
 */
interface WebGLResources {
  programs: Map<string, WebGLProgram>;
  textures: Map<string, WebGLTexture>;
  framebuffers: Map<
    string,
    { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number }
  >;
  vertexBuffer: WebGLBuffer;
  uniformSetters: Map<string, UniformSetter>;
}

/**
 * Context loss event interface
 */
interface ContextLossEvent {
  timestamp: number;
  recoverable: boolean;
  errorMessage?: string;
}

/**
 * WebGL error types
 */
export enum WebGLErrorType {
  CONTEXT_LOST = 'context_lost',
  SHADER_COMPILATION = 'shader_compilation',
  TEXTURE_CREATION = 'texture_creation',
  FRAMEBUFFER_CREATION = 'framebuffer_creation',
  RENDER_ERROR = 'render_error',
  CAPABILITY_ERROR = 'capability_error',
  TIMEOUT_ERROR = 'timeout_error'
}

/**
 * Enhanced error information
 */
export interface WebGLErrorInfo {
  type: WebGLErrorType;
  message: string;
  userMessage: string;
  suggestions: string[];
  recoverable: boolean;
  timestamp: number;
  context?: any;
}

/**
 * Main WebGL renderer class
 */
export class WebGLRenderer {
  private gl: WebGLRenderingContext;
  private canvas: HTMLCanvasElement;
  private resources: WebGLResources;
  private kernelCache: KernelCache;
  private isInitialized = false;

  // Context management properties
  private contextLost = false;
  private restoreAttempts = 0;
  private readonly MAX_RESTORE_ATTEMPTS = 3;
  private readonly MIN_BLUR_SIGMA_TEXEL = 0.1;
  private readonly MAX_BLUR_SIGMA_PER_PASS_TEXEL = 10.0;
  private readonly MAX_PSC_BLUR_SIGMA_TEXEL = 28.0;
  private contextLossHandler?: (event: ContextLossEvent) => void;
  private errorHandler?: (error: WebGLErrorInfo) => void;
  private blurDiagnostics = new Map<string, BlurExecutionDiagnostics>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      throw new Error('WebGL not supported');
    }

    this.gl = gl as WebGLRenderingContext;
    this.kernelCache = new KernelCache();

    this.resources = {
      programs: new Map(),
      textures: new Map(),
      framebuffers: new Map(),
      vertexBuffer: null as any,
      uniformSetters: new Map()
    };

    // Set up context loss handling
    this.setupContextLossHandling();


  }

  /**
   * Set up WebGL context loss and restore event handlers
   */
  private setupContextLossHandling(): void {
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  /**
   * Handle WebGL context loss
   */
  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.isInitialized = false;

    const contextEvent: ContextLossEvent = {
      timestamp: Date.now(),
      recoverable: true,
      errorMessage: 'WebGL context was lost'
    };

    if (this.contextLossHandler) {
      this.contextLossHandler(contextEvent);
    }
  };

  /**
   * Handle WebGL context restoration
   */
  private onContextRestored = async (): Promise<void> => {
    this.contextLost = false;
    this.restoreAttempts++;

    if (this.restoreAttempts > this.MAX_RESTORE_ATTEMPTS) {
      const contextEvent: ContextLossEvent = {
        timestamp: Date.now(),
        recoverable: false,
        errorMessage: 'Failed to restore WebGL context after maximum attempts'
      };

      if (this.contextLossHandler) {
        this.contextLossHandler(contextEvent);
      }
      return;
    }

    try {
      // Clear existing resources
      this.clearResources();

      // Reinitialize the renderer
      await this.initialize();


      this.restoreAttempts = 0; // Reset on successful restore

    } catch (error) {
      const contextEvent: ContextLossEvent = {
        timestamp: Date.now(),
        recoverable: this.restoreAttempts < this.MAX_RESTORE_ATTEMPTS,
        errorMessage: `Context restore failed: ${error}`
      };

      if (this.contextLossHandler) {
        this.contextLossHandler(contextEvent);
      }
    }
  };

  /**
   * Set context loss event handler
   */
  setContextLossHandler(handler: (event: ContextLossEvent) => void): void {
    this.contextLossHandler = handler;
  }

  /**
   * Set error handler for WebGL errors
   */
  setErrorHandler(handler: (error: WebGLErrorInfo) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Emit an error through the error handler
   */
  private emitError(type: WebGLErrorType, message: string, userMessage: string, suggestions: string[] = [], recoverable: boolean = false, context?: any): void {
    if (this.errorHandler) {
      const errorInfo: WebGLErrorInfo = {
        type,
        message,
        userMessage,
        suggestions,
        recoverable,
        timestamp: Date.now(),
        context
      };
      this.errorHandler(errorInfo);
    }
  }

  /**
   * Check if WebGL context is valid
   */
  isContextValid(): boolean {
    return !this.contextLost && this.gl && !this.gl.isContextLost();
  }

  /**
   * Clear all WebGL resources
   */
  private clearResources(): void {
    this.resources.programs.clear();
    this.resources.textures.clear();
    this.resources.framebuffers.clear();
    this.resources.uniformSetters.clear();
    this.kernelCache.clear();
    this.blurDiagnostics.clear();
  }

  /**
   * Initialize the renderer
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Check context validity before initialization
    if (!this.isContextValid()) {
      const errorMsg = 'Cannot initialize: WebGL context is lost or invalid';
      this.emitError(
        WebGLErrorType.CONTEXT_LOST,
        errorMsg,
        'Graphics initialization failed. Please refresh the page.',
        ['Refresh the page', 'Check if WebGL is enabled in your browser'],
        true
      );
      throw new Error(errorMsg);
    }

    try {
      // Create shader programs
      await this.createShaderPrograms();

      // Create vertex buffer for full-screen quad
      const vertexBuffer = createFullscreenQuad(this.gl);
      if (!vertexBuffer) {
        const errorMsg = 'Failed to create vertex buffer';
        this.emitError(
          WebGLErrorType.RENDER_ERROR,
          errorMsg,
          'Graphics setup failed. Please try refreshing the page.',
          ['Refresh the page', 'Check browser WebGL support'],
          true
        );
        throw new Error(errorMsg);
      }
      this.resources.vertexBuffer = vertexBuffer;

      // Set up WebGL state
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.disable(this.gl.CULL_FACE);
      this.gl.disable(this.gl.BLEND);

      this.isInitialized = true;

    } catch (error) {
      this.emitError(
        WebGLErrorType.RENDER_ERROR,
        `Initialization failed: ${error}`,
        'Graphics initialization failed. Please refresh the page.',
        ['Refresh the page', 'Update your browser', 'Check WebGL support'],
        true,
        { originalError: error }
      );
      throw error;
    }
  }

  /**
   * Create all required shader programs
   */
  private async createShaderPrograms(): Promise<void> {
    const programNames = [
      'copy',
      'horizontalBlur',
      'verticalBlur',
      'nuclearSclerosis',
      'pscMask',
      'positionedForeground',
      'composite',
      'splitView'
    ];

    for (const name of programNames) {
      const shaderConfig = shaderPrograms[name as keyof typeof shaderPrograms];
      const program = createProgram(this.gl, shaderConfig.vertex, shaderConfig.fragment);

      if (!program) {
        const errorMsg = `Failed to create shader program: ${name}`;
        this.emitError(
          WebGLErrorType.SHADER_COMPILATION,
          errorMsg,
          'Graphics shader compilation failed. Your browser may not support required features.',
          ['Update your browser', 'Check WebGL support', 'Try a different browser'],
          false,
          { shaderName: name }
        );
        throw new Error(errorMsg);
      }

      this.resources.programs.set(name, program);
      this.resources.uniformSetters.set(name, new UniformSetter(this.gl, program));
    }
  }

  /**
   * Load an image as a texture
   */
  async loadImageTexture(imageSource: string | HTMLImageElement | HTMLCanvasElement): Promise<string> {
    let image: HTMLImageElement | HTMLCanvasElement;

    if (typeof imageSource === 'string') {
      const loadedImage = new Image();
      await new Promise<void>((resolve, reject) => {
        loadedImage.onload = () => resolve();
        loadedImage.onerror = reject;
        loadedImage.src = imageSource;
      });
      image = loadedImage;
    } else {
      image = imageSource;
    }

    const texture = createTextureFromImage(this.gl, image, {
      flipY: true,
      minFilter: this.gl.LINEAR,
      magFilter: this.gl.LINEAR
    });

    if (!texture) {
      throw new Error('Failed to create texture from image');
    }

    const textureId = `image_${Date.now()}`;
    this.resources.textures.set(textureId, texture);
    return textureId;
  }

  /**
   * Update an existing texture in-place to avoid reallocating texture IDs.
   * Returns false if the texture is missing and cannot be updated.
   */
  updateImageTexture(textureId: string, imageSource: HTMLImageElement | HTMLCanvasElement): boolean {
    const texture = this.resources.textures.get(textureId);
    if (!texture) {
      return false;
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, imageSource);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    return true;
  }

  /**
   * Release a texture and free GPU memory
   */
  releaseTexture(textureId: string): void {
    if (!textureId) {
      return;
    }

    const texture = this.resources.textures.get(textureId);
    if (!texture) {
      return;
    }

    if (this.gl && !this.gl.isContextLost()) {
      this.gl.deleteTexture(texture);
    }

    this.resources.textures.delete(textureId);
  }

  /**
   * Create or resize framebuffers
   */
  private ensureFramebuffer(
    name: string,
    width: number,
    height: number
  ): { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } {
    const existing = this.resources.framebuffers.get(name);
    if (existing && existing.width === width && existing.height === height) {
      return existing;
    }

    if (existing) {
      this.gl.deleteFramebuffer(existing.framebuffer);
      this.gl.deleteTexture(existing.texture);
      this.resources.framebuffers.delete(name);
    }

    const fb = createFramebuffer(this.gl, width, height);
    if (!fb) {
      throw new Error(`Failed to create framebuffer: ${name}`);
    }

    const entry = {
      framebuffer: fb.framebuffer,
      texture: fb.texture,
      width,
      height
    };
    this.resources.framebuffers.set(name, entry);
    return entry;
  }

  private ensureFramebuffers(width: number, height: number): void {
    const requiredFramebuffers = [
      'blurred',
      'foregroundSharp',
      'compareLeft',
      'compareRight',
      'compareLeftComposite',
      'compareRightComposite'
    ];

    for (const name of requiredFramebuffers) {
      this.ensureFramebuffer(name, width, height);
    }
  }

  private getBlurPathFromDownsample(downsampleFactor: DownsampleFactor): Exclude<BlurPath, 'copy'> {
    if (downsampleFactor === 16) {
      return 'downsample-16x';
    }
    if (downsampleFactor === 8) {
      return 'downsample-8x';
    }
    if (downsampleFactor === 4) {
      return 'downsample-4x';
    }
    if (downsampleFactor === 2) {
      return 'downsample-2x';
    }
    return 'full-res';
  }

  /**
   * Apply Gaussian blur using separable filtering
   */
  private applyGaussianBlur(
    inputTextureId: string,
    outputFramebufferId: string,
    sigma: number,
    width: number,
    height: number,
    downsampleFactor: DownsampleFactor = 1
  ): void {
    const temp1Id = `${outputFramebufferId}__temp1`;
    const temp2Id = `${outputFramebufferId}__temp2`;
    const temp3Id = `${outputFramebufferId}__temp3`;

    this.ensureFramebuffer(temp1Id, width, height);
    this.ensureFramebuffer(temp2Id, width, height);
    this.ensureFramebuffer(temp3Id, width, height);
    this.ensureFramebuffer(outputFramebufferId, width, height);

    const blurPath = this.getBlurPathFromDownsample(downsampleFactor);

    if (sigma < this.MIN_BLUR_SIGMA_TEXEL) {
      // No blur needed, just copy
      this.copyTexture(inputTextureId, outputFramebufferId);
      this.blurDiagnostics.set(outputFramebufferId, {
        outputFramebufferId,
        path: 'copy',
        requestedSigma: sigma,
        sigmaTexelUsed: 0,
        sigmaPerPass: 0,
        passCount: 0,
        kernelTapCount: 0,
        kernelMaxOffset: 0,
        downsampleFactor,
        width,
        height
      });
      return;
    }

    const requestedSigma = Math.max(this.MIN_BLUR_SIGMA_TEXEL, sigma);
    const passCount = Math.max(
      1,
      Math.ceil(
        (requestedSigma * requestedSigma) /
          (this.MAX_BLUR_SIGMA_PER_PASS_TEXEL * this.MAX_BLUR_SIGMA_PER_PASS_TEXEL)
      )
    );
    const sigmaPerPass = requestedSigma / Math.sqrt(passCount);
    const kernel = this.kernelCache.getKernel(sigmaPerPass);
    const temp1 = this.resources.framebuffers.get(temp1Id)!;
    const hBlurProgram = this.resources.programs.get('horizontalBlur')!;
    const hBlurUniforms = this.resources.uniformSetters.get('horizontalBlur')!;
    const vBlurProgram = this.resources.programs.get('verticalBlur')!;
    const vBlurUniforms = this.resources.uniformSetters.get('verticalBlur')!;
    const initialInputTexture = this.resources.textures.get(inputTextureId)!;

    let currentSourceTexture = initialInputTexture;
    let lastTargetId = outputFramebufferId;

    for (let passIndex = 0; passIndex < passCount; passIndex++) {
      // Horizontal pass
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, temp1.framebuffer);
      this.gl.viewport(0, 0, width, height);

      this.gl.useProgram(hBlurProgram);
      setupFullscreenQuadAttributes(this.gl, hBlurProgram, this.resources.vertexBuffer);

      hBlurUniforms.setTexture('u_image', currentSourceTexture, 0);
      hBlurUniforms.setVec2('u_texelSize', 1.0 / width, 1.0 / height);
      hBlurUniforms.setFloatArray('u_weights', kernel.weights);
      hBlurUniforms.setFloatArray('u_offsets', kernel.offsets);
      hBlurUniforms.setInt('u_tapCount', kernel.tapCount);

      renderFullscreenQuad(this.gl);

      // Vertical pass
      const isFinalPass = passIndex === passCount - 1;
      const targetId = isFinalPass
        ? outputFramebufferId
        : (passIndex % 2 === 0 ? temp2Id : temp3Id);
      const outputFb = this.resources.framebuffers.get(targetId)!;
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);

      this.gl.useProgram(vBlurProgram);
      setupFullscreenQuadAttributes(this.gl, vBlurProgram, this.resources.vertexBuffer);

      vBlurUniforms.setTexture('u_image', temp1.texture, 0);
      vBlurUniforms.setVec2('u_texelSize', 1.0 / width, 1.0 / height);
      vBlurUniforms.setFloatArray('u_weights', kernel.weights);
      vBlurUniforms.setFloatArray('u_offsets', kernel.offsets);
      vBlurUniforms.setInt('u_tapCount', kernel.tapCount);

      renderFullscreenQuad(this.gl);

      lastTargetId = targetId;
      if (!isFinalPass) {
        currentSourceTexture = outputFb.texture;
      }
    }

    this.blurDiagnostics.set(outputFramebufferId, {
      outputFramebufferId,
      path: blurPath,
      requestedSigma: sigma,
      sigmaTexelUsed: requestedSigma,
      sigmaPerPass,
      passCount,
      kernelTapCount: kernel.tapCount,
      kernelMaxOffset: kernel.offsets[Math.max(0, kernel.tapCount - 1)] ?? 0,
      downsampleFactor,
      width,
      height
    });

    if (lastTargetId !== outputFramebufferId) {
      throw new Error(
        `Blur output mismatch: expected '${outputFramebufferId}', got '${lastTargetId}'`
      );
    }
  }

  /**
   * Copy texture to framebuffer
   */
  private copyTexture(inputTextureId: string, outputFramebufferId: string): void {
    const outputFb = this.resources.framebuffers.get(outputFramebufferId);
    const inputTexture = this.resources.textures.get(inputTextureId);

    if (!outputFb) {
      throw new Error(`Output framebuffer '${outputFramebufferId}' not found`);
    }
    if (!inputTexture) {
      throw new Error(`Input texture '${inputTextureId}' not found`);
    }

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);
    this.gl.viewport(0, 0, outputFb.width, outputFb.height);

    const copyProgram = this.resources.programs.get('copy')!;
    const copyUniforms = this.resources.uniformSetters.get('copy')!;

    this.gl.useProgram(copyProgram);
    setupFullscreenQuadAttributes(this.gl, copyProgram, this.resources.vertexBuffer);

    copyUniforms.setTexture('u_image', inputTexture, 0);
    renderFullscreenQuad(this.gl);
  }

  /**
   * Position and scale a foreground texture into a transparent framebuffer.
   * Foreground is centered horizontally and anchored to the bottom edge.
   */
  private positionForeground(
    inputTextureId: string,
    outputFramebufferId: string,
    normalizedWidth: number,
    normalizedHeight: number
  ): void {
    const outputFb = this.resources.framebuffers.get(outputFramebufferId);
    const inputTexture = this.resources.textures.get(inputTextureId);

    if (!outputFb) {
      throw new Error(`Output framebuffer '${outputFramebufferId}' not found`);
    }
    if (!inputTexture) {
      throw new Error(`Input texture '${inputTextureId}' not found`);
    }

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);
    this.gl.viewport(0, 0, outputFb.width, outputFb.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    const program = this.resources.programs.get('positionedForeground')!;
    const uniforms = this.resources.uniformSetters.get('positionedForeground')!;

    this.gl.useProgram(program);
    setupFullscreenQuadAttributes(this.gl, program, this.resources.vertexBuffer);

    uniforms.setTexture('u_image', inputTexture, 0);
    uniforms.setVec2('u_foregroundSize', normalizedWidth, normalizedHeight);
    renderFullscreenQuad(this.gl);
  }

  /**
   * Composite foreground over background with alpha blending in shader.
   */
  private compositeLayers(
    backgroundTextureId: string,
    foregroundTextureId: string,
    outputFramebufferId: string | null,
    backgroundAspect: number
  ): void {
    const backgroundTexture = this.resources.textures.get(backgroundTextureId);
    const foregroundTexture = this.resources.textures.get(foregroundTextureId);

    if (!backgroundTexture) {
      throw new Error(`Background texture '${backgroundTextureId}' not found`);
    }
    if (!foregroundTexture) {
      throw new Error(`Foreground texture '${foregroundTextureId}' not found`);
    }

    if (outputFramebufferId === null) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      const outputFb = this.resources.framebuffers.get(outputFramebufferId);
      if (!outputFb) {
        throw new Error(`Output framebuffer '${outputFramebufferId}' not found`);
      }
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);
      this.gl.viewport(0, 0, outputFb.width, outputFb.height);
    }

    const program = this.resources.programs.get('composite')!;
    const uniforms = this.resources.uniformSetters.get('composite')!;

    this.gl.useProgram(program);
    setupFullscreenQuadAttributes(this.gl, program, this.resources.vertexBuffer);

    uniforms.setTexture('u_backgroundImage', backgroundTexture, 0);
    uniforms.setTexture('u_foregroundImage', foregroundTexture, 1);
    uniforms.setFloat('u_backgroundAspect', backgroundAspect);
    uniforms.setFloat('u_viewAspect', this.canvas.width / Math.max(1, this.canvas.height));
    renderFullscreenQuad(this.gl);
  }

  /**
   * Apply nuclear sclerosis effect
   */
  private applyNuclearSclerosis(
    inputTextureId: string,
    outputFramebufferId: string,
    grade: number
  ): void {
    if (grade <= 0) {
      this.copyTexture(inputTextureId, outputFramebufferId);
      return;
    }

    const outputFb = this.resources.framebuffers.get(outputFramebufferId)!;
    const inputTexture = this.resources.textures.get(inputTextureId)!;

    // Calculate NS parameters
    const intensity = Math.max(0, Math.min(grade, 4)) / 4;
    const blueLoss = 0.62 * intensity;
    const redBoost = 0.18 * intensity;
    const greenLoss = 0.08 * intensity;
    const contrast = 1.0 - 0.38 * intensity;

    const colorMatrix = [
      1.0 + redBoost, 0.0, 0.0,
      0.0, 1.0 - greenLoss, 0.0,
      0.0, 0.0, 1.0 - blueLoss
    ];

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);
    this.gl.viewport(0, 0, outputFb.width, outputFb.height);

    const nsProgram = this.resources.programs.get('nuclearSclerosis')!;
    const nsUniforms = this.resources.uniformSetters.get('nuclearSclerosis')!;

    this.gl.useProgram(nsProgram);
    setupFullscreenQuadAttributes(this.gl, nsProgram, this.resources.vertexBuffer);

    nsUniforms.setTexture('u_image', inputTexture, 0);
    nsUniforms.setMat3('u_colorMatrix', colorMatrix);
    nsUniforms.setFloat('u_contrast', contrast);

    renderFullscreenQuad(this.gl);
  }

  /**
   * Apply PSC mask effect
   */
  private applyPSCMask(
    sharpTextureId: string,
    blurredTextureId: string,
    outputFramebufferId: string,
    radius: number,
    density: number,
    softness: number
  ): void {
    if (radius <= 0 || density <= 0) {
      this.copyTexture(sharpTextureId, outputFramebufferId);
      return;
    }

    const outputFb = this.resources.framebuffers.get(outputFramebufferId)!;
    const sharpTexture = this.resources.textures.get(sharpTextureId)!;
    const blurredTexture = this.resources.textures.get(blurredTextureId)!;

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFb.framebuffer);
    this.gl.viewport(0, 0, outputFb.width, outputFb.height);

    const pscProgram = this.resources.programs.get('pscMask')!;
    const pscUniforms = this.resources.uniformSetters.get('pscMask')!;

    this.gl.useProgram(pscProgram);
    setupFullscreenQuadAttributes(this.gl, pscProgram, this.resources.vertexBuffer);

    pscUniforms.setTexture('u_sharpImage', sharpTexture, 0);
    pscUniforms.setTexture('u_blurredImage', blurredTexture, 1);
    pscUniforms.setVec2('u_center', 0.5, 0.5); // Center of screen
    pscUniforms.setFloat('u_radius', radius);
    pscUniforms.setFloat('u_density', density);
    pscUniforms.setFloat('u_softness', softness);

    renderFullscreenQuad(this.gl);
  }

  private resolvePSCBlurDownsample(
    width: number,
    height: number,
    blurSigma: number
  ): DownsampleFactor {
    const pixelCount = width * height;
    if (pixelCount >= 3_000_000 || blurSigma >= 36) {
      return 4;
    }
    if (pixelCount >= 1_500_000 || blurSigma >= 18) {
      return 2;
    }
    return 1;
  }

  private applyCataractPostProcess(
    sourceTextureId: string,
    outputFramebufferId: string,
    width: number,
    height: number,
    nsGrade: number,
    pscRadius: number,
    pscDensity: number,
    pscSoftness: number,
    referenceSigma: number,
    keyPrefix: string
  ): string {
    const applyNS = nsGrade > 0;
    const applyPSC = pscRadius > 0 && pscDensity > 0;

    if (!applyNS && !applyPSC) {
      return sourceTextureId;
    }

    let currentTextureId = sourceTextureId;

    if (applyNS) {
      const nsFramebufferId = applyPSC ? `${keyPrefix}_ns` : outputFramebufferId;
      this.ensureFramebuffer(nsFramebufferId, width, height);
      this.applyNuclearSclerosis(currentTextureId, nsFramebufferId, nsGrade);
      const nsFb = this.resources.framebuffers.get(nsFramebufferId)!;
      const nsTextureAlias = `${keyPrefix}_ns_texture`;
      this.resources.textures.set(nsTextureAlias, nsFb.texture);
      currentTextureId = nsTextureAlias;
    }

    if (applyPSC) {
      const safeReferenceSigma = Number.isFinite(referenceSigma) ? Math.max(0, referenceSigma) : 0;
      const pscBlurSigma = Math.min(
        this.MAX_PSC_BLUR_SIGMA_TEXEL,
        Math.max(safeReferenceSigma * 2.4, 1.2) * (2.4 + pscDensity * 9.5)
      );
      const pscDownsample = this.resolvePSCBlurDownsample(width, height, pscBlurSigma);
      const blurWidth = Math.max(1, Math.ceil(width / pscDownsample));
      const blurHeight = Math.max(1, Math.ceil(height / pscDownsample));
      const blurSigmaGrid = pscBlurSigma / pscDownsample;

      const pscSourceFramebufferId = `${keyPrefix}_psc_source`;
      const pscSourceTextureAlias = `${keyPrefix}_psc_source_texture`;
      this.ensureFramebuffer(pscSourceFramebufferId, blurWidth, blurHeight);
      this.copyTexture(currentTextureId, pscSourceFramebufferId);
      const pscSourceFb = this.resources.framebuffers.get(pscSourceFramebufferId)!;
      this.resources.textures.set(pscSourceTextureAlias, pscSourceFb.texture);

      const pscBlurFramebufferId = `${keyPrefix}_psc_blur`;
      const pscBlurTextureAlias = `${keyPrefix}_psc_blur_texture`;
      this.applyGaussianBlur(
        pscSourceTextureAlias,
        pscBlurFramebufferId,
        blurSigmaGrid,
        blurWidth,
        blurHeight,
        pscDownsample
      );
      const pscBlurFb = this.resources.framebuffers.get(pscBlurFramebufferId)!;
      this.resources.textures.set(pscBlurTextureAlias, pscBlurFb.texture);

      this.ensureFramebuffer(outputFramebufferId, width, height);
      this.applyPSCMask(
        currentTextureId,
        pscBlurTextureAlias,
        outputFramebufferId,
        pscRadius,
        pscDensity,
        pscSoftness
      );
    }

    const outputFb = this.resources.framebuffers.get(outputFramebufferId)!;
    const outputTextureAlias = `${keyPrefix}_cataract_texture`;
    this.resources.textures.set(outputTextureAlias, outputFb.texture);
    return outputTextureAlias;
  }

  /**
   * Main render function
   */
  async render(imageTextureId: string, config: RenderConfig): Promise<void> {
    // Check context validity before rendering
    if (!this.isContextValid()) {
      const errorMsg = 'WebGL context is lost or invalid';
      this.emitError(
        WebGLErrorType.CONTEXT_LOST,
        errorMsg,
        'Graphics context lost. Please refresh the page.',
        ['Refresh the page'],
        true
      );
      throw new Error(errorMsg);
    }

    if (!this.isInitialized) {
      await this.initialize();
    }

    const {
      width,
      height,
      blurSigma,
      compareBlurSigma,
      blurDownsampleFactor,
      compareBlurDownsampleFactor,
      backgroundBlurSigma,
      compareBackgroundBlurSigma,
      backgroundBlurDownsampleFactor,
      compareBackgroundBlurDownsampleFactor,
      nsGrade,
      pscRadius,
      pscDensity,
      pscSoftness,
      compareNsGrade,
      comparePscRadius,
      comparePscDensity,
      comparePscSoftness,
      backgroundTextureId,
      backgroundNativeWidth,
      backgroundNativeHeight,
      foregroundScale,
      foregroundNativeWidth,
      foregroundNativeHeight
    } = config;

    // Ensure framebuffers are the right size
    this.ensureFramebuffers(width, height);

    const runForegroundDefocusBlur = (
      sourceTextureId: string,
      sigma: number,
      processingWidth: number,
      processingHeight: number,
      downsampleFactor: DownsampleFactor
    ): string => {
      let currentTextureId = sourceTextureId;

      // Step 1: Defocus blur
      if (sigma > 0.1) {
        this.applyGaussianBlur(
          currentTextureId,
          'blurred',
          sigma,
          processingWidth,
          processingHeight,
          downsampleFactor
        );
        const blurredFb = this.resources.framebuffers.get('blurred')!;
        this.resources.textures.set('blurred_texture', blurredFb.texture);
        currentTextureId = 'blurred_texture';
      } else {
        this.blurDiagnostics.set('blurred', {
          outputFramebufferId: 'blurred',
          path: this.getBlurPathFromDownsample(downsampleFactor),
          requestedSigma: sigma,
          sigmaTexelUsed: 0,
          sigmaPerPass: 0,
          passCount: 0,
          kernelTapCount: 0,
          kernelMaxOffset: 0,
          downsampleFactor,
          width: processingWidth,
          height: processingHeight
        });
      }

      return currentTextureId;
    };

    const normalizeDownsample = (value: number | undefined): DownsampleFactor => {
      if (value === 16 || value === 8 || value === 4 || value === 2 || value === 1) {
        return value;
      }
      return 1;
    };

    const rightNsGrade = typeof compareNsGrade === 'number' ? compareNsGrade : nsGrade;
    const rightPscRadius = typeof comparePscRadius === 'number' ? comparePscRadius : pscRadius;
    const rightPscDensity = typeof comparePscDensity === 'number' ? comparePscDensity : pscDensity;
    const rightPscSoftness = typeof comparePscSoftness === 'number' ? comparePscSoftness : pscSoftness;

    const overlayModeEnabled =
      typeof backgroundTextureId === 'string' &&
      typeof foregroundScale === 'number' &&
      typeof foregroundNativeWidth === 'number' &&
      typeof foregroundNativeHeight === 'number' &&
      foregroundNativeWidth > 0 &&
      foregroundNativeHeight > 0;

    if (overlayModeEnabled) {
      // Keep only a tiny epsilon floor; do not enforce a visible minimum size.
      const safeScale = Math.max(0.0001, foregroundScale);
      const displayWidth = Math.max(1, this.canvas.clientWidth);
      const displayHeight = Math.max(1, this.canvas.clientHeight);
      const normalizedWidth = (foregroundNativeWidth * safeScale) / displayWidth;
      const normalizedHeight = (foregroundNativeHeight * safeScale) / displayHeight;
      const foregroundWidthPxFull = Math.max(1, Math.round(normalizedWidth * width));
      const foregroundHeightPxFull = Math.max(1, Math.round(normalizedHeight * height));
      const visibleWidthPxFull = Math.max(1, Math.min(width, foregroundWidthPxFull));
      const visibleHeightPxFull = Math.max(1, Math.min(height, foregroundHeightPxFull));
      const backgroundAspect =
        typeof backgroundNativeWidth === 'number' &&
        typeof backgroundNativeHeight === 'number' &&
        backgroundNativeWidth > 0 &&
        backgroundNativeHeight > 0
          ? backgroundNativeWidth / backgroundNativeHeight
          : displayWidth / displayHeight;

      const processForegroundOverlay = (
        sigmaFull: number,
        downsampleFactorInput: number | undefined,
        outputFramebufferId: string,
        outputTextureAlias: string,
        diagnosticsId: string
      ): string => {
        const downsampleFactor = normalizeDownsample(downsampleFactorInput);
        const paddingFullPx = Math.ceil(Math.max(0, sigmaFull) * 3);
        const localFullWidth = Math.max(1, visibleWidthPxFull + paddingFullPx * 2);
        const localFullHeight = Math.max(1, visibleHeightPxFull + paddingFullPx);
        const blurWidth = Math.max(1, Math.ceil(localFullWidth / downsampleFactor));
        const blurHeight = Math.max(1, Math.ceil(localFullHeight / downsampleFactor));
        const localNormalizedWidth = (foregroundWidthPxFull / downsampleFactor) / blurWidth;
        const localNormalizedHeight = (foregroundHeightPxFull / downsampleFactor) / blurHeight;
        const sigmaBlurGrid = sigmaFull / downsampleFactor;

        this.ensureFramebuffer('foregroundLocalSharp', blurWidth, blurHeight);
        this.positionForeground(
          imageTextureId,
          'foregroundLocalSharp',
          localNormalizedWidth,
          localNormalizedHeight
        );
        const localSharpFb = this.resources.framebuffers.get('foregroundLocalSharp')!;
        this.resources.textures.set('foreground_local_sharp', localSharpFb.texture);

        const processedLocalId = runForegroundDefocusBlur(
          'foreground_local_sharp',
          sigmaBlurGrid,
          blurWidth,
          blurHeight,
          downsampleFactor
        );

        this.ensureFramebuffer(outputFramebufferId, width, height);
        // Do not clamp to 1 here; clamping one axis at close distances distorts aspect ratio.
        // Let the positioned foreground shader handle >1 normalized sizes for natural cropping.
        const paddedNormalizedWidth = (blurWidth * downsampleFactor) / width;
        const paddedNormalizedHeight = (blurHeight * downsampleFactor) / height;
        this.positionForeground(
          processedLocalId,
          outputFramebufferId,
          paddedNormalizedWidth,
          paddedNormalizedHeight
        );

        const outputFb = this.resources.framebuffers.get(outputFramebufferId)!;
        this.resources.textures.set(outputTextureAlias, outputFb.texture);

        const blurDiag = this.blurDiagnostics.get('blurred');
        if (blurDiag) {
          this.blurDiagnostics.set(diagnosticsId, {
            ...blurDiag,
            outputFramebufferId: diagnosticsId
          });
        }

        return outputTextureAlias;
      };

      const processBackgroundOverlay = (
        sourceTextureId: string,
        sigmaFull: number,
        downsampleFactorInput: number | undefined,
        sourceFramebufferId: string,
        outputFramebufferId: string,
        outputTextureAlias: string,
        diagnosticsId: string
      ): string => {
        const downsampleFactor = normalizeDownsample(downsampleFactorInput);
        const targetPixelCount = Math.max(
          1,
          Math.ceil((width * height) / (downsampleFactor * downsampleFactor))
        );
        const blurWidth = Math.max(1, Math.round(Math.sqrt(targetPixelCount * backgroundAspect)));
        const blurHeight = Math.max(1, Math.round(blurWidth / Math.max(0.0001, backgroundAspect)));
        const sigmaBlurGrid = Math.max(0, sigmaFull) / downsampleFactor;

        this.ensureFramebuffer(sourceFramebufferId, blurWidth, blurHeight);
        this.copyTexture(sourceTextureId, sourceFramebufferId);
        const sourceFb = this.resources.framebuffers.get(sourceFramebufferId)!;
        const sourceTextureAlias = `${outputTextureAlias}_source`;
        this.resources.textures.set(sourceTextureAlias, sourceFb.texture);

        if (sigmaBlurGrid > this.MIN_BLUR_SIGMA_TEXEL) {
          this.applyGaussianBlur(
            sourceTextureAlias,
            outputFramebufferId,
            sigmaBlurGrid,
            blurWidth,
            blurHeight,
            downsampleFactor
          );

          const outputFb = this.resources.framebuffers.get(outputFramebufferId)!;
          this.resources.textures.set(outputTextureAlias, outputFb.texture);
        } else {
          this.resources.textures.set(outputTextureAlias, sourceFb.texture);
          this.blurDiagnostics.set(diagnosticsId, {
            outputFramebufferId: diagnosticsId,
            path: this.getBlurPathFromDownsample(downsampleFactor),
            requestedSigma: sigmaBlurGrid,
            sigmaTexelUsed: 0,
            sigmaPerPass: 0,
            passCount: 0,
            kernelTapCount: 0,
            kernelMaxOffset: 0,
            downsampleFactor,
            width: blurWidth,
            height: blurHeight
          });
          return outputTextureAlias;
        }

        const blurDiag = this.blurDiagnostics.get(outputFramebufferId);
        if (blurDiag) {
          this.blurDiagnostics.set(diagnosticsId, {
            ...blurDiag,
            outputFramebufferId: diagnosticsId
          });
        }

        return outputTextureAlias;
      };

      const mainBackgroundSigma = Math.max(0, backgroundBlurSigma ?? 0);
      const mainBackgroundDownsample = normalizeDownsample(backgroundBlurDownsampleFactor);
      const mainBackgroundTextureId = processBackgroundOverlay(
        backgroundTextureId,
        mainBackgroundSigma,
        mainBackgroundDownsample,
        'backgroundMainSource',
        'backgroundMainBlurred',
        'background_main_blurred',
        'backgroundMain'
      );

      if (config.splitView && typeof compareBlurSigma === 'number') {
        const leftForegroundId = processForegroundOverlay(
          blurSigma,
          blurDownsampleFactor,
          'compareLeft',
          'compare_left_foreground',
          'blurred'
        );

        // Re-run with compare sigma for right side.
        const rightForegroundId = processForegroundOverlay(
          compareBlurSigma,
          compareBlurDownsampleFactor ?? blurDownsampleFactor,
          'compareRight',
          'compare_right_foreground',
          'compareRight'
        );

        const rightBackgroundSigma = Math.max(0, compareBackgroundBlurSigma ?? mainBackgroundSigma);
        const rightBackgroundDownsample = normalizeDownsample(
          compareBackgroundBlurDownsampleFactor ?? mainBackgroundDownsample
        );
        const shouldReuseBackground =
          rightBackgroundDownsample === mainBackgroundDownsample &&
          Math.abs(rightBackgroundSigma - mainBackgroundSigma) < 0.0001;
        const rightBackgroundTextureId = shouldReuseBackground
          ? mainBackgroundTextureId
          : processBackgroundOverlay(
              backgroundTextureId,
              rightBackgroundSigma,
              rightBackgroundDownsample,
              'backgroundCompareSource',
              'backgroundCompareBlurred',
              'background_compare_blurred',
              'backgroundCompare'
            );

        this.compositeLayers(mainBackgroundTextureId, leftForegroundId, 'compareLeftComposite', backgroundAspect);
        const leftCompositeFb = this.resources.framebuffers.get('compareLeftComposite')!;
        this.resources.textures.set('compare_left_composite', leftCompositeFb.texture);

        this.compositeLayers(rightBackgroundTextureId, rightForegroundId, 'compareRightComposite', backgroundAspect);
        const rightCompositeFb = this.resources.framebuffers.get('compareRightComposite')!;
        this.resources.textures.set('compare_right_composite', rightCompositeFb.texture);

        const leftFinalTextureId = this.applyCataractPostProcess(
          'compare_left_composite',
          'compareLeftCataract',
          width,
          height,
          nsGrade,
          pscRadius,
          pscDensity,
          pscSoftness,
          blurSigma,
          'overlay_left'
        );
        const rightFinalTextureId = this.applyCataractPostProcess(
          'compare_right_composite',
          'compareRightCataract',
          width,
          height,
          rightNsGrade,
          rightPscRadius,
          rightPscDensity,
          rightPscSoftness,
          compareBlurSigma,
          'overlay_right'
        );

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, width, height);
        this.renderSplitView(leftFinalTextureId, rightFinalTextureId, config.splitPosition);
        return;
      }

      const processedForegroundId = processForegroundOverlay(
        blurSigma,
        blurDownsampleFactor,
        'foregroundSharp',
        'foreground_sharp',
        'blurred'
      );

      this.ensureFramebuffer('mainComposite', width, height);
      this.compositeLayers(mainBackgroundTextureId, processedForegroundId, 'mainComposite', backgroundAspect);
      const mainCompositeFb = this.resources.framebuffers.get('mainComposite')!;
      this.resources.textures.set('main_composite', mainCompositeFb.texture);

      const finalTextureId = this.applyCataractPostProcess(
        'main_composite',
        'mainCataract',
        width,
        height,
        nsGrade,
        pscRadius,
        pscDensity,
        pscSoftness,
        blurSigma,
        'overlay_main'
      );

      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      this.gl.viewport(0, 0, width, height);
      this.renderToScreen(finalTextureId);
      return;
    }

    // Legacy single-image path (letters mode).
    if (config.splitView && typeof compareBlurSigma === 'number') {
      this.applyGaussianBlur(
        imageTextureId,
        'compareLeft',
        blurSigma,
        width,
        height,
        normalizeDownsample(blurDownsampleFactor)
      );
      this.applyGaussianBlur(
        imageTextureId,
        'compareRight',
        compareBlurSigma,
        width,
        height,
        normalizeDownsample(compareBlurDownsampleFactor ?? blurDownsampleFactor)
      );

      const leftFb = this.resources.framebuffers.get('compareLeft')!;
      const rightFb = this.resources.framebuffers.get('compareRight')!;
      this.resources.textures.set('compare_left_texture', leftFb.texture);
      this.resources.textures.set('compare_right_texture', rightFb.texture);

      const leftFinalTextureId = this.applyCataractPostProcess(
        'compare_left_texture',
        'compareLeftCataract',
        width,
        height,
        nsGrade,
        pscRadius,
        pscDensity,
        pscSoftness,
        blurSigma,
        'letters_left'
      );
      const rightFinalTextureId = this.applyCataractPostProcess(
        'compare_right_texture',
        'compareRightCataract',
        width,
        height,
        rightNsGrade,
        rightPscRadius,
        rightPscDensity,
        rightPscSoftness,
        compareBlurSigma,
        'letters_right'
      );

      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      this.gl.viewport(0, 0, width, height);
      this.renderSplitView(leftFinalTextureId, rightFinalTextureId, config.splitPosition);
      return;
    }

    const processedTextureId = runForegroundDefocusBlur(
      imageTextureId,
      blurSigma,
      width,
      height,
      normalizeDownsample(blurDownsampleFactor)
    );
    const finalTextureId = this.applyCataractPostProcess(
      processedTextureId,
      'mainCataract',
      width,
      height,
      nsGrade,
      pscRadius,
      pscDensity,
      pscSoftness,
      blurSigma,
      'letters_main'
    );
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, width, height);
    this.renderToScreen(finalTextureId);
  }

  /**
   * Render texture directly to screen
   */
  private renderToScreen(textureId: string): void {
    const texture = this.resources.textures.get(textureId)!;

    const copyProgram = this.resources.programs.get('copy')!;
    const copyUniforms = this.resources.uniformSetters.get('copy')!;

    this.gl.useProgram(copyProgram);
    setupFullscreenQuadAttributes(this.gl, copyProgram, this.resources.vertexBuffer);

    copyUniforms.setTexture('u_image', texture, 0);
    renderFullscreenQuad(this.gl);
  }

  /**
   * Render split view comparison
   */
  private renderSplitView(
    originalTextureId: string,
    processedTextureId: string,
    splitPosition: number
  ): void {
    const originalTexture = this.resources.textures.get(originalTextureId)!;
    const processedTexture = this.resources.textures.get(processedTextureId)!;

    const splitProgram = this.resources.programs.get('splitView')!;
    const splitUniforms = this.resources.uniformSetters.get('splitView')!;

    this.gl.useProgram(splitProgram);
    setupFullscreenQuadAttributes(this.gl, splitProgram, this.resources.vertexBuffer);

    splitUniforms.setTexture('u_originalImage', originalTexture, 0);
    splitUniforms.setTexture('u_processedImage', processedTexture, 1);
    splitUniforms.setFloat('u_splitPosition', splitPosition);
    splitUniforms.setFloat('u_dividerWidth', 0.003);

    renderFullscreenQuad(this.gl);
  }

  /**
   * Resize the renderer
   */
  resize(width: number, height: number): void {
    // Clean up old framebuffers
    for (const [name, fb] of this.resources.framebuffers) {
      this.gl.deleteFramebuffer(fb.framebuffer);
      this.gl.deleteTexture(fb.texture);
    }
    this.resources.framebuffers.clear();
    this.blurDiagnostics.clear();

    // Recreate framebuffers with new size
    this.ensureFramebuffers(width, height);
  }

  getBlurDiagnostics(outputFramebufferId: string): BlurExecutionDiagnostics | null {
    return this.blurDiagnostics.get(outputFramebufferId) ?? null;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    // Remove context loss event listeners
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    // Clean up WebGL resources
    if (this.gl && !this.gl.isContextLost()) {
      cleanupResources(this.gl, {
        programs: Array.from(this.resources.programs.values()),
        textures: Array.from(this.resources.textures.values()),
        buffers: [this.resources.vertexBuffer],
        framebuffers: Array.from(this.resources.framebuffers.values()).map(fb => fb.framebuffer)
      });
    }

    this.clearResources();
    this.isInitialized = false;
    this.contextLost = false;
    this.restoreAttempts = 0;
    this.contextLossHandler = undefined;
  }
}
