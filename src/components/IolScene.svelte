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
  import {loadOpticalImage,prefetchOpticalNeighbors,cancelOpticalImageLoads} from '../lib/render/psf/optical-images';
  import type {OpticalImageLayer} from '../lib/render/psf/optical-image-math';
  import {blurEngine,selectedLensId,selectedCompareLensId,masterDefocus,cssPxPerMmCal,calibrationScale,currentViewportScale,viewingDistance,splitViewEnabled,
    blurSigma,compareBlurSigma,backgroundBlurSigma,compareBackgroundBlurSigma,currentVADecimal,compareVADecimal} from '../lib/stores/app';

  let host:HTMLDivElement,canvas:HTMLCanvasElement;
  let renderer:WebGLRenderer|null=null;
  let psfDisplay:PsfDisplay|null=null;
  let worker:Worker|null=null;
  let observer:ResizeObserver;
  let ready=false,disposed=false,busy=false,dirty=false,version=0;
  let error='',status='Loading reading card…',renderMs=0;
  let backgroundReady=false,backgroundLoading=true,backgroundError='',backgroundAttempt=0;
  let backgroundProgress:AssetProgress|null=null,opticalProgress:AssetProgress|null=null;
  let fallbackMessage='';
  let backgroundController=new AbortController(),backgroundAssetHandle:LoadedPng|null=null;
  let profile:Record<string,unknown>={},scheduledAt=0;
  let timer:ReturnType<typeof setTimeout>|null=null;
  let prefetchTimer:ReturnType<typeof setTimeout>|null=null;
  let background:HTMLImageElement|HTMLCanvasElement,card:HTMLImageElement;
  let sourcePixels:ImageData;
  let loadController=new AbortController();
  let backgroundTexture='',cardTexture='';
  const cardCanvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const CARD_HEIGHT_MM=28,ASPECT=1528/1170;
  let id=0;
  type Computed={data:Uint8ClampedArray;milliseconds:number;profile:Record<string,number>};
  const pending=new Map<number,{resolve:(value:Computed)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();

  function resetWorker(reason:string):void {
    worker?.terminate();worker=null;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}pending.clear();
  }

  function ensureWorker():void {
    if(worker)return;
    const native=document.createElement('canvas');native.width=background.width;native.height=background.height;
    const ctx=native.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(background,0,0);
    sourcePixels=ctx.getImageData(0,0,native.width,native.height);
    worker=new Worker(new URL('../lib/render/psf/worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=event=>{const item=pending.get(event.data.id);if(!item)return;pending.delete(event.data.id);clearTimeout(item.timer);
      if(event.data.error)item.reject(new Error(event.data.error));else item.resolve(event.data);};
    worker.onerror=()=>resetWorker('Physics worker failed; retry rendering or select Gaussian');
    worker.postMessage({source:sourcePixels.data},[sourcePixels.data.buffer]);
    native.width=1;native.height=1;
  }

  function compute(input:SceneInput&{opticalLayer?:OpticalImageLayer},backgroundKey:string):Promise<Computed> {
    return new Promise((resolve,reject)=>{
      ensureWorker();
      const requestId=++id;pending.set(requestId,{resolve,reject,timer:setTimeout(()=>resetWorker('Physics rendering timed out; retry rendering or select Gaussian'),30000)});
      worker!.postMessage({id:requestId,input,backgroundKey});
    });
  }

  function schedule():void {
    if(!ready||disposed) return;
    version++;dirty=true;status='Updating…';opticalProgress=null;
    if(prefetchTimer!==null){clearTimeout(prefetchTimer);prefetchTimer=null;}
    cancelPsfPrefetch($blurEngine==='psf'?{models:[PSF_MODELS[$selectedLensId],...($splitViewEnabled?[PSF_MODELS[$selectedCompareLensId]]:[])],demand:objectVergence($masterDefocus)}:undefined);
    cancelOpticalImageLoads($blurEngine==='psf'&&[$selectedLensId,...($splitViewEnabled?[$selectedCompareLensId]:[])].includes('zcb00')?objectVergence($masterDefocus):undefined);
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
      const metrics:Record<string,unknown>={queueMs:start-scheduledAt,backgroundReady};
      fallbackMessage='';
      status=engine==='psf'?'Loading PSF library…':'Updating…';
      // Physics is computed off-thread at a bounded sampling grid; its physical
      // PSF scale uses this exact ratio. Gaussian keeps the original GPU policy.
      const library=engine==='psf'?await manifest(base):null,demand=objectVergence(defocus);
      const models=[PSF_MODELS[lens],...(split?[PSF_MODELS[compareLens]]:[])];
      const projections=library?.entries.filter(e=>models.includes(e.model)&&(e.objectVergenceD===demand||e.objectVergenceD===0)).map(e=>e.retinalMmPerTanTheta);
      const onlyAspheric=models.every(model=>model===PSF_MODELS.zcb00);
      // For precomputed-only scenes, choose the infinity background sampling
      // independently of near distance. Its convolution is reused on slides.
      const farProjections=library?.entries.filter(e=>models.includes(e.model)&&e.objectVergenceD===0).map(e=>e.retinalMmPerTanTheta);
      let sampling=library?mobileSampling(cssWidth,cssHeight,ppm,distance,onlyAspheric?1:demand,CARD_HEIGHT_MM,ASPECT,Math.min(...(onlyAspheric?farProjections!:projections!))):null;
      let opticalLayer:OpticalImageLayer|null=null;
      if(library&&models.includes(PSF_MODELS.zcb00)) {
        // Start infinity/other-lens transfers while the Aspheric image loads.
        void Promise.all(library.entries.filter(e=>models.includes(e.model)&&(e.objectVergenceD===0||(e.model!==PSF_MODELS.zcb00&&e.objectVergenceD===demand))).map(e=>loadPsf(base,e))).catch(()=>undefined);
        const entry=library.entries.find(e=>e.model===PSF_MODELS.zcb00&&e.objectVergenceD===demand)!;
        status='Loading optical image…';
        try{opticalLayer=await loadOpticalImage(base,entry,ppm*distance*1000*sampling!.scaleX,ppm*distance*1000*sampling!.scaleY,p=>{if(!disposed&&requestVersion===version)opticalProgress=p;});}
        catch(e){if(requestVersion===version){console.warn('Optical image unavailable; using the dynamic PSF renderer',String(e));fallbackMessage='Optical image unavailable. Using dynamic PSF rendering.';}}
        if(disposed||requestVersion!==version)return;
        if(onlyAspheric&&!opticalLayer)sampling=mobileSampling(cssWidth,cssHeight,ppm,distance,demand,CARD_HEIGHT_MM,ASPECT,Math.min(...projections!));
      }
      metrics.asphericRendering=opticalLayer?'precomputed':'dynamic';
      opticalProgress=null;status=engine==='psf'?'Loading PSF data…':'Updating…';
      const desiredScale=Math.min(devicePixelRatio||1,2);
      const width=sampling?.width??Math.max(1,Math.round(cssWidth*desiredScale)),height=sampling?.height??Math.max(1,Math.round(cssHeight*desiredScale));
      const scale=width/cssWidth,scaleY=height/cssHeight;
      const heightPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*distance*(-defocus)*ppm*scaleY));
      const widthPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*ASPECT*distance*(-defocus)*ppm*scale));
      if(widthPixels*heightPixels>4194304) throw new Error('Card exceeds available sampling memory; use a shorter viewing distance');
      const needsCardRaster=engine==='gaussian'||!opticalLayer||!onlyAspheric;
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
        // Start both sides' network requests together. CPU scene work remains
        // bounded to one Worker, avoiding a second large FFT memory peak.
        const selectedModels=models;
        const downloads:Record<string,Record<string,number>>={};
        const loadStarted=performance.now();
        await Promise.all(library!.entries.filter(e=>selectedModels.includes(e.model)&&(e.objectVergenceD===0||(e.objectVergenceD===demand&&!(opticalLayer&&e.model===PSF_MODELS.zcb00)))).map(e=>{
          const record:Record<string,number>={};downloads[e.file]=record;return loadPsf(base,e,record);
        }));
        metrics.psfDownloads=downloads;metrics.psfLoadMs=performance.now()-loadStarted;
        if(disposed||requestVersion!==version)return;
        status='Rendering optical scene…';
        const makeSide=async(lensId:string)=>{
          const model=PSF_MODELS[lensId];
          const near=library!.entries.find(e=>e.model===model&&e.objectVergenceD===demand);
          const infinity=library!.entries.find(e=>e.model===model&&e.objectVergenceD===0);
          if(!near||!infinity) throw new Error('Requested PSF is missing');
          const loadStart=performance.now();
          const nearLoad:Record<string,number>={},infinityLoad:Record<string,number>={};
          const imageLayer=lensId==='zcb00'?opticalLayer:null;
          const [nearEnergy,infinityEnergy]=await Promise.all([imageLayer?Promise.resolve(new Float32Array(0)):loadPsf(base,near,nearLoad),loadPsf(base,infinity,infinityLoad)]);
          if(disposed||requestVersion!==version) return null;
          const computeStart=performance.now();
          const result=await compute({width,height,background:new Uint8ClampedArray(0),backgroundWidth:background.width,backgroundHeight:background.height,
            card:gray,cardWidth:widthPixels,cardHeight:heightPixels,near,nearEnergy,infinity,infinityEnergy,
            cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scaleY,...(imageLayer?{opticalLayer:imageLayer}:{})},[model,width,height,ppm,distance,scale,scaleY].join(':'));
          metrics[lensId]={loadDecodeMs:computeStart-loadStart,nearLoad,infinityLoad,workerRoundTripMs:performance.now()-computeStart,workerMs:result.milliseconds,...result.profile};
          return result;
        };
        const left=await makeSide(lens);
        if(!left||disposed||requestVersion!==version) return;
        const right=split?(compareLens===lens?left:await makeSide(compareLens)):null;
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
        prefetchTimer=setTimeout(()=>{
          prefetchTimer=null;if(disposed||requestVersion!==version||!backgroundReady)return;
          const dynamicModels=selectedModels.filter(model=>!(opticalLayer&&model===PSF_MODELS.zcb00));
          if(dynamicModels.length)void prefetchPsfNeighbors(base,dynamicModels,demand).catch(()=>undefined);
          if(opticalLayer)void prefetchOpticalNeighbors(base,demand,ppm*distance*1000*scale,ppm*distance*1000*scaleY).catch(()=>undefined);
        },150);
      }
      if(requestVersion===version) {error='';status='';renderMs=performance.now()-start;profile={...metrics,renderMs,inputToSubmitMs:performance.now()-scheduledAt,width,height,objectVergenceD:demand,lens,compareLens:split?compareLens:null,cssPxPerMm:ppm,viewingDistanceM:distance,psfCache:psfCacheInfo()};}
    } catch(e) {if(requestVersion===version) {error=String(e);status='';opticalProgress=null;}}
    finally {busy=false;if(dirty&&!disposed) void flush();}
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
        version++;resetWorker('Background updated');
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
  onDestroy(()=>{disposed=true;loadController.abort();backgroundController.abort();backgroundAssetHandle?.release();cancelPsfPrefetch();cancelOpticalImageLoads();if(prefetchTimer!==null)clearTimeout(prefetchTimer);if(timer!==null)clearTimeout(timer);if(typeof window!=='undefined')window.visualViewport?.removeEventListener('resize',updateViewport);observer?.disconnect();resetWorker('Scene disposed');psfDisplay?.dispose();renderer?.dispose();});
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
