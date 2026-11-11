import {loadPngAsset,downloadBlob,allowSpeculativeLoads,waitForAsset,ManifestCache,type ProgressListener,type AssetProgress} from '../asset-loading.ts';
import readingCard from '../../../../static/reading-card.json' with { type: 'json' };
import type {PsfEntry} from './geometry';
import {OPTICAL_CACHE_BYTES,validatePackedOpticalImage,opticalImageKey,opticalColumns,cropOpticalPixels,packedOpticalBytes,
  type PackedOpticalImageLayer,type OpticalImageRef,type OpticalImageLevel} from './optical-image-math.ts';

interface OpticalNode {objectVergenceD:number;psfSha256:string;levels:OpticalImageLevel[]}
interface OpticalLibrary {version:number;model:string;encoding:string;physicalCardMm:[number,number];cardSvgCanonicalSha256:string;entries:OpticalNode[]}
export interface OpticalImageStore {
  getOptical:(key:string)=>OpticalImageRef|undefined;
  sliceOptical?:(selection:OpticalImageRef)=>Promise<OpticalImageRef|undefined>|undefined;
  registerOptical:(layer:PackedOpticalImageLayer)=>Promise<OpticalImageRef>;
}
type OpticalRequest={models:string[];demand:number};
interface OpticalSelection extends OpticalImageRef {model:string;demand:number}
interface VisibleColumns {width:number;cardWidth:number;left:number;right:number}
interface PendingLayer {
  promise:Promise<OpticalImageRef>;
  controller:AbortController;
  selection:OpticalSelection;
  bytes:number;
  listeners:Set<ProgressListener>;
  progress?:AssetProgress;
}
function supportsOpticalDensity(px:number,py:number):boolean {
  return Math.min(px,py)>=128&&Math.max(px,py)<=8192;
}

const packedBytes=(layer:Pick<OpticalImageRef,'level'|'columns'>)=>packedOpticalBytes(layer.level,layer.columns);
export function opticalDecodeBytes(layer:Pick<OpticalImageRef,'level'|'columns'>):number {
  return packedOpticalBytes(layer.level)+(layer.columns?packedBytes(layer):0);
}
type OpticalNodes=readonly [current:OpticalSelection|null,previous:OpticalSelection|null,next:OpticalSelection|null];

// A slider step must keep the displayed layers and the adjacent frame's layers
// resident together. The previous and next steps need not coexist.
export function opticalWorkingSet(sides:OpticalNodes[]) {
  const fits=(candidates:OpticalNodes[])=>{
    const bytesAt=(index:number)=>candidates.reduce((sum,nodes)=>sum+(nodes[index]?packedBytes(nodes[index]):0),0);
    return bytesAt(0)+Math.max(bytesAt(1),bytesAt(2))<=OPTICAL_CACHE_BYTES;
  };
  const available=sides.filter(nodes=>nodes[0]);
  const chosen=fits(available)?available:available.filter(nodes=>fits([nodes])).slice(0,1);
  const selections=sides.map(nodes=>chosen.includes(nodes)?nodes[0]:null);
  const neighbors=[...chosen.map(nodes=>nodes[1]),...chosen.map(nodes=>nodes[2])].filter(node=>node!==null);
  return {selections,neighbors};
}
export function selectOpticalLevel(levels:OpticalImageLevel[],px:number,py:number):OpticalImageLevel|null {
  if(!supportsOpticalDensity(px,py))return null;
  return [...levels].sort((a,b)=>a.density-b.density).find(level=>
    Math.max(px,py)<=(level.maxOutputDensity??Infinity)&&
    level.pixelsPerTanTheta[0]+1e-7>=px&&level.pixelsPerTanTheta[1]+1e-7>=py)??null;
}

