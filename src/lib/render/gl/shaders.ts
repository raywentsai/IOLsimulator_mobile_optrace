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
 * Centered cover projection onto the display sample grid.
 */
export const coverFragmentShader = `
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_scale;
varying vec2 v_texCoord;

void main() {
  gl_FragColor = texture2D(u_image, (v_texCoord - 0.5) * u_scale + 0.5);
}
`;

/**
 * Separable Gaussian with pairwise linear texture sampling
 */
const blurFragmentShader = `
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_texelStep;
uniform float u_weights[32];       // Gaussian weights (MAX_TAPS = 32)
uniform float u_offsets[32];       // Sample offsets
uniform int u_tapCount;            // Number of taps to use
varying vec2 v_texCoord;

void main() {
  vec4 color = texture2D(u_image, v_texCoord) * u_weights[0];
  
  for (int i = 1; i < 32; i++) {
    if (i >= u_tapCount) break;
    
    float offset = u_offsets[i];
    vec2 sampleCoord1 = v_texCoord + offset * u_texelStep;
    vec2 sampleCoord2 = v_texCoord - offset * u_texelStep;
    
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
precision highp float;
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
precision highp float;
uniform sampler2D u_backgroundImage;
uniform sampler2D u_foregroundImage;
varying vec2 v_texCoord;

void main() {
  vec4 bg = texture2D(u_backgroundImage, v_texCoord);
  vec4 fg = texture2D(u_foregroundImage, v_texCoord);
  gl_FragColor = vec4(fg.rgb + bg.rgb * (1.0 - fg.a), 1.0);
}
`;

/**
 * Split view comparison shader
 * Shows original on left, processed on right with divider
 */
export const splitViewFragmentShader = `
precision highp float;
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
 * Predefined shader programs
 */
export const shaderPrograms = {
  cover: {
    vertex: vertexShader,
    fragment: coverFragmentShader
  },

  blur: {
    vertex: vertexShader,
    fragment: blurFragmentShader
  },

  positionedForeground: {
    vertex: vertexShader,
    fragment: positionedForegroundFragmentShader
  },

  composite: {
    vertex: vertexShader,
    fragment: compositeFragmentShader
  },

  splitView: {
    vertex: vertexShader,
    fragment: splitViewFragmentShader
  }
} as const;
