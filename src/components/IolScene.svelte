<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {base} from '$app/paths';
  import {loadSceneImage} from '../lib/render/scene-assets';
  import {AssetError,waitForAsset,type AssetProgress,type LoadedImage} from '../lib/render/asset-loading';
  import {loadBackgroundAsset} from '../lib/render/background-asset';
  import LoadingProgress from './LoadingProgress.svelte';
  import {WebGLRenderer,type RenderConfig} from '../lib/render/gl/renderer';
  import {resolveBlurPolicy} from '../lib/render/blur-policy';
  import {manifest,loadPsf,prefetchPsfNeighbors,cancelPsfPrefetch,psfCacheInfo} from '../lib/render/psf/library';
  import {objectVergence,PSF_MODELS,mobileSampling,calibratedCssPxPerMm} from '../lib/render/psf/geometry';
  import {PsfDisplay} from '../lib/render/psf/display';
  import {GpuDisplay,GpuDisplayError,gpuSampling} from '../lib/render/psf/gpu-display';
  import {backgroundRegionKey} from '../lib/render/psf/scene';
  import {OpticalImageLoader,opticalDecodeBytes,opticalWorkingSet,type OpticalImageStore} from '../lib/render/psf/optical-images';
  import {OPTICAL_CACHE_BYTES,type OpticalImageRef} from '../lib/render/psf/optical-image-math';
  import {PhysicsWorkerClient} from '../lib/render/psf/worker-client';
  import {blurEngine,selectedLensId,selectedCompareLensId,masterDefocus,cssPxPerMmCal,calibrationScale,currentViewportScale,viewingDistance,splitViewEnabled,
    blurSigma,compareBlurSigma,backgroundBlurSigma,compareBackgroundBlurSigma,currentVADecimal,compareVADecimal} from '../lib/stores/app';

  let host:HTMLDivElement,canvas:HTMLCanvasElement,gpuCanvas:HTMLCanvasElement;
  let renderer:WebGLRenderer|null=null;
  let psfDisplay:PsfDisplay|null=null;
  let gpuDisplay:GpuDisplay|null=null,gpuRequested=false,gpuDisabled=false,gpuVisible=false;
  let nextGpuPaint:Promise<void>|null=null,gpuPaintId=0;
  let worker:PhysicsWorkerClient|null=null;
  let observer:ResizeObserver;
  let ready=false,disposed=false,busy=false,dirty=false,version=0;
  let error='',status='Loading reading card…',renderMs=0;
  let backgroundReady=false,backgroundLoading=true,backgroundAttempt=0;
  let backgroundError:AssetError|null=null;
  let backgroundProgress:AssetProgress|null=null,opticalProgress:AssetProgress|null=null;
  let fallbackMessage='';
  let backgroundController=new AbortController(),backgroundAssetHandle:LoadedImage|null=null,pendingBackground:LoadedImage|null=null;
  let renderController=new AbortController();
  let profile:Record<string,unknown>={},scheduledAt=0;
  let queued=false,lastRequestedKey='',backgroundRevision=0;
  let prefetchTimer:ReturnType<typeof setTimeout>|null=null;
  let background:HTMLImageElement|HTMLCanvasElement,card:HTMLImageElement;
  let loadController=new AbortController();
  let backgroundTexture='',cardTexture='';
  const cardCanvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const CARD_HEIGHT_MM=28,ASPECT=1528/1170;
  const backgroundErrorLabels={stalled:'Background download stalled',timeout:'Background download timed out',transfer:'Background download failed',
    decode:'Background image could not be decoded',native:'Browser could not load the background image',upload:'Background texture upload failed',cancelled:'Background download cancelled'};
  const cpuOpticalStore:OpticalImageStore={
    getOptical:key=>worker?.getOptical(key),
    sliceOptical:selection=>worker?.sliceOptical(selection),
    registerOptical:layer=>{ensureWorker();return worker!.registerOptical(layer);}
  };
  let opticalStore=cpuOpticalStore;
  const opticalImages=new OpticalImageLoader(cpuOpticalStore);

  function useOpticalStore(store:OpticalImageStore):void {
    if(opticalStore===store)return;
    opticalImages.useStore(store);opticalStore=store;
    if(store===cpuOpticalStore){gpuDisplay?.clearOptical();gpuDisplay?.clearBackgrounds();}
    else worker?.clearOptical();
  }

  function disableGpu(cause:unknown):void {
    gpuDisabled=true;
    useOpticalStore(cpuOpticalStore);
    gpuDisplay?.dispose();gpuDisplay=null;
    console.warn('WebGL2 composition unavailable; using CPU Physics rendering',String(cause));
  }

  function gpuContextLost(event:Event):void {
    event.preventDefault();
    if(!gpuDisplay)return;
    disableGpu('Graphics context lost');gpuVisible=false;
    gpuCanvas.width=1;gpuCanvas.height=1;
    lastRequestedKey='';schedule();
  }

  function markGpuSubmission():void {
    if(nextGpuPaint)return;
    nextGpuPaint=new Promise(resolve=>{
      gpuPaintId=requestAnimationFrame(()=>{gpuPaintId=0;nextGpuPaint=null;resolve();});
    });
  }

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

  const sceneEngine=()=>backgroundLoading&&!backgroundReady?'gaussian':$blurEngine;

  function schedule():void {
    if(!ready||disposed) return;
    const engine=sceneEngine();
    const key=JSON.stringify([engine,$selectedLensId,$splitViewEnabled?$selectedCompareLensId:null,$splitViewEnabled,$masterDefocus,
      calibratedCssPxPerMm($cssPxPerMmCal,$calibrationScale,$currentViewportScale),$viewingDistance,host.clientWidth,host.clientHeight,
      devicePixelRatio,window.visualViewport?.scale??1,backgroundRevision,
      ...(engine==='gaussian'?[$blurSigma,$compareBlurSigma,$backgroundBlurSigma,$compareBackgroundBlurSigma]:[])]);
    if(key===lastRequestedKey)return;
    lastRequestedKey=key;
    version++;dirty=true;status='Updating…';opticalProgress=null;
    renderController.abort();renderController=new AbortController();
    worker?.invalidate(version);
    if(prefetchTimer!==null){clearTimeout(prefetchTimer);prefetchTimer=null;}
    const keep=engine==='psf'?{
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
    const signal=renderController.signal;
    const engine=sceneEngine(),lens=$selectedLensId,compareLens=$selectedCompareLensId,split=$splitViewEnabled;
    const defocus=$masterDefocus,ppm=calibratedCssPxPerMm($cssPxPerMmCal,$calibrationScale,$currentViewportScale),distance=$viewingDistance;
    const sigma=$blurSigma,compareSigma=$compareBlurSigma,bgSigma=$backgroundBlurSigma,compareBgSigma=$compareBackgroundBlurSigma;
    const current=()=>!disposed&&requestVersion===version;
    try {
      const start=performance.now(),cssWidth=Math.max(1,host.clientWidth),cssHeight=Math.max(1,host.clientHeight);
      const metrics:Record<string,unknown>={engine,queueMs:start-scheduledAt,backgroundReady};
      const displayScale=(devicePixelRatio||1)*(window.visualViewport?.scale??1);
      const displayWidth=Math.max(1,Math.round(cssWidth*displayScale)),displayHeight=Math.max(1,Math.round(cssHeight*displayScale));
      fallbackMessage='';
      status=engine==='psf'?'Loading PSF library…':'Updating…';
      // Physics is computed off-thread at a bounded sampling grid; its physical
      // PSF scale uses this exact ratio. Gaussian keeps the original GPU policy.
      const library=engine==='psf'?await manifest(base,signal):null,demand=objectVergence(defocus);
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
      const sample=(at:number,near:typeof sides[number]['near'][])=>{
        const projections=[...sides.map(side=>side.infinity),...near];
        return mobileSampling(cssWidth,cssHeight,ppm,distance,near.length?at:1,CARD_HEIGHT_MM,ASPECT,
          Math.min(...projections.map(entry=>entry.retinalMmPerTanTheta)));
      };
      const near=sides.map(side=>side.near);
      // Keep the shared comparison grid even if one side uses FFT.
      let sampling=library?sample(demand,sides.length>1?near:[]):null;
      let opticalPlan:ReturnType<typeof opticalWorkingSet>|undefined;
      let renderedGpu=false;
      const physicalDensity=ppm*distance*1000;
      const cardWidthAt=(scale:number,at:number)=>Math.max(1,Math.round(CARD_HEIGHT_MM*ASPECT*distance*at*ppm*scale));
      const backgroundKeyAt=(model:string,width:number,height:number,scaleX:number,scaleY:number)=>[model,width,height,ppm,distance,scaleX,scaleY].join(':');
      if(library&&sampling){
        const opticalStart=performance.now();
        const opticalFailure=(cause:unknown)=>{
          if(current()){
            console.warn('Optical image unavailable; using the dynamic PSF renderer',String(cause));
            fallbackMessage='Optical image unavailable. Using dynamic PSF rendering.';
          }
          return null;
        };
        status='Loading optical image…';
        const select=(entry:typeof near[number],grid:ReturnType<typeof sample>,at:number,index:number)=>{
          const {width,scaleX,scaleY}=grid,mid=Math.floor(width/2);
          const visible=sides.length===2?{width,cardWidth:cardWidthAt(scaleX,at),left:index===0?0:mid,right:index===0?mid:width}:undefined;
          return opticalImages.select(base,entry,physicalDensity*scaleX,physicalDensity*scaleY,signal,visible);
        };
        const grid=sampling;
        const adjacent=[Math.round(demand*10-1)/10,Math.round(demand*10+1)/10].map(at=>{
          if(at<1||at>4)return null;
          const entries=sides.map(side=>library.entries.find(entry=>entry.model===side.model&&entry.objectVergenceD===at)!);
          return {entries,at,grid:sample(at,sides.length>1?entries:[])};
        });
        const candidates=await Promise.all(sides.map(async(side,index)=>{
          const selected=await select(side.near,grid,-defocus,index).catch(opticalFailure);
          if(!selected||signal.aborted)return [null,null,null] as const;
          const [previous,next]=await Promise.all(adjacent.map(node=>node?
            select(node.entries[index],node.grid,node.at,index).catch(()=>null):null));
          return [selected,previous,next] as const;
        }));
        if(!current())return;
        opticalPlan=opticalWorkingSet(candidates);
        const {selections}=opticalPlan;
        const loadSelections=async(nodes:typeof selections,gpu:GpuDisplay|null)=>{
          useOpticalStore(gpu??cpuOpticalStore);
          const keys=nodes.flatMap(node=>node?[node.key]:[]);
          if(gpu)gpu.reserveOptical(keys);
          else if(keys.length){ensureWorker();await worker!.reserveOptical(requestVersion,keys);}
          const loadSide=async(side:typeof sides[number],index:number)=>{
            const node=nodes[index];side.optical=null;
            if(!node||!current())return;
            side.optical=await waitForAsset(opticalImages.load(base,node,p=>{
              if(current())opticalProgress=p;
            }),signal).catch(cause=>{
              if(cause instanceof GpuDisplayError)throw cause;
              return opticalFailure(cause);
            });
          };
          const decodeBytes=nodes.reduce((sum,node)=>sum+(node&&!opticalStore.getOptical(node.key)?opticalDecodeBytes(node):0),0);
          if(decodeBytes>OPTICAL_CACHE_BYTES){
            for(const [index,side]of sides.entries())await loadSide(side,index);
          }else await Promise.all(sides.map(loadSide));
        };
        const geometry={width:grid.width,height:grid.height,cardWidth:cardWidthAt(grid.scaleX,-defocus),
          cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:grid.scaleX,renderScaleY:grid.scaleY};
        let cpuSelections=selections;
        if(gpuRequested&&!gpuDisabled&&geometry.width>=sides.length&&selections.every(node=>node&&gpuSampling(geometry,node))){
          try{
            const gpu=gpuDisplay??=new GpuDisplay(gpuCanvas);
            await loadSelections(selections,gpu);
            if(!current())return;
            if(sides.every(side=>side.optical)){
              metrics.opticalLoadMs=performance.now()-opticalStart;
              opticalProgress=null;status='Rendering optical scene…';
              const boundary=Math.floor(geometry.width/2);
              const regions=sides.map((side,index)=>{
                const left=index?boundary:0,right=sides.length===2&&!index?boundary:geometry.width;
                const backgroundKey=backgroundKeyAt(side.model,geometry.width,geometry.height,grid.scaleX,grid.scaleY);
                return {side,index,left,right,backgroundKey,key:backgroundRegionKey(backgroundKey,left,right)};
              });
              const missing=regions.filter(region=>!gpu.hasBackground(region.key));
              metrics.workerOutputBytes=0;
              if(missing.length){
                const farEnergy=await waitForAsset(farLoads,signal);
                if(!current())return;
                ensureWorker();
                const result=await worker!.prepareBackgrounds(missing.map(({side,index,left,right,backgroundKey})=>({
                  input:{width:geometry.width,height:geometry.height,backgroundWidth:background.width,backgroundHeight:background.height,
                    infinity:side.infinity,infinityEnergy:farEnergy[index],cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:grid.scaleX,renderScaleY:grid.scaleY},
                  left,right,backgroundKey
                })),requestVersion);
                if(!current())return;
                if(!result?.backgrounds)throw new GpuDisplayError('Worker background preparation failed');
                const retain=regions.map(region=>region.key);
                for(const frame of result.backgrounds)gpu.uploadBackground(frame,retain);
                metrics.workerOutputBytes=result.backgrounds.reduce((sum,frame)=>sum+frame.pixels.byteLength,0);
                for(const [index,{side}]of missing.entries())metrics[side.lensId]=result.profiles?.[index];
              }
              // Submit the first ready frame immediately and coalesce later updates before the next paint.
              if(nextGpuPaint&&!document.hidden)await waitForAsset(nextGpuPaint,signal);
              if(!current())return;
              const drawStart=performance.now();
              gpu.draw(geometry,regions.map(({side,left,right,key})=>({ref:side.optical!,left,right,backgroundKey:key})),displayWidth,displayHeight);
              metrics.drawSubmitMs=performance.now()-drawStart;
              metrics.gpuAssets=gpu.info();
              for(const side of sides)metrics[side.lensId]={...(metrics[side.lensId] as Record<string,number>|undefined),nearConvolveMs:0};
              markGpuSubmission();renderedGpu=true;
            }else cpuSelections=selections.map((node,index)=>sides[index].optical?node:null);
          }catch(cause){if(!current())return;disableGpu(cause);}
        }
        if(!renderedGpu)await loadSelections(cpuSelections,null);
        if(!current())return;
        if(sides.length===1&&!sides[0].optical)sampling=sample(demand,near);
        if(!renderedGpu)metrics.opticalLoadMs=performance.now()-opticalStart;
        metrics.composition=renderedGpu?'webgl2':'cpu';
        metrics.rendering=Object.fromEntries(sides.map(side=>[side.lensId,side.optical?'precomputed':'dynamic']));
      }
      opticalProgress=null;status=engine==='psf'?'Loading PSF data…':'Updating…';
      const desiredScale=Math.min(devicePixelRatio||1,2);
      const width=sampling?.width??Math.max(1,Math.round(cssWidth*desiredScale)),height=sampling?.height??Math.max(1,Math.round(cssHeight*desiredScale));
      const scale=width/cssWidth,scaleY=height/cssHeight;
      const heightPixels=Math.max(1,Math.round(CARD_HEIGHT_MM*distance*(-defocus)*ppm*scaleY));
      const widthPixels=cardWidthAt(scale,-defocus);
      if(widthPixels*heightPixels>4194304) throw new Error('Card exceeds available sampling memory; use a shorter viewing distance');
      const rasterCard=()=>{
        cardCanvas!.width=widthPixels;cardCanvas!.height=heightPixels;
        const ctx=cardCanvas!.getContext('2d',{willReadFrequently:true})!;
        ctx.fillStyle='white';ctx.fillRect(0,0,widthPixels,heightPixels);ctx.drawImage(card,0,0,widthPixels,heightPixels);
        return ctx;
      };
      const config:RenderConfig={width,height,blurSigma:0,nsGrade:0,pscRadius:0,pscDensity:0,pscSoftness:.2,splitView:false,splitPosition:.5};
      if(engine==='gaussian') {
        rasterCard();
        if(canvas.width!==width) canvas.width=width;
        if(canvas.height!==height) canvas.height=height;
        renderer!.updateImageTexture(cardTexture,cardCanvas!);
        const policy=(s:number)=>resolveBlurPolicy({sigmaCssRaw:s,deviceCssPxPerMm:ppm,viewingDistanceM:distance,renderPixelScale:scale}).sigmaTexelUsedFull;
        await renderer!.render(cardTexture,{...config,blurSigma:policy(sigma),compareBlurSigma:split?policy(compareSigma):undefined,
          backgroundBlurSigma:policy(bgSigma),compareBackgroundBlurSigma:split?policy(compareBgSigma):undefined,
          splitView:split,backgroundTextureId:backgroundTexture,backgroundNativeWidth:background.width,backgroundNativeHeight:background.height,
          foregroundScale:1,foregroundNativeWidth:widthPixels/scale,foregroundNativeHeight:heightPixels/scaleY});
      } else if(!renderedGpu) {
        const loadStarted=performance.now();
        const empty=new Float32Array(0);
        const [farEnergy,nearEnergy]=await waitForAsset(Promise.all([
          farLoads,Promise.all(sides.map(side=>side.optical?empty:loadKernel(side.near)))
        ]),signal);
        metrics.psfDownloads=downloads;metrics.psfLoadMs=performance.now()-loadStarted;
        if(!current())return;
        status='Rendering optical scene…';
        let gray=empty;
        if(sides.some(side=>!side.optical)){
          const pixels=rasterCard().getImageData(0,0,widthPixels,heightPixels).data;
          // Black SVG paths on white encode integrated linear radiance coverage.
          gray=new Float32Array(widthPixels*heightPixels);
          for(let i=0;i<gray.length;i++)gray[i]=pixels[4*i]/255;
        }
        const computeStart=performance.now();
        ensureWorker();
        const result=await worker!.renderFrame(sides.map(({model,near,infinity,optical},index)=>({
          input:{width,height,background:new Uint8ClampedArray(0),backgroundWidth:background.width,backgroundHeight:background.height,
            card:optical?empty:gray,cardWidth:widthPixels,cardHeight:heightPixels,near,nearEnergy:nearEnergy[index],infinity,infinityEnergy:farEnergy[index],
            cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scaleY,opticalLayer:optical??undefined},
          backgroundKey:backgroundKeyAt(model,width,height,scale,scaleY)
        })),requestVersion,true);
        if(!current()||result.cancelled||!result.data)return;
        metrics.workerRoundTripMs=performance.now()-computeStart;
        metrics.workerOutputBytes=result.data.byteLength;
        for(const [index,side]of sides.entries())metrics[side.lensId]=result.profiles?.[index];
        psfDisplay??=new PsfDisplay(canvas);
        Object.assign(metrics,psfDisplay.present(result.data,width,height,displayWidth,displayHeight));
      }
      if(engine==='psf'){
        prefetchTimer=setTimeout(()=>{
          prefetchTimer=null;if(disposed||requestVersion!==version||!backgroundReady)return;
          const dynamicModels=sides.filter(side=>!side.optical).map(side=>side.model);
          const opticalModels=sides.filter(side=>side.optical).map(side=>side.model);
          if(dynamicModels.length)void prefetchPsfNeighbors(base,dynamicModels,demand).catch(()=>undefined);
          if(opticalModels.length&&opticalPlan)void opticalImages.prefetch(base,
            opticalPlan.selections.filter(node=>node!==null),opticalPlan.neighbors.filter(node=>opticalModels.includes(node.model))).catch(()=>undefined);
        },150);
      }
      if(requestVersion===version) {
        if(gpuVisible&&!renderedGpu){gpuCanvas.width=1;gpuCanvas.height=1;}
        gpuVisible=renderedGpu;error='';status='';renderMs=performance.now()-start;
        profile={...metrics,renderMs,inputToSubmitMs:performance.now()-scheduledAt,width,height,objectVergenceD:demand,lens,
          compareLens:split?compareLens:null,cssPxPerMm:ppm,viewingDistanceM:distance,psfCache:psfCacheInfo(),workerAssets:worker?.info(),opticalLoads:opticalImages.info()};
      }
    } catch(e) {if(requestVersion===version) {lastRequestedKey='';error=String(e);status='';opticalProgress=null;}}
    finally {
      if(opticalStore===cpuOpticalStore)void worker?.reserveOptical(requestVersion,[]);
      else gpuDisplay?.reserveOptical([]);
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
        ready=true;installBackground();schedule();
      }catch(e){loadController.abort();if(!disposed){error=String(e);status='';}}
  }

  function installBackground():void {
    if(!ready||!pendingBackground)return;
    const asset=pendingBackground;pendingBackground=null;
    try {
      if(!renderer!.updateImageTexture(backgroundTexture,asset.image,true))throw new Error('WebGL rejected the background texture');
    }catch(error){
      asset.release();backgroundError=new AssetError('upload',String(error));return;
    }
    backgroundAssetHandle?.release();backgroundAssetHandle=asset;background=asset.image;backgroundReady=true;
    backgroundRevision++;
    gpuDisplay?.clearBackgrounds();
    // A worker may already be rendering the neutral background after a retry.
    if(worker)try{worker.source(backgroundPixels());}catch{resetWorker('Background changed');}
  }

  async function startBackgroundLoad():Promise<void> {
    backgroundController.abort();backgroundController=new AbortController();
    const attempt=++backgroundAttempt,signal=backgroundController.signal;
    backgroundLoading=true;backgroundError=null;backgroundProgress=null;
    pendingBackground?.release();pendingBackground=null;
    schedule();
    try {
      const asset=await loadBackgroundAsset(signal,p=>{if(!disposed&&attempt===backgroundAttempt)backgroundProgress=p;});
      if(disposed||attempt!==backgroundAttempt){asset.release();return;}
      pendingBackground=asset;installBackground();
    }catch(e){if(!disposed&&attempt===backgroundAttempt)backgroundError=e instanceof AssetError?e:new AssetError('decode',String(e));}
    finally{if(!disposed&&attempt===backgroundAttempt){backgroundLoading=false;backgroundProgress=null;schedule();}}
  }
  onMount(()=>{
    disposed=false;
    gpuRequested=new URLSearchParams(window.location.search).get('composition')==='gpu';
    if(gpuRequested)gpuCanvas.addEventListener('webglcontextlost',gpuContextLost);
    const neutral=document.createElement('canvas');neutral.width=1;neutral.height=1;
    const context=neutral.getContext('2d')!;context.fillStyle='#eeeeee';context.fillRect(0,0,1,1);background=neutral;
    updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);
    void startBackgroundLoad();
    void initializeScene();
  });
  function updateViewport():void {currentViewportScale.set(window.visualViewport?.scale??1);schedule();}
  onDestroy(()=>{disposed=true;loadController.abort();backgroundController.abort();renderController.abort();pendingBackground?.release();backgroundAssetHandle?.release();cancelPsfPrefetch();opticalImages.cancel();if(prefetchTimer!==null)clearTimeout(prefetchTimer);if(gpuPaintId)cancelAnimationFrame(gpuPaintId);gpuCanvas?.removeEventListener('webglcontextlost',gpuContextLost);if(typeof window!=='undefined')window.visualViewport?.removeEventListener('resize',updateViewport);observer?.disconnect();resetWorker('Scene disposed');gpuDisplay?.dispose();psfDisplay?.dispose();renderer?.dispose();});
  $: if(ready) {void [$blurEngine,$selectedLensId,$selectedCompareLensId,$masterDefocus,$cssPxPerMmCal,$calibrationScale,$currentViewportScale,$viewingDistance,$splitViewEnabled,
    $blurSigma,$compareBlurSigma,$backgroundBlurSigma,$compareBackgroundBlurSigma];schedule();}
  $: physicsLabel=backgroundLoading?'Gaussian preview':gpuRequested&&profile.engine==='psf'?`OPTrace PSF · ${gpuVisible?'GPU':'CPU'}`:'OPTrace PSF';
