<script lang="ts">
  import IolScene from '../components/IolScene.svelte';
  import SheetSelect from '../components/SheetSelect.svelte';
  import {
    simulationMethod, acuitySelection, physicsSelection, splitViewEnabled, masterDefocus,
    targetRefraction, compareTargetRefraction, cssPxPerMmCal, calibrationScale,
    currentViewportScale, effectiveCssPxPerMm, viewingDistance, hasCalibration
  } from '../lib/stores/app';
  import { acuityIols, physicsIols, type AcuityIolId, type PhysicsIolId } from '../lib/data/iol-models';
  import {
    MIN_VIEWING_DISTANCE_M, MAX_VIEWING_DISTANCE_M, calculatePPIFromPixelsPerMillimeter,
    calculateCssPixelsPerMillimeterFromCreditCardShortEdge,
    calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter, validateDisplayParams
  } from '../lib/optics/calibration';

  type Panel = 'about' | 'settings' | 'calibrate';
  let panel: Panel | null = null;
  let cardShortEdgePx = 180;
  let viewingDraft = 0.4;
  let displayedDefocus: number | null = null;

  const acuityOptions = Object.entries(acuityIols).map(([value, {label}]) => ({value, label}));
  const physicsOptions = Object.entries(physicsIols).map(([value, {label}]) => ({value, label}));
  const distances = [{label: 'Far', cm: 100, defocus: -1}, {label: 'Mid', cm: 50, defocus: -2},
    {label: 'Near', cm: 25, defocus: -4}];
  const titles = {about: 'About the simulation', settings: 'Settings', calibrate: 'Screen calibration'};

  $: options = $simulationMethod === 'physics' ? physicsOptions : acuityOptions;
  $: selection = $simulationMethod === 'physics' ? $physicsSelection : $acuitySelection;
  $: cardPpm = calculateCssPixelsPerMillimeterFromCreditCardShortEdge(cardShortEdgePx);
  $: calibrationErrors = validateDisplayParams(viewingDraft, calculatePPIFromPixelsPerMillimeter(cardPpm)).errors;
  $: shownDistance = Math.round(-100 / (displayedDefocus ?? $masterDefocus));

  function openCalibration() {
    cardShortEdgePx = Math.round(calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter($effectiveCssPxPerMm));
    viewingDraft = $viewingDistance;
    panel = 'calibrate';
  }

  function saveCalibration() {
    if (calibrationErrors.length) return;
    const scale = window.visualViewport?.scale ?? 1;
    cssPxPerMmCal.set(cardPpm);
    calibrationScale.set(scale);
    currentViewportScale.set(scale);
    viewingDistance.set(viewingDraft);
    hasCalibration.set(true);
    panel = null;
  }

  function selectIol(side: 'primary' | 'compare', id: string) {
    if ($simulationMethod === 'physics' && Object.hasOwn(physicsIols, id)) {
      physicsSelection.update(previous => ({ ...previous, [side]: id as PhysicsIolId }));
    } else if ($simulationMethod === 'acuity' && Object.hasOwn(acuityIols, id)) {
      acuitySelection.update(previous => ({ ...previous, [side]: id as AcuityIolId }));
    }
  }

  function stepDistance(tenths: number) {
    masterDefocus.set(Math.max(-40, Math.min(-10, Math.round($masterDefocus * 10) + tenths)) / 10);
  }
</script>

<svelte:head>
  <title>IOL Vision Simulator</title>
  <meta name="description" content="Compare intraocular lens models on a physically calibrated display using optrace optics." />
</svelte:head>

<svelte:window on:keydown={event => { if (event.key === 'Escape') panel = null; }} />

