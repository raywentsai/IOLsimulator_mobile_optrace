import { validateLensCurve, type LensCurve } from '../optics/mapping.ts';
import iolCurvesData from './iol_curves.json' with { type: 'json' };

// Settings, About, and the renderer use the same validated source records.
export const clinicalCurves = (iolCurvesData as LensCurve[]).filter(curve => validateLensCurve(curve).valid);
