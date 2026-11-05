import {loadSceneImage} from './scene-assets.ts';

export interface AssetProgress {url:string;stage:'download'|'decode'|'retry'|'native'|'complete';loaded:number;total?:number;attempt:number}
export type ProgressListener=(progress:AssetProgress)=>void;
interface DownloadOptions {onProgress?:ProgressListener;totalMs?:number;idleMs?:number;attempts?:number;mime?:string;expectedBytes?:number;priority?:'high'|'low'}
export interface LoadedPng {image:HTMLImageElement;release:()=>void}
class AssetError extends Error {readonly retryable:boolean;constructor(message:string,retryable=false){super(message);this.retryable=retryable;}}

// The idle timer covers headers AND stalled response bodies. The total budget
// spans retries, so a trickling or failing request cannot hold the UI forever.
export async function downloadBlob(url:string,signal:AbortSignal,options:DownloadOptions={}):Promise<Blob> {
  const controller=new AbortController();let reason='loading cancelled';
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const deadline=setTimeout(()=>{reason='download exceeded time limit';abort();},options.totalMs??30000);
  let idle:ReturnType<typeof setTimeout>|undefined;
  const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>{reason='network stalled (no data received)';abort();},options.idleMs??10000);};
  try {
    for(let attempt=1;attempt<=(options.attempts??2);attempt++) {
      if(controller.signal.aborted)throw new AssetError(reason);
      let loaded=0;
      try {
        touch();options.onProgress?.({url,stage:attempt===1?'download':'retry',loaded,attempt});
        const init:RequestInit&{priority?:'high'|'low'}={signal:controller.signal,priority:options.priority??'high'};
        const response=await fetch(url,init);
        if(!response.ok)throw new AssetError(`HTTP ${response.status}`,response.status===408||response.status===429||response.status>=500);
        const mime=response.headers.get('content-type')?.split(';')[0].trim();
        if(options.mime&&mime&&mime!==options.mime&&mime!=='application/octet-stream')throw new AssetError(`unexpected content type ${mime}`);
        const length=Number(response.headers.get('content-length'));
        const total=options.expectedBytes??(!response.headers.get('content-encoding')&&length>0?length:undefined);
        const chunks:Uint8Array[]=[];
        if(response.body) {
          const reader=response.body.getReader();
          try {while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);loaded+=value.byteLength;touch();options.onProgress?.({url,stage:'download',loaded,total,attempt});}}
          finally{reader.releaseLock();}
        }else{const bytes=new Uint8Array(await response.arrayBuffer());chunks.push(bytes);loaded=bytes.length;}
        if(options.expectedBytes!==undefined&&loaded!==options.expectedBytes)throw new AssetError(`incomplete response (${loaded}/${options.expectedBytes} bytes)`);
        options.onProgress?.({url,stage:'download',loaded,total:total??loaded,attempt});
        // Fetch byte streams contain ordinary ArrayBuffers, never shared ones.
        return new Blob(chunks as Uint8Array<ArrayBuffer>[],{type:options.mime??mime??'application/octet-stream'});
      }catch(error) {
        if(controller.signal.aborted)throw new AssetError(reason);
        if(error instanceof AssetError&&!error.retryable||attempt===(options.attempts??2))throw error;
        clearTimeout(idle);
        await new Promise<void>((resolve,reject)=>{
          const stop=()=>{clearTimeout(wait);controller.signal.removeEventListener('abort',stop);reject(new AssetError(reason));};
          const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',stop);resolve();},250);
          controller.signal.addEventListener('abort',stop,{once:true});
          if(controller.signal.aborted)stop();
        });
      }finally{clearTimeout(idle);}
    }
    throw new AssetError('unable to download');
  }catch(error){throw new Error(`${url}: ${error instanceof Error?error.message:String(error)}`);}
  finally{clearTimeout(deadline);clearTimeout(idle);signal.removeEventListener('abort',abort);}
}

// PNG bytes use an observable, bounded HTTP transfer. SVGs retain real native
// URLs. Keep a PNG's Blob URL alive until its owner releases the decoded image;
// if the browser cannot decode that URL, try its native real URL once.
export async function loadPngAsset(url:string,signal:AbortSignal,options:DownloadOptions={}):Promise<LoadedPng> {
  const controller=new AbortController();const abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;abort();},options.totalMs??30000);
  const report=(stage:AssetProgress['stage'],loaded=0,total?:number)=>options.onProgress?.({url,stage,loaded,total,attempt:1});
  const native=async(context?:string)=>{
    report('native');
    try {
      const image=await loadSceneImage(url,controller.signal,8000,1);
      report('complete');return {image,release:()=>image.removeAttribute('src')};
    }catch(error){if(context)throw new Error(`${url}: ${context}; native URL also failed (${String(error)})`);throw error;}
  };
  try {
    if(typeof fetch!=='function'||typeof URL.createObjectURL!=='function')return await native();
    let blob:Blob;
    try{blob=await downloadBlob(url,controller.signal,{...options,mime:'image/png'});}
    catch(error){
      // Some embedded browsers disable fetch while native image URLs work.
      if(!controller.signal.aborted&&/failed to fetch|load failed|networkerror|fetch is unavailable/i.test(String(error)))return await native('HTTP download failed before PNG decode');
      throw error;
    }
    const signature=new Uint8Array(await blob.slice(0,8).arrayBuffer());
    if(signature.length!==8||signature.some((b,i)=>b!==[137,80,78,71,13,10,26,10][i]))throw new Error(`${url}: invalid PNG response`);
    report('decode',blob.size,blob.size);
    let objectUrl:string;
    try{objectUrl=URL.createObjectURL(blob);}catch{return await native('Browser could not create a PNG Blob URL');}
    try {
      const image=await loadSceneImage(objectUrl,controller.signal,8000,1);
      report('complete',blob.size,blob.size);
      let released=false;
      return {image,release:()=>{if(!released){released=true;image.removeAttribute('src');URL.revokeObjectURL(objectUrl);}}};
    }catch(error){URL.revokeObjectURL(objectUrl);if(controller.signal.aborted)throw error;return await native('PNG decode failed after a complete download');}
  }catch(error){const message=timedOut?'loading exceeded time limit':signal.aborted?'loading cancelled':error instanceof Error?error.message:String(error);throw new Error(message.startsWith(url+':')?message:`${url}: ${message}`);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

export function allowSpeculativeLoads():boolean {
  if(typeof navigator==='undefined')return false;
  const device=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean;effectiveType?:string}};
  return !device.connection?.saveData&&!['slow-2g','2g','3g'].includes(device.connection?.effectiveType??'')&&!(device.deviceMemory&&device.deviceMemory<4);
}
