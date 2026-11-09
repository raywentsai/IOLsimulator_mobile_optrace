import type {BackgroundInput,BackgroundTextureData,SceneInput} from './scene';
import type {PsfEntry} from './geometry';
import {INACTIVE_OPTICAL_BYTES,opticalImageKey,packedOpticalBytes,type OpticalImageRef,type PackedOpticalImageLayer} from './optical-image-math.ts';
import type {AssetFrame,BackgroundFrame} from './worker-runtime';

export interface Computed {data?:Uint8ClampedArray;cancelled?:boolean;milliseconds:number;profile:Record<string,number>}
type RenderInput=SceneInput&{opticalLayer?:OpticalImageRef};
type FrameResult=Omit<Computed,'profile'>&{profiles?:Record<string,number>[]};
type Assets={optical:{keys:string[];bytes:number};psfs:{keys:string[];bytes:number}};
type Reply=FrameResult&{id:number;assets:Assets;error?:string;sliced?:boolean;backgrounds?:BackgroundTextureData[]};
export class PhysicsWorkerClient {
  private id=0;
  private version=0;
  private pending=new Map<number,{resolve:(r:Reply)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private activeFrame:Promise<Reply>|null=null;
  private registrations=new Map<string,Promise<unknown>>();
  private opticalRefs=new Map<string,OpticalImageRef>();
  private assets:Assets={optical:{keys:[],bytes:0},psfs:{keys:[],bytes:0}};
  private disposed=false;
  private worker:Worker;
  private failed:(reason:string)=>void;
  constructor(worker:Worker,source:Uint8ClampedArray,failed:(reason:string)=>void){
    this.worker=worker;this.failed=failed;
    worker.onmessage=event=>{
      const result=event.data as Reply;
      if(result.assets){
        this.assets=result.assets;
        for(const key of this.opticalRefs.keys())if(!this.assets.optical.keys.includes(key))this.opticalRefs.delete(key);
      }
      const item=this.pending.get(result.id);if(!item)return;
      this.pending.delete(result.id);clearTimeout(item.timer);
      if(result.error)item.reject(new Error(result.error));else item.resolve(result);
    };
    worker.onerror=()=>this.failed('Physics worker failed; retry rendering or select Gaussian');
    this.source(source);
  }
  source(data:Uint8ClampedArray):void {this.worker.postMessage({source:data},[data.buffer]);}
  invalidate(version:number):void {this.version=version;this.worker.postMessage({kind:'invalidate',version});}
  async reserveOptical(version:number,keys:string[]):Promise<void> {
    if(this.disposed||version!==this.version)return;
    const message={kind:'reserve-optical',version,keys};
    if(keys.length)await this.request(message);
    else this.worker.postMessage(message);
  }
  private request(message:object,transfer:Transferable[]=[]):Promise<Reply> {
    if(this.disposed)return Promise.reject(new Error('Physics worker disposed'));
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.failed('Physics rendering timed out; retry rendering or select Gaussian'),30000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({...message,id},transfer);}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  private async requestFrame(message:{version:number}&({kind:'render';frames:AssetFrame[]}|{kind:'backgrounds';frames:BackgroundFrame[]}),
    transfer:Transferable[]=[]):Promise<Reply|undefined> {
    // The caller can stop waiting on invalidation, while the Worker still owns
    // its active frame until it reaches a cancellation checkpoint.
    while(this.activeFrame&&message.version===this.version)await this.activeFrame.catch(()=>undefined);
    if(message.version!==this.version)return;
    const pending=this.request(message,transfer);
    this.activeFrame=pending;
    try{return await pending;}finally{this.activeFrame=null;}
  }
  getOptical(key:string):OpticalImageRef|undefined {return this.assets.optical.keys.includes(key)?this.opticalRefs.get(key):undefined;}
  retainOptical(keys:string[]):void {
    const refs=keys.flatMap(key=>this.getOptical(key)??[]);
    const bytes=refs.reduce((sum,ref)=>sum+packedOpticalBytes(ref.level,ref.columns),0);
    const retained=bytes<=INACTIVE_OPTICAL_BYTES?refs.map(ref=>ref.key):[];
    for(const key of this.opticalRefs.keys())if(!retained.includes(key))this.opticalRefs.delete(key);
    this.assets.optical={keys:retained,bytes:retained.length?bytes:0};
    this.worker.postMessage({kind:'retain-optical',keys:retained});
  }
  clearOptical():void {this.retainOptical([]);}
  async sliceOptical(target:OpticalImageRef):Promise<OpticalImageRef|undefined> {
    const {columns,level}=target;
    if(!columns)return;
    const [left,right]=columns,fullKey=opticalImageKey(level);
    const source=[...this.opticalRefs.values()].find(ref=>ref.key===fullKey||
      ref.columns&&ref.key===opticalImageKey(level,ref.columns)&&ref.columns[0]<=left&&ref.columns[1]>=right);
    if(!source)return;
    const reply=await this.request({kind:'slice-optical',sourceKey:source.key,columns});
    if(!reply.sliced)return;
    const ref={key:target.key,level,columns};
    this.opticalRefs.set(ref.key,ref);return ref;
  }
  async registerOptical(layer:PackedOpticalImageLayer):Promise<OpticalImageRef> {
    const found=this.getOptical(layer.key);if(found)return found;
    const ref={key:layer.key,level:layer.level,columns:layer.columns};
    await this.request({kind:'optical',layer},[layer.rgba.buffer]);
    this.opticalRefs.set(ref.key,ref);return ref;
  }
  private async psf(entry:PsfEntry,energy:Float32Array):Promise<string> {
    const key=`${entry.sha256}:${entry.width}:${entry.height}`;
    if(!this.assets.psfs.keys.includes(key)){
      let registration=this.registrations.get(key);
      if(!registration){registration=this.request({kind:'psf',key,energy});this.registrations.set(key,registration);}
      try{await registration;}finally{this.registrations.delete(key);}
    }
    return key;
  }
  async render(input:RenderInput,backgroundKey:string,version:number):Promise<Computed> {
    const {profiles,...result}=await this.renderFrame([{input,backgroundKey}],version);
    return {...result,profile:profiles?.[0]??{}};
  }
  async renderFrame(sides:{input:RenderInput;backgroundKey:string}[],version:number,transferCard=false):Promise<FrameResult> {
    const frames=await Promise.all(sides.map(async({input,backgroundKey}):Promise<AssetFrame>=>{
      const {background,nearEnergy,infinityEnergy,opticalLayer,...parameters}=input;
      const infinityKey=await this.psf(input.infinity,infinityEnergy);
      const nearKey=opticalLayer?undefined:await this.psf(input.near,nearEnergy);
      return {...parameters,infinityKey,nearKey,opticalKey:opticalLayer?.key,backgroundKey};
    }));
    if(version!==this.version)return {cancelled:true,milliseconds:0};
    const transfer=transferCard?[...new Set(frames.map(frame=>frame.card.buffer)
      .filter((buffer):buffer is ArrayBuffer=>buffer instanceof ArrayBuffer&&buffer.byteLength>0))]:[];
    return await this.requestFrame({kind:'render',frames,version},transfer)??{cancelled:true,milliseconds:0};
  }
  async prepareBackgrounds(sides:{input:Omit<BackgroundInput,'background'>;backgroundKey:string;left:number;right:number}[],version:number):Promise<Reply|undefined> {
    const frames=await Promise.all(sides.map(async({input,...region}):Promise<BackgroundFrame>=>{
      const {width,height,backgroundWidth,backgroundHeight,infinity,infinityEnergy,cssPxPerMm,viewingDistanceM,renderScale,renderScaleY}=input;
      const infinityKey=await this.psf(infinity,infinityEnergy);
      return {...region,infinityKey,infinity,width,height,backgroundWidth,backgroundHeight,cssPxPerMm,viewingDistanceM,renderScale,renderScaleY};
    }));
    if(version!==this.version)return;
    return this.requestFrame({kind:'backgrounds',frames,version});
  }
  info():{opticalPackedBytes:number;workerPsfBytes:number;opticalEntries:number} {
    return {opticalPackedBytes:this.assets.optical.bytes,workerPsfBytes:this.assets.psfs.bytes,opticalEntries:this.assets.optical.keys.length};
  }
  dispose(reason:string):void {
    this.disposed=true;this.worker.terminate();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}
    this.pending.clear();this.registrations.clear();this.opticalRefs.clear();
  }
}
