/**
 * WebGL utility functions for shader compilation, program creation, and resource management
 */

/**
 * Create and compile a WebGL shader
 * @param gl WebGL context
 * @param type Shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER)
 * @param source Shader source code
 * @returns Compiled shader or null on error
 */
export function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

/**
 * Create a WebGL program from vertex and fragment shaders
 * @param gl WebGL context
 * @param vertexShaderSource Vertex shader source
 * @param fragmentShaderSource Fragment shader source
 * @returns Linked program or null on error
 */
export function createProgram(
  gl: WebGLRenderingContext,
  vertexShaderSource: string,
  fragmentShaderSource: string
): WebGLProgram | null {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

  if (!vertexShader || !fragmentShader) {
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  // Clean up shaders (they're now part of the program)
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

/**
 * Create a texture from an image element
 * @param gl WebGL context
 * @param image Image element
 * @param options Texture options
 * @returns Created texture
 */
export function createTextureFromImage(
  gl: WebGLRenderingContext,
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  options: {
    wrapS?: number;
    wrapT?: number;
    minFilter?: number;
    magFilter?: number;
    flipY?: boolean;
  } = {}
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Set flip Y if specified
  if (options.flipY !== undefined) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, options.flipY);
  }

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

  // Set texture parameters
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.wrapS || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.wrapT || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.minFilter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.magFilter || gl.LINEAR);

  return texture;
}

/**
 * Create an empty texture for use as a render target
 * @param gl WebGL context
 * @param width Texture width
 * @param height Texture height
 * @param format Internal format
 * @returns Created texture
 */
export function createEmptyTexture(
  gl: WebGLRenderingContext,
  width: number,
  height: number,
  format: number = gl.RGBA
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, gl.UNSIGNED_BYTE, null);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return texture;
}

/**
 * Create a framebuffer with attached texture
 * @param gl WebGL context
 * @param width Framebuffer width
 * @param height Framebuffer height
 * @returns Framebuffer and attached texture
 */
export function createFramebuffer(
  gl: WebGLRenderingContext,
  width: number,
  height: number
): { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null {
  const framebuffer = gl.createFramebuffer();
  const texture = createEmptyTexture(gl, width, height);

  if (!framebuffer || !texture) {
    return null;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { framebuffer, texture };
}

/**
 * Create a full-screen quad geometry
 * @param gl WebGL context
 * @returns Vertex buffer for full-screen quad
 */
export function createFullscreenQuad(gl: WebGLRenderingContext): WebGLBuffer | null {
  const vertices = new Float32Array([
    // Position (x, y) and texture coordinates (u, v)
    -1.0, -1.0, 0.0, 0.0, // Bottom-left
     1.0, -1.0, 1.0, 0.0, // Bottom-right
    -1.0,  1.0, 0.0, 1.0, // Top-left
     1.0,  1.0, 1.0, 1.0  // Top-right
  ]);

  const buffer = gl.createBuffer();
  if (!buffer) {
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  return buffer;
}

/**
 * Set up vertex attributes for full-screen quad
 * @param gl WebGL context
 * @param program Shader program
 * @param buffer Vertex buffer
 */
export function setupFullscreenQuadAttributes(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  buffer: WebGLBuffer
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');

  if (positionLocation >= 0) {
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
  }

  if (texCoordLocation >= 0) {
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);
  }
}

/**
 * Render a full-screen quad
 * @param gl WebGL context
 */
export function renderFullscreenQuad(gl: WebGLRenderingContext): void {
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/**
 * Uniform setting utilities
 */
export class UniformSetter {
  private locations = new Map<string, WebGLUniformLocation | null>();

  constructor(private gl: WebGLRenderingContext, private program: WebGLProgram) {}

  private getLocation(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      const location = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, location);
    }
    return this.locations.get(name) || null;
  }

  setFloat(name: string, value: number): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.uniform1f(location, value);
    }
  }

  setInt(name: string, value: number): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.uniform1i(location, value);
    }
  }

  setVec2(name: string, x: number, y: number): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.uniform2f(location, x, y);
    }
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.uniform3f(location, x, y, z);
    }
  }

  setMat3(name: string, matrix: number[]): void {
    const location = this.getLocation(name);
    if (location && matrix.length === 9) {
      this.gl.uniformMatrix3fv(location, false, matrix);
    }
  }

  setFloatArray(name: string, values: number[]): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.uniform1fv(location, values);
    }
  }

  setTexture(name: string, texture: WebGLTexture, unit: number): void {
    const location = this.getLocation(name);
    if (location) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.uniform1i(location, unit);
    }
  }
}

/**
 * Clean up WebGL resources
 * @param gl WebGL context
 * @param resources Resources to clean up
 */
export function cleanupResources(
  gl: WebGLRenderingContext,
  resources: {
    programs?: WebGLProgram[];
    textures?: WebGLTexture[];
    buffers?: WebGLBuffer[];
    framebuffers?: WebGLFramebuffer[];
  }
): void {
  if (resources.programs) {
    resources.programs.forEach(program => gl.deleteProgram(program));
  }
  
  if (resources.textures) {
    resources.textures.forEach(texture => gl.deleteTexture(texture));
  }
  
  if (resources.buffers) {
    resources.buffers.forEach(buffer => gl.deleteBuffer(buffer));
  }
  
  if (resources.framebuffers) {
    resources.framebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
  }
}
