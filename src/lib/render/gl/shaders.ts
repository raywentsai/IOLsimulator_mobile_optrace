/**
 * WebGL shader definitions for the IOL Vision Simulator
 */

// ========== Vertex Shaders ==========

/**
 * Standard vertex shader for full-screen quad rendering
 */
export const vertexShader = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

// ========== Fragment Shaders ==========

/**
 * Simple texture copy shader (passthrough)
 */
export const copyFragmentShader = `
precision mediump float;
uniform sampler2D u_image;
varying vec2 v_texCoord;

void main() {
  gl_FragColor = texture2D(u_image, v_texCoord);
}
`;

/**
 * Horizontal Gaussian blur shader with optimized linear sampling
 */
export const horizontalBlurFragmentShader = `
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_texelSize;          // 1/width, 1/height
uniform float u_weights[32];       // Gaussian weights (MAX_TAPS = 32)
uniform float u_offsets[32];       // Sample offsets
uniform int u_tapCount;            // Number of taps to use
varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_image, v_texCoord) * u_weights[0];
  
  for (int i = 1; i < 32; i++) {
    if (i >= u_tapCount) break;
    
    float offset = u_offsets[i];
    vec2 sampleCoord1 = v_texCoord + vec2(offset * u_texelSize.x, 0.0);
    vec2 sampleCoord2 = v_texCoord - vec2(offset * u_texelSize.x, 0.0);
    
    vec4 sample1 = texture2D(u_image, sampleCoord1);
    vec4 sample2 = texture2D(u_image, sampleCoord2);
    
    color += (sample1 + sample2) * u_weights[i];
  }
  
  gl_FragColor = color;
}
`;

/**
 * Vertical Gaussian blur shader with optimized linear sampling
 */
export const verticalBlurFragmentShader = `
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_texelSize;          // 1/width, 1/height
uniform float u_weights[32];       // Gaussian weights (MAX_TAPS = 32)
uniform float u_offsets[32];       // Sample offsets
uniform int u_tapCount;            // Number of taps to use
varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_image, v_texCoord) * u_weights[0];
  
  for (int i = 1; i < 32; i++) {
    if (i >= u_tapCount) break;
    
    float offset = u_offsets[i];
    vec2 sampleCoord1 = v_texCoord + vec2(0.0, offset * u_texelSize.y);
    vec2 sampleCoord2 = v_texCoord - vec2(0.0, offset * u_texelSize.y);
    
    vec4 sample1 = texture2D(u_image, sampleCoord1);
    vec4 sample2 = texture2D(u_image, sampleCoord2);
    
    color += (sample1 + sample2) * u_weights[i];
  }
  
  gl_FragColor = color;
}
`;

/**
 * Position and scale a foreground texture against a transparent background.
 * Foreground is centered horizontally and anchored to the canvas bottom edge.
 */
export const positionedForegroundFragmentShader = `
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_foregroundSize; // normalized size (0-1) relative to output
varying vec2 v_texCoord;

void main() {
  float width = max(u_foregroundSize.x, 0.0001);
  float height = max(u_foregroundSize.y, 0.0001);

  float x0 = 0.5 - width * 0.5;
  float x1 = x0 + width;
  float y0 = 0.0;
  float y1 = height;

  if (v_texCoord.x < x0 || v_texCoord.x > x1 || v_texCoord.y < y0 || v_texCoord.y > y1) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 localUv = vec2(
    (v_texCoord.x - x0) / width,
    (v_texCoord.y - y0) / height
  );

  gl_FragColor = texture2D(u_image, localUv);
}
`;

/**
 * Composite foreground over background using foreground alpha.
 */
export const compositeFragmentShader = `
precision mediump float;
uniform sampler2D u_backgroundImage;
uniform sampler2D u_foregroundImage;
uniform float u_backgroundAspect;
uniform float u_viewAspect;
varying vec2 v_texCoord;

vec2 coverUv(vec2 uv, float srcAspect, float dstAspect) {
  if (dstAspect > srcAspect) {
    float yScale = srcAspect / dstAspect;
    return vec2(uv.x, (uv.y - 0.5) * yScale + 0.5);
  }

  float xScale = dstAspect / srcAspect;
  return vec2((uv.x - 0.5) * xScale + 0.5, uv.y);
}

void main() {
  vec2 bgUv = coverUv(v_texCoord, u_backgroundAspect, u_viewAspect);
  vec4 bg = texture2D(u_backgroundImage, clamp(bgUv, 0.0, 1.0));
  vec4 fg = texture2D(u_foregroundImage, v_texCoord);
  vec3 rgb = mix(bg.rgb, fg.rgb, fg.a);
  gl_FragColor = vec4(rgb, 1.0);
}
`;

/**
 * Split view comparison shader
 * Shows original on left, processed on right with divider
 */
export const splitViewFragmentShader = `
precision mediump float;
uniform sampler2D u_originalImage;
uniform sampler2D u_processedImage;
uniform float u_splitPosition;     // 0-1, position of the split
uniform float u_dividerWidth;      // Width of divider in UV coords
varying vec2 v_texCoord;

void main() {
  float splitLine = u_splitPosition;
  float halfDivider = u_dividerWidth * 0.5;
  
  if (v_texCoord.x < splitLine - halfDivider) {
    // Left side - original image
    gl_FragColor = texture2D(u_originalImage, v_texCoord);
  } else if (v_texCoord.x > splitLine + halfDivider) {
    // Right side - processed image
    gl_FragColor = texture2D(u_processedImage, v_texCoord);
  } else {
    // Divider area - white line
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
}
`;


// ========== Shader Program Definitions ==========

/**
 * Shader program configuration
 */
export interface ShaderProgram {
  vertex: string;
  fragment: string;
  uniforms: string[];
  attributes: string[];
}

/**
 * Predefined shader programs
 */
export const shaderPrograms = {
  copy: {
    vertex: vertexShader,
    fragment: copyFragmentShader,
    uniforms: ['u_image'],
    attributes: ['a_position', 'a_texCoord']
  },

  horizontalBlur: {
    vertex: vertexShader,
    fragment: horizontalBlurFragmentShader,
    uniforms: ['u_image', 'u_texelSize', 'u_weights[0]', 'u_offsets[0]', 'u_tapCount'],
    attributes: ['a_position', 'a_texCoord']
  },

  verticalBlur: {
    vertex: vertexShader,
    fragment: verticalBlurFragmentShader,
    uniforms: ['u_image', 'u_texelSize', 'u_weights[0]', 'u_offsets[0]', 'u_tapCount'],
    attributes: ['a_position', 'a_texCoord']
  },

  positionedForeground: {
    vertex: vertexShader,
    fragment: positionedForegroundFragmentShader,
    uniforms: ['u_image', 'u_foregroundSize'],
    attributes: ['a_position', 'a_texCoord']
  },

  composite: {
    vertex: vertexShader,
    fragment: compositeFragmentShader,
    uniforms: ['u_backgroundImage', 'u_foregroundImage', 'u_backgroundAspect', 'u_viewAspect'],
    attributes: ['a_position', 'a_texCoord']
  },

  splitView: {
    vertex: vertexShader,
    fragment: splitViewFragmentShader,
    uniforms: ['u_originalImage', 'u_processedImage', 'u_splitPosition', 'u_dividerWidth'],
    attributes: ['a_position', 'a_texCoord']
  }
} as const;
