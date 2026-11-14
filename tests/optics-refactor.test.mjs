import test from 'node:test';
import assert from 'node:assert/strict';
import { getIOLDefocus, logMARFromLensCurve, provisionalSigmaArcmin, sigmaFromLogMAR, validateLensCurve } from '../src/lib/optics/mapping.ts';
import { angularSigmaPixels, sigmaPixelsToArcmin } from '../src/lib/optics/angular-scale.ts';
import { acuityIols, physicsIols } from '../src/lib/data/iol-models.ts';
import { loadIOLCurves } from '../src/lib/data/loader.ts';
import {
  calculateCssPixelsPerMillimeterFromCreditCardShortEdge, calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter,
  calculateEffectiveCssPixelsPerMillimeter, parseCalibrationSnapshot, serializeCalibrationSnapshot
} from '../src/lib/optics/calibration.ts';
import { randomLandoltDirection, stimulusGeometry, thresholdBracket, thresholdsCsv } from '../src/lib/optics/acuity-calibration.ts';
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
    assert.ok(logMARFromLensCurve(curve, 0) < 0);
    assert.ok(10 ** -logMARFromLensCurve(curve, 0) > 1);
    assert.ok(!Object.hasOwn(physicsIols, id));
    assert.equal(validateLensCurve({ ...curve, logMAR: [NaN, ...curve.logMAR.slice(1)] }).valid, false);
  }
});

test('clinical curve interpolation stays inside observed nodes and applies the same signed refraction to near and far', () => {
  const wf = curves.find(curve => curve.id === 'sn60wf');
  assert.equal(logMARFromLensCurve(wf, -2.5), 0.539);
  approximatelyEqual(logMARFromLensCurve(wf, -2.25), (0.539 + 0.379) / 2);
  assert.equal(logMARFromLensCurve(wf, -2.5001), null);
  assert.equal(logMARFromLensCurve(wf, 1.5001), null);
  assert.equal(logMARFromLensCurve(wf, NaN), null);
  assert.equal(logMARFromLensCurve(curves.find(curve => curve.id === 'sn60at'), -4), 0.75);
  assert.equal(getIOLDefocus(-2.5, -1), -1.5);
  assert.equal(getIOLDefocus(0, -1), 1);
  assert.equal(logMARFromLensCurve(wf, getIOLDefocus(-4, -1)), null);
});

test('provisional mapping retains its deadband and reference-pixel blur on all rendering scales', () => {
  assert.equal(sigmaFromLogMAR(-0.05), 0);
  assert.equal(sigmaFromLogMAR(0.02), 0);
  assert.ok(sigmaFromLogMAR(0.021) > 0);
  const logMAR = 0.42;
  const sigma = provisionalSigmaArcmin(logMAR);
  for (const [distance, ppm, renderScale] of [[0.2, 4, 1], [0.4, 5, 2], [1, 7, 0.75]]) {
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

test('at 40 cm Landolt C uses the 5:1 diameter and actual display sample limits', () => {
  const geometry = stimulusGeometry(0, 2, 5, 3);
  approximatelyEqual(geometry.diameterMm, 800 * Math.tan(5 * Math.PI / 21600));
  approximatelyEqual(geometry.gapPx, geometry.diameterPx / 5);
  approximatelyEqual(geometry.sigmaPx, stimulusGeometry(0.7, 2, 5, 3).sigmaPx);
  assert.equal(geometry.sizeSupported, false);
  assert.equal(stimulusGeometry(0.3, 0, 5, 3).sizeSupported, true);
  assert.equal(stimulusGeometry(0, 0, 4, 1).minSigmaArcmin, 1.75);
  assert.equal(landoltInk(4.5, 0, 10, 0), false);
  assert.equal(landoltInk(4.5, 1.1, 10, 0), true);
  assert.equal(landoltInk(-4.5, 0, 10, 0), true);
  assert.equal(landoltInk(0, -4.5, 10, 6), false);
  assert.equal(landoltInk(0, 0, 10, 0), false);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => randomLandoltDirection(() => i / 8)), [0,1,2,3,4,5,6,7]);
});

test('Gaussian taps conserve brightness and threshold export preserves the observed bracket', () => {
  assert.deepEqual(gaussianHalfKernel(0), [1]);
  const weights = gaussianHalfKernel(2);
  approximatelyEqual(weights[0] + 2 * weights.slice(1).reduce((sum, weight) => sum + weight, 0), 1);
  assert.ok(weights[0] > weights[1]);
  assert.equal(thresholdBracket(0, 0.5), true);
  assert.equal(thresholdBracket(0.5, 0.5), false);
  assert.equal(thresholdBracket(null, 0.5), false);
  assert.equal(thresholdBracket(0.5, 0.25), false);
  assert.equal(thresholdsCsv([{ participantId: '=pilot', device: 'Example "phone"', baselineLogMAR: -0.1 }]),
    'participantId,device,baselineLogMAR\r\n"\'=pilot","Example ""phone""",-0.1\r\n');
});
