/// <reference lib="webworker" />
import { blurBackground, renderScene, type SceneInput } from './scene';
import {renderOpticalImage,type OpticalImageLayer} from './optical-image-math';

const workerScope=self as unknown as DedicatedWorkerGlobalScope;
const backgrounds=new Map<string,ReturnType<typeof blurBackground>>();
let original:Uint8ClampedArray;
workerScope.onmessage=(event:MessageEvent<{source?:Uint8ClampedArray;id:number;input:SceneInput&{opticalLayer?:OpticalImageLayer};backgroundKey:string}>)=>{
  if(event.data.source) {original=event.data.source;backgrounds.clear();return;}
  const {id,input,backgroundKey}=event.data;
  try {
    input.background=original;
    const start=performance.now();
    const profile:Record<string,number>={};
    let background=backgrounds.get(backgroundKey);
    if(!background) {
      background=blurBackground(input,profile);backgrounds.set(backgroundKey,background);
      if(backgrounds.size>2) backgrounds.delete(backgrounds.keys().next().value!);
    }
    const data=input.opticalLayer?renderOpticalImage(input,input.opticalLayer,background,profile):renderScene(input,background,profile);
    workerScope.postMessage({id,data,width:input.width,height:input.height,profile,milliseconds:performance.now()-start},[data.buffer]);
  } catch(error) {workerScope.postMessage({id,error:String(error)});}
};
