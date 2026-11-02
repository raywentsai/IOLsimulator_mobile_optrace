/**
 * Global state management using Svelte stores
 */

import { browser } from '$app/environment';
import { writable, derived, type Readable } from 'svelte/store';
import {
  CALIBRATION_STORAGE_KEY,
  DEFAULT_CALIBRATION_SCALE,
  DEFAULT_CSS_PX_PER_MM,
  DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M,
  DEFAULT_PHONE_VIEWING_DISTANCE_M,
  calculateEffectiveCssPixelsPerMillimeter,
  parseCalibrationSnapshot,
  serializeCalibrationSnapshot
} from '../optics/calibration';
import {
  sigmaFromLogMAR,
  logMARFromLensCurve,
  defocusFromAccommodation,
  getIOLDefocus,
  type LensCurve
} from '../optics/mapping';
import { loadIOLCurves } from '../data/loader';
import { defocusToDistance, distanceToDefocus } from '../optics/formulas';

// ========== Display Calibration Stores ==========
function loadStoredCalibration() {
  if (!browser) {
    return null;
  }

  return parseCalibrationSnapshot(localStorage.getItem(CALIBRATION_STORAGE_KEY));
}

const storedCalibration = loadStoredCalibration();

export const cssPxPerMmCal = writable(storedCalibration?.cssPxPerMmCal ?? DEFAULT_CSS_PX_PER_MM);
export const calibrationScale = writable(storedCalibration?.calibScale ?? DEFAULT_CALIBRATION_SCALE);
export const currentViewportScale = writable(DEFAULT_CALIBRATION_SCALE);
export const viewingDistance = writable(DEFAULT_PHONE_VIEWING_DISTANCE_M);
export const effectiveCssPxPerMm: Readable<number> = derived(
  [cssPxPerMmCal, calibrationScale, currentViewportScale],
  ([$cssPxPerMmCal, $calibrationScale, $currentViewportScale]) =>
    calculateEffectiveCssPixelsPerMillimeter($cssPxPerMmCal, $currentViewportScale, $calibrationScale)
);

if (browser) {
  derived(
    [cssPxPerMmCal, calibrationScale],
    ([$cssPxPerMmCal, $calibrationScale]) => serializeCalibrationSnapshot({
      cssPxPerMmCal: $cssPxPerMmCal,
      calibScale: $calibrationScale
    })
  ).subscribe((value) => {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, value);
  });
}

// ========== Simulation Mode and Parameters ==========
export type SimulationMode = 'IOL' | 'Presbyopia';
export const simulationMode = writable<SimulationMode>('IOL');
export type DisplayImageMode = 'letters' | 'book';
export const displayImageMode = writable<DisplayImageMode>('book');
export type PresbyopiaProfile = 'presbyopia' | 'normal';

// ========== Unified Defocus Control ==========
export const DEFAULT_HOLDING_DISTANCE_M = DEFAULT_BOOK_REFERENCE_HOLD_DISTANCE_M;
export const DEFAULT_MASTER_DEFOCUS_D = distanceToDefocus(DEFAULT_HOLDING_DISTANCE_M);
// Master defocus control in diopters (UI holding-distance range: -4.0 to -1.0).
export const masterDefocus = writable(DEFAULT_MASTER_DEFOCUS_D);

// ========== IOL Mode Parameters ==========
export const selectedLensId = writable('zcb00');
export const selectedCompareLensId = writable('vivity');
export const targetRefraction = writable(0.0);
export const compareTargetRefraction = writable(0.0);

// ========== Presbyopia Mode Parameters ==========
export const presbyopiaProfile = writable<PresbyopiaProfile>('presbyopia');
export const presbyopiaCompareProfile = writable<PresbyopiaProfile>('normal');
export const accommodationCapacity = writable(0.5); // diopters - available accommodation capacity

// ========== Cataract Parameters ==========
export const nsGrade = writable(0.0); // 0-4 nuclear sclerosis grade
export const pscRadius = writable(0.0); // 0-0.5 screen fraction
export const pscDensity = writable(0.0); // 0-1.0 opacity
export const pscSoftness = writable(0.2); // 0-1.0 edge softness
const DEFAULT_CATARACT_STATE = {
  nsGrade: 0.0,
  pscRadius: 0.0,
  pscDensity: 0.0,
  pscSoftness: 0.2
} as const;

interface PresbyopiaProfilePreset {
  curveId: string;
  accommodationCapacity: number;
  nsGrade: number;
  pscRadius: number;
  pscDensity: number;
  pscSoftness: number;
}

const PRESBYOPIA_MODEL_CURVE_ID = 'phakic_young_model';

