import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import {
  CALIBRATION_STORAGE_KEY, DEFAULT_CALIBRATION_SCALE, DEFAULT_CSS_PX_PER_MM,
  DEFAULT_PHONE_VIEWING_DISTANCE_M, calculateEffectiveCssPixelsPerMillimeter,
  parseCalibrationSnapshot, serializeCalibrationSnapshot
} from '../optics/calibration';
import { getIOLDefocus, logMARFromLensCurve, sigmaFromLogMAR } from '../optics/mapping';
import { loadIOLCurves } from '../data/loader';
import { acuityIols, type AcuityIolId, type PhysicsIolId } from '../data/iol-models';

const stored = browser ? parseCalibrationSnapshot(localStorage.getItem(CALIBRATION_STORAGE_KEY)) : null;
export const cssPxPerMmCal = writable(stored?.cssPxPerMmCal ?? DEFAULT_CSS_PX_PER_MM);
export const calibrationScale = writable(stored?.calibScale ?? DEFAULT_CALIBRATION_SCALE);
export const currentViewportScale = writable(DEFAULT_CALIBRATION_SCALE);
export const viewingDistance = writable(stored?.viewingDistanceM ?? DEFAULT_PHONE_VIEWING_DISTANCE_M);
export const hasCalibration = writable(stored?.viewingDistanceM !== undefined);
export const effectiveCssPxPerMm = derived(
  [cssPxPerMmCal, calibrationScale, currentViewportScale],
  ([ppm, calibratedScale, currentScale]) => calculateEffectiveCssPixelsPerMillimeter(ppm, currentScale, calibratedScale)
);

if (browser) {
  derived([cssPxPerMmCal, calibrationScale, viewingDistance, hasCalibration], ([ppm, scale, distance, confirmed]) =>
    confirmed ? serializeCalibrationSnapshot({ cssPxPerMmCal: ppm, calibScale: scale, viewingDistanceM: distance }) : null
  ).subscribe(snapshot => {
    if (snapshot) localStorage.setItem(CALIBRATION_STORAGE_KEY, snapshot);
  });
}

// UI defocus is negative for a finite object. Default object distance is 50 cm.
export const masterDefocus = writable(-2);
export const splitViewEnabled = writable(false);
export type SimulationMethod = 'acuity' | 'physics';
export const simulationMethod = writable<SimulationMethod>('physics');
export const acuitySelection = writable<{ primary: AcuityIolId; compare: AcuityIolId }>({
  primary: 'acrysof_iq_vivity', compare: 'sn60wf'
});
export const physicsSelection = writable<{ primary: PhysicsIolId; compare: PhysicsIolId }>({
  primary: 'aspheric_monofocal_dc_v1', compare: 'vivity_inspired_v2_1_dc_v1'
});
export const targetRefraction = writable(0);
export const compareTargetRefraction = writable(0);

const curves = loadIOLCurves();
const curveFor = (id: AcuityIolId) => curves.find(curve => curve.id === acuityIols[id].curveId);
export const selectedLensCurve = derived(acuitySelection, ({ primary }) => curveFor(primary));
export const selectedCompareLensCurve = derived(acuitySelection, ({ compare }) => curveFor(compare));

function acuityMetrics(curveStore: typeof selectedLensCurve, refractionStore: typeof targetRefraction) {
  return derived([simulationMethod, curveStore, masterDefocus, refractionStore],
    ([method, curve, defocus, refraction]) => ({
      near: method === 'acuity' && curve ? logMARFromLensCurve(curve, getIOLDefocus(defocus, refraction)) : 0,
      far: method === 'acuity' && curve ? logMARFromLensCurve(curve, refraction) : 0
    }));
}

const primary = acuityMetrics(selectedLensCurve, targetRefraction);
const compare = acuityMetrics(selectedCompareLensCurve, compareTargetRefraction);
export const blurSigma = derived(primary, ({ near }) => sigmaFromLogMAR(near));
export const compareBlurSigma = derived(compare, ({ near }) => sigmaFromLogMAR(near));
export const backgroundBlurSigma = derived(primary, ({ far }) => sigmaFromLogMAR(far));
export const compareBackgroundBlurSigma = derived(compare, ({ far }) => sigmaFromLogMAR(far));
export const currentVADecimal = derived(primary, ({ near }) => 10 ** -near);
export const compareVADecimal = derived(compare, ({ near }) => 10 ** -near);
