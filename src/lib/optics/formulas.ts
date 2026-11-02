/**
 * Core optical formulas used by the runtime simulation.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert defocus to object distance in meters.
 * Positive/zero defocus is treated as optical infinity.
 */
export function defocusToDistance(defocus_D: number): number {
  if (defocus_D >= 0) {
    return Infinity;
  }
  return 1 / Math.abs(defocus_D);
}

/**
 * Convert object distance in meters to defocus in diopters.
 */
export function distanceToDefocus(distance_m: number): number {
  if (!Number.isFinite(distance_m) || distance_m <= 0) {
    return 0;
  }
  return -1 / distance_m;
}

/**
 * Hofstetter 1950 formula constants.
 */
export const HOFSTETTER_CONSTANTS = {
  BASE_ACCOMMODATION: 18.5,
  AGE_COEFFICIENT: 0.30,
  MIN_ACCOMMODATION: 0.0,
  MAX_ACCOMMODATION: 4.0,
  MIN_AGE: 0,
  MAX_AGE: 100
} as const;

function calculateRawHofstetterAccommodation(age: number): number {
  const clampedAge = clamp(age, HOFSTETTER_CONSTANTS.MIN_AGE, HOFSTETTER_CONSTANTS.MAX_AGE);
  return HOFSTETTER_CONSTANTS.BASE_ACCOMMODATION - (HOFSTETTER_CONSTANTS.AGE_COEFFICIENT * clampedAge);
}

/**
 * Calculate accommodation capacity from age.
 * Formula: 18.5 - (0.30 * age), clamped to 0-4D.
 */
export function calculateAccommodationFromAge(age: number): number {
  const rawAccommodation = calculateRawHofstetterAccommodation(age);
  return clamp(rawAccommodation, HOFSTETTER_CONSTANTS.MIN_ACCOMMODATION, HOFSTETTER_CONSTANTS.MAX_ACCOMMODATION);
}
