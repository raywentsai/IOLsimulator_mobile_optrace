import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import {
  CALIBRATION_STORAGE_KEY, DEFAULT_CSS_PX_PER_MM, DEFAULT_PHONE_VIEWING_DISTANCE_M,
  calculateEffectiveCssPixelsPerMillimeter, parseCalibrationSnapshot, serializeCalibrationSnapshot
} from '../optics/calibration';

function savedCalibration() {
  if (browser) {
    try { return parseCalibrationSnapshot(localStorage.getItem(CALIBRATION_STORAGE_KEY)); }
    catch { /* In-memory calibration still works if storage is restricted. */ }
  }
  return null;
}

export const displayCalibration = writable(savedCalibration());
export const viewport = writable({ zoom: 1, dpr: 1 });
export const viewingDistance = derived(displayCalibration,
  saved => saved?.viewingDistanceM ?? DEFAULT_PHONE_VIEWING_DISTANCE_M);
export const effectiveCssPxPerMm = derived([displayCalibration, viewport], ([saved, { zoom, dpr }]) =>
  calculateEffectiveCssPixelsPerMillimeter(
    saved?.cssPxPerMmCal ?? DEFAULT_CSS_PX_PER_MM, zoom, saved?.calibScale ?? 1, dpr, saved?.devicePixelRatio
  ));

function readViewport() {
  return { zoom: window.visualViewport?.scale ?? 1, dpr: window.devicePixelRatio || 1 };
}

export function trackDisplayViewport() {
  function update() { viewport.set(readViewport()); }
  update();
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  return () => {
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  };
}

export function saveDisplayCalibration(cssPxPerMmCal: number, viewingDistanceM: number) {
  const { zoom, dpr } = readViewport();
  const snapshot = { cssPxPerMmCal, calibScale: zoom, devicePixelRatio: dpr, viewingDistanceM };
  viewport.set({ zoom, dpr });
  displayCalibration.set(snapshot);
  try { localStorage.setItem(CALIBRATION_STORAGE_KEY, serializeCalibrationSnapshot(snapshot)); }
  catch { /* Keep the calibration for the current session. */ }
}
