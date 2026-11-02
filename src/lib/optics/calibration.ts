/**
 * Display calibration utilities for CSS pixel to physical unit conversion,
 * PPI/PPD calculation, and foreground physical sizing.
 */

/**
 * ISO/IEC 7810 ID-1 credit card dimensions in millimeters.
 */
export const CREDIT_CARD_SHORT_EDGE_MM = 53.98;

/**
 * Display defaults.
 */
export const DEFAULT_PHONE_VIEWING_DISTANCE_M = 0.4;
export const MIN_VIEWING_DISTANCE_M = 0.2;
export const MAX_VIEWING_DISTANCE_M = 1.0;
export const DEFAULT_CALIBRATION_PPI = 170; // match original research setup
export const DEFAULT_CSS_PX_PER_MM = DEFAULT_CALIBRATION_PPI / 25.4;
export const DEFAULT_CALIBRATION_SCALE = 1;

/**
 * Book foreground sizing defaults.
 */
export const DEFAULT_BOOK_BASELINE_WIDTH_M = 0.07;
export const DEFAULT_BOOK_REFERENCE_VIEWING_DISTANCE_M = DEFAULT_PHONE_VIEWING_DISTANCE_M;
export const DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M = 0.4;

/**
 * Calibration storage key.
 */
export const CALIBRATION_STORAGE_KEY = 'iolsimulator.calibration.v2';

export interface CalibrationSnapshot {
  cssPxPerMmCal: number;
  calibScale: number;
}

/**
 * Convert a measured pixel length and physical millimeters into CSS pixels/mm.
 */
export function calculatePixelsPerMillimeter(pixelLength: number, physicalLengthMM: number): number {
  if (pixelLength <= 0 || physicalLengthMM <= 0) {
    throw new Error('Pixel length and physical length must be positive');
  }

  return pixelLength / physicalLengthMM;
}

/**
 * Convert CSS pixels/mm to pixels per inch (PPI).
 */
export function calculatePPIFromPixelsPerMillimeter(pixelsPerMM: number): number {
  if (pixelsPerMM <= 0) {
    throw new Error('Pixels per millimeter must be positive');
  }

  return pixelsPerMM * 25.4;
}

/**
 * Convert PPI to CSS pixels/mm.
 */
export function calculatePixelsPerMillimeterFromPPI(ppi: number): number {
  if (ppi <= 0) {
    throw new Error('PPI must be positive');
  }

  return ppi / 25.4;
}

/**
 * Estimate calibrated CSS pixels/mm from the credit card short edge match.
 */
export function calculateCssPixelsPerMillimeterFromCreditCardShortEdge(shortEdgePixels: number): number {
  return calculatePixelsPerMillimeter(shortEdgePixels, CREDIT_CARD_SHORT_EDGE_MM);
}

/**
 * Convert a physical length in millimeters to CSS pixels using calibrated CSS px/mm.
 */
export function calculatePixelsForPhysicalLength(physicalLengthMM: number, pixelsPerMM: number): number {
  if (physicalLengthMM <= 0 || pixelsPerMM <= 0) {
    throw new Error('Physical length and pixelsPerMM must be positive');
  }

  return pixelsPerMM * physicalLengthMM;
}

/**
 * Convert calibrated CSS pixels/mm to credit card short-edge CSS pixels.
 */
export function calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter(pixelsPerMM: number): number {
  return calculatePixelsForPhysicalLength(CREDIT_CARD_SHORT_EDGE_MM, pixelsPerMM);
}

/**
 * Apply viewport scale compensation to calibrated CSS px/mm.
 */
export function calculateEffectiveCssPixelsPerMillimeter(
  cssPxPerMmCal: number,
  currentScale: number,
  calibScale: number
): number {
  if (cssPxPerMmCal <= 0 || currentScale <= 0 || calibScale <= 0) {
    throw new Error('Calibration and scale inputs must be positive');
  }

  return cssPxPerMmCal * (currentScale / calibScale);
}

/**
 * Compute foreground width in meters using a direct absolute real-object model.
 *
 * Definitions:
 * W0: baseline physical width at reference viewing distance D0.
 * z0: reference hold distance used to normalize magnification.
 *
 * Equations:
 * theta0 = atan((W0/2) / D0)
 * W_actual/2 = z0 * tan(theta0)
 * W_display/2 = D * tan(atan((W_actual/2)/z))
 * W_display = 2 * D * tan(atan((W_actual/2)/z))
 */
