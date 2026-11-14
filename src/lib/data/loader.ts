import { validateLensCurve, type LensCurve } from '../optics/mapping.ts';
import iolCurvesData from './iol_curves.json' with { type: 'json' };

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
