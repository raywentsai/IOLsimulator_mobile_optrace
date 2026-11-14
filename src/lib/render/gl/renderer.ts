/**
 * WebGL renderer for the IOL Vision Simulator
 * Handles Gaussian blur and scene composition
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

type RenderTarget = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };
type Sigma = readonly [x: number, y: number];
type SceneBlur = { near: Sigma; far: Sigma };

export interface RenderConfig {
  width: number;
  height: number;
  cardWidth: number;
  cardHeight: number;
  backgroundTextureId: string;
  backgroundAspect: number;
  primary: SceneBlur;
  comparison?: SceneBlur;
}

const MIN_SIGMA = 0.1;
const MAX_SIGMA_PER_PASS = 14;

export class WebGLRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly programs = new Map<keyof typeof shaderPrograms, WebGLProgram>();
  private readonly uniforms = new Map<keyof typeof shaderPrograms, UniformSetter>();
  private readonly textures = new Map<string, WebGLTexture>();
  private readonly framebuffers = new Map<string, RenderTarget>();
  private readonly kernelCache = new KernelCache();
  private readonly farFrames = new Map<string, string>();
  private vertexBuffer?: WebGLBuffer;
  private textureSequence = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL is unavailable');
    this.gl = gl;
  }

  initialize(): void {
    const gl = this.gl;
    const vertexBuffer = createFullscreenQuad(gl);
    if (!vertexBuffer) throw new Error('Gaussian vertex buffer allocation failed');
    this.vertexBuffer = vertexBuffer;
    for (const name of Object.keys(shaderPrograms) as (keyof typeof shaderPrograms)[]) {
      const { vertex, fragment } = shaderPrograms[name];
      const program = createProgram(gl, vertex, fragment);
      if (!program) throw new Error('Gaussian shader initialization failed: ' + name);
      this.programs.set(name, program);
      this.uniforms.set(name, new UniformSetter(gl, program));
    }
  }

  loadImageTexture(source: HTMLImageElement | HTMLCanvasElement): string {
    const texture = createTextureFromImage(this.gl, source, { flipY: true });
    if (!texture) throw new Error('Gaussian texture allocation failed');
    const id = 'image_' + ++this.textureSequence;
    this.textures.set(id, texture);
    return id;
  }

  updateImageTexture(id: string, source: HTMLImageElement | HTMLCanvasElement, verifyUpload = false): boolean {
    const texture = this.textures.get(id);
    if (!texture) return false;

    const gl = this.gl;
    if (verifyUpload) {
      this.farFrames.clear();
      gl.getError();
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return !verifyUpload || gl.getError() === gl.NO_ERROR && !gl.isContextLost();
  }

  private ensureFramebuffer(
    name: string,
    width: number,
    height: number
  ): RenderTarget {
    const existing = this.framebuffers.get(name);
    if (existing && existing.width === width && existing.height === height) {
      return existing;
    }

    if (existing) {
      this.gl.deleteFramebuffer(existing.framebuffer);
      this.gl.deleteTexture(existing.texture);
      this.framebuffers.delete(name);
      this.farFrames.delete(name);
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
    this.framebuffers.set(name, entry);
    return entry;
  }

  // The destination and each source texture are sampled in the same pixel grid.
  private draw(
    name: keyof typeof shaderPrograms, target: RenderTarget | null,
    configure: (uniforms: UniformSetter) => void
  ): void {
    const gl = this.gl;
    const program = this.programs.get(name)!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
    gl.useProgram(program);
    setupFullscreenQuadAttributes(gl, program, this.vertexBuffer!);
    configure(this.uniforms.get(name)!);
    renderFullscreenQuad(gl);
  }

  private position(texture: WebGLTexture, target: RenderTarget, width: number, height: number): void {
    this.draw('positionedForeground', target, uniforms => {
      uniforms.setTexture('u_image', texture, 0);
      uniforms.setVec2('u_foregroundSize', width / target.width, height / target.height);
    });
  }

  private blur(source: RenderTarget, output: RenderTarget, sigma: Sigma, scratch: string): void {
    const largest = Math.max(sigma[0], sigma[1]);
    // Each pass adds variance. Limit the per-pass radius to the shader tap capacity.
    const passes = Math.max(1, Math.ceil((largest / MAX_SIGMA_PER_PASS) ** 2));
    const kernels = sigma.map(axis => this.kernelCache.getKernel(axis / Math.sqrt(passes)));
    const temp = this.ensureFramebuffer(scratch, source.width, source.height);
    let input = source.texture;
    for (let i = 0; i < passes; i++) {
      const vertical = i === passes - 1 ? output : source;
      for (const [texture, target, kernel, dx, dy] of [
        [input, temp, kernels[0], 1 / source.width, 0],
        [temp.texture, vertical, kernels[1], 0, 1 / source.height]
      ] as const) {
        this.draw('blur', target, uniforms => {
          uniforms.setTexture('u_image', texture, 0);
          uniforms.setVec2('u_texelStep', dx, dy);
          uniforms.setFloatArray('u_weights', kernel.weights);
          uniforms.setFloatArray('u_offsets', kernel.offsets);
          uniforms.setInt('u_tapCount', kernel.tapCount);
        });
      }
      input = vertical.texture;
    }
  }

  render(imageTextureId: string, config: RenderConfig): void {
    if (this.gl.isContextLost()) throw new Error('WebGL context lost');

    const { width, height, cardWidth, cardHeight, backgroundAspect, backgroundTextureId, primary, comparison } = config;
    const card = this.textures.get(imageTextureId)!;
    const background = this.textures.get(backgroundTextureId)!;
    const viewAspect = width / height;
    const coverX = Math.min(1, viewAspect / backgroundAspect);
    const coverY = Math.min(1, backgroundAspect / viewAspect);

    const projectBackground = (sigma: Sigma, id: string): WebGLTexture => {
      const target = this.ensureFramebuffer(id, width, height);
      const key = [backgroundTextureId, coverX, coverY, width, height, ...sigma].join(':');
      if (this.farFrames.get(id) === key) return target.texture;
      const blurred = Math.max(sigma[0], sigma[1]) > MIN_SIGMA;
      const source = blurred ? this.ensureFramebuffer('backgroundSource', width, height) : target;
      // Cover first. Blurring a landscape grid before a portrait cover crop magnifies its sigma.
      this.draw('cover', source, uniforms => {
        uniforms.setTexture('u_image', background, 0);
        uniforms.setVec2('u_scale', coverX, coverY);
      });
      if (blurred) this.blur(source, target, sigma, 'backgroundHorizontal');
      this.farFrames.set(id, key);
      return target.texture;
    };

    const primaryBackground = projectBackground(primary.far, 'backgroundLeft');
    const foreground = this.ensureFramebuffer('foreground', width, height);
    const padX = Math.ceil(4 * Math.max(primary.near[0], comparison?.near[0] ?? 0));
    const padY = Math.ceil(4 * Math.max(primary.near[1], comparison?.near[1] ?? 0));
    const parity = width % 2;
    const tileWidth = Math.ceil((Math.min(width, cardWidth) + 2 * padX - parity) / 32) * 32 + parity;
    const tileHeight = Math.ceil((Math.min(height, cardHeight) + padY) / 32) * 32;
    const renderSide = (side: SceneBlur, far: WebGLTexture, target: RenderTarget | null) => {
      const sigma = side.near;
      if (Math.max(sigma[0], sigma[1]) <= MIN_SIGMA) {
        this.position(card, foreground, cardWidth, cardHeight);
      } else {
        // One padded tile for both sides. Matching width parity avoids a
        // half-pixel horizontal resample when the tile is centered.
        const sharp = this.ensureFramebuffer('cardSource', tileWidth, tileHeight);
        const blurred = this.ensureFramebuffer('cardBlurred', tileWidth, tileHeight);
        this.position(card, sharp, cardWidth, cardHeight);
        this.blur(sharp, blurred, sigma, 'cardHorizontal');
        this.position(blurred.texture, foreground, tileWidth, tileHeight);
      }

      this.draw('composite', target, uniforms => {
        uniforms.setTexture('u_backgroundImage', far, 0);
        uniforms.setTexture('u_foregroundImage', foreground.texture, 1);
      });
    };

    if (!comparison) {
      renderSide(primary, primaryBackground, null);
      return;
    }

    const comparisonBackground = comparison.far[0] === primary.far[0] && comparison.far[1] === primary.far[1]
      ? primaryBackground : projectBackground(comparison.far, 'backgroundRight');
    const left = this.ensureFramebuffer('left', width, height);
    const right = this.ensureFramebuffer('right', width, height);
    renderSide(primary, primaryBackground, left);
    renderSide(comparison, comparisonBackground, right);
    this.draw('splitView', null, uniforms => {
      uniforms.setTexture('u_originalImage', left.texture, 0);
      uniforms.setTexture('u_processedImage', right.texture, 1);
      uniforms.setFloat('u_splitPosition', 0.5);
      uniforms.setFloat('u_dividerWidth', 0.003);
    });
  }

  dispose(): void {
    if (this.gl && !this.gl.isContextLost()) {
      const targets = Array.from(this.framebuffers.values());
      cleanupResources(this.gl, {
        programs: Array.from(this.programs.values()),
        textures: [...this.textures.values(), ...targets.map(target => target.texture)],
        buffers: this.vertexBuffer ? [this.vertexBuffer] : [],
        framebuffers: targets.map(target => target.framebuffer)
      });
    }
    this.programs.clear();
    this.uniforms.clear();
    this.textures.clear();
    this.framebuffers.clear();
    this.farFrames.clear();
    this.kernelCache.clear();
  }
}
