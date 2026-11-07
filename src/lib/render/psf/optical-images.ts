import {loadPngAsset,downloadBlob,allowSpeculativeLoads,type ProgressListener,type AssetProgress} from '../asset-loading.ts';
import type {PsfEntry} from './geometry';
import {validatePackedOpticalImage,opticalImageKey,type PackedOpticalImageLayer,type OpticalImageRef,type OpticalImageLevel} from './optical-image-math.ts';

interface OpticalNode {objectVergenceD:number;psfSha256:string;levels:OpticalImageLevel[]}
interface OpticalLibrary {version:number;model:string;encoding:string;physicalCardMm:[number,number];entries:OpticalNode[]}
export interface OpticalImageStore {getOptical:(key:string)=>OpticalImageRef|undefined;registerOptical:(layer:PackedOpticalImageLayer)=>Promise<OpticalImageRef>}
type ImageAsset=OpticalImageRef|PackedOpticalImageLayer;
interface CachedLayer {promise:Promise<ImageAsset>;controller:AbortController;pending:boolean;demand:number;bytes:number;listeners:Set<ProgressListener>;progress?:AssetProgress}
const MODEL='aspheric_monofocal_dc_v1',MAX_CACHE_BYTES=14*1024*1024;
let libraryPromise:Promise<OpticalLibrary>|undefined;
async function library(base:string):Promise<OpticalLibrary> {
  if(!libraryPromise)libraryPromise=(async()=>{
    const result=JSON.parse(await (await downloadBlob(`${base}/optical-images/manifest.json`,new AbortController().signal,{totalMs:12000})).text()) as OpticalLibrary;
    if(result.version!==1||result.model!==MODEL||result.encoding!=='opaque-rgb-f12-a12'||result.entries.length!==31||
      Math.abs(result.physicalCardMm[1]-28)>1e-9||Math.abs(result.physicalCardMm[0]-28*1528/1170)>1e-9)throw new Error('Incompatible optical image library');
    for(let d=10;d<=40;d++)if(!result.entries.some(e=>e.objectVergenceD===d/10))throw new Error('Incomplete optical image nodes');
    return result;
  })().catch(error=>{libraryPromise=undefined;throw error;});
  return libraryPromise;
}
function selectLevel(node:OpticalNode,px:number,py:number):OpticalImageLevel|null {
  if(Math.min(px,py)<128||Math.max(px,py)>8192)return null;
  return [...node.levels].sort((a,b)=>a.density-b.density).find(l=>l.pixelsPerTanTheta[0]+1e-7>=px&&l.pixelsPerTanTheta[1]+1e-7>=py)??null;
}

