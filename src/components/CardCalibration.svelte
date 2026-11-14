<script lang="ts">
  import {
    CREDIT_CARD_SHORT_EDGE_MM, MIN_VIEWING_DISTANCE_M, MAX_VIEWING_DISTANCE_M,
    calculatePPIFromPixelsPerMillimeter, calculateCssPixelsPerMillimeterFromCreditCardShortEdge,
    calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter, validateDisplayParams
  } from '../lib/optics/calibration';
  import { effectiveCssPxPerMm, saveDisplayCalibration, viewingDistance } from '../lib/stores/display';

  export let fixedDistanceM: number | undefined = undefined;
  export let formId = 'screen-calibration';
  export let onSaved = () => {};
  export let saveDisabled = true;

  let cardShortEdgePx = Math.max(107, Math.min(420,
    Math.round(calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter($effectiveCssPxPerMm))
  ));
  let distance = fixedDistanceM ?? $viewingDistance;
  let stageWidth = 0;
  let viewportHeight = 0;
  $: availableEdgePx = Math.max(stageWidth, Math.floor(viewportHeight * 2 / 3));
  $: maxEdgePx = Math.max(107, Math.min(420, availableEdgePx || 420));
  $: shownEdgePx = Math.min(cardShortEdgePx, maxEdgePx);
  $: verticalGuide = stageWidth > 0 && shownEdgePx > stageWidth;
  $: ppm = calculateCssPixelsPerMillimeterFromCreditCardShortEdge(shownEdgePx);
  $: errors = validateDisplayParams(distance, calculatePPIFromPixelsPerMillimeter(ppm)).errors;
  $: saveDisabled = errors.length > 0 || availableEdgePx < 107;

  function save() {
    if (saveDisabled) return;
    saveDisplayCalibration(ppm, fixedDistanceM === undefined ? distance : $viewingDistance);
    onSaved();
  }
</script>

<svelte:window bind:innerHeight={viewportHeight} />

<form id={formId} on:submit|preventDefault={save}>
  <p>Match the guide to the short edge of a credit card.</p>
  <div class="card-stage" class:vertical={verticalGuide} bind:clientWidth={stageWidth}
    style:height={verticalGuide ? `${shownEdgePx}px` : undefined}>
    <div class="card-guide" style:width={`${shownEdgePx}px`}></div>
  </div>
  {#if verticalGuide}<p class="note">Hold the card with its short edge vertical.</p>{/if}
  <label for="calibrate-card-size">Match the card edge <span>{CREDIT_CARD_SHORT_EDGE_MM} mm</span></label>
  <input id="calibrate-card-size" type="range" min="107" max={maxEdgePx} step="1"
    value={shownEdgePx} on:input={event => cardShortEdgePx = event.currentTarget.valueAsNumber} />
  {#if fixedDistanceM === undefined}
    <label for="calibrate-viewing-distance">Eye-to-screen distance <span>{Math.round(distance * 100)} cm</span></label>
    <input id="calibrate-viewing-distance" type="range" min={MIN_VIEWING_DISTANCE_M} max={MAX_VIEWING_DISTANCE_M}
      step="0.01" bind:value={distance} />
  {:else}
    <p>Test viewing distance is fixed at {Math.round(fixedDistanceM * 100)} cm.</p>
  {/if}
  {#each errors as error}<p class="error">{error}</p>{/each}
  {#if stageWidth > 0 && availableEdgePx < 107}<p class="error">Zoom out so the card guide fits.</p>{/if}
  {#if fixedDistanceM === undefined}
    <p class="note">Keep this distance, avoid browser zoom, and make sure you can focus on the screen. Use consistent brightness and room lighting when comparing lenses.</p>
  {:else}
    <button type="submit" disabled={saveDisabled}>Save screen scale</button>
  {/if}
</form>

<style>
  p { font-size: .9rem; line-height: 1.45; margin: .65rem 0; }
  label { display: flex; justify-content: space-between; font-weight: 650; font-size: .84rem; margin: .7rem 0 .2rem; }
  label span,.note { color: #526571; }
  input { width: 100%; height: 44px; margin: 0; accent-color: #1d4ed8; }
  .card-stage { position: relative; min-height: 50px; overflow: hidden; background: #f1f5f9; border-radius: .55rem; }
  .card-guide { position: absolute; top: 50%; left: 50%; translate: -50% -50%; }
  .vertical .card-guide { transform: rotate(90deg); }
  .card-guide { height: 20px; border: solid #1d4ed8; border-width: 0 2px 2px; }
  .note { font-size: .81rem; }
  .error { color: #991b1b; }
  button { padding: .45rem .8rem; min-height: 44px; background: #1d4ed8; color: white; border-radius: .55rem; }
  button:disabled { opacity: .5; }
</style>
