import {loadSceneImage} from './scene-assets.ts';

export interface AssetProgress {url:string;stage:'download'|'decode'|'retry'|'native'|'complete';loaded:number;total?:number;attempt:number}
export type ProgressListener=(progress:AssetProgress)=>void;
interface DownloadOptions {onProgress?:ProgressListener;totalMs?:number;idleMs?:number;attempts?:number;mime?:string;expectedBytes?:number;priority?:'high'|'low'}
interface ImageOptions extends DownloadOptions {nativeMs?:number}
export interface LoadedImage {image:HTMLImageElement;release:()=>void}
export type AssetErrorCode='stalled'|'timeout'|'transfer'|'decode'|'native'|'upload'|'cancelled';
export class AssetError extends Error {
  readonly code:AssetErrorCode;
  readonly retryable:boolean;
  constructor(code:AssetErrorCode,message:string,retryable=false){
    super(message);this.code=code;this.retryable=retryable;
  }
}

const cancelled=()=>new AssetError('cancelled','loading cancelled');

// Stop waiting on a superseded frame without restarting a shared asset request.
export function waitForAsset<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(cancelled());
    signal.addEventListener('abort',stop,{once:true});
    void promise.then(resolve,reject).then(()=>signal.removeEventListener('abort',stop));
    if(signal.aborted)stop();
  });
}

export class ManifestCache<T> {
  private entries=new Map<string,{promise:Promise<T>;controller?:AbortController}>();

  get(key:string,load:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    let entry=this.entries.get(key);
    if(!entry){
      const controller=new AbortController();
      const pending:{promise:Promise<T>;controller?:AbortController}={controller,promise:load(controller.signal)};
      this.entries.set(key,pending);entry=pending;
      void pending.promise.then(()=>{pending.controller=undefined;},()=>{
        if(this.entries.get(key)===pending)this.entries.delete(key);
      });
    }
    return signal?waitForAsset(entry.promise,signal):entry.promise;
  }

  cancel(keep:(key:string)=>boolean=()=>false):void {
    for(const [key,entry]of this.entries)if(entry.controller&&!keep(key)){
      this.entries.delete(key);entry.controller.abort();
    }
  }
}

// The idle timer covers headers AND stalled response bodies. The total budget
// spans retries, so a trickling or failing request cannot hold the UI forever.
export async function downloadBlob(url:string,signal:AbortSignal,options:DownloadOptions={}):Promise<Blob> {
  const controller=new AbortController();let reason=cancelled();
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const deadline=setTimeout(()=>{reason=new AssetError('timeout','download exceeded time limit');abort();},options.totalMs??30000);
  let idle:ReturnType<typeof setTimeout>|undefined;
  const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>{reason=new AssetError('stalled','network stalled (no data received)');abort();},options.idleMs??10000);};
  try {
    for(let attempt=1;attempt<=(options.attempts??2);attempt++) {
      if(controller.signal.aborted)throw reason;
      let loaded=0;
      try {
        touch();options.onProgress?.({url,stage:attempt===1?'download':'retry',loaded,attempt});
        const init:RequestInit&{priority?:'high'|'low'}={signal:controller.signal,priority:options.priority??'high'};
        const response=await fetch(url,init);
        if(!response.ok)throw new AssetError('transfer',`HTTP ${response.status}`,response.status===408||response.status===429||response.status>=500);
        const mime=response.headers.get('content-type')?.split(';')[0].trim();
        if(options.mime&&mime&&mime!==options.mime&&mime!=='application/octet-stream')throw new AssetError('transfer',`unexpected content type ${mime}`);
        const length=Number(response.headers.get('content-length'));
        const total=options.expectedBytes??(!response.headers.get('content-encoding')&&length>0?length:undefined);
        const chunks:Uint8Array[]=[];
        if(response.body) {
          const reader=response.body.getReader();
          try {while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.byteLength;touch();options.onProgress?.({url,stage:'download',loaded,total,attempt});}}
          finally{reader.releaseLock();}
        }else{const bytes=new Uint8Array(await response.arrayBuffer());chunks.push(bytes);loaded=bytes.length;}
        if(options.expectedBytes!==undefined&&loaded!==options.expectedBytes)throw new AssetError('transfer',`incomplete response (${loaded}/${options.expectedBytes} bytes)`);
        options.onProgress?.({url,stage:'download',loaded,total:total??loaded,attempt});
        // Fetch byte streams contain ordinary ArrayBuffers, never shared ones.
        return new Blob(chunks as Uint8Array<ArrayBuffer>[],{type:options.mime??mime??'application/octet-stream'});
      }catch(error) {
        if(controller.signal.aborted)throw reason;
        if(error instanceof AssetError&&!error.retryable||attempt===(options.attempts??2))throw error;
        clearTimeout(idle);
        await new Promise<void>((resolve,reject)=>{
          const stop=()=>{clearTimeout(wait);controller.signal.removeEventListener('abort',stop);reject(reason);};
          const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',stop);resolve();},250);
          controller.signal.addEventListener('abort',stop,{once:true});
          if(controller.signal.aborted)stop();
        });
      }finally{clearTimeout(idle);}
    }
    throw new AssetError('transfer','unable to download');
  }catch(error){throw new AssetError(error instanceof AssetError?error.code:'transfer',`${url}: ${error instanceof Error?error.message:String(error)}`);}
  finally{clearTimeout(deadline);clearTimeout(idle);signal.removeEventListener('abort',abort);}
}

