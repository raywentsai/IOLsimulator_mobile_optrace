import type {SceneInput} from './scene';
import type {PsfEntry} from './geometry';
import type {OpticalImageRef,PackedOpticalImageLayer} from './optical-image-math';
import type {AssetFrame} from './worker-runtime';

export interface Computed {data?:Uint8ClampedArray;cancelled?:boolean;milliseconds:number;profile:Record<string,number>}
type Assets={optical:{keys:string[];bytes:number};psfs:{keys:string[];bytes:number}};
type Reply=Computed&{id:number;assets:Assets;error?:string};
export class PhysicsWorkerClient {
  private id=0;
  private version=0;
  private pending=new Map<number,{resolve:(r:Reply)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private registrations=new Map<string,Promise<unknown>>();
  private opticalRefs=new Map<string,OpticalImageRef>();
  private assets:Assets={optical:{keys:[],bytes:0},psfs:{keys:[],bytes:0}};
  private disposed=false;
  private worker:Worker;
  private failed:(reason:string)=>void;
  constructor(worker:Worker,source:Uint8ClampedArray,failed:(reason:string)=>void){
    this.worker=worker;this.failed=failed;
    worker.onmessage=event=>{
      const result=event.data as Reply;if(result.assets)this.assets=result.assets;
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
  getOptical(key:string):OpticalImageRef|undefined {return this.assets.optical.keys.includes(key)?this.opticalRefs.get(key):undefined;}
  async registerOptical(layer:PackedOpticalImageLayer):Promise<OpticalImageRef> {
    const found=this.getOptical(layer.key);if(found)return found;
    const ref={key:layer.key,level:layer.level};
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
  async render(input:SceneInput&{opticalLayer?:OpticalImageRef},backgroundKey:string,version:number):Promise<Computed> {
    const {background,nearEnergy,infinityEnergy,opticalLayer,...parameters}=input;
    const infinityKey=await this.psf(input.infinity,infinityEnergy);
    const nearKey=opticalLayer?undefined:await this.psf(input.near,nearEnergy);
    if(version!==this.version)return {cancelled:true,milliseconds:0,profile:{}};
    const frame:AssetFrame={...parameters,infinityKey,nearKey,opticalKey:opticalLayer?.key};
    return this.request({kind:'render',input:frame,backgroundKey,version});
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