const PRESBYOPIA_PROFILE_PRESETS: Record<PresbyopiaProfile, PresbyopiaProfilePreset> = {
  presbyopia: {
    curveId: PRESBYOPIA_MODEL_CURVE_ID,
    accommodationCapacity: 0.5,
    nsGrade: 0.0,
    pscRadius: 0.0,
    pscDensity: 0.0,
    pscSoftness: 0.2
  },
  normal: {
    curveId: PRESBYOPIA_MODEL_CURVE_ID,
    accommodationCapacity: 4.0,
    nsGrade: 0.0,
    pscRadius: 0.0,
    pscDensity: 0.0,
    pscSoftness: 0.2
  }
};

function getPresbyopiaProfilePreset(profile: PresbyopiaProfile): PresbyopiaProfilePreset {
  return PRESBYOPIA_PROFILE_PRESETS[profile];
}

export function applyPresbyopiaProfile(profile: PresbyopiaProfile): void {
  const preset = getPresbyopiaProfilePreset(profile);
  presbyopiaProfile.set(profile);
  accommodationCapacity.set(preset.accommodationCapacity);
  nsGrade.set(preset.nsGrade);
  pscRadius.set(preset.pscRadius);
  pscDensity.set(preset.pscDensity);
  pscSoftness.set(preset.pscSoftness);
}

export function resetCataractState(): void {
  nsGrade.set(DEFAULT_CATARACT_STATE.nsGrade);
  pscRadius.set(DEFAULT_CATARACT_STATE.pscRadius);
  pscDensity.set(DEFAULT_CATARACT_STATE.pscDensity);
  pscSoftness.set(DEFAULT_CATARACT_STATE.pscSoftness);
}

// ========== Blur Mapping Parameters ==========
// Leung empirical mapping controls:
// x = max(0, logMAR_target - logMAR_base)
// sigma = kSigma * exp((x + 0.04533908) / 0.4001204)
export const blurLogMARBase = writable(0.0);
// NaN means "use sigmaFromLogMAR default kSigma".
export const blurSigmaTuning = writable(Number.NaN);

// ========== UI State ==========
export const splitViewEnabled = writable(false);
export const calibrationApplied = writable(true);
export const calibrationVersion = writable(1);

// ========== Lens Data ==========
// Load and cache lens curves
const lensData = loadIOLCurves();
export const availableLenses = writable<LensCurve[]>(lensData);

// Get IOL curves only
export const iolCurves: Readable<LensCurve[]> = derived(
  availableLenses,
  ($lenses) => $lenses.filter(lens => lens.type === 'IOL')
);

// Selected lens curve
export const selectedLensCurve: Readable<LensCurve | undefined> = derived(
  [selectedLensId, availableLenses],
  ([$lensId, $lenses]) => $lenses.find(lens => lens.id === $lensId)
);

export const selectedCompareLensCurve: Readable<LensCurve | undefined> = derived(
  [selectedCompareLensId, availableLenses],
  ([$lensId, $lenses]) => $lenses.find(lens => lens.id === $lensId)
);

function findCurveById(lenses: LensCurve[], id: string): LensCurve | undefined {
  return lenses.find((lens) => lens.id === id);
}

export const selectedPresbyopiaCurve: Readable<LensCurve | undefined> = derived(
  [presbyopiaProfile, availableLenses],
  ([$presbyopiaProfile, $lenses]) => {
    const preset = getPresbyopiaProfilePreset($presbyopiaProfile);
    return findCurveById($lenses, preset.curveId);
  }
);

export const selectedComparePresbyopiaCurve: Readable<LensCurve | undefined> = derived(
  [presbyopiaCompareProfile, availableLenses],
  ([$presbyopiaCompareProfile, $lenses]) => {
    const preset = getPresbyopiaProfilePreset($presbyopiaCompareProfile);
    return findCurveById($lenses, preset.curveId);
  }
);

// ========== Computed Values ==========
// Current defocus calculation using unified master control
export const currentDefocus: Readable<number> = derived(
  [
    simulationMode,
    masterDefocus,
    targetRefraction,
    accommodationCapacity
  ],
  ([
    $mode,
    $masterDefocus,
    $targetRefraction,
    $accommodationCapacity
  ]) => {
    if ($mode === 'IOL') {
      // IOL mode: defocus = masterDefocus - targetRefraction
      return getIOLDefocus($masterDefocus, $targetRefraction);
    } else {
      // Presbyopia mode: calculate defocus from master control and accommodation
      const objectDistance = defocusToDistance($masterDefocus);
      return defocusFromAccommodation(
        objectDistance,
        $accommodationCapacity,
        0
      );
    }
  }
);

