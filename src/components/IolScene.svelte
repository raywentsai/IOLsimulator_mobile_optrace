<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {base} from '$app/paths';
  import readingCard from '../../static/reading-card.json';
  import {loadSceneImage} from '../lib/render/scene-assets';
  import {AssetError,allowSpeculativeLoads,waitForAsset,type AssetProgress,type LoadedImage} from '../lib/render/asset-loading';
  import {loadBackgroundAsset} from '../lib/render/background-asset';
  import LoadingProgress from './LoadingProgress.svelte';
  import {WebGLRenderer} from '../lib/render/gl/renderer';
  import {angularSigmaPixels} from '../lib/optics/angular-scale';
  import {manifest,loadPsf,prefetchPsfNeighbors,cancelPsfPrefetch,psfCacheInfo,type PsfManifest} from '../lib/render/psf/library';
  import {objectVergence,mobileSampling,type PsfEntry} from '../lib/render/psf/geometry';
  import {PsfDisplay} from '../lib/render/psf/display';
  import {GpuDisplay,GpuDisplayError,gpuSampling,prepareGpuSides} from '../lib/render/psf/gpu-display';
  import {backgroundRegionKey} from '../lib/render/psf/scene';
  import {OpticalImageLoader,opticalDecodeBytes,opticalWorkingSet,type OpticalImageStore} from '../lib/render/psf/optical-images';
  import {OPTICAL_CACHE_BYTES,type OpticalImageRef} from '../lib/render/psf/optical-image-math';
  import {PhysicsWorkerClient} from '../lib/render/psf/worker-client';
  import {simulationMethod,physicsSelection,acuitySelection,masterDefocus,splitViewEnabled,
    primaryAcuity,comparisonAcuity} from '../lib/stores/app';
  import {effectiveCssPxPerMm,viewingDistance,viewport} from '../lib/stores/display';
  import type {AcuityIolId,PhysicsIolId} from '../lib/data/iol-models';

  type SceneModels={method:'acuity';lens:AcuityIolId;compareLens:AcuityIolId|null}|
    {method:'physics';lens:PhysicsIolId;compareLens:PhysicsIolId|null};
  type SceneConfiguration=SceneModels&{
    key:string;engine:'gaussian'|'psf';ppm:number;distance:number;
    cssWidth:number;cssHeight:number;dpr:number;displayWidth:number;displayHeight:number;backgroundReady:boolean;
  };
  type FrameAcuity={primary:typeof $primaryAcuity;comparison:typeof $comparisonAcuity|null};
  type FrameRequest={scene:SceneConfiguration;defocus:number;direction:number;acuity:FrameAcuity|null;scheduledAt:number;startedAt?:number};
  type SceneSide={lensId:string;model:string;near:PsfEntry;infinity:PsfEntry;optical:OpticalImageRef|null};
  type Grid=ReturnType<typeof mobileSampling>;
  type OpticalPlan=ReturnType<typeof opticalWorkingSet>;
  type WarmFrame={
    width:number;height:number;sides:ReturnType<typeof prepareGpuSides>;
    library:PsfManifest;plan:OpticalPlan;rendering:Record<string,string>;prefetched?:boolean;
  };

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
  let diagnostics=false,profile:Record<string,unknown>={};
  let displayedScene:SceneConfiguration|null=null;
  let configuration:SceneConfiguration|null=null,request:FrameRequest|null=null;
  let queued=false,backgroundRevision=0,viewportRevision=0,preparedVersion=0;
  const warmFrames=new Map<number,WarmFrame>();
  let displayedGpu:WarmFrame|null=null,lastCpuKeys:string[]=[];
  let displayedDefocus:number|null=null;
  let displayedAcuity:FrameAcuity|null=null;
  let prefetchTimer:ReturnType<typeof setTimeout>|null=null;
  let prediction:{scene:SceneConfiguration;demand:number;controller:AbortController}|null=null;
  let background:HTMLImageElement|HTMLCanvasElement,card:HTMLImageElement;
  let loadController=new AbortController();
  let backgroundTexture='',cardTexture='';
  const cardCanvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  const CARD_HEIGHT_MM=readingCard.objectHeightMm,ASPECT=readingCard.objectWidthMm/CARD_HEIGHT_MM;
  const MAX_CARD_PIXELS=4194304;
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
    if(store===cpuOpticalStore){
      prediction?.controller.abort();
      gpuDisplay?.retainFrame(displayedGpu?.sides??[]);
    }else worker?.retainOptical(lastCpuKeys);
  }

  function disableGpu(cause:unknown):void {
    gpuDisabled=true;
    useOpticalStore(cpuOpticalStore);
    gpuDisplay?.dispose();gpuDisplay=null;
    warmFrames.clear();displayedGpu=null;
    console.warn('WebGL2 composition unavailable; using CPU Physics rendering',String(cause));
  }

  function gpuContextLost(event:Event):void {
    event.preventDefault();
    if(!gpuDisplay)return;
    disableGpu('Graphics context lost');gpuVisible=false;
    displayedScene=null;
    gpuCanvas.width=1;gpuCanvas.height=1;
    retryRendering();
  }

  function markGpuSubmission():void {
    if(nextGpuPaint)return;
    nextGpuPaint=new Promise(resolve=>{
      gpuPaintId=requestAnimationFrame(()=>{
        gpuPaintId=0;nextGpuPaint=null;resolve();
        if(!busy&&dirty)void flush();
      });
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

  function readConfiguration(previous:SceneConfiguration|null):SceneConfiguration {
    const models:SceneModels=$simulationMethod==='physics'?
      {method:'physics',lens:$physicsSelection.primary,compareLens:$splitViewEnabled?$physicsSelection.compare:null}:
      {method:'acuity',lens:$acuitySelection.primary,compareLens:$splitViewEnabled?$acuitySelection.compare:null};
    const engine=models.method==='physics'&&(!backgroundLoading||backgroundReady)?'psf':'gaussian';
    const ppm=$effectiveCssPxPerMm,distance=$viewingDistance;
    const cssWidth=Math.max(1,host.clientWidth),cssHeight=Math.max(1,host.clientHeight);
    const {dpr,zoom}=$viewport,displayScale=dpr*zoom;
    const displayWidth=Math.max(1,Math.round(cssWidth*displayScale)),displayHeight=Math.max(1,Math.round(cssHeight*displayScale));
    const key=JSON.stringify([models.method,engine,models.lens,models.compareLens,ppm,distance,cssWidth,cssHeight,dpr,displayWidth,displayHeight,backgroundRevision]);
    if(previous?.key===key)return previous;
    warmFrames.clear();
    return {...models,key,engine,ppm,distance,cssWidth,cssHeight,dpr,displayWidth,displayHeight,backgroundReady};
  }

  function opticalRequest({scene,defocus}:FrameRequest) {
    return scene.engine==='psf'&&scene.method==='physics'?{
      models:scene.compareLens===null?[scene.lens]:[scene.lens,scene.compareLens],
      demand:objectVergence(defocus)
    }:undefined;
  }

  function prepareRequest(frame:FrameRequest):void {
    if(preparedVersion===version)return;
    preparedVersion=version;
    renderController.abort();renderController=new AbortController();
    worker?.invalidate(version);
    const keep=opticalRequest(frame);
    cancelPsfPrefetch(keep);
    opticalImages.cancel(keep);
  }

  function schedule(scene:SceneConfiguration,defocus:number):void {
    if(disposed)return;
    const acuity=scene.method==='acuity'?{primary:$primaryAcuity,comparison:scene.compareLens?$comparisonAcuity:null}:null;
    const previous=request;
    if(previous?.scene===scene&&previous.defocus===defocus&&
      previous.acuity?.primary===acuity?.primary&&previous.acuity?.comparison===acuity?.comparison)return;
    const direction=previous?.scene===scene?Math.sign(previous.defocus-defocus):0;
    request={scene,defocus,direction,acuity,scheduledAt:diagnostics?performance.now():0};
    version++;dirty=true;
    if(prefetchTimer!==null){clearTimeout(prefetchTimer);prefetchTimer=null;}
    if(prediction&&(prediction.scene!==scene||prediction.demand!==-defocus)){
      prediction.controller.abort();
      opticalImages.cancel(opticalRequest(request));
    }
    // A cold render may be awaiting a manifest, transfer, or Worker response.
    if(busy)prepareRequest(request);
    if(!queued&&!busy){queued=true;queueMicrotask(()=>{queued=false;void flush();});}
  }

  function retryRendering():void {
    request=null;
    if(configuration)schedule(configuration,$masterDefocus);
  }

  function schedulePrefetch(requestVersion:number,demand:number,dynamicModels:string[],plan?:ReturnType<typeof opticalWorkingSet>):void {
    prefetchTimer=setTimeout(()=>{
      prefetchTimer=null;if(disposed||requestVersion!==version||!backgroundReady)return;
      if(dynamicModels.length)void prefetchPsfNeighbors(base,dynamicModels,demand).catch(()=>undefined);
      if(plan)void opticalImages.prefetch(base,plan.selections.filter(node=>node!==null),plan.neighbors).catch(()=>undefined);
    },150);
  }

  function sceneSides(scene:SceneConfiguration,library:PsfManifest,demand:number):SceneSide[] {
    if(scene.method!=='physics')throw new Error('A physics model is required');
    const {lens,compareLens}=scene;
    return [...new Set(compareLens===null?[lens]:[lens,compareLens])].map(lensId=>{
      const model=lensId;
      const near=library.entries.find(entry=>entry.model===model&&entry.objectVergenceD===demand);
      const infinity=library.entries.find(entry=>entry.model===model&&entry.objectVergenceD===0);
      if(!near||!infinity)throw new Error('Requested PSF is missing');
      return {lensId,model,near,infinity,optical:null};
    });
  }

  const cardWidthAt=(scene:SceneConfiguration,scale:number,at:number)=>
    Math.max(1,Math.round(readingCard.objectWidthMm*scene.distance*at*scene.ppm*scale));
  const cardHeightAt=(scene:SceneConfiguration,scale:number,at:number)=>
    Math.max(1,Math.round(CARD_HEIGHT_MM*scene.distance*at*scene.ppm*scale));
  const backgroundKeyAt=(scene:SceneConfiguration,model:string,{width,height,scaleX,scaleY}:Grid)=>
    [model,width,height,scene.ppm,scene.distance,scaleX,scaleY].join(':');

  function sample(scene:SceneConfiguration,sides:SceneSide[],demand:number,includeNear:boolean):Grid {
    const {cssWidth,cssHeight,ppm,distance}=scene;
    const projections=sides.flatMap(side=>includeNear?[side.infinity,side.near]:[side.infinity]);
    return mobileSampling(cssWidth,cssHeight,ppm,distance,includeNear?demand:1,CARD_HEIGHT_MM,ASPECT,
      Math.min(...projections.map(entry=>entry.retinalMmPerTanTheta)));
  }

  async function planOptics(scene:SceneConfiguration,library:PsfManifest,sides:SceneSide[],grid:Grid,defocus:number,signal:AbortSignal,
    opticalFailure:(cause:unknown)=>null=()=>null):Promise<OpticalPlan> {
    const demand=objectVergence(defocus),density=scene.ppm*scene.distance*1000;
    const select=(entry:PsfEntry,{width,scaleX,scaleY}:Grid,at:number,index:number)=>{
      const mid=Math.floor(width/2);
      const cardWidth=cardWidthAt(scene,scaleX,at);
      const visible=sides.length===2?{width,cardWidth,left:index===0?0:mid,right:index===0?mid:width}:
        cardWidth>width?{width,cardWidth,left:0,right:width}:undefined;
      return opticalImages.select(base,entry,density*scaleX,density*scaleY,signal,visible);
    };
    const adjacent=[Math.round(demand*10-1)/10,Math.round(demand*10+1)/10].map(at=>{
      if(at<1||at>4)return null;
      const neighbors=sceneSides(scene,library,at);
      return {neighbors,at,grid:sample(scene,neighbors,at,sides.length>1)};
    });
    const candidates=await Promise.all(sides.map(async(side,index)=>{
      const selected=await select(side.near,grid,-defocus,index).catch(opticalFailure);
      if(!selected||signal.aborted)return [null,null,null] as const;
      const [previous,next]=await Promise.all(adjacent.map(node=>node?
        select(node.neighbors[index].near,node.grid,node.at,index).catch(()=>null):null));
      return [selected,previous,next] as const;
    }));
    return opticalWorkingSet(candidates);
  }

  function gpuFrame(scene:SceneConfiguration,library:PsfManifest,sides:SceneSide[],grid:Grid,plan:OpticalPlan,at:number) {
    const {width,height,scaleX,scaleY}=grid;
    const geometry={width,height,cardWidth:cardWidthAt(scene,scaleX,at),cssPxPerMm:scene.ppm,
      viewingDistanceM:scene.distance,renderScale:scaleX,renderScaleY:scaleY};
    const {selections}=plan;
    if(width<sides.length||!selections.every(node=>node&&gpuSampling(geometry,node)))return null;
    const boundary=Math.floor(width/2);
    const regions=sides.map((side,index)=>{
      const left=index?boundary:0,right=sides.length===2&&!index?boundary:width;
      const backgroundKey=backgroundKeyAt(scene,side.model,grid);
      return {side,index,left,right,backgroundKey,key:backgroundRegionKey(backgroundKey,left,right)};
    });
    const frame:WarmFrame={width,height,library,plan,
      sides:prepareGpuSides(geometry,regions.map(({index,left,right,key})=>({ref:selections[index]!,left,right,backgroundKey:key}))),
      rendering:Object.fromEntries(sides.map(side=>[side.lensId,'precomputed']))};
    return {frame,regions};
  }

  function scheduleGpuPrefetch(frame:FrameRequest,gpu:GpuDisplay,warm:WarmFrame):void {
    if(!frame.scene.backgroundReady||!allowSpeculativeLoads())return;
    const demand=Math.round(-frame.defocus*10+(frame.direction||(frame.defocus<=-4?-1:1)))/10;
    if(demand<1||demand>4)return;
    const known=warmFrames.get(-demand);
    if(known&&gpu.hasFrame(known.sides))return;
    const requestVersion=version;
    prefetchTimer=setTimeout(()=>{
      prefetchTimer=null;
      if(disposed||requestVersion!==version||prediction||opticalStore!==gpu)return;
      const task={scene:frame.scene,demand,controller:new AbortController()};
      prediction=task;
      void prefetchGpuFrame(task,gpu,warm).finally(()=>{prediction=null;});
    },0);
  }

  async function prefetchGpuFrame(task:NonNullable<typeof prediction>,gpu:GpuDisplay,warm:WarmFrame):Promise<void> {
    const {scene,demand,controller:{signal}}=task;
    try{
      const {library}=warm,sides=sceneSides(scene,library,demand);
      const grid=sample(scene,sides,demand,sides.length>1);
      const plan=await planOptics(scene,library,sides,grid,-demand,signal);
      if(signal.aborted||busy||opticalStore!==gpu)return;
      const next=gpuFrame(scene,library,sides,grid,plan,demand)?.frame;
      if(!next||!next.sides.every(side=>gpu.hasBackground(side.backgroundKey)))return;
      await opticalImages.prefetch(base,warm.plan.selections.filter(node=>node!==null),plan.selections.filter(node=>node!==null),signal);
      if(!signal.aborted&&configuration===scene&&gpu.hasFrame(next.sides)&&!warmFrames.has(-demand))
        warmFrames.set(-demand,{...next,prefetched:true});
    }catch{/* Speculation may be retried by a foreground request. */}
  }

  function presentFrame(frame:FrameRequest,renderedGpu:boolean):void {
    if(gpuVisible&&!renderedGpu){gpuCanvas.width=1;gpuCanvas.height=1;}
    gpuVisible=renderedGpu;displayedScene=frame.scene;
    displayedDefocus=frame.defocus;
    displayedAcuity=frame.acuity;
    if(renderedGpu)fallbackMessage='';
    error='';status='';opticalProgress=null;
  }

  function report(frame:FrameRequest,metrics:Record<string,unknown>,start:number,submittedAtMs:number,width:number,height:number,demand:number):void {
    const {scene,scheduledAt}=frame;
    renderMs=submittedAtMs-start;
    profile={...metrics,method:scene.method,engine:scene.engine,backgroundReady:scene.backgroundReady,queueMs:start-scheduledAt,renderMs,
      submittedAtMs,inputToSubmitMs:submittedAtMs-scheduledAt,width,height,objectVergenceD:demand,lens:scene.lens,
      compareLens:scene.compareLens,cssPxPerMm:scene.ppm,viewingDistanceM:scene.distance,
      psfCache:psfCacheInfo(),workerAssets:worker?.info(),gpuAssets:gpuDisplay?.info(),opticalLoads:opticalImages.info()};
  }

  async function flush():Promise<void> {
    if(busy||!dirty||disposed||!request)return;
    const frame=request,{scene,defocus,acuity}=frame;
    const {engine,lens,compareLens,ppm,distance,cssWidth,cssHeight,dpr,displayWidth,displayHeight}=scene;
    const split=compareLens!==null;
    const warm=engine==='psf'?warmFrames.get(defocus):undefined,gpu=gpuDisplay;
    const start=diagnostics?(frame.startedAt??=performance.now()):0;
    if(warm&&gpu?.hasFrame(warm.sides)){
      if(nextGpuPaint&&!document.hidden)return;
      const drawStart=diagnostics?performance.now():0;
      try{
        if(gpu.drawResident(warm,warm.sides,displayWidth,displayHeight)){
          const submittedAt=diagnostics?performance.now():0;
          const path=warm.prefetched?'prefetched-gpu':'warm-gpu';
          warm.prefetched=false;
          useOpticalStore(gpu);
          displayedGpu=warm;
          dirty=false;
          markGpuSubmission();
          presentFrame(frame,true);
          scheduleGpuPrefetch(frame,gpu,warm);
          if(diagnostics)report(frame,{path,composition:'webgl2',rendering:warm.rendering,
            assetsReadyMs:0,paintWaitMs:drawStart-start,drawSubmitMs:submittedAt-drawStart,workerOutputBytes:0},
            start,submittedAt,warm.width,warm.height,-defocus);
          return;
        }
      }catch(cause){disableGpu(cause);}
    }
    prepareRequest(frame);
    busy=true;dirty=false;const requestVersion=version;
    const signal=renderController.signal;
    const current=()=>!disposed&&requestVersion===version;
    try {
      const metrics:Record<string,unknown>={path:'full'};
      fallbackMessage='';
      status=engine==='psf'?'Loading PSF library…':'Updating…';
      // Physics is computed off-thread at a bounded sampling grid; its physical
      // PSF scale uses this exact ratio. Gaussian keeps the original GPU policy.
      const library=engine==='psf'?await manifest(base,signal):null,demand=objectVergence(defocus);
      if(!current())return;
      const sides=library?sceneSides(scene,library,demand):[];
      const downloads:Record<string,Record<string,number>>={};
      const loadKernel=(entry:typeof sides[number]['near'])=>{
        const record:Record<string,number>={};
        downloads[entry.file]=record;
        return loadPsf(base,entry,record);
      };
      const farLoads=Promise.all(sides.map(side=>loadKernel(side.infinity)));
      // Infinity downloads can overlap optical loading, including cancelled frames.
      void farLoads.catch(()=>undefined);
      // Keep the shared comparison grid even if one side uses FFT.
      let sampling=library?sample(scene,sides,demand,sides.length>1):null;
      let opticalPlan:OpticalPlan|undefined;
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
        const grid=sampling;
        opticalPlan=await planOptics(scene,library,sides,grid,defocus,signal,opticalFailure);
        if(!current())return;
        const {selections}=opticalPlan;
        const loadSelections=async(nodes:typeof selections,gpu:GpuDisplay|null)=>{
          useOpticalStore(gpu??cpuOpticalStore);
          const keys=nodes.flatMap(node=>node?[node.key]:[]);
          if(gpu)gpu.reserveOptical(keys);
          else if(keys.length){ensureWorker();await waitForAsset(worker!.reserveOptical(requestVersion,keys),signal);}
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
        let cpuSelections=selections;
        const candidate=gpuRequested&&!gpuDisabled?gpuFrame(scene,library,sides,grid,opticalPlan,-defocus):null;
        if(candidate){
          try{
            const {frame:warm,regions}=candidate;
            const gpu=gpuDisplay??=new GpuDisplay(gpuCanvas);
            await loadSelections(selections,gpu);
            if(!current())return;
            if(sides.every(side=>side.optical)){
              metrics.opticalLoadMs=performance.now()-opticalStart;
              opticalProgress=null;status='Rendering optical scene…';
              const missing=regions.filter(region=>!gpu.hasBackground(region.key));
              metrics.workerOutputBytes=0;
              if(missing.length){
                const farEnergy=await waitForAsset(farLoads,signal);
                if(!current())return;
                ensureWorker();
                const result=await waitForAsset(worker!.prepareBackgrounds(missing.map(({side,index,left,right,backgroundKey})=>({
                  input:{width:warm.width,height:warm.height,backgroundWidth:background.width,backgroundHeight:background.height,
                    infinity:side.infinity,infinityEnergy:farEnergy[index],cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:grid.scaleX,renderScaleY:grid.scaleY},
                  left,right,backgroundKey
                })),requestVersion),signal);
                if(!current())return;
                if(!result?.backgrounds)throw new GpuDisplayError('Worker background preparation failed');
                const retain=regions.map(region=>region.key);
                for(const frame of result.backgrounds)gpu.uploadBackground(frame,retain);
                metrics.workerOutputBytes=result.backgrounds.reduce((sum,frame)=>sum+frame.pixels.byteLength,0);
                for(const [index,{side}]of missing.entries())metrics[side.lensId]=result.profiles?.[index];
              }
              const readyAt=diagnostics?performance.now():0;
              if(nextGpuPaint&&!document.hidden)await waitForAsset(nextGpuPaint,signal);
              if(!current())return;
              const drawStart=diagnostics?performance.now():0;
              if(!gpu.drawResident(warm,warm.sides,displayWidth,displayHeight))throw new GpuDisplayError('GPU frame assets unavailable');
              const submittedAt=diagnostics?performance.now():0;
              if(defocus===-demand)warmFrames.set(defocus,warm);
              displayedGpu=warm;
              markGpuSubmission();
              presentFrame(frame,true);
              scheduleGpuPrefetch(frame,gpu,warm);
              if(diagnostics){
                for(const side of sides)metrics[side.lensId]={...(metrics[side.lensId] as Record<string,number>|undefined),nearConvolveMs:0};
                report(frame,{...metrics,assetsReadyMs:readyAt-start,paintWaitMs:drawStart-readyAt,
                  drawSubmitMs:submittedAt-drawStart,composition:'webgl2',rendering:warm.rendering},
                  start,submittedAt,warm.width,warm.height,demand);
              }
              return;
            }else cpuSelections=selections.map((node,index)=>sides[index].optical?node:null);
          }catch(cause){if(!current())return;disableGpu(cause);}
        }
        await loadSelections(cpuSelections,null);
        if(!current())return;
        if(sides.length===1&&!sides[0].optical)sampling=sample(scene,sides,demand,true);
        metrics.opticalLoadMs=performance.now()-opticalStart;
        metrics.composition='cpu';
        metrics.rendering=Object.fromEntries(sides.map(side=>[side.lensId,side.optical?'precomputed':'dynamic']));
      }
      opticalProgress=null;status=engine==='psf'?'Loading PSF data…':'Updating…';
      const physicalCardArea=readingCard.objectWidthMm*CARD_HEIGHT_MM*(ppm*distance*defocus)**2;
      const desiredScale=Math.min(dpr,2,Math.sqrt(4000000/physicalCardArea));
      const width=sampling?.width??Math.max(1,Math.round(cssWidth*desiredScale)),height=sampling?.height??Math.max(1,Math.round(cssHeight*desiredScale));
      const scale=width/cssWidth,scaleY=height/cssHeight;
      const heightPixels=cardHeightAt(scene,scaleY,-defocus);
      const widthPixels=cardWidthAt(scene,scale,-defocus);
      const rasterCard=()=>{
        if(widthPixels*heightPixels>MAX_CARD_PIXELS)
          throw new Error('Card exceeds available sampling memory; use a shorter viewing distance');
        cardCanvas!.width=widthPixels;cardCanvas!.height=heightPixels;
        const ctx=cardCanvas!.getContext('2d',{willReadFrequently:true})!;
        ctx.fillStyle='white';ctx.fillRect(0,0,widthPixels,heightPixels);ctx.drawImage(card,0,0,widthPixels,heightPixels);
        return ctx;
      };
      let drawStart=0;
      if(engine==='gaussian') {
        rasterCard();
        if(canvas.width!==width) canvas.width=width;
        if(canvas.height!==height) canvas.height=height;
        renderer!.updateImageTexture(cardTexture,cardCanvas!);
        const sigmaPx=(arcmin=0)=>angularSigmaPixels(arcmin,distance,ppm*scale);
        if(diagnostics){drawStart=performance.now();metrics.assetsReadyMs=drawStart-start;}
        await renderer!.render(cardTexture,{width,height,splitPosition:.5,blurSigma:sigmaPx(acuity?.primary.nearSigmaArcmin),
          compareBlurSigma:split?sigmaPx(acuity?.comparison?.nearSigmaArcmin):undefined,
          backgroundBlurSigma:sigmaPx(acuity?.primary.farSigmaArcmin),
          compareBackgroundBlurSigma:split?sigmaPx(acuity?.comparison?.farSigmaArcmin):undefined,
          splitView:split,backgroundTextureId:backgroundTexture,backgroundNativeWidth:background.width,backgroundNativeHeight:background.height,
          foregroundScale:1,foregroundNativeWidth:widthPixels/scale,foregroundNativeHeight:heightPixels/scaleY});
      } else {
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
        if(diagnostics)metrics.assetsReadyMs=computeStart-start;
        ensureWorker();
        const result=await waitForAsset(worker!.renderFrame(sides.map(({model,near,infinity,optical},index)=>({
          input:{width,height,background:new Uint8ClampedArray(0),backgroundWidth:background.width,backgroundHeight:background.height,
            card:optical?empty:gray,cardWidth:widthPixels,cardHeight:heightPixels,near,nearEnergy:nearEnergy[index],infinity,infinityEnergy:farEnergy[index],
            cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scaleY,opticalLayer:optical??undefined},
          backgroundKey:backgroundKeyAt(scene,model,{width,height,scaleX:scale,scaleY})
        })),requestVersion,true),signal);
        if(!current()||result.cancelled||!result.data)return;
        metrics.workerRoundTripMs=performance.now()-computeStart;
        metrics.workerOutputBytes=result.data.byteLength;
        for(const [index,side]of sides.entries())metrics[side.lensId]=result.profiles?.[index];
        psfDisplay??=new PsfDisplay(canvas);
        if(diagnostics)drawStart=performance.now();
        Object.assign(metrics,psfDisplay.present(result.data,width,height,displayWidth,displayHeight));
        lastCpuKeys=sides.flatMap(side=>side.optical?[side.optical.key]:[]);
      }
      const submittedAt=diagnostics?performance.now():0;
      if(engine==='psf'){
        const dynamicModels=sides.filter(side=>!side.optical).map(side=>side.model);
        const opticalModels=sides.filter(side=>side.optical).map(side=>side.model);
        schedulePrefetch(requestVersion,demand,dynamicModels,opticalModels.length&&opticalPlan?{
          selections:opticalPlan.selections,neighbors:opticalPlan.neighbors.filter(node=>opticalModels.includes(node.model))
        }:undefined);
      }
      if(requestVersion===version) {
        presentFrame(frame,false);
        if(diagnostics)report(frame,{...metrics,drawSubmitMs:submittedAt-drawStart},start,submittedAt,width,height,demand);
      }
    } catch(e) {if(requestVersion===version) {request=null;error=String(e);status='';opticalProgress=null;}}
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
        card=await loadSceneImage(`${base}/reading-card.svg?v=${readingCard.assetSha256}`,signal,15000,1);
        if(disposed) return;
        status='Preparing card…';
        // The card becomes usable independently of the large background.
        renderer?.dispose();renderer=new WebGLRenderer(canvas);
        await renderer.initialize();
        if(disposed)return;
        backgroundTexture=await renderer.loadImageTexture(background);
        // The first Gaussian frame uploads the actual sampled card; avoid
        // uploading its much larger native SVG raster during initialization.
        cardCanvas!.width=1;cardCanvas!.height=1;
        cardTexture=await renderer.loadImageTexture(cardCanvas!);
        observer=new ResizeObserver(resizeScene);observer.observe(host);
        ready=true;installBackground();
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
    try {
      const asset=await loadBackgroundAsset(signal,p=>{if(!disposed&&attempt===backgroundAttempt)backgroundProgress=p;});
      if(disposed||attempt!==backgroundAttempt){asset.release();return;}
      pendingBackground=asset;installBackground();
    }catch(e){if(!disposed&&attempt===backgroundAttempt)backgroundError=e instanceof AssetError?e:new AssetError('decode',String(e));}
    finally{if(!disposed&&attempt===backgroundAttempt){backgroundLoading=false;backgroundProgress=null;}}
  }
  onMount(()=>{
    disposed=false;
    const params=new URLSearchParams(window.location.search);
    gpuRequested=params.get('composition')!=='cpu';diagnostics=params.get('diagnostics')==='1';
    if(gpuRequested)gpuCanvas.addEventListener('webglcontextlost',gpuContextLost);
    const neutral=document.createElement('canvas');neutral.width=1;neutral.height=1;
    const context=neutral.getContext('2d')!;context.fillStyle='#eeeeee';context.fillRect(0,0,1,1);background=neutral;
    void startBackgroundLoad();
    void initializeScene();
  });
  function resizeScene():void {viewportRevision++;}
  onDestroy(()=>{
    disposed=true;loadController.abort();backgroundController.abort();renderController.abort();pendingBackground?.release();backgroundAssetHandle?.release();
    prediction?.controller.abort();cancelPsfPrefetch();opticalImages.cancel();
    if(prefetchTimer!==null)clearTimeout(prefetchTimer);if(gpuPaintId)cancelAnimationFrame(gpuPaintId);
    gpuCanvas?.removeEventListener('webglcontextlost',gpuContextLost);
    observer?.disconnect();resetWorker('Scene disposed');gpuDisplay?.dispose();psfDisplay?.dispose();renderer?.dispose();
  });
  $: if(ready) {
    void [$simulationMethod,$physicsSelection,$acuitySelection,$splitViewEnabled,$effectiveCssPxPerMm,$viewport,$viewingDistance,
      backgroundLoading,backgroundReady,backgroundRevision,viewportRevision];
    configuration=readConfiguration(configuration);
  }
  $: if(configuration) {
    void [$primaryAcuity,$comparisonAcuity];
    schedule(configuration,$masterDefocus);
  }
  $: matchingScene=displayedScene!==null&&displayedScene.method===configuration?.method&&
    displayedScene.lens===configuration.lens&&displayedScene.compareLens===configuration.compareLens;
  function acuityLabel(side:FrameAcuity['primary']):string {
    if(!side.curve)return 'Clinical defocus curve pending';
    if(side.near===null||side.far===null)return 'Outside measured defocus range';
    return `VA ≈ ${(10 ** -side.near).toFixed(2)} · binocular`;
  }
</script>

<div class="scene" bind:this={host} data-scene-state={!ready?'initializing':displayedScene?.backgroundReady?'complete':'partial'}>
  <canvas bind:this={canvas} data-render-ms={diagnostics?Math.round(renderMs):undefined} data-profile={diagnostics?JSON.stringify(profile):undefined} aria-label="IOL vision simulation canvas (WebGL)"></canvas>
  <canvas bind:this={gpuCanvas} class="gpu-canvas" class:visible={gpuVisible} aria-hidden="true"></canvas>
  <div class="loading-stack">
    {#if !ready&&status}<LoadingProgress label={status} detail="Controls are available while the scene loads." />{/if}
    {#if backgroundLoading}<LoadingProgress label="Loading background" progress={backgroundProgress} detail={$simulationMethod==='physics'?'Physics-based rendering will start after the background loads.':ready?'Near card is available. The complete scene is still loading.':'The card loads separately.'} />{/if}
    {#if ready&&status}<div class="status"><LoadingProgress label={status} progress={opticalProgress} /></div>{/if}
    {#if backgroundError}<div class="error" role="alert" data-background-error={backgroundError.code}><strong>{backgroundErrorLabels[backgroundError.code]}</strong><p>{ready?'The near card remains available on a neutral background.':'Controls remain available. The background can be retried separately from the card.'}</p><details><summary>Error details</summary>{backgroundError.message}</details><button on:click={()=>void startBackgroundLoad()}>Retry background</button></div>{/if}
    {#if error}<div class="error" role="alert"><p>{error}</p><button on:click={()=>ready?retryRendering():void initializeScene()}>{ready?'Retry rendering':'Retry card'}</button>{#if $simulationMethod==='physics'}<button on:click={()=>simulationMethod.set('acuity')}>Use Acuity-derived</button>{/if}</div>{/if}
    {#if fallbackMessage&&!status}<div class="notice" role="status">{fallbackMessage}</div>{/if}
  </div>
  {#if ready&&!matchingScene}
    <div class="scene-mask"></div>
  {:else if matchingScene}
    {#if displayedAcuity}
      {#each displayedAcuity.comparison ? [displayedAcuity.primary, displayedAcuity.comparison] : [displayedAcuity.primary] as side, index}
        {#if side.near===null || side.far===null}
          <div class="scene-mask acuity-coverage" class:left={$splitViewEnabled && index===0} class:right={index===1}>{acuityLabel(side)}</div>
        {:else}
          <div class="readout acuity-readout" class:right={index===1} class:half={$splitViewEnabled}>
            <div><span class="badge">{acuityLabel(side)}</span></div>
          </div>
        {/if}
      {/each}
    {:else if displayedScene?.engine==='psf'}
      <div class="readout"><div><span class="badge">optrace PSF</span></div></div>
    {/if}
    {#if displayedDefocus!==null}
      {@const distanceCm = -100 / displayedDefocus}
      <div class="distance-badges">
        <span class="badge">{distanceCm <= 45 ? 'Near' : distanceCm <= 75 ? 'Middle' : 'Far'}</span>
        <span class="badge">−{Math.abs(displayedDefocus).toFixed(1)} D / {Math.round(distanceCm)} cm</span>
      </div>
    {/if}
  {/if}
  {#if $splitViewEnabled}<div class="split-rule" aria-hidden="true"></div>{/if}
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
  .readout,.distance-badges {
    position: absolute;
    inset-inline: 0;
    pointer-events: none;
  }
  .readout { top: .5rem; display: grid; }
  .acuity-readout.half { inline-size: 50%; }
  .acuity-readout.right { inset-inline-start: 50%; }
  .readout > div { padding-inline: .5rem; }
  .distance-badges {
    bottom: .5rem;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    padding-inline: .5rem;
  }
  .badge {
    display: inline-block;
    padding: .2rem .42rem;
    border-radius: .4rem;
    background: #111827b8;
    color: #f9fafb;
    font-size: 1rem;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
  }
  .scene-mask{position:absolute;inset:0;display:grid;place-items:center;background:#eee;color:#374151;text-align:center;padding:.5rem;font-size:.8rem}
  .acuity-coverage{z-index:1;pointer-events:none}
  .scene-mask.left{right:50%}
  .scene-mask.right{left:50%}
  .split-rule{position:absolute;inset:0 auto 0 50%;width:3px;transform:translateX(-50%);background:#fff;box-shadow:0 0 0 1px #16252b99;pointer-events:none;z-index:1}
</style>
