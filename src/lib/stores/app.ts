import { derived, writable } from 'svelte/store';
import { getIOLDefocus, logMARFromLensCurve, provisionalSigmaArcmin } from '../optics/mapping';
import { loadIOLCurves } from '../data/loader';
import { acuityIols, type AcuityIolId, type PhysicsIolId } from '../data/iol-models';

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
const selectedLensCurve = derived(acuitySelection, ({ primary }) => curveFor(primary));
const selectedCompareLensCurve = derived(acuitySelection, ({ compare }) => curveFor(compare));

function acuityMetrics(curveStore: typeof selectedLensCurve, refractionStore: typeof targetRefraction) {
  return derived([curveStore, masterDefocus, refractionStore], ([curve, defocus, refraction]) => {
    const near = curve ? logMARFromLensCurve(curve, getIOLDefocus(defocus, refraction)) : null;
    const far = curve ? logMARFromLensCurve(curve, getIOLDefocus(0, refraction)) : null;
    return {
      curve,
      near,
      far,
      nearSigmaArcmin: near === null ? 0 : provisionalSigmaArcmin(near),
      farSigmaArcmin: far === null ? 0 : provisionalSigmaArcmin(far)
    };
  });
}

export const primaryAcuity = acuityMetrics(selectedLensCurve, targetRefraction);
export const comparisonAcuity = acuityMetrics(selectedCompareLensCurve, compareTargetRefraction);
