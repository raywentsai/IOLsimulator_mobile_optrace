import {AssetCache} from './asset-cache.ts';
import {blurBackground,renderScene,type SceneInput} from './scene.ts';
import {renderOpticalImage,renderOpticalImageLatest,opticalImageKey,type PackedOpticalImageLayer,type OpticalImageLayer} from './optical-image-math.ts';

export type AssetFrame=Omit<SceneInput,'background'|'nearEnergy'|'infinityEnergy'>&{nearKey?:string;infinityKey:string;opticalKey?:string};
export type WorkerRequest=
  |{kind:'optical';id:number;layer:PackedOpticalImageLayer}
  |{kind:'psf';id:number;key:string;energy:Float32Array}
  |{kind:'render';id:number;version:number;input:AssetFrame;backgroundKey:string}
  |{kind:'invalidate';version:number}
  |{source:Uint8ClampedArray}
  // Independent canonical /validation fixtures keep their direct-input protocol.
  |{id:number;input:SceneInput&{opticalLayer?:OpticalImageLayer|PackedOpticalImageLayer};backgroundKey:string};

export class PhysicsWorkerRuntime {
  // Largest adjacent 8192-level pair is ~12.61 MiB; leave mobile headroom.
  readonly optical=new AssetCache<PackedOpticalImageLayer>(14*1024*1024);
  // Two compared lenses plus recent near nodes; the main library has its own cache.
  readonly psfs=new AssetCache<Float32Array>(6*513*513*4);
  private backgrounds=new Map<string,ReturnType<typeof blurBackground>>();
  private source:Uint8ClampedArray=new Uint8ClampedArray(0);
  private latest=0;
  private rendering=false;
  private yieldTask:()=>Promise<void>;
  constructor(yieldTask:()=>Promise<void>) {this.yieldTask=yieldTask;}
  assets(){return {optical:this.optical.info(),psfs:this.psfs.info()};}
  async handle(message:WorkerRequest) {
    if('source' in message){this.source=message.source;this.backgrounds.clear();return;}
    if('kind' in message&&message.kind==='invalidate'){this.latest=message.version;return;}
    if('kind' in message&&message.kind==='optical'){
      const layer=message.layer;
      if(layer.key!==opticalImageKey(layer.level)||layer.rgba.length!==layer.level.width*layer.level.height*4)throw new Error('Invalid optical registration');
      this.optical.set(layer.key,layer,layer.rgba.byteLength);
      return {id:message.id,assets:this.assets()};
    }
    if('kind' in message&&message.kind==='psf'){
      this.psfs.set(message.key,message.energy,message.energy.byteLength);
      return {id:message.id,assets:this.assets()};
    }
    if(this.rendering)throw new Error('Physics renderer already busy');
    const modern='kind' in message;
    const current=()=>!modern||message.version===this.latest;
    if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
    let input:SceneInput,layer:PackedOpticalImageLayer|OpticalImageLayer|undefined;
    if(modern){
      const frame=message.input;
      const infinityEnergy=this.psfs.get(frame.infinityKey),nearEnergy=frame.nearKey?this.psfs.get(frame.nearKey):new Float32Array(0);
      layer=frame.opticalKey?this.optical.get(frame.opticalKey):undefined;
      if(!infinityEnergy||!nearEnergy||frame.opticalKey&&!layer)throw new Error('Worker asset missing; retry rendering');
      this.psfs.pinned.add(frame.infinityKey);if(frame.nearKey)this.psfs.pinned.add(frame.nearKey);
      if(frame.opticalKey)this.optical.pinned.add(frame.opticalKey);
      input={...frame,background:this.source,nearEnergy,infinityEnergy};
    }else{input={...message.input,background:this.source};layer=message.input.opticalLayer;}
    this.rendering=true;
    try {
      const start=performance.now(),profile:Record<string,number>={};
      let background=this.backgrounds.get(message.backgroundKey);
      if(!background){
        background=blurBackground(input,profile);this.backgrounds.set(message.backgroundKey,background);
        if(this.backgrounds.size>2)this.backgrounds.delete(this.backgrounds.keys().next().value!);
        // Inputs arriving during a synchronous cold FFT can skip the obsolete near work.
        if(modern)await this.yieldTask();
      }else{this.backgrounds.delete(message.backgroundKey);this.backgrounds.set(message.backgroundKey,background);}
      if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
      const data=layer?('rgba' in layer&&modern?await renderOpticalImageLatest(input,layer,background,profile,current,this.yieldTask):renderOpticalImage(input,layer,background,profile)):renderScene(input,background,profile);
      if(!data||!current())return {id:message.id,cancelled:true,assets:this.assets()};
      return {id:message.id,data,profile,milliseconds:performance.now()-start,assets:this.assets()};
    }finally{this.rendering=false;this.psfs.pinned.clear();this.optical.pinned.clear();}
  }
}
