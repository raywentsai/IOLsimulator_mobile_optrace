import {AssetCache} from './asset-cache.ts';
import {blurBackground,renderScene,type SceneInput} from './scene.ts';
import {OPTICAL_CACHE_BYTES,renderOpticalImageLatest,opticalImageKey,type PackedOpticalImageLayer} from './optical-image-math.ts';

export type AssetFrame=Omit<SceneInput,'background'|'nearEnergy'|'infinityEnergy'>&{nearKey?:string;infinityKey:string;opticalKey?:string};
export type WorkerRequest=
  |{kind:'optical';id:number;layer:PackedOpticalImageLayer}
  |{kind:'psf';id:number;key:string;energy:Float32Array}
  |{kind:'render';id:number;version:number;input:AssetFrame;backgroundKey:string}
  |{kind:'invalidate';version:number}
  |{kind:'reserve-optical';id?:number;version:number;keys:string[]}
  |{source:Uint8ClampedArray};

export class PhysicsWorkerRuntime {
  readonly optical=new AssetCache<PackedOpticalImageLayer>(OPTICAL_CACHE_BYTES);
  // Two compared lenses plus recent near nodes; the main library has its own cache.
  readonly psfs=new AssetCache<Float32Array>(6*513*513*4);
  private backgrounds=new Map<string,ReturnType<typeof blurBackground>>();
  private source:Uint8ClampedArray=new Uint8ClampedArray(0);
  private latest=0;
  private reservedOptical:string[]=[];
  private rendering=false;
  private yieldTask:()=>Promise<void>;
  constructor(yieldTask:()=>Promise<void>) {this.yieldTask=yieldTask;}
  assets(){return {optical:this.optical.info(),psfs:this.psfs.info()};}
  async handle(message:WorkerRequest) {
    if('source' in message){this.source=message.source;this.backgrounds.clear();return;}
    if(message.kind==='invalidate'){this.latest=message.version;this.reservedOptical=[];return;}
    if(message.kind==='reserve-optical'){
      if(message.version===this.latest)this.reservedOptical=message.keys;
      return message.id===undefined?undefined:{id:message.id,assets:this.assets()};
    }
    if(message.kind==='optical'){
      const layer=message.layer;
      if(layer.key!==opticalImageKey(layer.level)||layer.rgba.length!==layer.level.width*layer.level.height*4)throw new Error('Invalid optical registration');
      this.optical.set(layer.key,layer,layer.rgba.byteLength,this.reservedOptical);
      return {id:message.id,assets:this.assets()};
    }
    if(message.kind==='psf'){
      this.psfs.set(message.key,message.energy,message.energy.byteLength);
      return {id:message.id,assets:this.assets()};
    }
    if(this.rendering)throw new Error('Physics renderer already busy');
    const current=()=>message.version===this.latest;
    if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
    const frame=message.input;
    const infinityEnergy=this.psfs.get(frame.infinityKey),nearEnergy=frame.nearKey?this.psfs.get(frame.nearKey):new Float32Array(0);
    const layer=frame.opticalKey?this.optical.get(frame.opticalKey):undefined;
    if(!infinityEnergy||!nearEnergy||frame.opticalKey&&!layer)throw new Error('Worker asset missing; retry rendering');
    this.psfs.pinned.add(frame.infinityKey);if(frame.nearKey)this.psfs.pinned.add(frame.nearKey);
    if(frame.opticalKey)this.optical.pinned.add(frame.opticalKey);
    const input:SceneInput={...frame,background:this.source,nearEnergy,infinityEnergy};
    this.rendering=true;
    try {
      const start=performance.now(),profile:Record<string,number>={};
      let background=this.backgrounds.get(message.backgroundKey);
      if(!background){
        background=blurBackground(input,profile);this.backgrounds.set(message.backgroundKey,background);
        if(this.backgrounds.size>2)this.backgrounds.delete(this.backgrounds.keys().next().value!);
        // Inputs arriving during a synchronous cold FFT can skip the obsolete near work.
        await this.yieldTask();
      }else{this.backgrounds.delete(message.backgroundKey);this.backgrounds.set(message.backgroundKey,background);}
      if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
      const data=layer?await renderOpticalImageLatest(input,layer,background,profile,current,this.yieldTask):renderScene(input,background,profile);
      if(!data||!current())return {id:message.id,cancelled:true,assets:this.assets()};
      return {id:message.id,data,profile,milliseconds:performance.now()-start,assets:this.assets()};
    }finally{this.rendering=false;this.psfs.pinned.clear();this.optical.pinned.clear();}
  }
}
