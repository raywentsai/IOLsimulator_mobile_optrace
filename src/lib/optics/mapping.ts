/**
 * Visual acuity mapping utilities for converting between logMAR, defocus, 
 * and blur sigma values.
 */

/**
 * IOL curve data structure
 */
export interface LensCurve {
  id: string;
  label: string;
  type: 'IOL' | 'phakic';
  defocus_D: number[];
  logMAR: number[];
  manufacturer?: string;
  model?: string;
  notes?: string;
}

/**
 * Leung-style empirical mapping from logMAR loss to Gaussian sigma (reference pixels).
 *
 * x = max(0, logMAR_target - logMAR_base)
 * sigma_ref(px) = exp((x + 0.04533908) / 0.4001204)
 * sigma_app(px) = kSigma * sigma_ref(px)
 *
 * NOTE: This function returns sigma in reference pixel units. Convert to the
 * render pass pixel grid (texels) before applying WebGL blur.
 */
export function sigmaFromLogMAR(
  logMARTarget: number,
  logMARBase: number = 0.0,
  kSigma: number = 1.0
): number {
  const NO_BLUR_DEADBAND_LOGMAR = 0.02;

  if (!Number.isFinite(logMARTarget) || !Number.isFinite(logMARBase) || !Number.isFinite(kSigma)) {
    throw new Error('logMARTarget, logMARBase, and kSigma must be finite numbers');
  }

  if (kSigma < 0) {
    throw new Error('kSigma must be non-negative');
  }

  const x = Math.max(0, logMARTarget - logMARBase);
  if (x <= NO_BLUR_DEADBAND_LOGMAR) {
    return 0;
  }

  const sigmaRefPx = Math.exp((x + 0.04533908) / 0.4001204);
  return kSigma * sigmaRefPx;
}

/**
 * Linear interpolation function for VA curves
 * @param x Array of x values (defocus)
 * @param y Array of y values (logMAR)
 * @param xq Query x value
 * @returns Interpolated y value
 */
export function interpolateVA(
  x: number[], 
  y: number[], 
  xq: number
): number {
  if (x.length !== y.length || x.length === 0) {
    throw new Error('Invalid interpolation data');
  }
  
  // Boundary extrapolation
  if (xq <= x[0]) return y[0];
  if (xq >= x[x.length - 1]) return y[y.length - 1];
  
  // Find interpolation interval
  let i = 0;
  while (i < x.length - 1 && xq > x[i + 1]) {
    i++;
  }
  
  // Linear interpolation
  const t = (xq - x[i]) / (x[i + 1] - x[i]);
  return y[i] * (1 - t) + y[i + 1] * t;
}

/**
 * Get logMAR from IOL curve at specific defocus
 * @param curve IOL curve data
 * @param defocus Defocus in diopters
 * @returns logMAR value
 */
export function logMARFromLensCurve(curve: LensCurve, defocus: number): number {
  return interpolateVA(curve.defocus_D, curve.logMAR, defocus);
}

/**
 * Calculate defocus from IOL mode parameters
 * @param sliderValue Defocus slider value
 * @param targetRefraction Target refraction offset
 * @returns Effective defocus
 */
export function getIOLDefocus(sliderValue: number, targetRefraction: number): number {
  return sliderValue - targetRefraction;
}

/**
 * Calculate defocus from presbyopia parameters
 * @param objectDistance_m Object distance in meters (Infinity allowed)
 * @param accommodationCapacity_D Available accommodation capacity in diopters
 * @param targetRefraction_D Target refraction in diopters
 * @returns Defocus in diopters
 */
export function defocusFromAccommodation(
  objectDistance_m: number,
  accommodationCapacity_D: number,
  targetRefraction_D: number
): number {
  // Calculate accommodation demand based on object distance
  const demand = (isFinite(objectDistance_m) && objectDistance_m > 0) 
    ? 1 / objectDistance_m 
    : 0;
  
  // Calculate accommodation that can actually be used (limited by capacity)
  const accommodationUsed = Math.min(demand, accommodationCapacity_D);
  
  // Residual defocus = demand that cannot be met by accommodation.
  const residualDefocus = demand - accommodationUsed;
  
  // App defocus convention: near residual defocus is negative.
  // Keep target-refraction offset direction consistent with IOL mode (subtract).
  return -residualDefocus - targetRefraction_D;
}

/**
 * Validate lens curve data
 * @param curve Lens curve to validate
 * @returns Validation result
 */
export function validateLensCurve(curve: LensCurve): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (!curve.id || !curve.label) {
    errors.push('Curve must have id and label');
  }
  
  if (!Array.isArray(curve.defocus_D) || !Array.isArray(curve.logMAR)) {
    errors.push('Defocus and logMAR must be arrays');
  }
  
  if (curve.defocus_D.length !== curve.logMAR.length) {
    errors.push('Defocus and logMAR arrays must have equal length');
  }
  
  if (curve.defocus_D.length < 3) {
    errors.push('At least 3 data points required for interpolation');
  }
  
  // Check monotonic increasing defocus
  for (let i = 1; i < curve.defocus_D.length; i++) {
    if (curve.defocus_D[i] <= curve.defocus_D[i - 1]) {
      errors.push('Defocus values must be monotonically increasing');
    }
  }
  
  // Check non-negative logMAR
  if (curve.logMAR.some(val => val < 0)) {
    errors.push('logMAR values must be non-negative');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
