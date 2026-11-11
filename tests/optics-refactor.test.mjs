import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logMARFromLensCurve, sigmaFromLogMAR } from '../src/lib/optics/mapping.ts';
import { resolveBlurPolicy } from '../src/lib/render/blur-policy.ts';
import { acuityIols, physicsIols } from '../src/lib/data/iol-models.ts';
import { calculateCssPixelsPerMillimeterFromCreditCardShortEdge, calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter, parseCalibrationSnapshot, serializeCalibrationSnapshot } from '../src/lib/optics/calibration.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const curvesPath = path.resolve(__dirname, '../src/lib/data/iol_curves.json');
const curves = JSON.parse(readFileSync(curvesPath, 'utf8'));
const REFERENCE_CSS_PX_PER_MM = 110 / 25.4;
const REFERENCE_VIEWING_DISTANCE_M = 0.4;

test('target refraction can be used directly as far-background defocus on curve mapping', () => {
  const modelCurve = curves.find((curve) => curve.id === 'vivity');
  assert.ok(modelCurve, 'phakic_young_model curve must exist');

  const backgroundDefocus = -1.5;
  const logMAR = logMARFromLensCurve(modelCurve, backgroundDefocus);
  const sigma = sigmaFromLogMAR(logMAR);

  assert.equal(logMAR, 0.1);
  assert.ok(sigma > 0);
});

test('sigma mapping applies a no-blur deadband up to 0.02 logMAR loss', () => {
  assert.equal(sigmaFromLogMAR(0.0, 0.0), 0);
  assert.equal(sigmaFromLogMAR(0.02, 0.0), 0);
  assert.ok(sigmaFromLogMAR(0.021, 0.0) > 0);
});

test('legacy blur policy preserves full sigma at full resolution for extreme workloads', () => {
  const policy = resolveBlurPolicy({
    sigmaCssRaw: 40,
    deviceCssPxPerMm: REFERENCE_CSS_PX_PER_MM,
    viewingDistanceM: REFERENCE_VIEWING_DISTANCE_M,
    renderPixelScale: 2,
    blurRenderScale: 1,
    dpr: 2.5,
    foregroundCoverage: 1
  });

  // Upstream deliberately disabled workload downsampling. Preserve that rendering behavior.
  assert.equal(policy.downsampleFactor, 1);
  assert.equal(policy.path, 'full-res');
  assert.equal(policy.sigmaTexelUsedFull, policy.sigmaTexelRawFull);
  assert.equal(policy.sigmaTexelUsedBlurGrid, policy.sigmaTexelUsedFull / policy.downsampleFactor);
});

test('acuity models resolve only their own clinical data and physics models have separate identities', () => {
  assert.deepEqual(Object.entries(acuityIols).map(([id, model]) => [id, model.curveId]), [
    ['sn60at', null], ['sn60wf', null], ['acrysof_iq_vivity', 'vivity']
  ]);
  const curve = curves.find(curve => curve.id === acuityIols.acrysof_iq_vivity.curveId);
  assert.equal(curve.type, 'IOL');
  assert.equal(curve.manufacturer, 'Alcon');
  assert.equal(curve.label, acuityIols.acrysof_iq_vivity.label);
  assert.ok(Object.keys(physicsIols).every(id => !Object.hasOwn(acuityIols, id) && !curves.some(curve => curve.id === id)));
  for (const curve of curves) {
    assert.equal(curve.defocus_D.length, curve.logMAR.length);
    assert.ok(curve.logMAR.every(Number.isFinite));
  }
});

test('credit card calibration round-trips physical scale and saved snapshot', () => {
  const cssPxPerMmCal = calculateCssPixelsPerMillimeterFromCreditCardShortEdge(270);
  assert.ok(Math.abs(calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter(cssPxPerMmCal) - 270) < 1e-10);
  const snapshot = { cssPxPerMmCal, calibScale: 1 };
  assert.deepEqual(parseCalibrationSnapshot(serializeCalibrationSnapshot(snapshot)), snapshot);
  const withDistance = { ...snapshot, viewingDistanceM: 0.6 };
  assert.deepEqual(parseCalibrationSnapshot(serializeCalibrationSnapshot(withDistance)), withDistance);
});

test('blur policy preserves physical blur size across device px/mm calibration', () => {
  const sigmaRefPx = 8;
  const referenceCssPxPerMm = REFERENCE_CSS_PX_PER_MM;
  const deviceCssPxPerMmA = referenceCssPxPerMm;
  const deviceCssPxPerMmB = referenceCssPxPerMm * 2;

  const policyA = resolveBlurPolicy({
    sigmaCssRaw: sigmaRefPx,
    referenceCssPxPerMm,
    deviceCssPxPerMm: deviceCssPxPerMmA,
    viewingDistanceM: REFERENCE_VIEWING_DISTANCE_M,
    renderPixelScale: 1
  });

  const policyB = resolveBlurPolicy({
    sigmaCssRaw: sigmaRefPx,
    referenceCssPxPerMm,
    deviceCssPxPerMm: deviceCssPxPerMmB,
    viewingDistanceM: REFERENCE_VIEWING_DISTANCE_M,
    renderPixelScale: 1
  });

  const sigmaMmA = policyA.sigmaCssNormalized / deviceCssPxPerMmA;
  const sigmaMmB = policyB.sigmaCssNormalized / deviceCssPxPerMmB;

  assert.ok(Math.abs(sigmaMmA - sigmaMmB) < 1e-12);
  assert.ok(policyB.sigmaTexelUsedFull > policyA.sigmaTexelUsedFull);
});

test('blur policy can normalize blur for viewing-distance angular consistency', () => {
  const sigmaRefPx = 8;
  const deviceCssPxPerMm = 5;
  const referenceViewingDistanceM = REFERENCE_VIEWING_DISTANCE_M;
  const nearViewingDistanceM = 0.2;
  const farViewingDistanceM = 0.8;

  const nearPolicy = resolveBlurPolicy({
    sigmaCssRaw: sigmaRefPx,
    deviceCssPxPerMm,
    referenceViewingDistanceM,
    viewingDistanceM: nearViewingDistanceM,
    renderPixelScale: 1
  });

  const farPolicy = resolveBlurPolicy({
    sigmaCssRaw: sigmaRefPx,
    deviceCssPxPerMm,
    referenceViewingDistanceM,
    viewingDistanceM: farViewingDistanceM,
    renderPixelScale: 1
  });

  const nearSigmaRad = (nearPolicy.sigmaCssNormalized / deviceCssPxPerMm) / nearViewingDistanceM;
  const farSigmaRad = (farPolicy.sigmaCssNormalized / deviceCssPxPerMm) / farViewingDistanceM;

  assert.ok(Math.abs(nearSigmaRad - farSigmaRad) < 1e-12);
  assert.equal(nearPolicy.viewingDistanceNormalizationScale, 0.5);
  assert.equal(farPolicy.viewingDistanceNormalizationScale, 2);
});
