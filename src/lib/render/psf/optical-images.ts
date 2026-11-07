import {loadPngAsset,downloadBlob,allowSpeculativeLoads,type ProgressListener,type AssetProgress} from '../asset-loading.ts';
import type {PsfEntry} from './geometry';
import {OPTICAL_CACHE_BYTES,validatePackedOpticalImage,opticalImageKey,type PackedOpticalImageLayer,type OpticalImageRef,type OpticalImageLevel} from './optical-image-math.ts';

interface OpticalNode {objectVergenceD:number;psfSha256:string;levels:OpticalImageLevel[]}
interface OpticalLibrary {version:number;model:string;encoding:string;physicalCardMm:[number,number];entries:OpticalNode[]}
export interface OpticalImageStore {getOptical:(key:string)=>OpticalImageRef|undefined;registerOptical:(layer:PackedOpticalImageLayer)=>Promise<OpticalImageRef>}
type OpticalRequest={models:string[];demand:number};
interface OpticalSelection extends OpticalImageRef {model:string;demand:number}
interface PendingLayer {
  promise:Promise<OpticalImageRef>;
  controller:AbortController;
  selection:OpticalSelection;
  bytes:number;
  listeners:Set<ProgressListener>;
  progress?:AssetProgress;
}
const libraries=new Map<string,Promise<OpticalLibrary>>();
function library(base:string,model:string):Promise<OpticalLibrary> {
  const url=`${base}/optical-images/${model}.json`;
  const existing=libraries.get(url);
  if(existing)return existing;
  const pending=(async()=>{
    const result=JSON.parse(await (await downloadBlob(url,new AbortController().signal,{totalMs:12000})).text()) as OpticalLibrary;
    if(result.version!==1||result.model!==model||result.encoding!=='opaque-rgb-f12-a12'||result.entries.length!==31||
      Math.abs(result.physicalCardMm[1]-28)>1e-9||Math.abs(result.physicalCardMm[0]-28*1528/1170)>1e-9)throw new Error('Incompatible optical image library');
    for(let d=10;d<=40;d++)if(!result.entries.some(e=>e.objectVergenceD===d/10))throw new Error('Incomplete optical image nodes');
    return result;
  })().catch(error=>{libraries.delete(url);throw error;});
  libraries.set(url,pending);
  return pending;
}
function supportsOpticalDensity(px:number,py:number):boolean {
  return Math.min(px,py)>=128&&Math.max(px,py)<=8192;
}
function selectLevel(node:OpticalNode,px:number,py:number):OpticalImageLevel|null {
  if(!supportsOpticalDensity(px,py))return null;
  return [...node.levels].sort((a,b)=>a.density-b.density).find(l=>l.pixelsPerTanTheta[0]+1e-7>=px&&l.pixelsPerTanTheta[1]+1e-7>=py)??null;
}

// The Worker owns completed layers. Only in-flight loads live here.
export class OpticalImageLoader {
  private pending=new Map<string,PendingLayer>();
  private generation=0;
  private store:OpticalImageStore;
  constructor(store:OpticalImageStore) {this.store=store;}
  cancel(keep?:OpticalRequest):void {
    this.generation++;
    for(const [key,item]of this.pending){
      const {model,demand}=item.selection;
      if(keep?.demand===demand&&keep.models.includes(model))continue;
      this.pending.delete(key);
      item.controller.abort();
    }
  }
  info(){
    return {mainPackedBytes:[...this.pending.values()].reduce((sum,item)=>sum+item.bytes,0),pending:this.pending.size};
  }
  private observe(item:PendingLayer,listener?:ProgressListener):Promise<OpticalImageRef> {
    if(listener){item.listeners.add(listener);if(item.progress)listener(item.progress);}
    return item.promise.finally(()=>{if(listener)item.listeners.delete(listener);});
  }
  async load(base:string,selection:OpticalSelection,listener?:ProgressListener):Promise<OpticalImageRef> {
    const {key,level}=selection;
    const resident=this.store.getOptical(key);
    if(resident)return resident;
    const found=this.pending.get(key);
    if(found)return this.observe(found,listener);
    const bytes=level.width*level.height*4;
    if(level.width<1||level.height<1||bytes+this.info().mainPackedBytes>OPTICAL_CACHE_BYTES){
      throw new Error('Optical image exceeds packed memory budget');
    }
    const controller=new AbortController();let item:PendingLayer;
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
        return await this.store.registerOptical(layer);
      }finally{asset.release();}
    })();
    item={promise,controller,selection,bytes,listeners:new Set()};
    this.pending.set(key,item);
    const remove=()=>{if(this.pending.get(key)===item)this.pending.delete(key);};
    void promise.then(remove,remove);
    return this.observe(item,listener);
  }
  async select(base:string,entry:PsfEntry,px:number,py:number):Promise<OpticalSelection|null> {
    if(!supportsOpticalDensity(px,py))return null;
    const manifest=await library(base,entry.model);
    const node=manifest.entries.find(e=>e.objectVergenceD===entry.objectVergenceD);
    if(!node||node.psfSha256!==entry.sha256)throw new Error('Precomputed optical image does not match selected PSF');
    const level=selectLevel(node,px,py);
    return level?{key:opticalImageKey(level),level,model:entry.model,demand:entry.objectVergenceD}:null;
  }
  async prefetch(base:string,models:string[],demand:number,px:number,py:number):Promise<void> {
    if(!allowSpeculativeLoads())return;
    const generation=this.generation;
    const manifests=await Promise.all(models.map(model=>library(base,model)));
    if(generation!==this.generation)return;
    const neighbors:OpticalSelection[]=[];
    for(const next of [Math.round(demand*10-1)/10,Math.round(demand*10+1)/10]){
      for(const manifest of manifests){
        const node=manifest.entries.find(entry=>entry.objectVergenceD===next);
        const level=node&&selectLevel(node,px,py);
        if(level&&level.width*level.height*4<=2*1024*1024&&!this.store.getOptical(opticalImageKey(level))){
          neighbors.push({key:opticalImageKey(level),level,model:manifest.model,demand:next});
        }
      }
    }
    await Promise.all(neighbors.slice(0,2).map(selection=>this.load(base,selection).catch(()=>undefined)));
  }
}
