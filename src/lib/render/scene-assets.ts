// Keep PNG/SVG at their real URLs for their whole lifetime, as in 01e764e.
// No fetch, Blob URL creation or early object-URL revocation is required.
export async function loadSceneImage(url:string,signal:AbortSignal,timeoutMs=60000):Promise<HTMLImageElement> {
  for(let attempt=0;attempt<2;attempt++) {
    if(signal.aborted)throw new Error(url+': loading cancelled');
    try {
      return await new Promise<HTMLImageElement>((resolve,reject)=>{
        const image=new Image();let settled=false;
        const finish=(error?:string)=>{
          if(settled)return;settled=true;
          clearTimeout(timer);signal.removeEventListener('abort',abort);
          image.onload=null;image.onerror=null;
          if(error){image.removeAttribute('src');reject(new Error(url+': '+error));}
          else resolve(image);
        };
        const abort=()=>finish('loading cancelled');
        const timer=setTimeout(()=>finish('image request timed out'),timeoutMs);
        signal.addEventListener('abort',abort,{once:true});
        image.onload=()=>image.naturalWidth>0?finish():finish('empty image');
        image.onerror=()=>finish('image download or decode failed');
        if(signal.aborted)abort();else image.src=url;
      });
    }catch(error){if(signal.aborted||attempt===1)throw error;}
  }
  throw new Error(url+': unable to load image');
}
