import {loadPngAsset,downloadBlob,allowSpeculativeLoads,type ProgressListener,type AssetProgress} from '../asset-loading';
import type {PsfEntry} from './geometry';
import {unpackOpticalImage,type OpticalImageLayer,type OpticalImageLevel} from './optical-image-math';

interface OpticalNode {objectVergenceD:number;psfSha256:string;levels:OpticalImageLevel[]}
interface OpticalLibrary {version:number;model:string;encoding:string;physicalCardMm:[number,number];entries:OpticalNode[]}
interface CachedLayer {promise:Promise<OpticalImageLayer>;controller:AbortController;pending:boolean;demand:number;bytes:number;listeners:Set<ProgressListener>;progress?:AssetProgress}
const MODEL='aspheric_monofocal_dc_v1',MAX_CACHE_BYTES=16*1024*1024;
let libraryPromise:Promise<OpticalLibrary>|undefined,generation=0,keepDemand:number|undefined;
const cache=new Map<string,CachedLayer>();

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

export function cancelOpticalImageLoads(demand?:number):void {
  generation++;keepDemand=demand;
  for(const [key,item]of cache)if(item.pending&&item.demand!==demand){cache.delete(key);item.controller.abort();}
}

function trim(keep:string):void {
  while([...cache.values()].reduce((sum,item)=>sum+item.bytes,0)>MAX_CACHE_BYTES) {
    const oldest=[...cache.keys()].find(key=>key!==keep);
    if(!oldest)break;
    const item=cache.get(oldest)!;cache.delete(oldest);if(item.pending)item.controller.abort();
  }
}

function selectLevel(node:OpticalNode,px:number,py:number):OpticalImageLevel|null {
  if(Math.min(px,py)<128||Math.max(px,py)>8192)return null;
  return [...node.levels].sort((a,b)=>a.density-b.density).find(l=>l.pixelsPerTanTheta[0]+1e-7>=px&&l.pixelsPerTanTheta[1]+1e-7>=py)??null;
}

function observe(item:CachedLayer,listener?:ProgressListener):Promise<OpticalImageLayer> {
  if(listener){item.listeners.add(listener);if(item.progress)listener(item.progress);}
  return item.promise.finally(()=>{if(listener)item.listeners.delete(listener);});
}

async function loadLevel(base:string,node:OpticalNode,level:OpticalImageLevel,listener?:ProgressListener):Promise<OpticalImageLayer> {
  const found=cache.get(level.file);
  if(found){cache.delete(level.file);cache.set(level.file,found);return observe(found,listener);}
  const bytes=level.width*level.height*8;
  if(bytes>MAX_CACHE_BYTES||level.width<1||level.height<1)throw new Error('Optical image exceeds the decoded memory budget');
  const controller=new AbortController();
  let item:CachedLayer;
  const promise=(async()=>{
    const asset=await loadPngAsset(`${base}/optical-images/${level.file}`,controller.signal,{totalMs:18000,expectedBytes:level.bytes,priority:listener?'high':'low',onProgress:p=>{if(item){item.progress=p;for(const fn of item.listeners)fn(p);}}});
    const image=asset.image;
    try {
      if(image.naturalWidth!==level.width||image.naturalHeight!==level.height)throw new Error('Optical image dimensions changed');
      const canvas=document.createElement('canvas');canvas.width=level.width;canvas.height=level.height;
      const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(image,0,0);
      const rgba=context.getImageData(0,0,level.width,level.height).data;canvas.width=1;canvas.height=1;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rgba)),b=>b.toString(16).padStart(2,'0')).join('');
      if(hash!==level.decodedRgbaSha256)throw new Error('Optical image numeric samples failed integrity validation');
      return unpackOpticalImage(rgba,level);
    }finally{asset.release();}
  })();
  item={promise,controller,pending:true,demand:node.objectVergenceD,bytes,listeners:new Set()};cache.set(level.file,item);trim(level.file);
  void promise.then(()=>{item.pending=false;},()=>{item.pending=false;if(cache.get(level.file)===item)cache.delete(level.file);});
  return observe(item,listener);
}

export async function loadOpticalImage(base:string,entry:PsfEntry,px:number,py:number,onProgress?:ProgressListener):Promise<OpticalImageLayer|null> {
  if(entry.model!==MODEL||Math.min(px,py)<128||Math.max(px,py)>8192)return null;
  const requestGeneration=generation,manifest=await library(base);
  if(generation!==requestGeneration&&keepDemand!==entry.objectVergenceD)return null;
  const node=manifest.entries.find(e=>e.objectVergenceD===entry.objectVergenceD);
  if(!node||node.psfSha256!==entry.sha256)throw new Error('Precomputed optical image does not match the selected PSF');
  const level=selectLevel(node,px,py);
  return level?loadLevel(base,node,level,onProgress):null;
}

export async function prefetchOpticalNeighbors(base:string,demand:number,px:number,py:number):Promise<void> {
  if(!allowSpeculativeLoads())return;
  const requestGeneration=generation,manifest=await library(base);
  if(requestGeneration!==generation)return;
  const neighbors=manifest.entries.filter(e=>Math.abs(Math.abs(e.objectVergenceD-demand)-.1)<1e-8);
  await Promise.all(neighbors.map(node=>{
    const level=selectLevel(node,px,py);
    // Avoid multiplying large high-density decoded images on small devices.
    return level&&level.width*level.height*8<=4*1024*1024?loadLevel(base,node,level).catch(()=>undefined):undefined;
  }));
}
