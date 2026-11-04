import type { PsfEntry } from './geometry';

export interface PsfManifest { version: number; entries: PsfEntry[] }
let manifestPromise: Promise<PsfManifest> | undefined;
const cache = new Map<string, Promise<Float32Array>>();

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

export async function loadPsf(base:string,entry:PsfEntry,profile:Record<string,number>={}):Promise<Float32Array> {
  const found=cache.get(entry.file);
  if(found) {profile.cacheHit=1;cache.delete(entry.file);cache.set(entry.file,found);return found;}
  const promise=(async()=>{
    const start=performance.now();
    const response=await fetch(`${base}/psf/${entry.file}`);
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
  })().catch(e=>{cache.delete(entry.file);throw new Error(`${entry.file}: ${String(e)}`);});
  cache.set(entry.file,promise);
  if(cache.size>8) cache.delete(cache.keys().next().value!);
  return promise;
}
