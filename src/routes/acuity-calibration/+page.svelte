<script lang="ts">
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import CardCalibration from '../../components/CardCalibration.svelte';
  import { DEFAULT_PHONE_VIEWING_DISTANCE_M } from '../../lib/optics/calibration';
  import {
    LOGMAR_LEVELS, MAX_FIELD_PX, MAX_SIGMA_ARCMIN, SIGMA_STEP_ARCMIN,
    randomLandoltDirection, stimulusGeometry
  } from '../../lib/optics/acuity-calibration';
  import { renderLandoltC } from '../../lib/render/landolt-c';
  import { displayCalibration, effectiveCssPxPerMm, viewport } from '../../lib/stores/display';

  const viewingDistanceCm = Math.round(DEFAULT_PHONE_VIEWING_DISTANCE_M * 100);
  let calibrating = false;
  let level = LOGMAR_LEVELS.indexOf(0.7);
  let sigma = 0;
  let direction: number | undefined;
  let canvas: HTMLCanvasElement;
  let fieldWidth = 0;
  let drew = false;

  onMount(randomize);

  $: calibrated = $displayCalibration?.devicePixelRatio !== undefined;
  $: renderScale = $viewport.dpr * $viewport.zoom;
  $: logMAR = LOGMAR_LEVELS[level];
  $: geometry = stimulusGeometry(logMAR, sigma, $effectiveCssPxPerMm, renderScale);
  $: fieldCssPx = geometry.fieldPx / renderScale;
  $: fitsField = geometry.fieldPx <= MAX_FIELD_PX && fieldWidth >= fieldCssPx;
  $: drew = calibrated && !calibrating && fitsField && canvas && direction !== undefined
    ? renderLandoltC(canvas, geometry.fieldPx, geometry.diameterPx, geometry.sigmaPx, direction)
    : false;

  function randomize() {
    direction = randomLandoltDirection();
  }

  function changeLevel(next: number) {
    level = next;
    randomize();
  }

  function adjustSigma(step: -1 | 1) {
    if (step > 0) {
      const next = Math.max(sigma + SIGMA_STEP_ARCMIN, geometry.minSigmaArcmin);
      if (next <= MAX_SIGMA_ARCMIN) sigma = next;
    } else {
      const next = sigma - SIGMA_STEP_ARCMIN;
      sigma = next < geometry.minSigmaArcmin ? 0 : next;
    }
  }
</script>

<svelte:head>
  <title>Gaussian / Acuity Calibration · IOL Vision Simulator</title>
  <meta name="description" content={`Adjust a display-calibrated Landolt C and angular Gaussian blur at ${viewingDistanceCm} cm.`} />
</svelte:head>

<main>
  <header>
    <a href={`${base}/`}>← Simulator</a>
    <h1>Gaussian / Acuity Calibration</h1>
  </header>

  {#if !calibrated || calibrating}
    <section class="panel" aria-label="Screen calibration">
      <CardCalibration fixedDistanceM={DEFAULT_PHONE_VIEWING_DISTANCE_M} onSaved={() => calibrating = false} />
      {#if calibrated}<button type="button" on:click={() => calibrating = false}>Cancel</button>{/if}
    </section>
  {:else}
    <section class="panel" aria-labelledby="stimulus">
      <div class="row">
        <h2 id="stimulus">Landolt C</h2>
        <button type="button" on:click={() => calibrating = true}>Recalibrate</button>
      </div>
      <p>Keep your eyes {viewingDistanceCm} cm from the screen.</p>
      <div class="stimulus" bind:clientWidth={fieldWidth}>
        <canvas bind:this={canvas} aria-label="Landolt C stimulus" style:width={`${fieldCssPx}px`} style:height={`${fieldCssPx}px`}
          style:visibility={drew ? 'visible' : 'hidden'} />
      </div>
      <div class="steppers">
        <div>
          <span class="value">{logMAR.toFixed(1)} logMAR</span>
          <div class="buttons">
            <button type="button" disabled={level === 0} on:click={() => changeLevel(level - 1)}>Larger C</button>
            <button type="button" disabled={level === LOGMAR_LEVELS.length - 1} on:click={() => changeLevel(level + 1)}>Smaller C</button>
          </div>
        </div>
        <div>
          <span class="value">σ {sigma.toFixed(2)} arcmin</span>
          <div class="buttons">
            <button type="button" aria-label="Decrease Gaussian sigma" disabled={sigma === 0} on:click={() => adjustSigma(-1)}>−</button>
            <button type="button" aria-label="Increase Gaussian sigma" disabled={sigma >= MAX_SIGMA_ARCMIN || geometry.minSigmaArcmin > MAX_SIGMA_ARCMIN} on:click={() => adjustSigma(1)}>+</button>
          </div>
        </div>
      </div>
      <p class="muted">Gap {geometry.gapPx.toFixed(2)} px · σ {geometry.sigmaPx.toFixed(2)} px on the render grid</p>
      {#if !fitsField && fieldWidth}
        <p class="warning" role="status">This stimulus exceeds the render field. Reduce the size or blur.</p>
      {:else if !geometry.sizeSupported}
        <p class="warning" role="status">The gap is under 2 render pixels. Use a larger C for measurements.</p>
      {/if}
      {#if geometry.minSigmaArcmin > SIGMA_STEP_ARCMIN}
        <p class="muted">Minimum nonzero σ for measurement on this screen is {geometry.minSigmaArcmin.toFixed(2)} arcmin.</p>
      {/if}
      <button type="button" on:click={randomize}>New gap direction</button>
    </section>
  {/if}
</main>

<style>
  main { max-width: 42rem; margin: auto; padding: 1.1rem clamp(.65rem, 4vw, 1.5rem) 2rem; color: #172b35; }
  header { margin-bottom: 1rem; }
  h1 { font-size: clamp(1.25rem, 4vw, 1.65rem); font-weight: 700; margin: .45rem 0; }
  h2 { font-size: 1.04rem; font-weight: 700; }
  a { color: #1d4ed8; text-decoration: underline; display: inline-flex; align-items: center; min-height: 44px; }
  .panel { border: 1px solid #dce5eb; border-radius: .65rem; padding: .85rem; background: white; }
  p { font-size: .9rem; margin: .45rem 0 .65rem; }
  .muted { color: #516371; }
  .warning { color: #8a410b; }
  .row,.buttons { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .row { justify-content: space-between; }
  button { min-width: 44px; min-height: 44px; padding: .35rem .65rem; border: 1px solid #cbd5e1; border-radius: .5rem; background: #f8fafc; font-size: .84rem; font-weight: 600; touch-action: manipulation; }
  button:disabled { opacity: .45; }
  .stimulus { display: grid; place-items: center; min-height: 8rem; overflow: hidden; border: 1px solid #e2e8f0; border-radius: .45rem; margin: .55rem 0; }
  canvas { display: block; max-width: none; }
  .steppers { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: .5rem; }
  .value { display: block; font-size: .85rem; margin-bottom: .2rem; font-variant-numeric: tabular-nums; }
</style>
