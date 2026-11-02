/**
 * Centralized blur sigma policy.
 * Select computational path by workload: full-res, 2x/4x/8x/16x downsample.
 */

export type BlurPath = 'full-res' | 'downsample-2x' | 'downsample-4x' | 'downsample-8x' | 'downsample-16x';
export const BACKGROUND_BLUR_DOWNSAMPLE_FACTOR: 1 = 1;
// Reference CSS px/mm used by the original Leung-tuned sigma mapping environment (~170 PPI).
export const DEFAULT_BLUR_REFERENCE_CSS_PX_PER_MM = 170 / 25.4;
// Reference display distance by the original Leung's work (1 meter).
export const DEFAULT_BLUR_REFERENCE_VIEWING_DISTANCE_M = 1.0;

export interface BlurPolicyInput {
  // Raw sigma from optics mapping in reference pixel units.
  sigmaCssRaw: number;
  // Calibrated device CSS px/mm used to preserve physical blur size.
  deviceCssPxPerMm: number;
  // Reference CSS px/mm that defines the sigmaCssRaw unit basis.
  referenceCssPxPerMm?: number;
  // Current eye-to-screen viewing distance in meters.
  viewingDistanceM: number;
  // Reference viewing distance in meters used by the original sigma tuning.
  referenceViewingDistanceM?: number;
  renderPixelScale: number;
  blurRenderScale?: number;
  dpr?: number;
  foregroundCoverage?: number;
}

export interface BlurPolicyOutput {
  sigmaCssRaw: number;
  sigmaCssNormalized: number;
  physicalNormalizationScale: number;
  viewingDistanceNormalizationScale: number;
  sigmaTexelRawFull: number;
  sigmaTexelUsedFull: number;
  sigmaTexelUsedBlurGrid: number;
  downsampleFactor: 1 | 2 | 4 | 8 | 16;
  path: BlurPath;
  workloadScore: number;
}

export function resolveBlurPolicy(input: BlurPolicyInput): BlurPolicyOutput {
  const {
    sigmaCssRaw,
    referenceCssPxPerMm = DEFAULT_BLUR_REFERENCE_CSS_PX_PER_MM,
    deviceCssPxPerMm,
    viewingDistanceM,
    referenceViewingDistanceM = DEFAULT_BLUR_REFERENCE_VIEWING_DISTANCE_M,
    renderPixelScale,
    blurRenderScale = 1,
    dpr = renderPixelScale,
    foregroundCoverage = 0
  } = input;

  if (!Number.isFinite(sigmaCssRaw) || sigmaCssRaw < 0) {
    throw new Error('sigmaCssRaw must be a finite non-negative number');
  }

  if (!Number.isFinite(renderPixelScale) || renderPixelScale <= 0) {
    throw new Error('renderPixelScale must be a finite positive number');
  }

  if (!Number.isFinite(referenceCssPxPerMm) || referenceCssPxPerMm <= 0) {
    throw new Error('referenceCssPxPerMm must be a finite positive number');
  }

  if (!Number.isFinite(deviceCssPxPerMm) || deviceCssPxPerMm <= 0) {
    throw new Error('deviceCssPxPerMm must be a finite positive number');
  }

  if (!Number.isFinite(referenceViewingDistanceM) || referenceViewingDistanceM <= 0) {
    throw new Error('referenceViewingDistanceM must be a finite positive number');
  }

  if (!Number.isFinite(viewingDistanceM) || viewingDistanceM <= 0) {
    throw new Error('viewingDistanceM must be a finite positive number');
  }

  if (!Number.isFinite(blurRenderScale) || blurRenderScale <= 0) {
    throw new Error('blurRenderScale must be a finite positive number');
  }

  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error('dpr must be a finite positive number');
  }

  if (!Number.isFinite(foregroundCoverage) || foregroundCoverage < 0) {
    throw new Error('foregroundCoverage must be a finite non-negative number');
  }

  const clampedCoverage = Math.min(1, foregroundCoverage);
  const physicalNormalizationScale = deviceCssPxPerMm / referenceCssPxPerMm;
  const viewingDistanceNormalizationScale = viewingDistanceM / referenceViewingDistanceM;
  const sigmaCssNormalized =
    sigmaCssRaw *
    physicalNormalizationScale *
    viewingDistanceNormalizationScale;
  const sigmaTexelRawFull = sigmaCssNormalized * renderPixelScale * blurRenderScale;

  // Comment out workload scaling temporarily
  // Workload scaling encourages earlier downsampling for large foreground area/high DPR.
  let workloadScore = sigmaTexelRawFull;
  let downsampleFactor: 1 | 2 | 4 | 8 | 16 = 1;
  let path: BlurPath = 'full-res';

/*   if (clampedCoverage >= 0.45) {
    workloadScore *= 1.45;
  } else if (clampedCoverage >= 0.30) {
    workloadScore *= 1.30;
  } else if (clampedCoverage >= 0.18) {
    workloadScore *= 1.15;
  }

  if (dpr >= 2.5) {
    workloadScore *= 1.25;
  } else if (dpr >= 2.0) {
    workloadScore *= 1.10;
  }

  if (workloadScore > 48) {
    downsampleFactor = 16;
    path = 'downsample-16x';
  } else if (workloadScore > 24) {
    downsampleFactor = 8;
    path = 'downsample-8x';
  } else if (workloadScore > 12) {
    downsampleFactor = 4;
    path = 'downsample-4x';
  } else if (workloadScore > 6) {
    downsampleFactor = 2;
    path = 'downsample-2x';
  } */

  return {
    sigmaCssRaw,
    sigmaCssNormalized,
    physicalNormalizationScale,
    viewingDistanceNormalizationScale,
    sigmaTexelRawFull,
    sigmaTexelUsedFull: sigmaTexelRawFull,
    sigmaTexelUsedBlurGrid: sigmaTexelRawFull / downsampleFactor,
    downsampleFactor,
    path,
    workloadScore
  };
}