// With a Worker store, only pending loads live here. Transfer moves the sole
// packed buffer to that store; completed promises do not retain detached assets.
export class OpticalImageLoader {
  private cache=new Map<string,CachedLayer>();
  private generation=0;
  private keepDemand:number|undefined;
  private store?:OpticalImageStore;
  constructor(store?:OpticalImageStore) {this.store=store;}
  cancel(demand?:number):void {
    this.generation++;this.keepDemand=demand;
    for(const [key,item]of this.cache)if(item.pending&&item.demand!==demand){this.cache.delete(key);item.controller.abort();}
  }
  clear():void {this.cancel();this.cache.clear();}
  info(){return {mainPackedBytes:[...this.cache.values()].reduce((s,i)=>s+i.bytes,0),pending:[...this.cache.values()].filter(i=>i.pending).length};}
  private trim(keep:string):void {
    while(this.info().mainPackedBytes>MAX_CACHE_BYTES){
      const oldest=[...this.cache.keys()].find(k=>k!==keep);if(!oldest)break;
      const item=this.cache.get(oldest)!;this.cache.delete(oldest);if(item.pending)item.controller.abort();
    }
  }
  private observe(item:CachedLayer,listener?:ProgressListener):Promise<ImageAsset> {
    if(listener){item.listeners.add(listener);if(item.progress)listener(item.progress);}
    return item.promise.finally(()=>{if(listener)item.listeners.delete(listener);});
  }
  private async loadLevel(base:string,node:OpticalNode,level:OpticalImageLevel,listener?:ProgressListener):Promise<ImageAsset> {
    const key=opticalImageKey(level),resident=this.store?.getOptical(key);
    if(resident)return resident;
    const found=this.cache.get(key);
    if(found){this.cache.delete(key);this.cache.set(key,found);return this.observe(found,listener);}
    const bytes=level.width*level.height*4;
    if(bytes>MAX_CACHE_BYTES||level.width<1||level.height<1)throw new Error('Optical image exceeds packed memory budget');
    const controller=new AbortController();let item:CachedLayer;
    const promise=(async()=>{
      const asset=await loadPngAsset(`${base}/optical-images/${level.file}`,controller.signal,{totalMs:18000,expectedBytes:level.bytes,priority:listener?'high':'low',onProgress:p=>{if(item){item.progress=p;for(const fn of item.listeners)fn(p);}}});
      try{
        const image=asset.image;
        if(image.naturalWidth!==level.width||image.naturalHeight!==level.height)throw new Error('Optical image dimensions changed');
        const canvas=document.createElement('canvas');canvas.width=level.width;canvas.height=level.height;
        let rgba:Uint8ClampedArray<ArrayBuffer>;
        try{const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(image,0,0);rgba=ctx.getImageData(0,0,level.width,level.height).data;}
        finally{canvas.width=1;canvas.height=1;}
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rgba)),b=>b.toString(16).padStart(2,'0')).join('');
        if(controller.signal.aborted)throw new Error('Optical image loading cancelled');
        if(hash!==level.decodedRgbaSha256)throw new Error('Optical image numeric samples failed integrity validation');
        validatePackedOpticalImage(rgba,level);
        const layer:PackedOpticalImageLayer={key,level,rgba};
        return this.store?await this.store.registerOptical(layer):layer;
      }finally{asset.release();}
    })();
    item={promise,controller,pending:true,demand:node.objectVergenceD,bytes,listeners:new Set()};this.cache.set(key,item);this.trim(key);
    void promise.then(()=>{item.pending=false;if(this.store&&this.cache.get(key)===item)this.cache.delete(key);},()=>{item.pending=false;if(this.cache.get(key)===item)this.cache.delete(key);});
    return this.observe(item,listener);
  }
  async load(base:string,entry:PsfEntry,px:number,py:number,onProgress?:ProgressListener):Promise<ImageAsset|null> {
    if(entry.model!==MODEL||Math.min(px,py)<128||Math.max(px,py)>8192)return null;
    const requestGeneration=this.generation,manifest=await library(base);
    if(this.generation!==requestGeneration&&this.keepDemand!==entry.objectVergenceD)return null;
    const node=manifest.entries.find(e=>e.objectVergenceD===entry.objectVergenceD);
    if(!node||node.psfSha256!==entry.sha256)throw new Error('Precomputed optical image does not match selected PSF');
    const level=selectLevel(node,px,py);
    return level?this.loadLevel(base,node,level,onProgress):null;
  }
  async prefetch(base:string,demand:number,px:number,py:number):Promise<void> {
    if(!allowSpeculativeLoads())return;
    const generation=this.generation,manifest=await library(base);if(generation!==this.generation)return;
    const neighbors=manifest.entries.filter(e=>Math.abs(Math.abs(e.objectVergenceD-demand)-.1)<1e-8);
    await Promise.all(neighbors.map(node=>{
      const level=selectLevel(node,px,py);
      // Retain the old prefetch envelope: <=4 MiB expanded / <=2 MiB packed.
      return level&&level.width*level.height*4<=2*1024*1024?this.loadLevel(base,node,level).catch(()=>undefined):undefined;
    }));
  }
}

// Standalone validation owns a small main-thread packed cache, with no transfer.
const defaultLoader=new OpticalImageLoader();
export async function loadOpticalImage(base:string,entry:PsfEntry,px:number,py:number,onProgress?:ProgressListener):Promise<PackedOpticalImageLayer|null> {
  return await defaultLoader.load(base,entry,px,py,onProgress) as PackedOpticalImageLayer|null;
}
