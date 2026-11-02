<script lang="ts">
  import { onDestroy } from 'svelte';
  import ImageCanvas from '../components/ImageCanvas.svelte';
  import SheetSelect from '../components/SheetSelect.svelte';
  import {
    simulationMode,
    selectedLensId,
    selectedCompareLensId,
    presbyopiaProfile,
    presbyopiaCompareProfile,
    splitViewEnabled,
    iolCurves,
    masterDefocus,
    targetRefraction,
    compareTargetRefraction,
    accommodationCapacity,
    nsGrade,
    pscRadius,
    pscDensity,
    cssPxPerMmCal,
    calibrationScale,
    currentViewportScale,
    effectiveCssPxPerMm,
    viewingDistance,
    calibrationApplied,
    calibrationVersion,
    displayImageMode,
    DEFAULT_MASTER_DEFOCUS_D,
    applyPresbyopiaProfile,
    resetCataractState,
    type SimulationMode,
    type PresbyopiaProfile
  } from '../lib/stores/app';
  import { calculateAccommodationFromAge } from '../lib/optics/formulas';
  import {
    DEFAULT_CSS_PX_PER_MM,
    MIN_VIEWING_DISTANCE_M,
    MAX_VIEWING_DISTANCE_M,
    calculatePPIFromPixelsPerMillimeter,
    calculatePixelsPerMillimeterFromPPI,
    calculateCssPixelsPerMillimeterFromCreditCardShortEdge,
    calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter,
    validateDisplayParams
  } from '../lib/optics/calibration';

  type Panel = 'landing' | 'settings' | 'calibrate' | null;
  type ActionPanel = 'settings' | 'calibrate';
  type SelectOption = { value: string; label: string };
  const ALLOWED_PRESBYOPIA_PROFILES: PresbyopiaProfile[] = ['presbyopia', 'normal'];
  const PRESBYOPIA_DEFAULT_AGE = 60;
  const PRESBYOPIA_DEFAULT_ACCOMMODATION_D = 0.5;
  const TARGET_REFRACTION_MIN_D = -3.0;
  const TARGET_REFRACTION_MAX_D = 0.5;
  const CARD_MATCH_MIN_PPI = 50;
  const CARD_MATCH_MAX_PX = 420;
  const CARD_MATCH_MIN_PX = Math.ceil(
    calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter(
      calculatePixelsPerMillimeterFromPPI(CARD_MATCH_MIN_PPI)
    )
  );
  const LANDING_SHEET_TITLE = 'IOL Vision Simulator';
  const LANDING_DISCLAIMER_LINES = [
    'Demo only. Visual acuity, blur, and cataract effects are illustrative.',
    'No claims regarding product performance, comparative efficacy, or individual outcomes.'
  ] as const;
  const LANDING_BEFORE_START_ITEMS = [
    'Calibrate display with a credit card.',
    'Measure and set eye to screen distance.',
    'Do not zoom after calibration.'
  ] as const;
  const LANDING_USAGE_ITEMS = [
    {
      title: 'Set Defocus with Slider',
      detail: 'See near 📖 & far 🌳.'
    },
    {
      title: 'Compare Lenses',
      detail: 'Tap Compare for side-by-side view.'
    },
    {
      title: 'Try Presbyopia / Cataract',
      detail: 'Explore conditions in settings.'
    }
  ] as const;
  const LANDING_REFERENCE_GROUPS = [
    {
      lenses: '1-piece Monofocal (TECNIS ZCB00)',
      citation: 'Corbett D, Black D, Roberts TV, et al. Quality of vision clinical outcomes for a new fully-refractive extended depth of focus Intraocular Lens. Eye (Lond). 2024;38(Suppl 1):9-14. doi:10.1038/s41433-024-03039-8'
    },
    {
      lenses: 'enVista Monofocal, AcrySof IQ Vivity',
      citation: "Pantanelli SM, O'Rourke T, Bolognia O, Scruggs K, Longenecker A, Lehman E. Vision and patient-reported outcomes with nondiffractive EDOF or neutral aspheric monofocal intraocular lenses. J Cataract Refract Surg. 2023;49(4):360-366. doi:10.1097/j.jcrs.0000000000001123"
    }
  ] as const;

  let activePanel: Panel = 'landing';
  let patientAge = PRESBYOPIA_DEFAULT_AGE;

  let cardShortEdgePx = 180;
  let calibratedPPI = 110;
  let calibratedCssPxPerMm = DEFAULT_CSS_PX_PER_MM;
  let calibrationErrors: string[] = [];
  let mainDefocusSliderValue = DEFAULT_MASTER_DEFOCUS_D;
  let pendingMainDefocusValue: number | null = null;
  let mainDefocusRaf: number | null = null;
  let isMainDefocusDragging = false;

  const presbyopiaProfileOptions: SelectOption[] = [
    { value: 'presbyopia', label: 'Presbyopia' },
    { value: 'normal', label: 'Normal' }
  ];

  $: calibratedCssPxPerMm = calculateCssPixelsPerMillimeterFromCreditCardShortEdge(cardShortEdgePx);
  $: calibratedPPI = calculatePPIFromPixelsPerMillimeter(calibratedCssPxPerMm);
  $: calibrationErrors = validateDisplayParams($viewingDistance, calibratedPPI).errors;
  $: if (!isMainDefocusDragging) {
    mainDefocusSliderValue = $masterDefocus;
  }
  $: if ($simulationMode === 'Presbyopia' && !ALLOWED_PRESBYOPIA_PROFILES.includes($presbyopiaProfile)) {
    applyPresbyopiaProfile('presbyopia');
  }
  $: if ($simulationMode === 'Presbyopia' && !ALLOWED_PRESBYOPIA_PROFILES.includes($presbyopiaCompareProfile)) {
    presbyopiaCompareProfile.set('normal');
  }
  $: iolOptions = $iolCurves.map((lens) => ({ value: lens.id, label: lens.label }));
  $: targetRefractionLabel = formatTargetRefractionLabel($targetRefraction);
  $: targetRefractionLeftLabel = formatTargetRefractionLabel($targetRefraction);
  $: targetRefractionRightLabel = formatTargetRefractionLabel($compareTargetRefraction);
  $: panelTitle = activePanel === 'landing'
    ? LANDING_SHEET_TITLE
    : activePanel === 'settings'
      ? 'Settings'
      : 'Calibrate';

  function formatTargetRefractionLabel(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)} D`;
  }

  function setMode(mode: SimulationMode): void {
    if ($simulationMode === mode) {
      return;
    }

    simulationMode.set(mode);

    if (mode === 'Presbyopia') {
      patientAge = PRESBYOPIA_DEFAULT_AGE;
      targetRefraction.set(0);
      compareTargetRefraction.set(0);
      applyPresbyopiaProfile('presbyopia');
      presbyopiaCompareProfile.set('normal');
      accommodationCapacity.set(PRESBYOPIA_DEFAULT_ACCOMMODATION_D);
      return;
    }

    resetCataractState();
  }

  function toggleCompare(): void {
    splitViewEnabled.update((enabled) => !enabled);
  }

  function togglePanel(panel: ActionPanel): void {
    const next = activePanel === panel ? null : panel;

    if (next === 'calibrate') {
      const currentMatch = calculateCreditCardShortEdgePixelsFromCssPixelsPerMillimeter($effectiveCssPxPerMm);
      cardShortEdgePx = Math.min(CARD_MATCH_MAX_PX, Math.max(CARD_MATCH_MIN_PX, currentMatch));
    }

    activePanel = next;
  }

  function closePanel(): void {
    if (activePanel === 'calibrate') {
      persistCalibration();
    }
    activePanel = null;
  }

  function updateAge(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    patientAge = value;
    accommodationCapacity.set(calculateAccommodationFromAge(value));
  }

  function updateAccommodation(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    accommodationCapacity.set(value);
  }

  function getTargetRefractionFromInput(event: Event): number | null {
    const rawValue = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(rawValue)) {
      return null;
    }

    return Math.min(TARGET_REFRACTION_MAX_D, Math.max(TARGET_REFRACTION_MIN_D, rawValue));
  }

  function onTargetRefractionInput(event: Event): void {
    const clampedValue = getTargetRefractionFromInput(event);
    if (clampedValue === null) {
      return;
    }

    targetRefraction.set(clampedValue);
  }

  function onCompareTargetRefractionInput(event: Event): void {
    const clampedValue = getTargetRefractionFromInput(event);
    if (clampedValue === null) {
      return;
    }

    compareTargetRefraction.set(clampedValue);
  }

  function handlePrimaryLensChange(event: CustomEvent<{ value: string }>): void {
    selectedLensId.set(event.detail.value);
  }

  function handleCompareLensChange(event: CustomEvent<{ value: string }>): void {
    selectedCompareLensId.set(event.detail.value);
  }

  function handlePrimaryPresbyopiaProfileChange(event: CustomEvent<{ value: string }>): void {
    applyPresbyopiaProfile(event.detail.value as PresbyopiaProfile);
  }

  function handleComparePresbyopiaProfileChange(event: CustomEvent<{ value: string }>): void {
    presbyopiaCompareProfile.set(event.detail.value as PresbyopiaProfile);
  }

  function persistCalibration(): void {
    if (calibrationErrors.length > 0) {
      return;
    }

    const viewportScale = typeof window !== 'undefined'
      ? (window.visualViewport?.scale ?? 1)
      : 1;
    cssPxPerMmCal.set(calibratedCssPxPerMm);
    calibrationScale.set(viewportScale);
    currentViewportScale.set(viewportScale);
    calibrationApplied.set(true);
    calibrationVersion.update((version) => version + 1);
  }

  function scheduleMainDefocusUpdate(nextValue: number): void {
    pendingMainDefocusValue = nextValue;
    if (mainDefocusRaf !== null) {
      return;
    }

    mainDefocusRaf = requestAnimationFrame(() => {
      mainDefocusRaf = null;
      if (pendingMainDefocusValue === null) {
        return;
      }

      const value = pendingMainDefocusValue;
      pendingMainDefocusValue = null;
      masterDefocus.set(value);
    });
  }

  function onMainDefocusInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) {
      return;
    }

    mainDefocusSliderValue = value;
    scheduleMainDefocusUpdate(value);
  }

  function onMainDefocusDragStart(): void {
    isMainDefocusDragging = true;
  }

  function flushMainDefocusUpdate(): void {
    isMainDefocusDragging = false;

    if (pendingMainDefocusValue === null) {
      return;
    }

    const value = pendingMainDefocusValue;
    pendingMainDefocusValue = null;

    if (mainDefocusRaf !== null) {
      cancelAnimationFrame(mainDefocusRaf);
      mainDefocusRaf = null;
    }

    masterDefocus.set(value);
  }

  onDestroy(() => {
    if (mainDefocusRaf !== null) {
      cancelAnimationFrame(mainDefocusRaf);
      mainDefocusRaf = null;
    }
  });
</script>

<svelte:head>
  <title>IOL Vision Simulator</title>
  <meta name="description" content="Phone-first IOL vision simulation" />
</svelte:head>

<div class="app-shell">
  <header class="top-bar">
    <div class="mode-tabs" role="tablist" aria-label="Simulation mode">
      <button
        role="tab"
        aria-selected={$simulationMode === 'IOL'}
        class:active={$simulationMode === 'IOL'}
        on:click={() => setMode('IOL')}
      >
        IOL
      </button>
      <button
        role="tab"
        aria-selected={$simulationMode === 'Presbyopia'}
        class:active={$simulationMode === 'Presbyopia'}
        on:click={() => setMode('Presbyopia')}
      >
        Presbyopia
      </button>
    </div>

    {#if $simulationMode === 'IOL'}
      <div class="selector-row {$splitViewEnabled ? 'dual' : 'single'}">
        <SheetSelect
          options={iolOptions}
          value={$selectedLensId}
          ariaLabel="Primary IOL"
          title="Select primary IOL"
          on:change={handlePrimaryLensChange}
        />
        {#if $splitViewEnabled}
          <SheetSelect
            options={iolOptions}
            value={$selectedCompareLensId}
            ariaLabel="Comparison IOL"
            title="Select comparison IOL"
            on:change={handleCompareLensChange}
          />
        {/if}
      </div>
    {:else}
      <div class="selector-row {$splitViewEnabled ? 'dual' : 'single'}">
        <SheetSelect
          options={presbyopiaProfileOptions}
          value={$presbyopiaProfile}
          ariaLabel="Primary Presbyopia mode"
          title="Select primary mode"
          on:change={handlePrimaryPresbyopiaProfileChange}
        />
        {#if $splitViewEnabled}
          <SheetSelect
            options={presbyopiaProfileOptions}
            value={$presbyopiaCompareProfile}
            ariaLabel="Comparison Presbyopia mode"
            title="Select comparison mode"
            on:change={handleComparePresbyopiaProfileChange}
          />
        {/if}
      </div>
    {/if}
  </header>

  <main class="canvas-area">
    <ImageCanvas />
  </main>

  <section class="viewing-strip">
    <input
      class="viewing-slider range-input"
      type="range"
      min="-4.0"
      max="-1.0"
      step="0.1"
      value={mainDefocusSliderValue}
      aria-label="Holding distance"
      on:input={onMainDefocusInput}
      on:change={flushMainDefocusUpdate}
      on:pointerdown={onMainDefocusDragStart}
      on:pointerup={flushMainDefocusUpdate}
      on:pointercancel={flushMainDefocusUpdate}
      on:touchstart={onMainDefocusDragStart}
      on:touchend={flushMainDefocusUpdate}
    />
  </section>

  <nav class="bottom-nav" aria-label="Bottom navigation">
    <button
      class:active={$splitViewEnabled}
      on:click={toggleCompare}
      aria-pressed={$splitViewEnabled}
    >
      Compare
    </button>
    <button class:active={activePanel === 'settings'} on:click={() => togglePanel('settings')}>Settings</button>
    <button class:active={activePanel === 'calibrate'} on:click={() => togglePanel('calibrate')}>Calibrate</button>
  </nav>

  {#if activePanel}
    <div class="panel-overlay" role="dialog" aria-modal="true">
      <button class="panel-backdrop" type="button" aria-label="Close panel" on:click={closePanel}></button>
      <section class="panel-surface">
        <div class="sheet-grip" aria-hidden="true"></div>

        <header class="panel-header">
          <h2>{panelTitle}</h2>
          <button on:click={closePanel}>Done</button>
        </header>

        <div class="panel-body">
          {#if activePanel === 'landing'}
            <div class="landing-content">
              <div class="settings-section">
                <h3 class="section-title">Disclaimer</h3>
                <p class="landing-disclaimer">
                  {LANDING_DISCLAIMER_LINES[0]}<br />
                  {LANDING_DISCLAIMER_LINES[1]}
                </p>
              </div>

              <div class="settings-section">
                <h3 class="section-title">Before You Start</h3>
                <ul class="landing-list">
                  {#each LANDING_BEFORE_START_ITEMS as item}
                    <li>{item}</li>
                  {/each}
                </ul>
              </div>

              <div class="settings-section">
                <h3 class="section-title">How to use</h3>
                <ul class="landing-list">
                  {#each LANDING_USAGE_ITEMS as item}
                    <li><strong>{item.title}:</strong> <br>{item.detail}</li>
                  {/each}
                </ul>
              </div>

              <div class="settings-section">
                <h3 class="section-title">Defocus Curve Source</h3>
                <ul class="landing-reference-list">
                  {#each LANDING_REFERENCE_GROUPS as group}
                    <li>
                      <strong>{group.lenses}</strong>
                      <br />
                      {group.citation}
                    </li>
                  {/each}
                </ul>
              </div>
            </div>
          {/if}

          {#if activePanel === 'settings'}
            <div class="settings-section">
              <h3 class="section-title">Image</h3>
              <div class="segmented-control" role="radiogroup" aria-label="Display image">
                <button
                  type="button"
                  class:active={$displayImageMode === 'letters'}
                  aria-pressed={$displayImageMode === 'letters'}
                  on:click={() => ($displayImageMode = 'letters')}
                >
                  Eye Chart
                </button>
                <button
                  type="button"
                  class:active={$displayImageMode === 'book'}
                  aria-pressed={$displayImageMode === 'book'}
                  on:click={() => ($displayImageMode = 'book')}
                >
                  Book
                </button>
              </div>
            </div>

            {#if $simulationMode === 'IOL'}
              <div class="settings-section">
                <h3 class="section-title">Vision</h3>
                {#if $splitViewEnabled}
                  <div class="control-block">
                    <div class="control-header">
                      <label for="target-refraction-left">Target refraction (left)</label>
                      <span class="control-value">{targetRefractionLeftLabel}</span>
                    </div>
                    <input
                      id="target-refraction-left"
                      class="range-input"
                      type="range"
                      min={TARGET_REFRACTION_MIN_D}
                      max={TARGET_REFRACTION_MAX_D}
                      step="0.25"
                      value={$targetRefraction}
                      on:input={onTargetRefractionInput}
                    />
                  </div>
                  <div class="control-block">
                    <div class="control-header">
                      <label for="target-refraction-right">Target refraction (right)</label>
                      <span class="control-value">{targetRefractionRightLabel}</span>
                    </div>
                    <input
                      id="target-refraction-right"
                      class="range-input"
                      type="range"
                      min={TARGET_REFRACTION_MIN_D}
                      max={TARGET_REFRACTION_MAX_D}
                      step="0.25"
                      value={$compareTargetRefraction}
                      on:input={onCompareTargetRefractionInput}
                    />
                  </div>
                {:else}
                  <div class="control-block">
                    <div class="control-header">
                      <label for="target-refraction">Target Refraction</label>
                      <span class="control-value">{targetRefractionLabel}</span>
                    </div>
                    <input
                      id="target-refraction"
                      class="range-input"
                      type="range"
                      min={TARGET_REFRACTION_MIN_D}
                      max={TARGET_REFRACTION_MAX_D}
                      step="0.25"
                      value={$targetRefraction}
                      on:input={onTargetRefractionInput}
                    />
                  </div>
                {/if}
              </div>
            {:else}
              <div class="settings-section">
                <h3 class="section-title">Vision</h3>
                <div class="control-block">
                  <div class="control-header">
                    <label for="patient-age">Patient Age</label>
                    <span class="control-value">{patientAge.toFixed(0)} y</span>
                  </div>
                  <p class="control-helper">Accommodation capacity<br />= 18.5 - 0.30 x age (D)</p>
                  <input id="patient-age" class="range-input" type="range" min="0" max="100" step="1" value={patientAge} on:input={updateAge} />
                </div>

                <div class="control-block">
                  <div class="control-header">
                    <label for="accommodation-capacity">Accommodation</label>
                    <span class="control-value">{$accommodationCapacity.toFixed(1)} D</span>
                  </div>
                  <input id="accommodation-capacity" class="range-input" type="range" min="0" max="4.0" step="0.1" value={$accommodationCapacity} on:input={updateAccommodation} />
                </div>
              </div>

              <div class="settings-section">
                <h3 class="section-title">Cataract</h3>
                <div class="control-block">
                  <div class="control-header">
                    <label for="ns-grade">Nuclear Sclerosis</label>
                    <span class="control-value">{$nsGrade.toFixed(1)}</span>
                  </div>
                  <p class="control-helper">Lens yellowing/haze</p>
                  <input id="ns-grade" class="range-input" type="range" min="0" max="4" step="0.1" bind:value={$nsGrade} />
                </div>
                <div class="control-block">
                  <div class="control-header">
                    <label for="psc-radius">PSC Radius</label>
                    <span class="control-value">{($pscRadius * 100).toFixed(0)}%</span>
                  </div>
                  <p class="control-helper">Central back-of-lens opacity</p>
                  <input id="psc-radius" class="range-input" type="range" min="0" max="0.5" step="0.01" bind:value={$pscRadius} />
                </div>
                <div class="control-block">
                  <div class="control-header">
                    <label for="psc-density">PSC Density</label>
                    <span class="control-value">{($pscDensity * 100).toFixed(0)}%</span>
                  </div>
                  <input id="psc-density" class="range-input" type="range" min="0" max="1.0" step="0.05" bind:value={$pscDensity} />
                </div>
              </div>
            {/if}
          {/if}

          {#if activePanel === 'calibrate'}
            <div class="calibration-view">
              <p class="calibration-instruction">
                Match your credit card short edge to the line for best results.
              </p>

              <div class="card-stage" aria-hidden="true">
                <div class="short-edge-guide" style="width: {cardShortEdgePx}px;">
                  <div class="short-edge-line"></div>
                </div>
              </div>

              <div class="control-block">
                <div class="control-header">
                  <label for="calibrate-card-size">Card Match</label>
                  <span class="control-value">{calibratedCssPxPerMm.toFixed(2)} px/mm</span>
                </div>
                <input
                  id="calibrate-card-size"
                  class="range-input"
                  type="range"
                  min={CARD_MATCH_MIN_PX}
                  max={CARD_MATCH_MAX_PX}
                  step="0.5"
                  bind:value={cardShortEdgePx}
                />
              </div>

              <div class="control-block">
                <div class="control-header">
                  <label for="calibrate-viewing-distance">Viewing Distance</label>
                  <span class="control-value">{($viewingDistance * 100).toFixed(0)} cm</span>
                </div>
                <input
                  id="calibrate-viewing-distance"
                  class="range-input"
                  type="range"
                  min={MIN_VIEWING_DISTANCE_M}
                  max={MAX_VIEWING_DISTANCE_M}
                  step="0.01"
                  bind:value={$viewingDistance}
                />
              </div>
            </div>
          {/if}
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f3f4f6;
  }

  .app-shell {
    height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    overflow: hidden;
    background: #f3f4f6;
  }

  .top-bar {
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
    padding: calc(env(safe-area-inset-top, 0px) + 0.45rem) 0.65rem 0.5rem;
  }

  .mode-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.2rem;
    padding: 0.2rem;
    border-radius: 0.65rem;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
  }

  .mode-tabs button {
    border: 0;
    background: transparent;
    min-height: 2.35rem;
    border-radius: 0.52rem;
    color: #374151;
    font-size: 0.88rem;
    font-weight: 600;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .mode-tabs button.active {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .mode-tabs button:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }

  .selector-row {
    margin-top: 0.5rem;
    display: grid;
    gap: 0.45rem;
  }

  .selector-row.single {
    grid-template-columns: 1fr;
  }

  .selector-row.dual {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .canvas-area {
    overflow: auto;
    background: #111827;
  }

  .viewing-strip {
    background: #ffffff;
    border-top: 1px solid #e5e7eb;
    padding: 0.5rem 0.65rem 0.42rem;
  }

  .viewing-slider {
    width: 100%;
    margin: 0;
  }

  .bottom-nav {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-top: 1px solid #e5e7eb;
    box-shadow: 0 -4px 14px rgba(15, 23, 42, 0.08);
    background: #ffffff;
    padding: 0.2rem 0.35rem calc(env(safe-area-inset-bottom, 16px) + 0.25rem);
    gap: 0.25rem;
  }

  .bottom-nav button {
    border: 0;
    border-radius: 0.7rem;
    background: transparent;
    min-height: 3.35rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: #374151;
  }

  .bottom-nav button.active {
    color: #1d4ed8;
    background: #eff6ff;
  }

  .panel-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(17, 24, 39, 0.32);
    display: flex;
    align-items: flex-end;
  }

  .panel-backdrop {
    position: absolute;
    inset: 0;
    z-index: 0;
    border: 0;
    background: transparent;
  }

  .panel-surface {
    position: relative;
    z-index: 1;
    width: 100%;
    height: min(78dvh, calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem));
    background: #ffffff;
    display: grid;
    grid-template-rows: auto auto 1fr;
    border-radius: 1rem 1rem 0 0;
    box-shadow: 0 -8px 28px rgba(15, 23, 42, 0.18);
    animation: settings-sheet-up 160ms ease-out;
    overflow: hidden;
  }

  .sheet-grip {
    width: 2.2rem;
    height: 0.25rem;
    border-radius: 999px;
    background: #d1d5db;
    margin: 0.45rem auto 0;
  }

  .panel-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.8rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
    background: #ffffff;
  }

  .panel-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: #111827;
  }

  .panel-header button {
    border: 0;
    background: #111827;
    color: #ffffff;
    border-radius: 0.55rem;
    min-height: 2.1rem;
    padding: 0.35rem 0.72rem;
    font-size: 0.78rem;
    font-weight: 600;
  }

  .panel-body {
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 0.8rem 0.85rem calc(env(safe-area-inset-bottom, 16px) + 1.1rem);
  }

  .settings-section {
    margin: 0;
  }

  .settings-section + .settings-section {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
  }

  .section-title {
    margin: 0 0 0.55rem;
    font-size: 0.90rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #6b7280;
    font-weight: 700;
  }

  .landing-content {
    display: grid;
    gap: 0.82rem;
  }

  .landing-disclaimer {
    margin: 0;
    font-size: 1.00rem;
    line-height: 1.35;
    color: #1f2937;
  }

  .landing-list {
    margin: 0;
    padding-left: 1.05rem;
    list-style-type: disc;
    list-style-position: outside;
    font-size: 1.00rem;
    line-height: 1.35;
    color: #1f2937;
  }

  .landing-list li + li {
    margin-top: 0.36rem;
  }

  .landing-list strong {
    color: #111827;
    font-weight: 600;
  }

  .landing-reference-list {
    margin: 0;
    padding-left: 1.05rem;
    list-style-type: disc;
    list-style-position: outside;
    font-size: 0.7rem;
    line-height: 1.4;
    color: #1f2937;
  }

  .landing-reference-list li + li {
    margin-top: 0.32rem;
  }

  .segmented-control {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.2rem;
    padding: 0.2rem;
    border-radius: 999px;
    border: 1px solid #d1d5db;
    background: #f9fafb;
  }

  .segmented-control button {
    border: 0;
    border-radius: 999px;
    min-height: 2.5rem;
    background: transparent;
    color: #374151;
    font-size: 0.84rem;
    font-weight: 600;
  }

  .segmented-control button.active {
    background: #2563eb;
    color: #ffffff;
  }

  .control-block {
    margin-bottom: 0.72rem;
  }

  .control-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    margin-bottom: 0.22rem;
  }

  .control-header label {
    font-size: 0.82rem;
    color: #111827;
    font-weight: 600;
  }

  .control-value {
    font-size: 0.8rem;
    color: #374151;
    font-weight: 600;
    text-align: right;
  }

  .control-helper {
    margin: 0 0 0.32rem;
    font-size: 0.72rem;
    color: #6b7280;
    line-height: 1.25;
  }

  .range-input {
    width: 100%;
    margin: 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    height: 1.85rem;
  }

  .range-input:focus {
    outline: none;
  }

  .range-input::-webkit-slider-runnable-track {
    height: 0.32rem;
    border-radius: 999px;
    background: #d1d5db;
  }

  .range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 2.0rem;
    height: 2.0rem;
    border-radius: 999px;
    margin-top: -0.69rem;
    border: 2px solid #ffffff;
    background: #2563eb;
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
  }

  .range-input::-moz-range-track {
    height: 0.32rem;
    border: 0;
    border-radius: 999px;
    background: #d1d5db;
  }

  .range-input::-moz-range-thumb {
    width: 2.0rem;
    height: 2.0rem;
    border-radius: 999px;
    border: 2px solid #ffffff;
    background: #2563eb;
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
  }

  .calibration-view {
    min-height: 0;
    display: grid;
    gap: 0.6rem;
  }

  .calibration-instruction {
    margin: 0;
    font-size: 0.78rem;
    color: #1f2937;
    line-height: 1.3;
  }

  .card-stage {
    min-height: 4.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #e5e7eb;
    border-radius: 0.65rem;
    background: #f9fafb;
    overflow: hidden;
  }

  .short-edge-guide {
    position: relative;
    height: 2px;
  }

  .short-edge-line {
    position: absolute;
    inset: 0;
    height: 2px;
    background: #111827;
    border-radius: 999px;
  }

  @keyframes settings-sheet-up {
    from {
      transform: translateY(14px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
