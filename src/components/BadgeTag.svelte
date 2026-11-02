<script lang="ts">
  export let text = '';
  export let styleText = '';
</script>

<div class="badge-tag" style={styleText}>{text}</div>

<style>
  .badge-tag {
    position: absolute;
    padding: 0.2rem 0.4rem;
    border-radius: 0.4rem;
    background: rgba(17, 24, 39, 0.66);
    color: #f9fafb;
    font-size: 0.7rem;
    line-height: 1;
    pointer-events: none;
    white-space: nowrap;
  }
</style>
