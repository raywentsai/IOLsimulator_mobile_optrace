<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface SheetSelectOption {
    value: string;
    label: string;
  }

  export let options: SheetSelectOption[] = [];
  export let value = '';
  export let ariaLabel = 'Select option';
  export let title = 'Select option';
  export let disabled = false;

  const dispatch = createEventDispatcher<{ change: { value: string } }>();
  let open = false;

  $: selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  function openSheet(): void {
    if (disabled) {
      return;
    }
    open = true;
  }

  function closeSheet(): void {
    open = false;
  }

  function chooseOption(nextValue: string): void {
    if (nextValue !== value) {
      dispatch('change', { value: nextValue });
    }
  }
</script>

<button
  class="selector-pill"
  type="button"
  aria-label={ariaLabel}
  aria-expanded={open}
  disabled={disabled}
  on:click={openSheet}
>
  <span class="selector-label">{selectedLabel}</span>
  <span class="selector-chevron" aria-hidden="true">▾</span>
</button>

{#if open}
  <button class="sheet-backdrop" type="button" aria-label="Close selector" on:click={closeSheet}></button>
  <div class="sheet-panel" role="dialog" aria-modal="true" aria-label={title}>
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header">
      <h3>{title}</h3>
      <button type="button" class="sheet-done" on:click={closeSheet}>Done</button>
    </div>
    <div class="sheet-options">
      {#each options as option}
        <button
          type="button"
          class:selected={option.value === value}
          on:click={() => chooseOption(option.value)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .selector-pill {
    width: 100%;
    min-width: 0;
    min-height: 2.5rem;
    padding: 0.45rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    background: #ffffff;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.55rem;
    color: #111827;
  }

  .selector-label {
    min-width: 0;
    font-size: 0.8rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selector-chevron {
    color: #6b7280;
    flex: none;
    font-size: 0.78rem;
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(17, 24, 39, 0.32);
  }

  .sheet-panel {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 81;
    border-radius: 1rem 1rem 0 0;
    background: #ffffff;
    border-top: 1px solid #e5e7eb;
    padding: 0.55rem 0.85rem calc(env(safe-area-inset-bottom, 16px) + 0.9rem);
    max-height: 70dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    animation: sheet-up 150ms ease-out;
  }

  .sheet-handle {
    width: 2.2rem;
    height: 0.25rem;
    margin: 0.05rem auto 0.5rem;
    border-radius: 999px;
    background: #d1d5db;
  }

  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    margin-bottom: 0.55rem;
  }

  .sheet-panel h3 {
    margin: 0;
    font-size: 0.84rem;
    color: #374151;
    font-weight: 600;
  }

  .sheet-options {
    display: grid;
    gap: 0.35rem;
    padding-bottom: 0.2rem;
  }

  .sheet-options button {
    border: 1px solid #d1d5db;
    border-radius: 0.65rem;
    min-height: 2.55rem;
    text-align: left;
    padding: 0.55rem 0.7rem;
    background: #ffffff;
    color: #111827;
    font-size: 0.84rem;
  }

  .sheet-options button.selected {
    border-color: #2563eb;
    background: #eff6ff;
    color: #1d4ed8;
    font-weight: 600;
  }

  .sheet-done {
    border: 0;
    background: #111827;
    color: #ffffff;
    border-radius: 0.55rem;
    min-height: 2.1rem;
    padding: 0.35rem 0.72rem;
    font-size: 0.78rem;
    font-weight: 600;
    flex: none;
  }

  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
