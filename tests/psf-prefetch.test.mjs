import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prefetchPsfNeighbors,cancelPsfPrefetch,loadPsf} from '../src/lib/render/psf/library.ts';

test('foreground claims a speculative PSF, cancelling other downloads without duplicate fetch or stale cache deletion',async()=>{
  const original=globalThis.fetch;
  const library=JSON.parse(fs.readFileSync('static/psf/manifest.json'));
  const model='aspheric_monofocal_dc_v1';
  const target=library.entries.find(e=>e.model===model&&e.objectVergenceD===2.4);
  const requests=new Map();
  try {
    globalThis.fetch=async(url,options)=>{
      if(url.endsWith('manifest.json'))return new Response(JSON.stringify(library));
      assert.ok(!requests.has(url),'duplicate download');
      return new Promise((resolve,reject)=>{
        requests.set(url,{resolve,reject,signal:options.signal});
        options.signal?.addEventListener('abort',()=>reject(new Error('cancelled')));
      });
    };
    const neighbors=prefetchPsfNeighbors('/test',[model],2.5);
    for(let i=0;i<20&&requests.size<2;i++)await new Promise(r=>setTimeout(r,1));
    assert.equal(requests.size,2);
    // UI schedules cancellation before starting the foreground load.
    cancelPsfPrefetch({models:[model],demand:2.4});
    const profile={},claimed=loadPsf('/test',target,profile);
    const targetRequest=requests.get(`/test/psf/${target.file}`);
    assert.equal(targetRequest.signal.aborted,false);
    assert.equal([...requests.values()].filter(r=>r.signal.aborted).length,1);
    targetRequest.resolve(new Response(fs.readFileSync(`static/psf/${target.file}`)));
    const energy=await claimed;await neighbors;
    assert.equal(profile.cacheHit,1);
    assert.ok(Math.abs(energy.reduce((s,x)=>s+x,0)-1)<1e-6);
    assert.equal(await loadPsf('/test',target),energy);
    assert.equal(requests.size,2);
    const obsolete=library.entries.find(e=>e.model===model&&e.objectVergenceD===3.8);
    const pending=loadPsf('/test',obsolete);
    cancelPsfPrefetch({models:[model],demand:2.4});
    await assert.rejects(pending,/cancelled/);
    assert.equal(await loadPsf('/test',target),energy);
  }finally{cancelPsfPrefetch();globalThis.fetch=original;}
});
