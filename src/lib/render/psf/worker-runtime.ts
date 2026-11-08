import {AssetCache} from './asset-cache.ts';
import {blurBackground,renderScene,sceneTarget,type SceneInput,type SceneProfile} from './scene.ts';
import {OPTICAL_CACHE_BYTES,renderOpticalImageLatest,opticalImageKey,packedOpticalBytes,cropOpticalPixels,
  type OpticalColumns,type PackedOpticalImageLayer} from './optical-image-math.ts';

export type AssetFrame=Omit<SceneInput,'background'|'nearEnergy'|'infinityEnergy'>&{nearKey?:string;infinityKey:string;opticalKey?:string;backgroundKey:string};
export type WorkerRequest=
  |{kind:'optical';id:number;layer:PackedOpticalImageLayer}
  |{kind:'slice-optical';id:number;sourceKey:string;columns:OpticalColumns}
  |{kind:'psf';id:number;key:string;energy:Float32Array}
  |{kind:'render';id:number;version:number;frames:AssetFrame[]}
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
      const {level,columns}=layer;
      if(layer.key!==opticalImageKey(level,columns)||layer.rgba.length!==packedOpticalBytes(level,columns)||
        columns&&(!columns.every(Number.isInteger)||columns[0]<0||columns[1]>level.width||columns[0]>columns[1]))throw new Error('Invalid optical registration');
      this.optical.set(layer.key,layer,layer.rgba.byteLength,this.reservedOptical);
      return {id:message.id,assets:this.assets()};
    }
    if(message.kind==='slice-optical'){
      const source=this.optical.get(message.sourceKey),{columns}=message;
      if(!source)return {id:message.id,sliced:false,assets:this.assets()};
      const {level}=source,[left,right]=source.columns??[0,level.width];
      if(columns[0]<left||columns[1]>right||columns[0]>columns[1]||!columns.every(Number.isInteger))throw new Error('Invalid optical slice');
      const key=opticalImageKey(level,columns),rgba=cropOpticalPixels(source.rgba,level,columns,source.columns);
      this.optical.set(key,{key,level,columns,rgba},rgba.byteLength,this.reservedOptical);
      return {id:message.id,sliced:true,assets:this.assets()};
    }
    if(message.kind==='psf'){
      this.psfs.set(message.key,message.energy,message.energy.byteLength);
      return {id:message.id,assets:this.assets()};
    }
    if(this.rendering)throw new Error('Physics renderer already busy');
    const current=()=>message.version===this.latest;
    if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
    const {frames}=message;
    if(frames.length<1||frames.length>2)throw new Error('Invalid frame count');
    const {width,height}=frames[0];
    if(frames.some(frame=>frame.width!==width||frame.height!==height))throw new Error('Compared frames must share the scene grid');
    const data=new Uint8ClampedArray(width*height*4),profiles:SceneProfile[]=[];
    const start=performance.now(),boundary=Math.floor(width/2);
    this.rendering=true;
    try {
      const inputs=frames.map(frame=>{
        const infinityEnergy=this.psfs.get(frame.infinityKey),nearEnergy=frame.nearKey?this.psfs.get(frame.nearKey):new Float32Array(0);
        const layer=frame.opticalKey?this.optical.get(frame.opticalKey):undefined;
        if(!infinityEnergy||!nearEnergy||frame.opticalKey&&!layer)throw new Error('Worker asset missing; retry rendering');
        this.psfs.pinned.add(frame.infinityKey);if(frame.nearKey)this.psfs.pinned.add(frame.nearKey);
        if(frame.opticalKey)this.optical.pinned.add(frame.opticalKey);
        const input:SceneInput={...frame,background:this.source,nearEnergy,infinityEnergy};
        return {input,layer,backgroundKey:frame.backgroundKey};
      });
      for(const [index,{input,layer,backgroundKey}]of inputs.entries()){
        const sideStart=performance.now(),profile:SceneProfile={};profiles.push(profile);
        const left=index===0?0:boundary,right=inputs.length===2&&index===0?boundary:width;
        if(left===right)continue;
        const target=sceneTarget(width,height,left,right,data);
        const key=`${backgroundKey}:${left}:${right}`;
        let background=this.backgrounds.get(key);
        if(!background){
          background=blurBackground(input,profile,target);this.backgrounds.set(key,background);
          if(this.backgrounds.size>2)this.backgrounds.delete(this.backgrounds.keys().next().value!);
          // Inputs arriving during a synchronous cold FFT can skip obsolete work.
          await this.yieldTask();
        }else{this.backgrounds.delete(key);this.backgrounds.set(key,background);}
        if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
        if(layer)await renderOpticalImageLatest(input,layer,background,profile,current,this.yieldTask,6,target);
        else renderScene(input,background,profile,target);
        profile.workerMs=performance.now()-sideStart;
        if(!current())return {id:message.id,cancelled:true,assets:this.assets()};
      }
      return {id:message.id,data,profiles,milliseconds:performance.now()-start,assets:this.assets()};
    }finally{this.rendering=false;this.psfs.pinned.clear();this.optical.pinned.clear();}
  }
}
