import type { PsfEntry } from './geometry';

export interface PsfManifest { version: number; entries: PsfEntry[] }
let manifestPromise: Promise<PsfManifest> | undefined;
type CachedPsf={promise:Promise<Float32Array>;controller:AbortController;speculative:boolean;pending:boolean;bytes:number;model:string;demand:number};
const cache = new Map<string, CachedPsf>();
const infinityFiles=new Set<string>();
let prefetchGeneration=0;

export function psfCacheInfo():{entries:number;decodedBytes:number} {
  return {entries:cache.size,decodedBytes:[...cache.values()].reduce((sum,item)=>sum+item.bytes,0)};
}

export function cancelPsfPrefetch(keep?:{models:string[];demand:number}):void {
  prefetchGeneration++;
  // A superseded foreground download must not hold the single scene queue
  // behind a slow network request. Keep current near and infinity requests.
  for(const [file,item] of cache)if(item.pending){
    if(keep?.models.includes(item.model)&&(keep.demand===item.demand||item.demand===0))item.speculative=false;
    else {cache.delete(file);item.controller.abort();}
  }
}

export async function prefetchPsfNeighbors(base:string,models:string[],demand:number):Promise<void> {
  const generation=prefetchGeneration;
  const library=await manifest(base);
  const nodes=library.entries.filter(e=>models.includes(e.model)&&Math.abs(Math.abs(e.objectVergenceD-demand)-.1)<1e-8);
  // At most two speculative downloads at a time; foreground requests claim
  // an in-flight neighbor rather than downloading it a second time.
  while(nodes.length&&generation===prefetchGeneration)await Promise.all(nodes.splice(0,2).map(e=>loadPsf(base,e,{},true).catch(()=>undefined)));
}

export async function manifest(base: string): Promise<PsfManifest> {
  if(!manifestPromise) manifestPromise=(async()=>{
    const response=await fetch(`${base}/psf/manifest.json`);
    if(!response.ok) throw new Error('PSF library is unavailable');
    const value=await response.json() as PsfManifest;
    if(value.version!==1 || value.entries.length!==96) throw new Error('Incomplete PSF library');
    return value;
  })().catch(e=>{manifestPromise=undefined;throw e;});
  return manifestPromise;
}

export async function loadPsf(base:string,entry:PsfEntry,profile:Record<string,number>={},speculative=false):Promise<Float32Array> {
  const found=cache.get(entry.file);
  if(found) {if(!speculative)found.speculative=false;profile.cacheHit=1;cache.delete(entry.file);cache.set(entry.file,found);return found.promise;}
  if(entry.objectVergenceD===0)infinityFiles.add(entry.file);
  const controller=new AbortController();
  const promise=(async()=>{
    const start=performance.now();
    const response=await fetch(`${base}/psf/${entry.file}`,{signal:controller?.signal});
    if(!response.ok || !response.body) throw new Error(`PSF download failed: ${entry.file}`);
    const compressed=await response.arrayBuffer(),downloaded=performance.now();
    profile.downloadMs=downloaded-start;
    const bytes=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const inflated=performance.now();profile.inflateMs=inflated-downloaded;
    if(bytes.byteLength!==entry.width*entry.height*4) throw new Error('PSF data length mismatch');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(digest!==entry.sha256) throw new Error('PSF integrity check failed');
    const view=new DataView(bytes),data=new Float32Array(entry.width*entry.height);
    for(let i=0;i<data.length;i++) data[i]=view.getFloat32(4*i,true);
    const sum=data.reduce((a,b)=>a+b,0);
    if(data.some(x=>!Number.isFinite(x)||x<0) || Math.abs(sum-1)>1e-5) throw new Error('PSF energy is invalid');
    profile.verifyDecodeMs=performance.now()-inflated;
    return data;
  })().catch(e=>{if(cache.get(entry.file)?.promise===promise)cache.delete(entry.file);throw new Error(`${entry.file}: ${String(e)}`);});
  const item={promise,controller,speculative,pending:true,bytes:entry.width*entry.height*4,model:entry.model,demand:entry.objectVergenceD};cache.set(entry.file,item);
  // Infinity PSFs stay hot; fifteen 513x513 kernels bound decoded cache
  // storage to <16 MiB, including speculative nodes (temporary buffers extra).
  while(cache.size>15){const oldest=[...cache.keys()].find(file=>!infinityFiles.has(file));if(!oldest)break;cache.delete(oldest);}
  void promise.then(()=>{item.speculative=false;item.pending=false;},()=>{item.pending=false;});
  return promise;
}
