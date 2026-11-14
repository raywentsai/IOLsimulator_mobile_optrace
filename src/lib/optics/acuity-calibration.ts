import { angularExtentMm, angularSigmaPixels, sigmaPixelsToArcmin } from './angular-scale.ts';

export const TEST_DISTANCE_M = 0.4;
export const LOGMAR_LEVELS = [1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, -0.1, -0.2];
export const SIGMA_STEP_ARCMIN = 0.25;
export const MAX_SIGMA_ARCMIN = 12;
export const MAX_FIELD_PX = 512;
const MIN_SIGMA_RENDER_PX = 0.75;
const MIN_GAP_RENDER_PX = 2;

export function stimulusGeometry(logMAR: number, sigmaArcmin: number, cssPxPerMm: number, renderPxPerCssPx: number) {
  const marArcmin = 10 ** logMAR;
  const diameterMm = angularExtentMm(5 * marArcmin, TEST_DISTANCE_M);
  const renderPxPerMm = cssPxPerMm * renderPxPerCssPx;
  const diameterPx = diameterMm * renderPxPerMm;
  const gapPx = diameterPx / 5;
  const sigmaPx = angularSigmaPixels(sigmaArcmin, TEST_DISTANCE_M, renderPxPerMm);
  return {
    marArcmin, diameterMm, diameterPx, gapPx, sigmaPx,
    sizeSupported: gapPx >= MIN_GAP_RENDER_PX,
    minSigmaArcmin: Math.max(SIGMA_STEP_ARCMIN, Math.ceil(
      sigmaPixelsToArcmin(MIN_SIGMA_RENDER_PX, TEST_DISTANCE_M, renderPxPerMm) / SIGMA_STEP_ARCMIN
    ) * SIGMA_STEP_ARCMIN),
    fieldPx: 2 * Math.ceil(diameterPx / 2 + Math.ceil(4 * sigmaPx) + 1)
  };
}

export function randomLandoltDirection(random = Math.random): number {
  return Math.floor(random() * 8);
}

export function thresholdBracket(lastReadable: number | null, firstUnreadable: number | null) {
  return lastReadable !== null && firstUnreadable !== null && lastReadable >= 0 &&
    firstUnreadable > lastReadable &&
    Number.isFinite(firstUnreadable) && Number.isFinite(lastReadable);
}

export type ThresholdRow = {
  participantId: string;
  measuredAt: string;
  repetition: number;
  stimulusVersion: string;
  device: string;
  screenWidthCssPx: number;
  screenHeightCssPx: number;
  viewportZoom: number;
  devicePixelRatio: number;
  effectiveCssPxPerMm: number;
  calibratedCssPxPerMm: number;
  calibrationZoom: number;
  calibrationDpr: number | null;
  renderPxPerCssPx: number;
  viewingDistanceCm: number;
  baselineLogMAR: number;
  optotypeLogMAR: number;
  degradationLogMAR: number;
  gapRenderPx: number;
  lastReadableSigmaArcmin: number;
  firstUnreadableSigmaArcmin: number;
  lastReadableSigmaRenderPx: number;
  firstUnreadableSigmaRenderPx: number;
};

export function thresholdsCsv(rows: ThresholdRow[]): string {
  if (!rows.length) return '';
  const csvCell = (value: string | number | null) => {
    if (typeof value !== 'string') return String(value ?? '');
    const safe = /^[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const columns = Object.keys(rows[0]) as (keyof ThresholdRow)[];
  return [
    columns.join(','),
    ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))
  ].join('\r\n') + '\r\n';
}
