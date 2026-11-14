import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLensCurve, getIOLDefocus, provisionalSigmaArcmin, sigmaFromLogMAR, validateLensCurve } from '../src/lib/optics/mapping.ts';
import { angularSigmaPixels, sigmaPixelsToArcmin } from '../src/lib/optics/angular-scale.ts';
import { acuityIols, physicsIols } from '../src/lib/data/iol-models.ts';
import { loadIOLCurves } from '../src/lib/data/loader.ts';
import {
  calculateCssPixelsPerMillimeterFromCreditCardShortEdge, calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter,
  calculateEffectiveCssPixelsPerMillimeter, DEFAULT_PHONE_VIEWING_DISTANCE_M, parseCalibrationSnapshot, serializeCalibrationSnapshot
} from '../src/lib/optics/calibration.ts';
import { randomLandoltDirection, stimulusGeometry } from '../src/lib/optics/acuity-calibration.ts';
import { gaussianHalfKernel } from '../src/lib/render/gl/gaussian.ts';
import { landoltInk } from '../src/lib/render/landolt-c.ts';

const curves = loadIOLCurves();
const approximatelyEqual = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} vs ${expected}`);

test('each clinical selection resolves its exact model and preserves negative measured logMAR', () => {
  assert.equal(curves.length, 3);
  for (const [id, model] of Object.entries(acuityIols)) {
    const curve = curves.find(curve => curve.id === model.curveId);
    assert.equal(curve.label, model.label);
    assert.deepEqual(model.modelCodes, [curve.model]);
    assert.ok(curve.source.url.startsWith('https://www.accessdata.fda.gov/'));
    assert.ok(evaluateLensCurve(curve, 0).logMAR < 0);
    assert.ok(10 ** -evaluateLensCurve(curve, 0).logMAR > 1);
    assert.ok(!Object.hasOwn(physicsIols, id));
    assert.equal(validateLensCurve({ ...curve, logMAR: [NaN, ...curve.logMAR.slice(1)] }).valid, false);
  }
});

test('curve evaluation distinguishes measured, interpolated, and extrapolated VA', () => {
  const wf = curves.find(curve => curve.id === 'sn60wf');
  const vivity = curves.find(curve => curve.id === 'vivity');
  const sn60at = curves.find(curve => curve.id === 'sn60at');
  assert.deepEqual(evaluateLensCurve(wf, -2.5), { logMAR: 0.539, method: 'measured' });
  const middle = evaluateLensCurve(wf, -2.25);
  assert.equal(middle.method, 'interpolated');
  approximatelyEqual(middle.logMAR, (0.539 + 0.379) / 2);
  assert.deepEqual(evaluateLensCurve(sn60at, -4), { logMAR: 0.75, method: 'measured' });
  for (const [curve, atFour] of [[wf, 0.8233195147784623], [vivity, 0.6578520860167566]]) {
    const edge = evaluateLensCurve(curve, -2.5).logMAR;
    const continuation = evaluateLensCurve(curve, -2.5000000001);
    assert.equal(continuation.method, 'extrapolated');
    approximatelyEqual(continuation.logMAR, edge);
    assert.ok(evaluateLensCurve(curve, -3.5).logMAR > evaluateLensCurve(curve, -3).logMAR);
    approximatelyEqual(evaluateLensCurve(curve, -4).logMAR, atFour);
    assert.equal(evaluateLensCurve(curve, -4.0001), null);
    assert.equal(evaluateLensCurve(curve, 1.5001), null);
    assert.equal(evaluateLensCurve(curve, NaN), null);
  }
  assert.equal(getIOLDefocus(-2.5, -1), -1.5);
  assert.equal(getIOLDefocus(0, -1), 1);
  assert.equal(evaluateLensCurve(wf, getIOLDefocus(-4, -1)).method, 'extrapolated');
  assert.equal(evaluateLensCurve(wf, getIOLDefocus(-4, 0.25)), null);
});

test('provisional mapping retains its deadband and reference-pixel blur on all rendering scales', () => {
  assert.equal(sigmaFromLogMAR(-0.05), 0);
  assert.equal(sigmaFromLogMAR(0.02), 0);
  assert.ok(sigmaFromLogMAR(0.021) > 0);
  const logMAR = 0.42;
  const sigma = provisionalSigmaArcmin(logMAR);
  for (const [distance, ppm, renderScale] of [[0.2, 4, 1], [0.3, 5, 2], [1, 7, 0.75]]) {
    const pixels = angularSigmaPixels(sigma, distance, ppm * renderScale);
    approximatelyEqual(pixels, sigmaFromLogMAR(logMAR) * ppm / (170 / 25.4) * distance * renderScale);
    approximatelyEqual(sigmaPixelsToArcmin(pixels, distance, ppm * renderScale), sigma);
  }
});

test('credit card calibration preserves physical pixel scale through pinch and page zoom', () => {
  const cssPxPerMmCal = calculateCssPixelsPerMillimeterFromCreditCardShortEdge(270);
  approximatelyEqual(calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter(cssPxPerMmCal), 270);
  const legacy = { cssPxPerMmCal, calibScale: 1 };
  const snapshot = { ...legacy, viewingDistanceM: 0.6, devicePixelRatio: 2 };
  for (const value of [legacy, snapshot]) {
    assert.deepEqual(parseCalibrationSnapshot(serializeCalibrationSnapshot(value)), value);
  }
  approximatelyEqual(calculateEffectiveCssPixelsPerMillimeter(cssPxPerMmCal, 1.5, 1, 3, 2) * 1.5 * 3,
    cssPxPerMmCal * 2);
});

test('at 30 cm Landolt C uses the 5:1 diameter and keeps angular sigma independent of letter size', () => {
  assert.equal(DEFAULT_PHONE_VIEWING_DISTANCE_M, 0.3);
  const geometry = stimulusGeometry(0, 2, 5, 3);
  approximatelyEqual(geometry.diameterMm, 600 * Math.tan(5 * Math.PI / 21600));
  approximatelyEqual(geometry.gapPx, geometry.diameterPx / 5);
  approximatelyEqual(geometry.sigmaPx, angularSigmaPixels(2, 0.4, 15) * 0.75);
  approximatelyEqual(geometry.sigmaPx, stimulusGeometry(0.7, 2, 5, 3).sigmaPx);
  assert.equal(geometry.sizeSupported, false);
  assert.equal(stimulusGeometry(0.3, 0, 5, 3).sizeSupported, true);
  assert.equal(stimulusGeometry(0, 0, 4, 1).minSigmaArcmin, 2.25);
  assert.equal(landoltInk(4.5, 0, 10, 0), false);
  assert.equal(landoltInk(4.5, 1.1, 10, 0), true);
  assert.equal(landoltInk(-4.5, 0, 10, 0), true);
  assert.equal(landoltInk(0, -4.5, 10, 6), false);
  assert.equal(landoltInk(0, 0, 10, 0), false);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => randomLandoltDirection(() => i / 8)), [0,1,2,3,4,5,6,7]);
});

test('Gaussian taps conserve brightness', () => {
  assert.deepEqual(gaussianHalfKernel(0), [1]);
  const weights = gaussianHalfKernel(2);
  approximatelyEqual(weights[0] + 2 * weights.slice(1).reduce((sum, weight) => sum + weight, 0), 1);
  assert.ok(weights[0] > weights[1]);
});
