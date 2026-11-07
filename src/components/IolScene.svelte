<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {base} from '$app/paths';
  import backgroundAsset from '../lib/assets/images/background.png';
  import backgroundInfo from '../lib/assets/images/background.json';
  import {loadSceneImage} from '../lib/render/scene-assets';
  import {loadPngAsset,type AssetProgress,type LoadedPng} from '../lib/render/asset-loading';
  import LoadingProgress from './LoadingProgress.svelte';
  import {WebGLRenderer,type RenderConfig} from '../lib/render/gl/renderer';
  import {resolveBlurPolicy} from '../lib/render/blur-policy';
  import {manifest,loadPsf,prefetchPsfNeighbors,cancelPsfPrefetch,psfCacheInfo} from '../lib/render/psf/library';
  import {objectVergence,PSF_MODELS,mobileSampling,calibratedCssPxPerMm} from '../lib/render/psf/geometry';
  import type {SceneInput} from '../lib/render/psf/scene';
  import {PsfDisplay} from '../lib/render/psf/display';
  import {OpticalImageLoader} from '../lib/render/psf/optical-images';
  import type {OpticalImageRef} from '../lib/render/psf/optical-image-math';
  import {PhysicsWorkerClient,type Computed} from '../lib/render/psf/worker-client';
  import {blurEngine,selectedLensId,selectedCompareLensId,masterDefocus,cssPxPerMmCal,calibrationScale,currentViewportScale,viewingDistance,splitViewEnabled,
    blurSigma,compareBlurSigma,backgroundBlurSigma,compareBackgroundBlurSigma,currentVADecimal,compareVADecimal} from '../lib/stores/app';

  let host:HTMLDivElement,canvas:HTMLCanvasElement;
  let renderer:WebGLRenderer|null=null;
  let psfDisplay:PsfDisplay|null=null;
  let worker:PhysicsWorkerClient|null=null;
  let observer:ResizeObserver;
  let ready=false,disposed=false,busy=false,dirty=false,version=0;
  let error='',status='Loading reading card…',renderMs=0;
  let backgroundReady=false,backgroundLoading=true,backgroundError='',backgroundAttempt=0;
  let backgroundProgress:AssetProgress|null=null,opticalProgress:AssetProgress|null=null;
  let fallbackMessage='';
  let backgroundController=new AbortController(),backgroundAssetHandle:LoadedPng|null=null;
  let profile:Record<string,unknown>={},scheduledAt=0;
  let queued=false,lastRequestedKey='',backgroundRevision=0;
  let prefetchTimer:ReturnType<typeof setTimeout>|null=null;
  let background:HTMLImageElement|HTMLCanvasElement,card:HTMLImageElement;
  let loadController=new AbortController();
  let backgroundTexture='',cardTexture='';
  const cardCanvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const CARD_HEIGHT_MM=28,ASPECT=1528/1170;
  const opticalImages=new OpticalImageLoader({
    getOptical:key=>worker?.getOptical(key),
    registerOptical:layer=>{ensureWorker();return worker!.registerOptical(layer);}
  });

  function resetWorker(reason:string):void {
    worker?.dispose(reason);worker=null;
  }

  function backgroundPixels():Uint8ClampedArray {
    const native=document.createElement('canvas');native.width=background.width;native.height=background.height;
    const ctx=native.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(background,0,0);
    const pixels=ctx.getImageData(0,0,native.width,native.height).data;
    native.width=1;native.height=1;
    return pixels;
  }

  function ensureWorker():void {
    if(worker)return;
    worker=new PhysicsWorkerClient(new Worker(new URL('../lib/render/psf/worker.ts',import.meta.url),{type:'module'}),backgroundPixels(),resetWorker);
    worker.invalidate(version);
  }

  function compute(input:SceneInput&{opticalLayer?:OpticalImageRef},backgroundKey:string,requestVersion:number):Promise<Computed> {
    ensureWorker();return worker!.render(input,backgroundKey,requestVersion);
  }

  function schedule():void {
    if(!ready||disposed) return;
    const key=JSON.stringify([$blurEngine,$selectedLensId,$splitViewEnabled?$selectedCompareLensId:null,$splitViewEnabled,$masterDefocus,
      calibratedCssPxPerMm($cssPxPerMmCal,$calibrationScale,$currentViewportScale),$viewingDistance,host.clientWidth,host.clientHeight,
      devicePixelRatio,window.visualViewport?.scale??1,backgroundRevision,
      ...($blurEngine==='gaussian'?[$blurSigma,$compareBlurSigma,$backgroundBlurSigma,$compareBackgroundBlurSigma]:[])]);
    if(key===lastRequestedKey)return;
    lastRequestedKey=key;
    version++;dirty=true;status='Updating…';opticalProgress=null;
    worker?.invalidate(version);
    if(prefetchTimer!==null){clearTimeout(prefetchTimer);prefetchTimer=null;}
    const keep=$blurEngine==='psf'?{
      models:[PSF_MODELS[$selectedLensId],...($splitViewEnabled?[PSF_MODELS[$selectedCompareLensId]]:[])],
      demand:objectVergence($masterDefocus)
    }:undefined;
    cancelPsfPrefetch(keep);
    opticalImages.cancel(keep);
    scheduledAt=performance.now();
    // Svelte has already coalesced synchronous store updates. No extra frame/timer wait.
    if(!queued&&!busy){queued=true;queueMicrotask(()=>{queued=false;void flush();});}
  }

  async function flush():Promise<void> {
    if(busy||!dirty||disposed) return;
    busy=true;dirty=false;const requestVersion=version;
    const engine=$blurEngine,lens=$selectedLensId,compareLens=$selectedCompareLensId,split=$splitViewEnabled;
    const defocus=$masterDefocus,ppm=calibratedCssPxPerMm($cssPxPerMmCal,$calibrationScale,$currentViewportScale),distance=$viewingDistance;
    const sigma=$blurSigma,compareSigma=$compareBlurSigma,bgSigma=$backgroundBlurSigma,compareBgSigma=$compareBackgroundBlurSigma;
    const current=()=>!disposed&&requestVersion===version;
    try {
      const start=performance.now(),cssWidth=Math.max(1,host.clientWidth),cssHeight=Math.max(1,host.clientHeight);
      const metrics:Record<string,unknown>={engine,queueMs:start-scheduledAt,backgroundReady};
      fallbackMessage='';
      status=engine==='psf'?'Loading PSF library…':'Updating…';
      // Physics is computed off-thread at a bounded sampling grid; its physical
      // PSF scale uses this exact ratio. Gaussian keeps the original GPU policy.
      const library=engine==='psf'?await manifest(base):null,demand=objectVergence(defocus);
      if(!current())return;
      const sides=library?[...new Set([lens,...(split?[compareLens]:[])])].map(lensId=>{
        const model=PSF_MODELS[lensId];
        const near=library.entries.find(entry=>entry.model===model&&entry.objectVergenceD===demand);
        const infinity=library.entries.find(entry=>entry.model===model&&entry.objectVergenceD===0);
        if(!near||!infinity)throw new Error('Requested PSF is missing');
        return {lensId,model,near,infinity,optical:null as OpticalImageRef|null};
      }):[];
      const downloads:Record<string,Record<string,number>>={};
      const loadKernel=(entry:typeof sides[number]['near'])=>{
        const record:Record<string,number>={};
        downloads[entry.file]=record;
        return loadPsf(base,entry,record);
      };
      const farLoads=Promise.all(sides.map(side=>loadKernel(side.infinity)));
      // Infinity downloads can overlap optical loading, including cancelled frames.
      void farLoads.catch(()=>undefined);
      const sample=(dynamic=sides.filter(side=>!side.optical))=>{
        // Preserve the shared comparison grid when either side falls back to FFT.
        const boundedNear=sides.length>1?sides:dynamic;
        const projections=[...sides.map(side=>side.infinity),...boundedNear.map(side=>side.near)];
        return mobileSampling(cssWidth,cssHeight,ppm,distance,boundedNear.length?demand:1,CARD_HEIGHT_MM,ASPECT,
          Math.min(...projections.map(entry=>entry.retinalMmPerTanTheta)));
      };
      let sampling=library?sample([]):null;
      const physicalDensity=ppm*distance*1000;
      if(sampling){
        const opticalStart=performance.now();
        const px=physicalDensity*sampling.scaleX,py=physicalDensity*sampling.scaleY;
        const opticalFailure=(cause:unknown)=>{
          if(current()){
            console.warn('Optical image unavailable; using the dynamic PSF renderer',String(cause));
            fallbackMessage='Optical image unavailable. Using dynamic PSF rendering.';
          }
          return null;
        };
        status='Loading optical image…';
        const selections=await Promise.all(sides.map(side=>opticalImages.select(base,side.near,px,py).catch(opticalFailure)));
        if(!current())return;
        const keys=selections.flatMap(selection=>selection?[selection.key]:[]);
        if(keys.length){
          ensureWorker();
          await worker!.reserveOptical(requestVersion,keys);
        }
        if(!current())return;
        await Promise.all(sides.map(async(side,index)=>{
          const selection=selections[index];
          if(selection)side.optical=await opticalImages.load(base,selection,p=>{
            if(current())opticalProgress=p;
          }).catch(opticalFailure);
        }));
        if(!current())return;
        if(sides.length===1&&!sides[0].optical)sampling=sample();
        metrics.opticalLoadMs=performance.now()-opticalStart;
        metrics.rendering=Object.fromEntries(sides.map(side=>[side.lensId,side.optical?'precomputed':'dynamic']));
      }
      opticalProgress=null;status=engine==='psf'?'Loading PSF data…':'Updating…';
      const desiredScale=Math.min(devicePixelRatio||1,2);
      const width=sampling?.width??Math.max(1,Math.round(cssWidth*desiredScale)),height=sampling?.height??Math.max(1,Math.round(cssHeight*desiredScale));
      const scale=width/cssWidth,scaleY=height/cssHeight;
      const heightPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*distance*(-defocus)*ppm*scaleY));
      const widthPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*ASPECT*distance*(-defocus)*ppm*scale));
      if(widthPixels*heightPixels>4194304) throw new Error('Card exceeds available sampling memory; use a shorter viewing distance');
      const needsCardRaster=engine==='gaussian'||sides.some(side=>!side.optical);
      if(needsCardRaster){cardCanvas!.width=widthPixels;cardCanvas!.height=heightPixels;}
      const ctx=cardCanvas!.getContext('2d',{willReadFrequently:true})!;
      if(needsCardRaster){ctx.fillStyle='white';ctx.fillRect(0,0,widthPixels,heightPixels);ctx.drawImage(card,0,0,widthPixels,heightPixels);}
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
        const cardPixels=needsCardRaster?ctx.getImageData(0,0,widthPixels,heightPixels).data:new Uint8ClampedArray(0);
        // SVG black-path coverage on white is an integrated linear radiance
        // sample, as in the reference MuPDF vector rasterizer.
        const gray=new Float32Array(needsCardRaster?widthPixels*heightPixels:0);
        for(let i=0;i<gray.length;i++) gray[i]=cardPixels[4*i]/255;
        const loadStarted=performance.now();
        const empty=new Float32Array(0);
        const [farEnergy,nearEnergy]=await Promise.all([
          farLoads,Promise.all(sides.map(side=>side.optical?empty:loadKernel(side.near)))
        ]);
        metrics.psfDownloads=downloads;metrics.psfLoadMs=performance.now()-loadStarted;
        if(!current())return;
        status='Rendering optical scene…';
        // Both sides use the same grid and request version. Only one Worker renders.
        const frames:Uint8ClampedArray[]=[];
        for(const [index,{lensId,model,near,infinity,optical}]of sides.entries()){
          const computeStart=performance.now();
          const result=await compute({width,height,background:new Uint8ClampedArray(0),backgroundWidth:background.width,backgroundHeight:background.height,
            card:optical?empty:gray,cardWidth:widthPixels,cardHeight:heightPixels,near,nearEnergy:nearEnergy[index],infinity,infinityEnergy:farEnergy[index],
            cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scaleY,opticalLayer:optical??undefined},
            [model,width,height,ppm,distance,scale,scaleY].join(':'),requestVersion);
          if(!current()||result.cancelled||!result.data)return;
          metrics[lensId]={workerRoundTripMs:performance.now()-computeStart,workerMs:result.milliseconds,...result.profile};
          frames.push(result.data);
        }
        const [left,right]=frames;
        const displayStart=performance.now();
        if(right) for(let y=0;y<height;y++) {
          const start=4*(y*width+Math.floor(width/2)),end=4*(y+1)*width;
          left.set(right.subarray(start,end),start);
        }
        metrics.splitCopyMs=performance.now()-displayStart;
        psfDisplay??=new PsfDisplay(canvas);
        const displayScale=(devicePixelRatio||1)*(window.visualViewport?.scale??1);
        Object.assign(metrics,psfDisplay.present(left,width,height,Math.max(1,Math.round(cssWidth*displayScale)),Math.max(1,Math.round(cssHeight*displayScale))));
        prefetchTimer=setTimeout(()=>{
          prefetchTimer=null;if(disposed||requestVersion!==version||!backgroundReady)return;
          const dynamicModels=sides.filter(side=>!side.optical).map(side=>side.model);
          const opticalModels=sides.filter(side=>side.optical).map(side=>side.model);
          if(dynamicModels.length)void prefetchPsfNeighbors(base,dynamicModels,demand).catch(()=>undefined);
          if(opticalModels.length)void opticalImages.prefetch(base,opticalModels,demand,physicalDensity*scale,physicalDensity*scaleY).catch(()=>undefined);
        },150);
      }
      if(requestVersion===version) {error='';status='';renderMs=performance.now()-start;profile={...metrics,renderMs,inputToSubmitMs:performance.now()-scheduledAt,width,height,objectVergenceD:demand,lens,compareLens:split?compareLens:null,cssPxPerMm:ppm,viewingDistanceM:distance,psfCache:psfCacheInfo(),workerAssets:worker?.info(),opticalLoads:opticalImages.info()};}
    } catch(e) {if(requestVersion===version) {lastRequestedKey='';error=String(e);status='';opticalProgress=null;}}
    finally {
      void worker?.reserveOptical(requestVersion,[]);
      busy=false;
      if(dirty&&!disposed)void flush();
    }
  }

  async function initializeScene():Promise<void> {
    loadController.abort();loadController=new AbortController();
    const signal=loadController.signal;
    error='';status='Loading reading card…';
      try {
        card=await loadSceneImage(`${base}/reading-card.svg`,signal,15000,1);
        if(disposed) return;
        status='Preparing chart…';
        // The chart becomes usable independently of the large background.
        renderer?.dispose();renderer=new WebGLRenderer(canvas);
        await renderer.initialize();
        if(disposed)return;
        backgroundTexture=await renderer.loadImageTexture(background);
        // The first Gaussian frame uploads the actual sampled card; avoid
        // uploading its much larger native SVG raster during initialization.
        cardCanvas!.width=1;cardCanvas!.height=1;
        cardTexture=await renderer.loadImageTexture(cardCanvas!);
        observer=new ResizeObserver(schedule);observer.observe(host);
        ready=true;schedule();
      }catch(e){loadController.abort();if(!disposed){error=String(e);status='';}}
  }

  async function startBackgroundLoad():Promise<void> {
    backgroundController.abort();backgroundController=new AbortController();
    const attempt=++backgroundAttempt,signal=backgroundController.signal;
    backgroundLoading=true;backgroundError='';backgroundProgress=null;
    try {
      const asset=await loadPngAsset(backgroundAsset,signal,{expectedBytes:backgroundInfo.bytes,totalMs:45000,onProgress:p=>{if(!disposed&&attempt===backgroundAttempt)backgroundProgress=p;}});
      if(disposed||attempt!==backgroundAttempt){asset.release();return;}
      const old=backgroundAssetHandle;backgroundAssetHandle=asset;background=asset.image;backgroundReady=true;
      if(ready){
        // Invalidate work using the explicitly labelled neutral placeholder.
        backgroundRevision++;worker?.source(backgroundPixels());
        renderer!.updateImageTexture(backgroundTexture,background);
        schedule();
      }
      old?.release();
    }catch(e){if(!disposed&&attempt===backgroundAttempt)backgroundError=String(e);}
    finally{if(!disposed&&attempt===backgroundAttempt){backgroundLoading=false;backgroundProgress=null;}}
  }
  onMount(()=>{
    disposed=false;
    const neutral=document.createElement('canvas');neutral.width=1;neutral.height=1;
    const context=neutral.getContext('2d')!;context.fillStyle='#eeeeee';context.fillRect(0,0,1,1);background=neutral;
    updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);
    void startBackgroundLoad();
    void initializeScene();
  });
  function updateViewport():void {currentViewportScale.set(window.visualViewport?.scale??1);schedule();}
  onDestroy(()=>{disposed=true;loadController.abort();backgroundController.abort();backgroundAssetHandle?.release();cancelPsfPrefetch();opticalImages.cancel();if(prefetchTimer!==null)clearTimeout(prefetchTimer);if(typeof window!=='undefined')window.visualViewport?.removeEventListener('resize',updateViewport);observer?.disconnect();resetWorker('Scene disposed');psfDisplay?.dispose();renderer?.dispose();});
  $: if(ready) {void [$blurEngine,$selectedLensId,$selectedCompareLensId,$masterDefocus,$cssPxPerMmCal,$calibrationScale,$currentViewportScale,$viewingDistance,$splitViewEnabled,
    $blurSigma,$compareBlurSigma,$backgroundBlurSigma,$compareBackgroundBlurSigma];schedule();}
