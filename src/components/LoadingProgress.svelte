<script lang="ts">
  import type {AssetProgress} from '../lib/render/asset-loading';
  export let label:string;
  export let progress:AssetProgress|null=null;
  export let detail='';
  $: measured=progress?.stage==='download'&&!!progress.total;
  $: loaded=progress?.loaded??0;
  $: total=progress?.total??1;
  $: stage=progress?.stage==='decode'?'Decoding PNG…':progress?.stage==='native'?'Loading with the browser image decoder…':progress?.stage==='retry'?'Retrying download…':'';
</script>

<div class="loading-progress" role="status" aria-live="polite">
  <div class="heading"><span>{label}</span>{#if measured}<span>{Math.min(100,Math.round(100*loaded/total))}%</span>{/if}</div>
  {#if measured}<progress aria-label={label} value={loaded} max={total}></progress>
  {:else}<progress aria-label={label}></progress>{/if}
  {#if stage||detail}<div class="detail">{stage||detail}</div>{/if}
</div>

<style>
  .loading-progress{background:#fffffff2;color:#374151;padding:.65rem .8rem;border:1px solid #dbe3ef;border-radius:.65rem;box-shadow:0 2px 10px #0001;font-size:.78rem}
  .heading{display:flex;justify-content:space-between;gap:.5rem;font-weight:500}
  progress{display:block;width:100%;height:.4rem;margin:.5rem 0 .15rem;accent-color:#2563eb}
  .detail{font-size:.72rem;margin-top:.35rem;line-height:1.4;color:#4b5563}
</style>
