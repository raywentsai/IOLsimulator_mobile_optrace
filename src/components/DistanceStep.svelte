<script lang="ts">
  import { onDestroy } from 'svelte';

  export let direction: -1 | 1;
  export let disabled = false;
  export let step: (direction: -1 | 1) => void;

  const HOLD_DELAY_MS = 350;
  const REPEAT_INTERVAL_MS = 160;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: number | undefined;
  let repeated = false;

  function stop() {
    clearTimeout(timer);
    pointer = undefined;
  }

  function repeat() {
    if (pointer === undefined || disabled) return;
    repeated = true;
    step(direction);
    timer = setTimeout(repeat, REPEAT_INTERVAL_MS);
  }

  function start(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || disabled) return;
    stop();
    repeated = false;
    pointer = event.pointerId;
    (event.currentTarget as HTMLButtonElement).setPointerCapture(pointer);
    timer = setTimeout(repeat, HOLD_DELAY_MS);
  }

  function end(event: PointerEvent) {
    if (event.pointerId === pointer) stop();
  }

  function activate(event: MouseEvent) {
    // Keyboard and assistive-technology activation have no pointer click count.
    if (!repeated || event.detail === 0) step(direction);
  }

  $: if (disabled) stop();
  onDestroy(stop);
</script>

<svelte:window on:blur={stop} on:pagehide={stop} />
<svelte:document on:visibilitychange={stop} />

<button type="button" {disabled}
  aria-label={direction < 0 ? 'Move simulated object closer by 0.1 D' : 'Move simulated object farther by 0.1 D'}
  on:pointerdown={start} on:pointerup={end} on:pointercancel={end} on:lostpointercapture={end}
  on:contextmenu|preventDefault on:click={activate}>
  {direction < 0 ? '−' : '+'}
</button>

<style>
  button {
    height: 44px;
    border: 0;
    border-radius: .52rem;
    background: #f1f5f9;
    color: #1e3a5f;
    font-size: 1.35rem;
    font-weight: 650;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  button:active { background: #dbeafe; }
  button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .45; }
</style>
