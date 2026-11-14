import { sigmaPixelsToArcmin } from './angular-scale.ts';

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
  type: 'IOL';
  defocus_D: number[];
  logMAR: number[];
  manufacturer?: string;
  model?: string;
  source: { url: string; figure: string; subjects: number };
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

// Preserve the simulator's existing reference display and provisional fit.
export function provisionalSigmaArcmin(logMAR: number): number {
  return sigmaPixelsToArcmin(sigmaFromLogMAR(logMAR), 1, 170 / 25.4);
}

/** Evaluate a validated clinical curve at the effective defocus in diopters. */
export function evaluateLensCurve(curve: LensCurve, defocus: number) {
  const { defocus_D: nodes, logMAR: values } = curve;
  if (!Number.isFinite(defocus) || defocus < -4 || defocus > nodes[nodes.length - 1]) return null;
  const [edge, adjacent] = nodes;
  if (defocus < edge) {
    // Continue the near-end slope in angular MAR without allowing acuity to improve.
    const edgeMAR = 10 ** values[0];
    const slope = Math.max(0, (edgeMAR - 10 ** values[1]) / (adjacent - edge));
    return { logMAR: Math.log10(edgeMAR + (edge - defocus) * slope), method: 'extrapolated' } as const;
  }
  const right = nodes.findIndex(node => node >= defocus);
  if (nodes[right] === defocus) return { logMAR: values[right], method: 'measured' } as const;
  const left = right - 1;
  const weight = (defocus - nodes[left]) / (nodes[right] - nodes[left]);
  return { logMAR: values[left] * (1 - weight) + values[right] * weight, method: 'interpolated' } as const;
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
    return { valid: false, errors: ['Defocus and logMAR must be arrays'] };
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
  
  if (!curve.defocus_D.every(Number.isFinite) || !curve.logMAR.every(Number.isFinite)) {
    errors.push('Defocus and logMAR must be finite');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
