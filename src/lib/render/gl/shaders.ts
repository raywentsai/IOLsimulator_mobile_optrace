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
 * Nuclear sclerosis (NS) cataract effect shader
 * Applies color matrix transformation and contrast adjustment
 */
export const nuclearSclerosisFragmentShader = `
precision mediump float;
uniform sampler2D u_image;
uniform mat3 u_colorMatrix;        // 3x3 color transformation matrix
uniform float u_contrast;          // Contrast multiplier (1.0 = no change)
varying vec2 v_texCoord;

// Convert sRGB to linear RGB for color operations
vec3 srgbToLinear(vec3 srgb) {
  return pow(srgb, vec3(2.2));
}

// Convert linear RGB back to sRGB
vec3 linearToSrgb(vec3 linear) {
  return pow(linear, vec3(1.0 / 2.2));
}

void main() {
  vec4 texColor = texture2D(u_image, v_texCoord);
  
  // Convert to linear space for color operations
  vec3 linearColor = srgbToLinear(texColor.rgb);
  
  // Apply color matrix (yellowing effect)
  vec3 transformedColor = u_colorMatrix * linearColor;
  
  // Apply contrast around mid-gray (0.5 in linear space is ~0.73 in sRGB)
  vec3 contrastedColor = (transformedColor - 0.5) * u_contrast + 0.5;
  
  // Clamp to valid range and convert back to sRGB
  vec3 finalColor = linearToSrgb(clamp(contrastedColor, 0.0, 1.0));
  
  gl_FragColor = vec4(finalColor, texColor.a);
}
`;

/**
 * Posterior subcapsular cataract (PSC) mask shader
 * Blends sharp and blurred images based on radial distance with enhanced optical realism
 */
export const pscMaskFragmentShader = `
precision mediump float;
uniform sampler2D u_sharpImage;    // Original sharp image
uniform sampler2D u_blurredImage;  // Heavily blurred image
uniform vec2 u_center;             // Center of PSC in normalized coords (0-1)
uniform float u_radius;            // PSC radius in normalized coords
uniform float u_density;           // Opacity/density of PSC (0-1)
uniform float u_softness;          // Edge softness (0-1)
varying vec2 v_texCoord;

void main() {
  float distance = length(v_texCoord - u_center);
  
  // Calculate inner and outer radius for soft edge
  float innerRadius = u_radius * (1.0 - u_softness);
  float outerRadius = u_radius;
  
  // Create smooth transition mask with enhanced falloff
  float maskValue = smoothstep(outerRadius, innerRadius, distance);
  
  // Enhanced density mapping for more realistic PSC effect
  // PSC causes significant light scattering, especially at high densities
  float enhancedDensity = min(u_density * 1.15, 1.0);
  
  // At high densities, PSC becomes much more opaque and scattering
  if (u_density > 0.5) {
    enhancedDensity = 0.58 + (u_density - 0.5) * 2.4;
    enhancedDensity = min(enhancedDensity, 0.98); // Keep a small amount of detail
  }
  
  // Apply enhanced density to the mask with additional central concentration
  float centralFactor = 1.0 - distance / u_radius;
  centralFactor = clamp(centralFactor, 0.0, 1.0);
  
  // PSC is typically denser in the center, creating a gradient effect
  float densityGradient = enhancedDensity * (0.58 + 0.42 * centralFactor);
  float blendFactor = clamp(maskValue * densityGradient, 0.0, 0.99);
  
  // Sample both images
  vec4 sharpColor = texture2D(u_sharpImage, v_texCoord);
  vec4 blurredColor = texture2D(u_blurredImage, v_texCoord);
  
  // Enhanced blending with slight brightness reduction to simulate opacity
  vec4 blendedColor = mix(sharpColor, blurredColor, blendFactor);
  
  // PSC can cause slight darkening due to light scattering
  float darkeningFactor = 1.0 - (blendFactor * 0.24);
  blendedColor.rgb *= darkeningFactor;
  
  gl_FragColor = blendedColor;
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

  nuclearSclerosis: {
    vertex: vertexShader,
    fragment: nuclearSclerosisFragmentShader,
    uniforms: ['u_image', 'u_colorMatrix', 'u_contrast'],
    attributes: ['a_position', 'a_texCoord']
  },

  pscMask: {
    vertex: vertexShader,
    fragment: pscMaskFragmentShader,
    uniforms: ['u_sharpImage', 'u_blurredImage', 'u_center', 'u_radius', 'u_density', 'u_softness'],
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
