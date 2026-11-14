import { angularExtentMm, angularSigmaPixels, sigmaPixelsToArcmin } from './angular-scale.ts';
import { DEFAULT_PHONE_VIEWING_DISTANCE_M } from './calibration.ts';

export const LOGMAR_LEVELS = [1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, -0.1, -0.2];
export const SIGMA_STEP_ARCMIN = 0.25;
export const MAX_SIGMA_ARCMIN = 12;
export const MAX_FIELD_PX = 512;
const MIN_SIGMA_RENDER_PX = 0.75;
const MIN_GAP_RENDER_PX = 2;

export function stimulusGeometry(logMAR: number, sigmaArcmin: number, cssPxPerMm: number, renderPxPerCssPx: number) {
  const marArcmin = 10 ** logMAR;
  const diameterMm = angularExtentMm(5 * marArcmin, DEFAULT_PHONE_VIEWING_DISTANCE_M);
  const renderPxPerMm = cssPxPerMm * renderPxPerCssPx;
  const diameterPx = diameterMm * renderPxPerMm;
  const gapPx = diameterPx / 5;
  const sigmaPx = angularSigmaPixels(sigmaArcmin, DEFAULT_PHONE_VIEWING_DISTANCE_M, renderPxPerMm);
  return {
    diameterMm, diameterPx, gapPx, sigmaPx,
    sizeSupported: gapPx >= MIN_GAP_RENDER_PX,
    minSigmaArcmin: Math.max(SIGMA_STEP_ARCMIN, Math.ceil(
      sigmaPixelsToArcmin(MIN_SIGMA_RENDER_PX, DEFAULT_PHONE_VIEWING_DISTANCE_M, renderPxPerMm) / SIGMA_STEP_ARCMIN
    ) * SIGMA_STEP_ARCMIN),
    fieldPx: 2 * Math.ceil(diameterPx / 2 + Math.ceil(4 * sigmaPx) + 1)
  };
}

export function randomLandoltDirection(random = Math.random): number {
  return Math.floor(random() * 8);
}
