/// <reference lib="webworker" />
import {PhysicsWorkerRuntime,type WorkerRequest} from './worker-runtime';
const scope=self as unknown as DedicatedWorkerGlobalScope;
const channel=new MessageChannel(),waiting:Array<()=>void>=[];
channel.port1.onmessage=()=>waiting.shift()?.();
const runtime=new PhysicsWorkerRuntime(()=>new Promise(resolve=>{waiting.push(resolve);channel.port2.postMessage(0);}));
scope.onmessage=async(event:MessageEvent<WorkerRequest>)=>{
  try{
    const result=await runtime.handle(event.data);
    if(result){
      const transfer='data' in result&&result.data?[result.data.buffer]:
        'backgrounds' in result&&result.backgrounds?result.backgrounds.map(frame=>frame.pixels.buffer):[];
      scope.postMessage(result,transfer);
    }
  }catch(error){scope.postMessage({id:'id' in event.data?event.data.id:undefined,error:String(error),assets:runtime.assets()});}
};
