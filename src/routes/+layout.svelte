<script>
  import { onMount } from 'svelte';
  import { trackDisplayViewport } from '../lib/stores/display';
  import '../app.css';

  onMount(trackDisplayViewport);
</script>

<slot />
