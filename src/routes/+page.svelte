<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import CardCalibration from '../components/CardCalibration.svelte';
  import DistanceStep from '../components/DistanceStep.svelte';
  import IolScene from '../components/IolScene.svelte';
  import SheetSelect from '../components/SheetSelect.svelte';
  import {
    simulationMethod, acuitySelection, physicsSelection, splitViewEnabled, masterDefocus,
    targetRefraction, compareTargetRefraction, primaryAcuity, comparisonAcuity
  } from '../lib/stores/app';
  import { acuityIols, physicsIols, type AcuityIolId, type PhysicsIolId } from '../lib/data/iol-models';
  import { clinicalCurves } from '../lib/data/loader';
  type Panel = 'about' | 'settings' | 'calibrate';
  let panel: Panel | null = null;
  let calibrationSaveDisabled = true;

  const acuityOptions = Object.entries(acuityIols).map(([value, {label}]) => ({value, label}));
  const physicsOptions = Object.entries(physicsIols).map(([value, {label}]) => ({value, label}));
  const introKey = 'iol-simulator-intro-seen';
  const titles = {about: 'IOL Vision Simulator', settings: 'Settings', calibrate: 'Screen calibration'};

  onMount(() => {
    try {
      if (!localStorage.getItem(introKey)) panel = 'about';
    } catch {
      panel = 'about';
    }
  });

  $: options = $simulationMethod === 'physics' ? physicsOptions : acuityOptions;
  $: selection = $simulationMethod === 'physics' ? $physicsSelection : $acuitySelection;

  function closePanel() {
    if (panel === 'about') {
      try { localStorage.setItem(introKey, '1'); } catch { /* Storage can be unavailable. */ }
    }
    panel = null;
  }

  function focusPanelButton(node: HTMLButtonElement) {
    node.focus({ preventScroll: true });
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

<svelte:window on:keydown={event => { if (event.key === 'Escape' && panel) closePanel(); }} />

<div class="app-shell" inert={panel !== null}>
  <header class="top-bar">
    <div class="methods" role="group" aria-label="Simulation method">
      <button type="button" aria-pressed={$simulationMethod === 'physics'} on:click={() => simulationMethod.set('physics')}>Physics-based (optrace)</button>
      <button type="button" aria-pressed={$simulationMethod === 'acuity'} on:click={() => simulationMethod.set('acuity')}>Acuity-derived</button>
    </div>
  </header>

  <div class="selectors" class:dual={$splitViewEnabled}>
    <div>
      <SheetSelect {options} value={selection.primary} label="Primary IOL"
        on:change={event => selectIol('primary', event.detail.value)} />
    </div>
    {#if $splitViewEnabled}
      <div>
        <SheetSelect {options} value={selection.compare} label="Comparison IOL"
          on:change={event => selectIol('compare', event.detail.value)} />
      </div>
    {/if}
  </div>

  <main class="scene-area">
    <IolScene />
  </main>

  <section class="controls" aria-label="Simulated object distance">
    <div class="distance-adjust">
      <DistanceStep direction={-1} disabled={panel !== null || $masterDefocus <= -4} step={stepDistance} />
      <input class="range object-slider" type="range" aria-label="Object distance" aria-valuetext={`${Math.round(-100 / $masterDefocus)} cm`}
        min="-4" max="-1" step="0.1" bind:value={$masterDefocus} />
      <DistanceStep direction={1} disabled={panel !== null || $masterDefocus >= -1} step={stepDistance} />
    </div>
  </section>

  <nav class="actions" aria-label="Simulator controls">
    <button type="button" on:click={() => panel = 'calibrate'}>Calibrate</button>
    <button type="button" aria-pressed={$splitViewEnabled} on:click={() => splitViewEnabled.update(value => !value)}>Compare</button>
    <button type="button" on:click={() => panel = 'settings'}>Settings</button>
  </nav>
</div>

{#if panel}
  {#key panel}
  <div class="overlay">
    <button class="backdrop" type="button" tabindex="-1" aria-label="Close panel" on:click={closePanel}></button>
    <section class="panel" role="dialog" aria-modal="true" aria-label={titles[panel]}>
      <header class="panel-header">
        <h2>{titles[panel]}</h2>
        {#if panel === 'calibrate'}
          <button type="submit" form="screen-calibration" disabled={calibrationSaveDisabled}>Done</button>
        {:else}
          <button type="button" use:focusPanelButton on:click={closePanel}>{panel === 'about' ? 'Start' : 'Done'}</button>
        {/if}
      </header>
      {#if panel === 'calibrate'}
        <CardCalibration bind:saveDisabled={calibrationSaveDisabled} onSaved={closePanel} />
      {:else if panel === 'settings'}
        {#if $simulationMethod === 'acuity'}
          <label for="target-refraction-left">{$splitViewEnabled ? 'Left target refraction' : 'Target refraction'} <span>{$targetRefraction.toFixed(2)} D</span></label>
          <input id="target-refraction-left" class="range" type="range" min="-3" max=".5" step=".25" bind:value={$targetRefraction} />
          {#if $splitViewEnabled}
            <label for="target-refraction-right">Right target refraction <span>{$compareTargetRefraction.toFixed(2)} D</span></label>
            <input id="target-refraction-right" class="range" type="range" min="-3" max=".5" step=".25" bind:value={$compareTargetRefraction} />
          {/if}
          <p class="note">Distance-corrected cohort means. Near-range extrapolations are labelled on the image.</p>
          <div class="papers">
            {#each [$primaryAcuity.curve, $splitViewEnabled ? $comparisonAcuity.curve : undefined] as curve, i}
              {#if curve && (i === 0 || curve !== $primaryAcuity.curve)}
                <a href={curve.source.url} target="_blank" rel="noreferrer">{curve.model} · {curve.source.figure} · n={curve.source.subjects}</a>
              {/if}
            {/each}
          </div>
        {:else}
          <p class="note">Physics-based rendering uses fixed distance-corrected optical models.</p>
        {/if}
        <a class="about-link" href={`${base}/acuity-calibration/`}>Gaussian / Acuity Calibration</a>
        <button type="button" class="about-link" on:click={() => panel = 'about'}>About the simulation</button>
      {:else}
        <p>Compare how intraocular lenses render near objects and distant scenes on a calibrated screen.</p>
        <p><strong>Physics-based</strong> uses geometric ray tracing through models of the eye and implanted lens to simulate retinal images. It draws on the open-source optrace project and its published research.</p>
        <div class="papers">
          <a href="https://github.com/drocheam/optrace" target="_blank" rel="noreferrer">optrace · Open-source ray tracer</a>
          <a href="https://doi.org/10.1167/tvst.13.8.33" target="_blank" rel="noreferrer">Mendroch et al. · Functional Design Analysis (2024)</a>
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC12758424/" target="_blank" rel="noreferrer">Mendroch et al. · Polychromatic Virtual Retinal Imaging (2025)</a>
        </div>
        <p><strong>Acuity-derived</strong> estimates visual acuity at each object distance from clinical defocus curves for commercial IOLs. It converts acuity to equivalent on-screen blur using Gaussian calibration informed by Leung et al. (2026) and this project's initial Landolt C measurements.</p>
        <div class="papers">
          <a href="https://doi.org/10.1080/10447318.2026.2664698" target="_blank" rel="noreferrer">Leung et al. · Screen-Based Acuity Loss Simulation (2026)</a>
          {#each clinicalCurves as curve}
            <a href={curve.source.url} target="_blank" rel="noreferrer">{curve.model} · FDA {curve.source.figure} · n={curve.source.subjects}</a>
          {/each}
        </div>
        <p class="note">Tap Calibrate with a credit card ready. Choose a lens, adjust the object distance, then tap Compare for a split view.</p>
      {/if}
    </section>
  </div>
  {/key}
{/if}

<style>
  .app-shell,.overlay{--ink:#172b35;--muted:#526571;--line:#e2e8f0;--accent:#1d4ed8;--active:#dbeafe}
  .app-shell{height:100dvh;max-width:1100px;margin:auto;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;background:#fff;color:var(--ink)}
  .top-bar,.selectors,.controls,.actions{padding-inline:clamp(.65rem,3vw,1.25rem)}
  .top-bar{padding-block:calc(env(safe-area-inset-top,0px) + .32rem) .24rem}
  .methods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.2rem;padding:.16rem;border:1px solid var(--line);border-radius:.65rem;background:#f8fafc}
  .methods button{min-height:44px;border-radius:.52rem;font-size:.82rem;font-weight:650;padding-inline:.2rem;line-height:1.15}
  .methods button,.actions button{touch-action:manipulation}
  button{cursor:pointer;color:inherit}
  button:focus-visible,.range:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
  button:disabled{cursor:default;opacity:.45}
  .panel-header button{border-radius:.55rem;min-height:44px;padding:0 .85rem;background:#172b35;color:#fff;font-size:.81rem;font-weight:650}
  .selectors{display:grid;grid-template-columns:minmax(0,1fr);align-items:end;gap:.42rem;padding-block:.12rem .38rem}
  .selectors.dual{grid-template-columns:repeat(2,minmax(0,1fr))}
  .selectors>div{min-width:0}
  .scene-area{overflow:hidden;background:#edf0ed}
  .controls{padding-block:.18rem .26rem;border-top:1px solid var(--line)}
  .distance-adjust{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;gap:.62rem;align-items:center}
  .range{width:100%;height:44px;accent-color:var(--accent);margin:0}
  .object-slider {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
  }
  .object-slider::-webkit-slider-runnable-track {
    height: .32rem;
    border-radius: 999px;
    background: #d1d5db;
  }
  .object-slider::-moz-range-track {
    height: .32rem;
    border-radius: 999px;
    background: #d1d5db;
  }
  .object-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 2rem;
    height: 2rem;
    margin-top: -.84rem;
    border: 2px solid white;
    border-radius: 50%;
    background: #2563eb;
    box-shadow: 0 2px 6px #2563eb59;
  }
  .object-slider::-moz-range-thumb {
    box-sizing: border-box;
    width: 2rem;
    height: 2rem;
    border: 2px solid white;
    border-radius: 50%;
    background: #2563eb;
    box-shadow: 0 2px 6px #2563eb59;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: .25rem;
    padding-block: .2rem calc(env(safe-area-inset-bottom, 0px) + .25rem);
    border-top: 1px solid var(--line);
  }
  .actions button {
    min-height: 3.35rem;
    border-radius: .7rem;
    font-size: .9rem;
    font-weight: 600;
  }
  button[aria-pressed="true"]{background:var(--active);color:var(--accent)}
  .overlay{position:fixed;inset:0;z-index:60;display:grid;align-items:end;justify-items:center}
  .backdrop{position:absolute;inset:0;background:#13242c80}
  .panel{position:relative;width:min(100%,38rem);max-height:90dvh;overflow:auto;padding:1rem 1rem max(1rem,env(safe-area-inset-bottom));border-radius:1rem 1rem 0 0;background:white;color:var(--ink)}
  .panel-header{display:flex;align-items:center;justify-content:space-between;gap:1rem}
  .panel h2{font-size:1.15rem;font-weight:750;margin:0}
  .panel p{font-size:.9rem;line-height:1.45;margin:.65rem 0}
  .panel .note{color:var(--muted);font-size:.81rem}
  .panel label{display:flex;justify-content:space-between;font-weight:650;font-size:.84rem;margin:.7rem 0 .2rem}
  .panel label span{color:var(--muted);font-variant-numeric:tabular-nums}
  .papers{display:grid;gap:.5rem;font-size:.82rem;color:var(--accent)}
  .papers a,.about-link{text-decoration:underline;text-underline-offset:.15em}
  .about-link{display:flex;align-items:center;min-height:44px;font-size:.82rem;color:var(--accent)}
  @media(min-width:720px){.panel{border-radius:1rem;margin-bottom:1rem}.scene-area{border-inline:1px solid var(--line)}}
</style>
