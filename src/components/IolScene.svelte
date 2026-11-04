<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {base} from '$app/paths';
  import backgroundAsset from '../lib/assets/images/background.lossless.webp';
  import {loadSceneImage} from '../lib/render/scene-assets';
  import {WebGLRenderer,type RenderConfig} from '../lib/render/gl/renderer';
  import {resolveBlurPolicy} from '../lib/render/blur-policy';
  import {manifest,loadPsf,prefetchPsfNeighbors,cancelPsfPrefetch,psfCacheInfo} from '../lib/render/psf/library';
  import {objectVergence,PSF_MODELS,mobileSampling,calibratedCssPxPerMm} from '../lib/render/psf/geometry';
  import type {SceneInput} from '../lib/render/psf/scene';
  import {PsfDisplay} from '../lib/render/psf/display';
  import {blurEngine,selectedLensId,selectedCompareLensId,masterDefocus,cssPxPerMmCal,calibrationScale,currentViewportScale,viewingDistance,splitViewEnabled,
    blurSigma,compareBlurSigma,backgroundBlurSigma,compareBackgroundBlurSigma,currentVADecimal,compareVADecimal} from '../lib/stores/app';

  let host:HTMLDivElement,canvas:HTMLCanvasElement;
  let renderer:WebGLRenderer|null=null;
  let psfDisplay:PsfDisplay|null=null;
  let worker:Worker|null=null;
  let observer:ResizeObserver;
  let ready=false,disposed=false,busy=false,dirty=false,version=0;
  let error='',status='Loading scene…',renderMs=0;
  let profile:Record<string,unknown>={},scheduledAt=0;
  let timer:ReturnType<typeof setTimeout>|null=null;
  let prefetchTimer:ReturnType<typeof setTimeout>|null=null;
  let background:HTMLImageElement,card:HTMLImageElement;
  let sourcePixels:ImageData;
  let loadController=new AbortController();
  let backgroundTexture='',cardTexture='';
  const cardCanvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const CARD_HEIGHT_MM=28,ASPECT=1528/1170;
  let id=0;
  type Computed={data:Uint8ClampedArray;milliseconds:number;profile:Record<string,number>};
  const pending=new Map<number,{resolve:(value:Computed)=>void;reject:(error:Error)=>void}>();

  function ensureWorker():void {
    if(worker)return;
    const native=document.createElement('canvas');native.width=background.width;native.height=background.height;
    const ctx=native.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(background,0,0);
    sourcePixels=ctx.getImageData(0,0,native.width,native.height);
    worker=new Worker(new URL('../lib/render/psf/worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=event=>{const item=pending.get(event.data.id);if(!item)return;pending.delete(event.data.id);
      if(event.data.error)item.reject(new Error(event.data.error));else item.resolve(event.data);};
    worker.onerror=()=>{error='Physics worker failed; please reload';status='';for(const p of pending.values())p.reject(new Error(error));pending.clear();};
    worker.postMessage({source:sourcePixels.data},[sourcePixels.data.buffer]);
    native.width=1;native.height=1;
  }

  function compute(input:SceneInput,backgroundKey:string):Promise<Computed> {
    return new Promise((resolve,reject)=>{
      ensureWorker();
      const requestId=++id;pending.set(requestId,{resolve,reject});
      worker!.postMessage({id:requestId,input,backgroundKey});
    });
  }

  function schedule():void {
    if(!ready||disposed) return;
    version++;dirty=true;status='Updating…';
    if(prefetchTimer!==null){clearTimeout(prefetchTimer);prefetchTimer=null;}
    cancelPsfPrefetch($blurEngine==='psf'?{models:[PSF_MODELS[$selectedLensId],...($splitViewEnabled?[PSF_MODELS[$selectedCompareLensId]]:[])],demand:objectVergence($masterDefocus)}:undefined);
    scheduledAt=performance.now();
    if(timer===null&&!busy)timer=setTimeout(()=>{timer=null;void flush();},16);
  }

  async function flush():Promise<void> {
    if(busy||!dirty||disposed) return;
    busy=true;dirty=false;const requestVersion=version;
    const engine=$blurEngine,lens=$selectedLensId,compareLens=$selectedCompareLensId,split=$splitViewEnabled;
    const defocus=$masterDefocus,ppm=calibratedCssPxPerMm($cssPxPerMmCal,$calibrationScale,$currentViewportScale),distance=$viewingDistance;
    const sigma=$blurSigma,compareSigma=$compareBlurSigma,bgSigma=$backgroundBlurSigma,compareBgSigma=$compareBackgroundBlurSigma;
    try {
      const start=performance.now(),cssWidth=Math.max(1,host.clientWidth),cssHeight=Math.max(1,host.clientHeight);
      const metrics:Record<string,unknown>={queueMs:start-scheduledAt};
      // Physics is computed off-thread at a bounded sampling grid; its physical
      // PSF scale uses this exact ratio. Gaussian keeps the original GPU policy.
      const library=engine==='psf'?await manifest(base):null,demand=objectVergence(defocus);
      const projections=library?.entries.filter(e=>[PSF_MODELS[lens],...(split?[PSF_MODELS[compareLens]]:[])].includes(e.model) && (e.objectVergenceD===demand||e.objectVergenceD===0)).map(e=>e.retinalMmPerTanTheta);
      const sampling=library?mobileSampling(cssWidth,cssHeight,ppm,distance,demand,CARD_HEIGHT_MM,ASPECT,Math.min(...projections!)):null;
      const desiredScale=Math.min(devicePixelRatio||1,2);
      const width=sampling?.width??Math.max(1,Math.round(cssWidth*desiredScale)),height=sampling?.height??Math.max(1,Math.round(cssHeight*desiredScale));
      const scale=width/cssWidth,scaleY=height/cssHeight;
      const heightPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*distance*(-defocus)*ppm*scaleY));
      const widthPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*ASPECT*distance*(-defocus)*ppm*scale));
      if(widthPixels*heightPixels>4194304) throw new Error('Card exceeds available sampling memory; use a shorter viewing distance');
      cardCanvas!.width=widthPixels;cardCanvas!.height=heightPixels;
      const ctx=cardCanvas!.getContext('2d',{willReadFrequently:true})!;
      ctx.fillStyle='white';ctx.fillRect(0,0,widthPixels,heightPixels);ctx.drawImage(card,0,0,widthPixels,heightPixels);
      const config:RenderConfig={width,height,blurSigma:0,nsGrade:0,pscRadius:0,pscDensity:0,pscSoftness:.2,splitView:false,splitPosition:.5};
      if(engine==='gaussian') {
        if(canvas.width!==width) canvas.width=width;
        if(canvas.height!==height) canvas.height=height;
        renderer!.updateImageTexture(cardTexture,cardCanvas!);
        const policy=(s:number)=>resolveBlurPolicy({sigmaCssRaw:s,deviceCssPxPerMm:ppm,viewingDistanceM:distance,renderPixelScale:scale}).sigmaTexelUsedFull;
        await renderer!.render(cardTexture,{...config,blurSigma:policy(sigma),compareBlurSigma:split?policy(compareSigma):undefined,
          backgroundBlurSigma:policy(bgSigma),compareBackgroundBlurSigma:split?policy(compareBgSigma):undefined,
          splitView:split,backgroundTextureId:backgroundTexture,backgroundNativeWidth:background.width,backgroundNativeHeight:background.height,
          foregroundScale:1,foregroundNativeWidth:widthPixels/scale,foregroundNativeHeight:heightPixels/scaleY});
      } else {
        const cardPixels=ctx.getImageData(0,0,widthPixels,heightPixels).data;
        // SVG black-path coverage on white is an integrated linear radiance
        // sample, as in the reference MuPDF vector rasterizer.
        const gray=new Float32Array(widthPixels*heightPixels);
        for(let i=0;i<gray.length;i++) gray[i]=cardPixels[4*i]/255;
        // Start both sides' network requests together. CPU scene work remains
        // bounded to one Worker, avoiding a second large FFT memory peak.
        const selectedModels=[PSF_MODELS[lens],...(split?[PSF_MODELS[compareLens]]:[])];
        const downloads:Record<string,Record<string,number>>={};
        const loadStarted=performance.now();
        await Promise.all(library!.entries.filter(e=>selectedModels.includes(e.model)&&(e.objectVergenceD===demand||e.objectVergenceD===0)).map(e=>{
          const record:Record<string,number>={};downloads[e.file]=record;return loadPsf(base,e,record);
        }));
        metrics.psfDownloads=downloads;metrics.psfLoadMs=performance.now()-loadStarted;
        if(disposed||requestVersion!==version)return;
        const makeSide=async(lensId:string)=>{
          const model=PSF_MODELS[lensId];
          const near=library!.entries.find(e=>e.model===model&&e.objectVergenceD===demand);
          const infinity=library!.entries.find(e=>e.model===model&&e.objectVergenceD===0);
          if(!near||!infinity) throw new Error('Requested PSF is missing');
          const loadStart=performance.now();
          const nearLoad:Record<string,number>={},infinityLoad:Record<string,number>={};
          const [nearEnergy,infinityEnergy]=await Promise.all([loadPsf(base,near,nearLoad),loadPsf(base,infinity,infinityLoad)]);
          if(disposed||requestVersion!==version) return null;
          const computeStart=performance.now();
          const result=await compute({width,height,background:new Uint8ClampedArray(0),backgroundWidth:background.width,backgroundHeight:background.height,
            card:gray,cardWidth:widthPixels,cardHeight:heightPixels,near,nearEnergy,infinity,infinityEnergy,
            cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scaleY},[model,width,height,ppm,distance,scale,scaleY].join(':'));
          metrics[lensId]={loadDecodeMs:computeStart-loadStart,nearLoad,infinityLoad,workerRoundTripMs:performance.now()-computeStart,workerMs:result.milliseconds,...result.profile};
          return result;
        };
        const left=await makeSide(lens);
        if(!left||disposed||requestVersion!==version) return;
        const right=split?await makeSide(compareLens):null;
        if(disposed||requestVersion!==version) return;
        const displayStart=performance.now();
        if(right) for(let y=0;y<height;y++) {
          const start=4*(y*width+Math.floor(width/2)),end=4*(y+1)*width;
          left.data.set(right.data.subarray(start,end),start);
        }
        metrics.splitCopyMs=performance.now()-displayStart;
        psfDisplay??=new PsfDisplay(canvas);
        const displayScale=(devicePixelRatio||1)*(window.visualViewport?.scale??1);
        Object.assign(metrics,psfDisplay.present(left.data,width,height,Math.max(1,Math.round(cssWidth*displayScale)),Math.max(1,Math.round(cssHeight*displayScale))));
        prefetchTimer=setTimeout(()=>{prefetchTimer=null;if(!disposed&&requestVersion===version)void prefetchPsfNeighbors(base,selectedModels,demand).catch(()=>undefined);},150);
      }
      if(requestVersion===version) {error='';status='';renderMs=performance.now()-start;profile={...metrics,renderMs,inputToSubmitMs:performance.now()-scheduledAt,width,height,objectVergenceD:demand,lens,compareLens:split?compareLens:null,cssPxPerMm:ppm,viewingDistanceM:distance,psfCache:psfCacheInfo()};}
    } catch(e) {if(requestVersion===version) {error=String(e);status='';}}
    finally {busy=false;if(dirty&&!disposed) void flush();}
  }

  async function initializeScene():Promise<void> {
    loadController.abort();loadController=new AbortController();
    const signal=loadController.signal;
    error='';status='Loading scene…';
      try {
        renderer?.dispose();renderer=new WebGLRenderer(canvas);
        const images=Promise.all([loadSceneImage(backgroundAsset,signal),loadSceneImage(`${base}/reading-card.svg`,signal)]);
        // Initialize shaders while the two required scene assets download.
        const [loaded]=await Promise.all([images,renderer.initialize()]);
        [background,card]=loaded;
        if(disposed) return;
        backgroundTexture=await renderer.loadImageTexture(background);
        // The first Gaussian frame uploads the actual sampled card; avoid
        // uploading its much larger native SVG raster during initialization.
        cardCanvas!.width=1;cardCanvas!.height=1;
        cardTexture=await renderer.loadImageTexture(cardCanvas!);
        observer=new ResizeObserver(schedule);observer.observe(host);
        ready=true;schedule();
      }catch(e){loadController.abort();if(!disposed){error=String(e);status='';}}
  }
  onMount(()=>{
    disposed=false;
    updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);
    void initializeScene();
  });
  function updateViewport():void {currentViewportScale.set(window.visualViewport?.scale??1);schedule();}
  onDestroy(()=>{disposed=true;loadController.abort();cancelPsfPrefetch();if(prefetchTimer!==null)clearTimeout(prefetchTimer);if(timer!==null)clearTimeout(timer);if(typeof window!=='undefined')window.visualViewport?.removeEventListener('resize',updateViewport);observer?.disconnect();worker?.terminate();psfDisplay?.dispose();renderer?.dispose();
    for(const p of pending.values())p.reject(new Error('Scene disposed'));pending.clear();});
  $: if(ready) {void [$blurEngine,$selectedLensId,$selectedCompareLensId,$masterDefocus,$cssPxPerMmCal,$calibrationScale,$currentViewportScale,$viewingDistance,$splitViewEnabled,
    $blurSigma,$compareBlurSigma,$backgroundBlurSigma,$compareBackgroundBlurSigma];schedule();}