function resolveCurveLogMAR(curve: LensCurve | undefined, defocus: number): number {
  if (!curve) {
    return 0;
  }
  return logMARFromLensCurve(curve, defocus);
}

export const activePrimaryCurve: Readable<LensCurve | undefined> = derived(
  [simulationMode, selectedLensCurve, selectedPresbyopiaCurve],
  ([$mode, $selectedLensCurve, $selectedPresbyopiaCurve]) =>
    $mode === 'IOL' ? $selectedLensCurve : $selectedPresbyopiaCurve
);

export const activeCompareCurve: Readable<LensCurve | undefined> = derived(
  [simulationMode, selectedCompareLensCurve, selectedComparePresbyopiaCurve],
  ([$mode, $selectedCompareLensCurve, $selectedComparePresbyopiaCurve]) =>
    $mode === 'IOL' ? $selectedCompareLensCurve : $selectedComparePresbyopiaCurve
);

export const compareDefocus: Readable<number> = derived(
  [
    simulationMode,
    masterDefocus,
    compareTargetRefraction,
    presbyopiaCompareProfile
  ],
  ([
    $simulationMode,
    $masterDefocus,
    $compareTargetRefraction,
    $presbyopiaCompareProfile
  ]) => {
    if ($simulationMode === 'IOL') {
      return getIOLDefocus($masterDefocus, $compareTargetRefraction);
    }

    const preset = getPresbyopiaProfilePreset($presbyopiaCompareProfile);
    const compareObjectDistance = defocusToDistance($masterDefocus);
    return defocusFromAccommodation(
      compareObjectDistance,
      preset.accommodationCapacity,
      0
    );
  }
);

// Current logMAR calculation
export const currentLogMAR: Readable<number> = derived(
  [activePrimaryCurve, currentDefocus],
  ([$curve, $defocus]) => resolveCurveLogMAR($curve, $defocus)
);

// Current blur sigma in pixels
export const blurSigma: Readable<number> = derived(
  [currentLogMAR, blurLogMARBase, blurSigmaTuning],
  ([$logMAR, $base, $kSigma]) => sigmaFromLogMAR(
    $logMAR,
    $base,
    Number.isFinite($kSigma) ? $kSigma : undefined
  )
);

// Secondary comparison metrics
export const compareLogMAR: Readable<number> = derived(
  [activeCompareCurve, compareDefocus],
  ([$curve, $defocus]) => resolveCurveLogMAR($curve, $defocus)
);

export const compareBlurSigma: Readable<number> = derived(
  [compareLogMAR, blurLogMARBase, blurSigmaTuning],
  ([$logMAR, $base, $kSigma]) => sigmaFromLogMAR(
    $logMAR,
    $base,
    Number.isFinite($kSigma) ? $kSigma : undefined
  )
);

// Background blur uses per-side target refraction as far-distance defocus.
export const backgroundLogMAR: Readable<number> = derived(
  [simulationMode, activePrimaryCurve, targetRefraction],
  ([$mode, $curve, $targetRefraction]) =>
    $mode === 'IOL' ? resolveCurveLogMAR($curve, $targetRefraction) : 0
);

export const compareBackgroundLogMAR: Readable<number> = derived(
  [simulationMode, activeCompareCurve, compareTargetRefraction],
  ([$mode, $curve, $targetRefraction]) =>
    $mode === 'IOL' ? resolveCurveLogMAR($curve, $targetRefraction) : 0
);

export const backgroundBlurSigma: Readable<number> = derived(
  [simulationMode, backgroundLogMAR, blurLogMARBase, blurSigmaTuning],
  ([$mode, $logMAR, $base, $kSigma]) =>
    $mode === 'IOL'
      ? sigmaFromLogMAR(
          $logMAR,
          $base,
          Number.isFinite($kSigma) ? $kSigma : undefined
        )
      : 0
);

export const compareBackgroundBlurSigma: Readable<number> = derived(
  [simulationMode, compareBackgroundLogMAR, blurLogMARBase, blurSigmaTuning],
  ([$mode, $logMAR, $base, $kSigma]) =>
    $mode === 'IOL'
      ? sigmaFromLogMAR(
          $logMAR,
          $base,
          Number.isFinite($kSigma) ? $kSigma : undefined
        )
      : 0
);

// Current visual acuity in Snellen decimal
export const currentVADecimal: Readable<number> = derived(
  currentLogMAR,
  ($logMAR) => Math.pow(10, -$logMAR)
);

export const compareVADecimal: Readable<number> = derived(
  compareLogMAR,
  ($logMAR) => Math.pow(10, -$logMAR)
);

// ========== Performance Monitoring ==========
export const renderTime = writable(0); // milliseconds
export const frameRate = writable(60); // fps