// The active renderer owns completed layers. Only in-flight loads live here.
export class OpticalImageLoader {
  private manifests=new ManifestCache<OpticalLibrary>();
  private pending=new Map<string,PendingLayer>();
  private store:OpticalImageStore;
  constructor(store:OpticalImageStore) {this.store=store;}
  useStore(store:OpticalImageStore):void {
    if(this.store===store)return;
    this.cancel();this.store=store;
  }
  cancel(keep?:OpticalRequest):void {
    this.manifests.cancel(url=>keep?.models.some(model=>url.split('?')[0].endsWith(`/${model}.json`))??false);
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
    const store=this.store,resident=store.getOptical(key);
    if(resident)return resident;
    const found=this.pending.get(key);
    if(found)return this.observe(found,listener);
    const bytes=opticalDecodeBytes(selection);
    if(level.width<1||level.height<1||bytes+this.info().mainPackedBytes>OPTICAL_CACHE_BYTES){
      throw new Error('Optical image exceeds packed memory budget');
    }
    const controller=new AbortController();let item:PendingLayer;
    const promise=(async()=>{
      if(selection.columns&&store.sliceOptical){
        const sliced=await store.sliceOptical(selection);
        if(controller.signal.aborted)throw new Error('Optical image loading cancelled');
        if(sliced)return sliced;
      }
      const asset=await loadPngAsset(`${base}/optical-images/${level.file}?v=${level.fileSha256}`,controller.signal,{totalMs:18000,expectedBytes:level.bytes,priority:listener?'high':'low',onProgress:p=>{if(item){item.progress=p;for(const fn of item.listeners)fn(p);}}});
      let rgba:Uint8ClampedArray<ArrayBuffer>;
      try{
        const image=asset.image;
        if(image.naturalWidth!==level.width||image.naturalHeight!==level.height)throw new Error('Optical image dimensions changed');
        const canvas=document.createElement('canvas');canvas.width=level.width;canvas.height=level.height;
        try{const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(image,0,0);rgba=ctx.getImageData(0,0,level.width,level.height).data;}
        finally{canvas.width=1;canvas.height=1;}
      }finally{asset.release();}
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rgba)),b=>b.toString(16).padStart(2,'0')).join('');
      if(controller.signal.aborted)throw new Error('Optical image loading cancelled');
      if(hash!==level.decodedRgbaSha256)throw new Error('Optical image numeric samples failed integrity validation');
      validatePackedOpticalImage(rgba,level);
      const {columns}=selection;
      if(columns)rgba=cropOpticalPixels(rgba,level,columns);
      return await store.registerOptical({key,level,columns,rgba});
    })();
    item={promise,controller,selection,bytes,listeners:new Set()};
    this.pending.set(key,item);
    const remove=()=>{if(this.pending.get(key)===item)this.pending.delete(key);};
    void promise.then(remove,remove);
    return this.observe(item,listener);
  }
  async select(base:string,entry:PsfEntry,px:number,py:number,signal?:AbortSignal,visible?:VisibleColumns):Promise<OpticalSelection|null> {
    if(!supportsOpticalDensity(px,py))return null;
    const url=`${base}/optical-images/${entry.model}.json?v=${readingCard.assetSha256}`;
    const manifest=await this.manifests.get(url,async downloadSignal=>{
      const result=JSON.parse(await (await downloadBlob(url,downloadSignal,{totalMs:12000})).text()) as OpticalLibrary;
      if(result.version!==1||result.model!==entry.model||result.encoding!=='opaque-rgb-f12-a12'||result.entries.length!==31||
        result.cardSvgCanonicalSha256!==readingCard.assetSha256||
        result.physicalCardMm[0]!==readingCard.objectWidthMm||result.physicalCardMm[1]!==readingCard.objectHeightMm)
        throw new Error('Incompatible optical image library');
      for(let d=10;d<=40;d++)if(!result.entries.some(e=>e.objectVergenceD===d/10))throw new Error('Incomplete optical image nodes');
      return result;
    },signal);
    const node=manifest.entries.find(e=>e.objectVergenceD===entry.objectVergenceD);
    if(!node||node.psfSha256!==entry.sha256)throw new Error('Precomputed optical image does not match selected PSF');
    const level=selectOpticalLevel(node.levels,px,py);
    if(!level)return null;
    const columns=visible?opticalColumns(level,px,visible.width,visible.cardWidth,visible.left,visible.right):undefined;
    if(opticalDecodeBytes({level,columns})>OPTICAL_CACHE_BYTES)return null;
    return {key:opticalImageKey(level,columns),level,columns,model:entry.model,demand:entry.objectVergenceD};
  }
  async prefetch(base:string,current:OpticalSelection[],neighbors:OpticalSelection[],signal?:AbortSignal):Promise<void> {
    if(!allowSpeculativeLoads())return;
    // Directional GPU prefetch decodes one asset at a time, including its crop.
    const decodeBudget=(signal?6:2)*1024*1024;
    const small=neighbors.filter(node=>opticalDecodeBytes(node)<=decodeBudget);
    if(signal&&small.length!==neighbors.length)return;
    if([...current,...small].reduce((sum,node)=>sum+packedBytes(node),0)>OPTICAL_CACHE_BYTES)return;
    const pending=small.filter(node=>!this.store.getOptical(node.key)).slice(0,2);
    if(signal){
      for(const node of pending){
        if(signal.aborted)return;
        await waitForAsset(this.load(base,node),signal);
      }
    }else await Promise.all(pending.map(node=>this.load(base,node).catch(()=>undefined)));
  }
}