export function loadPngAsset(url:string,signal:AbortSignal,options:ImageOptions={}):Promise<LoadedImage> {
  return loadRasterAsset(url,signal,'PNG',options);
}

export function loadJpegAsset(url:string,signal:AbortSignal,options:ImageOptions={}):Promise<LoadedImage> {
  return loadRasterAsset(url,signal,'JPEG',options);
}

// Keep the Blob URL alive until its owner releases the decoded image. If the
// browser cannot decode that URL, try the real URL once.
async function loadRasterAsset(url:string,signal:AbortSignal,format:'PNG'|'JPEG',options:ImageOptions):Promise<LoadedImage> {
  const mime=format==='PNG'?'image/png':'image/jpeg';
  const signature=format==='PNG'?[137,80,78,71,13,10,26,10]:[255,216,255];
  const report=(stage:AssetProgress['stage'],loaded=0,total?:number)=>options.onProgress?.({url,stage,loaded,total,attempt:1});
  const native=async(context?:string,code:AssetErrorCode='native')=>{
    report('native');
    try {
      const image=await loadSceneImage(url,signal,options.nativeMs??8000,1);
      report('complete');return {image,release:()=>image.removeAttribute('src')};
    }catch(error){
      if(signal.aborted)throw cancelled();
      throw new AssetError(code,context?`${url}: ${context}; native URL also failed (${String(error)})`:String(error));
    }
  };
  if(typeof fetch!=='function'||typeof URL.createObjectURL!=='function')return native();
  let blob:Blob;
  try{blob=await downloadBlob(url,signal,{...options,mime});}
  catch(error){
    // Some embedded browsers disable fetch while native image URLs work.
    if(!signal.aborted&&/failed to fetch|load failed|networkerror|fetch is unavailable/i.test(String(error)))return native(`HTTP download failed before ${format} decode`);
    throw error;
  }
  const header=new Uint8Array(await blob.slice(0,signature.length).arrayBuffer());
  if(signal.aborted)throw cancelled();
  if(header.length!==signature.length||header.some((b,i)=>b!==signature[i]))throw new AssetError('decode',`${url}: invalid ${format} response`);
  report('decode',blob.size,blob.size);
  let objectUrl:string;
  try{objectUrl=URL.createObjectURL(blob);}catch{return native(`Browser could not create a ${format} Blob URL`);}
  try {
    const image=await loadSceneImage(objectUrl,signal,8000,1);
    report('complete',blob.size,blob.size);
    let released=false;
    return {image,release:()=>{if(!released){released=true;image.removeAttribute('src');URL.revokeObjectURL(objectUrl);}}};
  }catch{URL.revokeObjectURL(objectUrl);if(signal.aborted)throw cancelled();return native(`${format} decode failed after a complete download`,'decode');}
}

export function allowSpeculativeLoads():boolean {
  if(typeof navigator==='undefined')return false;
  const device=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean;effectiveType?:string}};
  return !device.connection?.saveData&&!['slow-2g','2g','3g'].includes(device.connection?.effectiveType??'')&&!(device.deviceMemory&&device.deviceMemory<4);
}
