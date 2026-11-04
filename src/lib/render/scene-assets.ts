// Bounded network retries with resource-specific errors. Decode only after an
// HTTP success so an HTML error page cannot masquerade as an image failure.
export async function fetchSceneAsset(url:string,signal?:AbortSignal,timeoutMs=30000):Promise<Blob> {
  for(let attempt=0;attempt<2;attempt++) {
    const controller=new AbortController();
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let retryable=true;
    try {
      if(signal?.aborted)throw new Error('Cancelled');
      const response=await fetch(url,{signal:controller.signal,cache:attempt?'reload':'default'});
      if(!response.ok) {
        retryable=response.status===408||response.status===429||response.status>=500;
        throw new Error(`HTTP ${response.status}`);
      }
      const blob=await response.blob();
      if(!blob.size||!blob.type.startsWith('image/')) {retryable=false;throw new Error(`Invalid image response (${blob.type||'missing content type'})`);}
      return blob;
    }catch(error) {
      if(signal?.aborted)throw new Error('Scene loading cancelled');
      if(attempt||!retryable)throw new Error(`Could not load ${url}: ${controller.signal.aborted?'download timed out':String(error)}`);
    }finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  throw new Error(`Could not load ${url}`);
}

export async function loadSceneImage(url:string,signal:AbortSignal):Promise<HTMLImageElement> {
  const blob=await fetchSceneAsset(url,signal),objectUrl=URL.createObjectURL(blob);
  try {
    return await new Promise((resolve,reject)=>{
      const image=new Image();
      const finish=(error?:string)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);image.onload=null;image.onerror=null;
        if(error){image.src='';reject(new Error(`${url}: ${error}`));}else resolve(image);};
      const abort=()=>finish('loading cancelled');
      const timer=setTimeout(()=>finish('image decode timed out'),20000);
      signal.addEventListener('abort',abort,{once:true});
      image.onload=()=>image.naturalWidth>0?finish():finish('empty image');
      image.onerror=()=>finish(`image decode failed (${blob.type}, ${blob.size} bytes)`);
      if(signal.aborted)abort();else image.src=objectUrl;
    });
  }finally{URL.revokeObjectURL(objectUrl);}
}