</script>

<div class="scene" bind:this={host} data-scene-state={!ready?'initializing':profile.backgroundReady?'complete':'partial'}>
  <canvas bind:this={canvas} data-render-ms={Math.round(renderMs)} data-profile={JSON.stringify(profile)} aria-label="IOL vision simulation canvas (WebGL)"></canvas>
  <canvas bind:this={gpuCanvas} class="gpu-canvas" class:visible={gpuVisible} aria-hidden="true"></canvas>
  <div class="loading-stack">
    {#if !ready&&status}<LoadingProgress label={status} detail="Controls are available while the scene loads." />{/if}
    {#if backgroundLoading}<LoadingProgress label="Loading background" progress={backgroundProgress} detail={$blurEngine==='psf'?'Physics will start after the background loads.':ready?'Near chart is available. The complete scene is still loading.':'The chart loads separately.'} />{/if}
    {#if ready&&status}<div class="status"><LoadingProgress label={status} progress={opticalProgress} /></div>{/if}
    {#if backgroundError}<div class="error" role="alert" data-background-error={backgroundError.code}><strong>{backgroundErrorLabels[backgroundError.code]}</strong><p>{ready?'The near chart remains available on a neutral background.':'Controls remain available. The background can be retried separately from the chart.'}</p><details><summary>Error details</summary>{backgroundError.message}</details><button on:click={()=>void startBackgroundLoad()}>Retry background</button></div>{/if}
    {#if error}<div class="error" role="alert"><p>{error}</p><button on:click={()=>ready?schedule():void initializeScene()}>{ready?'Retry rendering':'Retry chart'}</button>{#if $blurEngine==='psf'}<button on:click={()=>blurEngine.set('gaussian')}>Use Gaussian</button>{/if}</div>{/if}
    {#if fallbackMessage&&!status}<div class="notice" role="status">{fallbackMessage}</div>{/if}
  </div>
  <div class="readout">
    <span>{$blurEngine==='psf'?physicsLabel:`VA ~ ${$currentVADecimal.toFixed(2)}`}</span>
    {#if $splitViewEnabled}<span>{$blurEngine==='psf'?physicsLabel:`VA ~ ${$compareVADecimal.toFixed(2)}`}</span>{/if}
  </div>
  <span class="distance">{$masterDefocus.toFixed(1)} D / {Math.round(-100/$masterDefocus)} cm</span>
</div>

<style>
  .scene{position:relative;width:100%;height:100%;overflow:hidden;background:#eee}
  canvas{display:block;width:100%;height:100%}
  .gpu-canvas{position:absolute;inset:0;visibility:hidden;pointer-events:none}
  .gpu-canvas.visible{visibility:visible}
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
