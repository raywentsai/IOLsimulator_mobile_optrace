/// <reference lib="webworker" />
import { blurBackground, renderScene, type SceneInput } from './scene';

const workerScope=self as unknown as DedicatedWorkerGlobalScope;
const backgrounds=new Map<string,ReturnType<typeof blurBackground>>();
let original:Uint8ClampedArray;
workerScope.onmessage=(event:MessageEvent<{source?:Uint8ClampedArray;id:number;input:SceneInput;backgroundKey:string}>)=>{
  if(event.data.source) {original=event.data.source;return;}
  const {id,input,backgroundKey}=event.data;
  try {
    input.background=original;
    const start=performance.now();
    let background=backgrounds.get(backgroundKey);
    if(!background) {
      background=blurBackground(input);backgrounds.set(backgroundKey,background);
      if(backgrounds.size>2) backgrounds.delete(backgrounds.keys().next().value!);
    }
    const data=renderScene(input,background);
    workerScope.postMessage({id,data,width:input.width,height:input.height,milliseconds:performance.now()-start},[data.buffer]);
  } catch(error) {workerScope.postMessage({id,error:String(error)});}
};