<div class="app-shell">
  <header class="top-bar">
    <div>
      <h1>IOL Vision Simulator</h1>
      <p>{$simulationMethod === 'physics' ? 'Physics-based (optrace)' : 'Acuity-derived'}</p>
    </div>
    <button class:calibrated={$hasCalibration} class="calibrate" type="button" on:click={openCalibration}>Calibrate</button>
  </header>

  <div class="selectors" class:dual={$splitViewEnabled}>
    <div>
      {#if $splitViewEnabled}<span class="side-label">Left</span>{/if}
      <SheetSelect {options} value={selection.primary} ariaLabel="Primary IOL" title="Primary IOL"
        on:change={event => selectIol('primary', event.detail.value)} />
    </div>
    {#if $splitViewEnabled}
      <div>
        <span class="side-label">Right</span>
        <SheetSelect {options} value={selection.compare} ariaLabel="Comparison IOL" title="Comparison IOL"
          on:change={event => selectIol('compare', event.detail.value)} />
      </div>
    {/if}
  </div>

  <main class="scene-area">
    <IolScene bind:displayedDefocus />
  </main>

  <section class="controls" aria-label="Simulated object distance">
    <div class="distance-heading"><span>Object distance</span><output>{shownDistance} cm</output></div>
    <div class="distance-adjust">
      <button type="button" aria-label="Move simulated object closer by 0.1 D" disabled={$masterDefocus <= -4} on:click={() => stepDistance(-1)}>−</button>
      <input class="range" type="range" aria-label="Holding distance" aria-valuetext={`${Math.round(-100 / $masterDefocus)} cm`}
        min="-4" max="-1" step="0.1" bind:value={$masterDefocus} />
      <button type="button" aria-label="Move simulated object farther by 0.1 D" disabled={$masterDefocus >= -1} on:click={() => stepDistance(1)}>+</button>
    </div>
    <div class="presets" aria-label="Distance presets">
      {#each distances as distance}
        <button type="button" aria-pressed={$masterDefocus === distance.defocus} on:click={() => masterDefocus.set(distance.defocus)}>
          {distance.label} <span>{distance.cm} cm</span>
        </button>
      {/each}
    </div>
  </section>

  <nav class="actions" aria-label="Simulator controls">
    <button type="button" aria-pressed={$splitViewEnabled} on:click={() => splitViewEnabled.update(value => !value)}>Compare</button>
    <button type="button" on:click={() => panel = 'settings'}>Settings</button>
    <button type="button" on:click={() => panel = 'about'}>About</button>
  </nav>
</div>

{#if panel}
  <div class="overlay">
    <button class="backdrop" type="button" aria-label="Close panel" on:click={() => panel = null}></button>
    <section class="panel" role="dialog" aria-modal="true" aria-label={titles[panel]}>
      <header class="panel-header">
        <h2>{titles[panel]}</h2>
        {#if panel === 'calibrate'}
          <button type="button" disabled={calibrationErrors.length > 0} on:click={saveCalibration}>Done</button>
        {:else}
          <button type="button" on:click={() => panel = null}>Done</button>
        {/if}
      </header>
      {#if panel === 'calibrate'}
        <p>Match this line to the short edge of a credit card, then set the distance from your eyes to the screen.</p>
        <div class="card-stage"><div class="card-guide" style:width={`${cardShortEdgePx}px`}></div></div>
        <label for="calibrate-card-size">Match the card edge <span>53.98 mm</span></label>
        <input id="calibrate-card-size" class="range" type="range" min="107" max="420" step="1" bind:value={cardShortEdgePx} />
        <label for="calibrate-viewing-distance">Eye-to-screen distance <span>{Math.round(viewingDraft * 100)} cm</span></label>
        <input id="calibrate-viewing-distance" class="range" type="range" min={MIN_VIEWING_DISTANCE_M} max={MAX_VIEWING_DISTANCE_M}
          step="0.01" bind:value={viewingDraft} />
        {#each calibrationErrors as error}<p class="calibration-error">{error}</p>{/each}
        <p class="note">Keep this distance, avoid browser zoom, and make sure you can focus on the screen. Use consistent brightness and room lighting when comparing lenses.</p>
      {:else if panel === 'settings'}
        <div class="field-title" id="method-label">Simulation Method</div>
        <div class="methods" role="group" aria-labelledby="method-label">
          <button type="button" aria-pressed={$simulationMethod === 'physics'} on:click={() => simulationMethod.set('physics')}>Physics-based (optrace)</button>
          <button type="button" aria-pressed={$simulationMethod === 'acuity'} on:click={() => simulationMethod.set('acuity')}>Acuity-derived</button>
        </div>
        {#if $simulationMethod === 'acuity'}
          <label for="target-refraction-left">{$splitViewEnabled ? 'Left target refraction' : 'Target refraction'} <span>{$targetRefraction.toFixed(2)} D</span></label>
          <input id="target-refraction-left" class="range" type="range" min="-3" max=".5" step=".25" bind:value={$targetRefraction} />
          {#if $splitViewEnabled}
            <label for="target-refraction-right">Right target refraction <span>{$compareTargetRefraction.toFixed(2)} D</span></label>
            <input id="target-refraction-right" class="range" type="range" min="-3" max=".5" step=".25" bind:value={$compareTargetRefraction} />
          {/if}
          <p class="note">The Vivity curve uses legacy samples. Clinical curves for SN60AT and SN60WF are pending.</p>
        {:else}
          <p class="note">Physics-based rendering uses fixed distance-corrected optical models.</p>
        {/if}
      {:else}
        <p>A display-calibrated, interactive simulator that brings optrace optical simulations to ordinary phones and computers.</p>
        <p>Physics-based rendering uses point-spread functions for a 3 mm pupil and an average cornea. Acuity-derived rendering maps clinical defocus curves to equivalent Gaussian blur.</p>
        <p class="note">The illustration compares modeled image formation and provides a research demonstration.</p>
        <div class="papers">
          <a href="https://doi.org/10.1167/tvst.13.8.33" target="_blank" rel="noreferrer">Mendroch et al. · Functional Design Analysis (2024)</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC12758424/" target="_blank" rel="noreferrer">Mendroch et al. · Polychromatic Virtual Retinal Imaging (2025)</a>
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .app-shell{height:100dvh;max-width:1100px;margin:auto;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;background:#fff;color:#172b35}
  .top-bar,.selectors,.controls,.actions{padding-inline:clamp(.65rem,3vw,1.25rem)}
  .top-bar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding-block:.58rem .42rem}
  h1{font-size:clamp(1.05rem,3.7vw,1.5rem);font-weight:750;line-height:1.15;margin:0}
  .top-bar p{font-size:.73rem;color:#526571;margin:.22rem 0 0}
  button{cursor:pointer;color:inherit}
  button:focus-visible,.range:focus-visible{outline:2px solid #116c74;outline-offset:2px}
  button:disabled{cursor:default;opacity:.45}
  .calibrate,.panel-header button{border:1px solid #185c61;border-radius:.6rem;min-height:44px;padding:0 .85rem;background:#185c61;color:#fff;font-size:.81rem;font-weight:650}
  .calibrate.calibrated{background:#eaf4f2;color:#174c51;border-color:#c5dedb}
  .selectors{display:grid;grid-template-columns:minmax(0,1fr);align-items:end;gap:.55rem;min-height:64px;padding-bottom:.4rem}
  .selectors.dual{grid-template-columns:repeat(2,minmax(0,1fr))}
  .selectors>div{min-width:0}
  .side-label{display:block;color:#526571;font-size:.69rem;font-weight:650;margin-bottom:.1rem}
  .scene-area{overflow:hidden;background:#edf0ed}
  .controls{padding-top:.32rem;border-top:1px solid #dce5e6}
  .distance-heading{display:flex;justify-content:space-between;align-items:center;font-size:.8rem;color:#526571;font-weight:600}
  output{font-size:.96rem;color:#172b35;font-variant-numeric:tabular-nums;font-weight:700}
  .distance-adjust{display:grid;grid-template-columns:50px minmax(0,1fr) 50px;gap:.65rem;align-items:center}
  .distance-adjust button{height:50px;border-radius:.65rem;background:#eaf4f2;font-size:1.42rem;font-weight:650;color:#174c51}
  .range{width:100%;height:44px;accent-color:#185c61;margin:0}
  .presets,.actions,.methods{display:grid;gap:.35rem}
  .presets,.actions{grid-template-columns:repeat(3,minmax(0,1fr))}
  .presets button,.actions button,.methods button{min-height:44px;border-radius:.6rem;font-size:.8rem;font-weight:650}
  .presets span{color:#526571;font-weight:500;margin-left:.15rem;white-space:nowrap}
  .actions{padding-bottom:env(safe-area-inset-bottom,0px);border-top:1px solid #dce5e6}
  button[aria-pressed="true"]{background:#eaf4f2;color:#174c51}
  .overlay{position:fixed;inset:0;z-index:60;display:grid;align-items:end;justify-items:center}
  .backdrop{position:absolute;inset:0;background:#13242c80}
  .panel{position:relative;width:min(100%,38rem);max-height:90dvh;overflow:auto;padding:1rem 1rem max(1rem,env(safe-area-inset-bottom));border-radius:1rem 1rem 0 0;background:white;color:#172b35}
  .panel-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}
  .panel h2{font-size:1.15rem;font-weight:750;margin:0}
  .panel p{font-size:.9rem;line-height:1.45;margin:.65rem 0}
  .panel .note{color:#526571;font-size:.81rem}
  .field-title,.panel label{display:flex;justify-content:space-between;font-weight:650;font-size:.84rem;margin:.7rem 0 .2rem}
  .panel label span{color:#526571;font-variant-numeric:tabular-nums}
  .card-stage{display:grid;place-items:center;min-height:50px;overflow:hidden;background:#f1f6f6;border-radius:.55rem}
  .card-guide{height:20px;border:solid #185c61;border-width:0 2px 2px;max-width:none}
  .calibration-error{color:#a22626}
  .methods{grid-template-columns:repeat(2,minmax(0,1fr))}
  .methods button{border:1px solid #cddbdd;padding:.35rem}
  .papers{display:grid;gap:.5rem;font-size:.82rem;color:#185c61}
  .papers a{text-decoration:underline;text-underline-offset:.15em}
  @media(min-width:720px){.panel{border-radius:1rem;margin-bottom:1rem}.scene-area{border-inline:1px solid #dce5e6}}
</style>