</script>

<div class="scene" bind:this={host} data-scene-state={!ready?'initializing':profile.backgroundReady?'complete':'partial'}>
  <canvas bind:this={canvas} data-render-ms={Math.round(renderMs)} data-profile={JSON.stringify(profile)} aria-label="IOL vision simulation canvas (WebGL)"></canvas>
  <div class="loading-stack">
    {#if !ready&&status}<LoadingProgress label={status} detail="Controls are available while the scene loads." />{/if}
    {#if backgroundLoading}<LoadingProgress label="Loading background" progress={backgroundProgress} detail={ready?'Near chart is available. The complete scene is still loading.':'The chart loads separately.'} />{/if}
    {#if ready&&status}<div class="status"><LoadingProgress label={status} progress={opticalProgress} /></div>{/if}
    {#if backgroundError}<div class="error" role="alert"><strong>Background unavailable</strong><p>{ready?'The near chart remains available on a neutral background.':'Controls remain available. The background can be retried separately from the chart.'}</p><details><summary>Error details</summary>{backgroundError}</details><button on:click={()=>void startBackgroundLoad()}>Retry background</button></div>{/if}
    {#if error}<div class="error" role="alert"><p>{error}</p><button on:click={()=>ready?schedule():void initializeScene()}>{ready?'Retry rendering':'Retry chart'}</button>{#if $blurEngine==='psf'}<button on:click={()=>blurEngine.set('gaussian')}>Use Gaussian</button>{/if}</div>{/if}
    {#if fallbackMessage&&!status}<div class="notice" role="status">{fallbackMessage}</div>{/if}
  </div>
  <div class="readout">
    <span>{$blurEngine==='psf'?'OPTrace PSF':`VA ~ ${$currentVADecimal.toFixed(2)}`}</span>
    {#if $splitViewEnabled}<span>{$blurEngine==='psf'?'OPTrace PSF':`VA ~ ${$compareVADecimal.toFixed(2)}`}</span>{/if}
  </div>
  <span class="distance">{$masterDefocus.toFixed(1)} D / {Math.round(-100/$masterDefocus)} cm</span>
</div>

<style>
  .scene{position:relative;width:100%;height:100%;overflow:hidden;background:#eee}
  canvas{display:block;width:100%;height:100%}
  .loading-stack{position:absolute;top:2rem;left:50%;transform:translateX(-50%);width:min(22rem,90%);z-index:2;display:grid;gap:.5rem}
  .status{animation:reveal .15s .15s both}
  @keyframes reveal{from{opacity:0}to{opacity:1}}
  @media(prefers-reduced-motion:reduce){.status{animation:none}}
  .error,.notice{background:#fffffff2;padding:.65rem .8rem;border:1px solid #dbe3ef;border-radius:.65rem;font-size:.78rem;overflow-wrap:anywhere}
  .error{color:#991b1b}.error p{margin:.35rem 0}.error details{font-size:.7rem;margin:.4rem 0}
  .error button{color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:.4rem;padding:.35rem .55rem;margin:.35rem .4rem 0 0;cursor:pointer}
  .notice{color:#4b5563}
  .readout{position:absolute;inset:.5rem .5rem auto;display:flex;gap:1rem;font-size:.7rem;pointer-events:none}
  .readout span{flex:1;color:white;text-shadow:0 1px 3px black}
  .distance{position:absolute;bottom:.5rem;right:.5rem;background:#374151aa;color:white;border-radius:5px;padding:2px 5px;font-size:.65rem}
</style>
