export const ARC_MINUTES_PER_RADIAN = 10800 / Math.PI;

// A centered extent spans both sides of the line of sight.
export function angularExtentMm(arcmin: number, viewingDistanceM: number): number {
  return 2000 * viewingDistanceM * Math.tan(arcmin / (2 * ARC_MINUTES_PER_RADIAN));
}

// Sigma is the standard deviation along either axis in tangent-plane
// angular coordinates, using the paraxial radian-to-arcmin conversion.
export function angularSigmaPixels(sigmaArcmin: number, viewingDistanceM: number, pixelsPerMm: number): number {
  return sigmaArcmin / ARC_MINUTES_PER_RADIAN * viewingDistanceM * 1000 * pixelsPerMm;
}

export function sigmaPixelsToArcmin(sigmaPixels: number, viewingDistanceM: number, pixelsPerMm: number): number {
  return sigmaPixels / (viewingDistanceM * 1000 * pixelsPerMm) * ARC_MINUTES_PER_RADIAN;
}
