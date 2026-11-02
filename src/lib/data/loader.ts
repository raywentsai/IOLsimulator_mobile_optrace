import type { LensCurve } from '../optics/mapping.js';
import { validateLensCurve } from '../optics/mapping.js';
import iolCurvesData from './iol_curves.json';

/**
 * Load and validate IOL curves data.
 * Invalid entries are ignored so the app can continue rendering with valid curves.
 */
export function loadIOLCurves(): LensCurve[] {
  const curves = iolCurvesData as LensCurve[];
  const validatedCurves: LensCurve[] = [];

  for (const curve of curves) {
    if (validateLensCurve(curve).valid) {
      validatedCurves.push(curve);
    }
  }

  return validatedCurves;
}