export function calculateForegroundWidthMeters(
  baselineWidth_m: number,
  viewingDistance_m: number,
  holdDistance_m: number,
  referenceViewingDistance_m: number = DEFAULT_BOOK_REFERENCE_VIEWING_DISTANCE_M,
  referenceHoldDistance_m: number = DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M
): number {
  if (
    baselineWidth_m <= 0 ||
    viewingDistance_m <= 0 ||
    holdDistance_m <= 0 ||
    referenceViewingDistance_m <= 0 ||
    referenceHoldDistance_m <= 0
  ) {
    throw new Error('All foreground sizing inputs must be positive');
  }

  const halfBaselineWidth = baselineWidth_m * 0.5;
  const theta0 = Math.atan(halfBaselineWidth / referenceViewingDistance_m);
  const halfActualWidth = referenceHoldDistance_m * Math.tan(theta0);
  const displayHalfAngle = Math.atan(halfActualWidth / holdDistance_m);

  return 2 * viewingDistance_m * Math.tan(displayHalfAngle);
}

/**
 * Compute foreground width in CSS px from exact angular geometry.
 */
export function calculateForegroundWidthCssPx(
  baselineWidth_m: number,
  effectiveCssPxPerMm: number,
  viewingDistance_m: number,
  holdDistance_m: number,
  referenceViewingDistance_m: number = DEFAULT_BOOK_REFERENCE_VIEWING_DISTANCE_M,
  referenceHoldDistance_m: number = DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M
): number {
  if (effectiveCssPxPerMm <= 0) {
    throw new Error('effectiveCssPxPerMm must be positive');
  }

  const foregroundWidth_m = calculateForegroundWidthMeters(
    baselineWidth_m,
    viewingDistance_m,
    holdDistance_m,
    referenceViewingDistance_m,
    referenceHoldDistance_m
  );

  // Convert meters to millimeters for cssPx/mm scaling.
  return foregroundWidth_m * 1000 * effectiveCssPxPerMm;
}

/**
 * Calculate pixels per degree (PPD) based on viewing distance and screen PPI.
 */
export function calculatePPD(distance_m: number, ppi: number): number {
  if (distance_m <= 0 || ppi <= 0) {
    throw new Error('Distance and PPI must be positive');
  }

  const pixelPitch_m = 0.0254 / ppi;
  const linearSizePerDegree_m = distance_m * Math.PI / 180;
  return linearSizePerDegree_m / pixelPitch_m;
}

/**
 * Validate display parameters.
 */
export function validateDisplayParams(distance_m: number, ppi: number): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (distance_m < MIN_VIEWING_DISTANCE_M || distance_m > MAX_VIEWING_DISTANCE_M) {
    errors.push(`Viewing distance must be between ${MIN_VIEWING_DISTANCE_M.toFixed(2)}m and ${MAX_VIEWING_DISTANCE_M.toFixed(2)}m`);
  }

  if (ppi < 50 || ppi > 600) {
    errors.push('PPI must be between 50 and 600');
  }

  const ppd = distance_m > 0 && ppi > 0 ? calculatePPD(distance_m, ppi) : 0;
  if (ppd < 10 || ppd > 200) {
    errors.push('Resulting PPD should be between 10 and 200');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Calibration snapshot serialization helpers.
 */
export function serializeCalibrationSnapshot(snapshot: CalibrationSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseCalibrationSnapshot(rawValue: string | null | undefined): CalibrationSnapshot | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<CalibrationSnapshot>;
    if (
      typeof parsed.cssPxPerMmCal !== 'number' ||
      typeof parsed.calibScale !== 'number' ||
      !Number.isFinite(parsed.cssPxPerMmCal) ||
      !Number.isFinite(parsed.calibScale) ||
      parsed.cssPxPerMmCal <= 0 ||
      parsed.calibScale <= 0
    ) {
      return null;
    }

    return {
      cssPxPerMmCal: parsed.cssPxPerMmCal,
      calibScale: parsed.calibScale
    };
  } catch {
    return null;
  }
}

