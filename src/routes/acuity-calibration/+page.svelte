<script lang="ts">
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import CardCalibration from '../../components/CardCalibration.svelte';
  import {
    LOGMAR_LEVELS, MAX_FIELD_PX, MAX_SIGMA_ARCMIN, SIGMA_STEP_ARCMIN, TEST_DISTANCE_M,
    randomLandoltDirection, stimulusGeometry, thresholdBracket, thresholdsCsv, type ThresholdRow
  } from '../../lib/optics/acuity-calibration';
  import { angularSigmaPixels } from '../../lib/optics/angular-scale';
  import { renderLandoltC } from '../../lib/render/landolt-c';
  import { displayCalibration, effectiveCssPxPerMm, viewport } from '../../lib/stores/display';

  let participantId = '';
  let device = '';
  let ready = false;
  let calibrating = false;
  let level = LOGMAR_LEVELS.indexOf(0.7);
  let baseline: number | null = null;
  let sigma = 0;
  let direction = -1;
  let lastReadable: number | null = null;
  let firstUnreadable: number | null = null;
  let rows: ThresholdRow[] = [];
  let canvas: HTMLCanvasElement;
  let fieldWidth = 0;
  let drew = false;
  let previousRenderScale = 0;

  onMount(() => {
    device = navigator.userAgent;
    direction = randomLandoltDirection();
    ready = true;
  });

  $: renderScale = $viewport.dpr * $viewport.zoom;
  $: physicalScale = $effectiveCssPxPerMm * renderScale;
  $: if (calibrated && Math.abs(physicalScale - previousRenderScale) > 1e-8) {
    previousRenderScale = physicalScale;
    resetThreshold();
    baseline = null;
  }
  $: calibrated = ready && $displayCalibration?.devicePixelRatio !== undefined;
  $: logMAR = LOGMAR_LEVELS[level];
  $: geometry = stimulusGeometry(logMAR, sigma, $effectiveCssPxPerMm, renderScale);
  $: fieldCssPx = geometry.fieldPx / renderScale;
  $: representable = geometry.sizeSupported && geometry.fieldPx <= MAX_FIELD_PX &&
    fieldWidth >= fieldCssPx && (sigma === 0 || sigma >= geometry.minSigmaArcmin);
  $: if (calibrated && !calibrating && representable && canvas && direction >= 0) {
    drew = renderLandoltC(canvas, geometry.fieldPx, geometry.diameterPx, geometry.sigmaPx, direction);
  } else drew = false;
  $: canRecord = calibrated && drew && !!participantId.trim() && baseline !== null && logMAR >= baseline &&
    thresholdBracket(lastReadable, firstUnreadable);
  $: nextLevelUsable = level < LOGMAR_LEVELS.length - 1 && baseline !== null && LOGMAR_LEVELS[level + 1] >= baseline &&
    stimulusGeometry(LOGMAR_LEVELS[level + 1], 0, $effectiveCssPxPerMm, renderScale).sizeSupported;

  function randomize() { direction = randomLandoltDirection(); }

  function resetThreshold() {
    sigma = 0;
    lastReadable = firstUnreadable = null;
  }

  function changeLevel(next: number) {
    level = next;
    resetThreshold();
    randomize();
  }

  function adjustSigma(increment: number) {
    const next = sigma === 0 && increment > 0 ? geometry.minSigmaArcmin : sigma + increment * SIGMA_STEP_ARCMIN;
    sigma = next < geometry.minSigmaArcmin ? 0 : Math.min(MAX_SIGMA_ARCMIN, next);
  }

  function markReadable() {
    lastReadable = sigma;
    if (firstUnreadable !== null && firstUnreadable <= sigma) firstUnreadable = null;
  }

  function markUnreadable() {
    if (sigma === 0) return;
    firstUnreadable = sigma;
    if (lastReadable !== null && lastReadable >= sigma) lastReadable = null;
  }

  function record(advance: boolean) {
    const saved = $displayCalibration;
    if (!canRecord || !saved || baseline === null || lastReadable === null || firstUnreadable === null) return;
    const id = participantId.trim();
    const repetition = 1 + rows.filter(row => row.participantId === id && row.optotypeLogMAR === logMAR).length;
    rows = [...rows, {
      participantId: id, measuredAt: new Date().toISOString(), repetition, stimulusVersion: 'landolt-encoded-v1', device,
      screenWidthCssPx: screen.width, screenHeightCssPx: screen.height,
      viewportZoom: $viewport.zoom, devicePixelRatio: $viewport.dpr,
      effectiveCssPxPerMm: $effectiveCssPxPerMm, calibratedCssPxPerMm: saved.cssPxPerMmCal,
      calibrationZoom: saved.calibScale, calibrationDpr: saved.devicePixelRatio ?? null,
      renderPxPerCssPx: renderScale, viewingDistanceCm: TEST_DISTANCE_M * 100,
      baselineLogMAR: baseline, optotypeLogMAR: logMAR, degradationLogMAR: +(logMAR - baseline).toFixed(2),
      gapRenderPx: geometry.gapPx,
      lastReadableSigmaArcmin: lastReadable, firstUnreadableSigmaArcmin: firstUnreadable,
      lastReadableSigmaRenderPx: angularSigmaPixels(lastReadable, TEST_DISTANCE_M, physicalScale),
      firstUnreadableSigmaRenderPx: angularSigmaPixels(firstUnreadable, TEST_DISTANCE_M, physicalScale)
    }];
    if (advance && nextLevelUsable) changeLevel(level + 1);
    else { resetThreshold(); randomize(); }
  }

  function download(format: 'csv' | 'json') {
    const data = format === 'csv' ? thresholdsCsv(rows) : JSON.stringify({ schemaVersion: 1, measurements: rows }, null, 2);
    const url = URL.createObjectURL(new Blob([data], {type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = `acuity-calibration.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<svelte:head>
  <title>Gaussian / Acuity Calibration · IOL Vision Simulator</title>
  <meta name="description" content="Record preliminary angular Gaussian blur thresholds using a display-calibrated Landolt C at 40 cm." />
</svelte:head>

<main>
  <header>
    <a href={`${base}/`}>← Simulator</a>
    <h1>Gaussian / Acuity Calibration</h1>
    <p class="muted">Pilot threshold tool · 40 cm eye-to-screen</p>
  </header>

  <section class="panel" aria-labelledby="setup">
    <div class="row">
      <h2 id="setup">1. Screen setup</h2>
      {#if calibrated}
        <button type="button" on:click={() => calibrating = !calibrating}>{calibrating ? 'Close card guide' : 'Recalibrate'}</button>
      {/if}
    </div>
    {#if !calibrated || calibrating}
      <CardCalibration fixedDistanceM={TEST_DISTANCE_M} onSaved={() => { calibrating = false; resetThreshold(); baseline = null; }} />
    {:else}
      <p>Keep your eyes 40 cm from the screen. Wear your usual correction for reading at this distance, and keep brightness and zoom fixed.</p>
      <div class="row">
        <label for="participant">Anonymous participant ID</label>
        <input id="participant" maxlength="48" bind:value={participantId} disabled={rows.length > 0} autocomplete="off" />
      </div>
    {/if}
  </section>

  {#if calibrated && !calibrating}
    <section class="panel" aria-labelledby="stimulus">
      <h2 id="stimulus">2. Landolt C</h2>
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
            <button type="button" aria-label="Increase Gaussian sigma" disabled={baseline === null || sigma >= MAX_SIGMA_ARCMIN} on:click={() => adjustSigma(1)}>+</button>
          </div>
        </div>
      </div>
      <p class="muted">Gap {geometry.gapPx.toFixed(2)} px · σ {geometry.sigmaPx.toFixed(2)} px on the render grid</p>
      {#if !geometry.sizeSupported}
        <p class="warning" role="status">The gap is under 2 render pixels. Choose a larger C for measurement.</p>
      {:else if !representable && fieldWidth}
        <p class="warning" role="status">This stimulus exceeds the supported render field. Reduce the size or blur.</p>
      {/if}
      {#if geometry.minSigmaArcmin > SIGMA_STEP_ARCMIN}
        <p class="muted">Smallest supported nonzero σ on this screen is {geometry.minSigmaArcmin.toFixed(2)} arcmin.</p>
      {/if}
      <button type="button" on:click={randomize}>New gap direction</button>
    </section>

    <section class="panel" aria-labelledby="measure">
      <h2 id="measure">3. Measure threshold</h2>
      {#if baseline === null}
        <p>With σ at zero, find the smallest C whose gap you can reliably identify after changing directions. Use that size as your baseline.</p>
        <button type="button" class="primary" disabled={!drew} on:click={() => { baseline = logMAR; if (level > 0) changeLevel(0); }}>
          Set unblurred baseline
        </button>
      {:else}
        <p>Baseline {baseline.toFixed(1)} logMAR. Start with a larger C. Mark the last readable σ and the first unreadable σ, then repeat or move to a smaller C.</p>
        {#if logMAR < baseline}<p class="warning">This C is finer than the saved unblurred baseline.</p>{/if}
        <div class="buttons">
          <button type="button" disabled={!drew || logMAR < baseline} on:click={markReadable}>Mark readable</button>
          <button type="button" disabled={!drew || sigma === 0 || logMAR < baseline} on:click={markUnreadable}>Mark unreadable</button>
        </div>
        <p aria-live="polite" class="muted">Readable {lastReadable?.toFixed(2) ?? '—'} · Unreadable {firstUnreadable?.toFixed(2) ?? '—'} arcmin</p>
        <div class="buttons">
          <button type="button" class="primary" disabled={!canRecord} on:click={() => record(false)}>Record threshold</button>
          <button type="button" disabled={!canRecord || !nextLevelUsable} on:click={() => record(true)}>Record &amp; next size</button>
          <button type="button" class="subtle" on:click={() => { baseline = null; resetThreshold(); }}>Reset baseline</button>
        </div>
      {/if}
    </section>
  {/if}

  {#if rows.length}
    <section class="panel" aria-labelledby="results">
      <div class="row">
        <h2 id="results">Measurements ({rows.length})</h2>
        <div class="buttons">
          <button type="button" on:click={() => download('csv')}>CSV</button>
          <button type="button" on:click={() => download('json')}>JSON</button>
        </div>
      </div>
      <table>
        <thead><tr><th scope="col">logMAR</th><th scope="col">Repeat</th><th scope="col">σ bracket (arcmin)</th></tr></thead>
        <tbody>
          {#each rows as row}
            <tr><td>{row.optotypeLogMAR.toFixed(1)}</td><td>{row.repetition}</td>
              <td>{row.lastReadableSigmaArcmin.toFixed(2)}–{row.firstUnreadableSigmaArcmin.toFixed(2)}</td></tr>
          {/each}
        </tbody>
      </table>
      <p class="muted">Measurements stay on this page. Export before closing or refreshing.</p>
    </section>
  {/if}
</main>

<style>
  main { max-width: 42rem; margin: auto; padding: 1.1rem clamp(.65rem, 4vw, 1.5rem) 2rem; color: #172b35; }
  header { margin: 0 0 1rem; }
  h1 { font-size: clamp(1.25rem, 4vw, 1.65rem); font-weight: 700; margin: .45rem 0; }
  h2 { font-size: 1.04rem; font-weight: 700; }
  a { color: #1d4ed8; text-decoration: underline; display: inline-flex; align-items: center; min-height: 36px; }
  .panel { border: 1px solid #dce5eb; border-radius: .65rem; padding: .85rem; margin-bottom: .65rem; background: white; }
  p { font-size: .9rem; margin: .4rem 0 .7rem; }
  .muted { color: #516371; }
  .warning { color: #8a410b; }
  .row,.buttons { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .row { justify-content: space-between; }
  label { font-size: .88rem; font-weight: 600; }
  input { max-width: 100%; min-height: 44px; border: 1px solid #b7c4d0; padding: 0 .55rem; border-radius: .48rem; }
  input:disabled { opacity: .65; }
  button { min-height: 44px; padding: .35rem .65rem; border: 1px solid #cbd5e1; border-radius: .5rem; background: #f8fafc; font-size: .84rem; font-weight: 600; touch-action: manipulation; }
  button:disabled { opacity: .45; }
  .primary { background: #1d4ed8; color: white; border-color: #1d4ed8; }
  .subtle { border-color: transparent; background: transparent; color: #1d4ed8; }
  .stimulus { display: grid; place-items: center; min-height: 8rem; overflow: hidden; border: 1px solid #e2e8f0; border-radius: .45rem; margin: .55rem 0; }
  canvas { display: block; max-width: none; }
  .steppers { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  .value { display: block; font-size: .85rem; margin-bottom: .2rem; font-variant-numeric: tabular-nums; }
  table { width: 100%; margin-top: .45rem; font-size: .85rem; font-variant-numeric: tabular-nums; }
  th,td { padding: .25rem; border-bottom: 1px solid #e2e8f0; text-align: left; }
</style>