</script>

<div class="scene" bind:this={host}>
  <canvas bind:this={canvas} data-render-ms={Math.round(renderMs)} data-profile={JSON.stringify(profile)} aria-label="IOL vision simulation canvas (WebGL)"></canvas>
  {#if status}<div class="status" role="status">{status}</div>{/if}
  {#if error}<div class="error" role="alert">{error}{#if !ready}<button on:click={()=>void initializeScene()}>Retry scene</button>{/if}</div>{/if}
  <div class="readout">
    <span>{$blurEngine==='psf'?'OPTrace PSF':`VA ~ ${$currentVADecimal.toFixed(2)}`}</span>
    {#if $splitViewEnabled}<span>{$blurEngine==='psf'?'OPTrace PSF':`VA ~ ${$compareVADecimal.toFixed(2)}`}</span>{/if}
  </div>
  <span class="distance">{$masterDefocus.toFixed(1)} D / {Math.round(-100/$masterDefocus)} cm</span>
</div>

<style>
  .scene{position:relative;width:100%;height:100%;overflow:hidden;background:#eee}
  canvas{display:block;width:100%;height:100%}
  .status,.error{position:absolute;top:2rem;left:50%;transform:translateX(-50%);background:#fffE;padding:.5rem .8rem;border-radius:.5rem;font-size:.8rem;max-width:90%;z-index:2}
  .error{color:#991b1b}
  .readout{position:absolute;inset:.5rem .5rem auto;display:flex;gap:1rem;font-size:.7rem;pointer-events:none}
  .readout span{flex:1;color:white;text-shadow:0 1px 3px black}
  .distance{position:absolute;bottom:.5rem;right:.5rem;background:#374151aa;color:white;border-radius:5px;padding:2px 5px;font-size:.65rem}
</style>
