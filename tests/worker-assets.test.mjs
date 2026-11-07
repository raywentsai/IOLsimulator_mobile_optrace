import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {AssetCache} from '../src/lib/render/psf/asset-cache.ts';
import {PhysicsWorkerRuntime} from '../src/lib/render/psf/worker-runtime.ts';
import {PhysicsWorkerClient} from '../src/lib/render/psf/worker-client.ts';
import {unpackOpticalImage,renderOpticalImage,renderOpticalImageLatest,opticalImageKey,validatePackedOpticalImage} from '../src/lib/render/psf/optical-image-math.ts';
import {readRgbPng} from './png-helper.mjs';
const library=JSON.parse(fs.readFileSync('static/optical-images/manifest.json'));
const fixtures=JSON.parse(fs.readFileSync('static/validation/optical-image-reference.json')).cases;
const energy=e=>{const a=gunzipSync(fs.readFileSync('static/psf/'+e.file));return new Float32Array(a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength));};
const packed=level=>({key:opticalImageKey(level),level,rgba:readRgbPng('static/optical-images/'+level.file).rgba});

test('packed CPU integration is byte-identical to Float32 planes for all 62 levels, cropped odd/even anchors and low density',()=>{
  for(const node of library.entries)for(const level of node.levels){
    const p=packed(level);validatePackedOpticalImage(p.rgba,level);
    const expanded=unpackOpticalImage(p.rgba,level);
    for(const width of [73,74]){
      const density=width===73?128:Math.min(...level.pixelsPerTanTheta)*.8;
      const input={width,height:91,cardWidth:Math.round(28*1528/1170*node.objectVergenceD*density/1000),cssPxPerMm:1,viewingDistanceM:1,renderScale:density/1000};
      const background=[0,1,2].map(c=>Float32Array.from({length:width*91},(_,i)=>.05+c*.1+(i%19)/40));
      assert.deepEqual(renderOpticalImage(input,p,background),renderOpticalImage(input,expanded,background),level.file);
    }
  }
});

test('byte LRU retains both high-density neighbours, touches hits, accounts replacement and protects active assets',()=>{
  const cache=new AssetCache(16*1024*1024);
  const [a,b]=[3.9,4].map(d=>packed(library.entries.find(e=>e.objectVergenceD===d).levels[1]));
  cache.set(a.key,a,a.rgba.byteLength);cache.set(b.key,b,b.rgba.byteLength);
  assert.equal(cache.info().keys.length,2);assert.ok(cache.info().bytes<cache.budget);
  assert.equal(cache.get(a.key),a);cache.pinned.add(a.key);
  cache.set('other',null,5*1024*1024);
  assert.equal(cache.get(b.key),undefined);assert.equal(cache.get(a.key),a);
  const before=cache.info();assert.throws(()=>cache.set('too-large',null,12*1024*1024),/Active assets/);assert.deepEqual(cache.info(),before);
  cache.set(a.key,a,a.rgba.byteLength);assert.equal(cache.info().bytes,a.rgba.byteLength+5*1024*1024);
  cache.clear();assert.equal(cache.info().bytes,0);
});

// Actual structuredClone/transfer semantics, asynchronous message boundaries and runtime.
class FakeWorker {
  messages=[];terminated=false;
  runtime=new PhysicsWorkerRuntime(()=>new Promise(r=>setImmediate(r)));
  postMessage(message,transfer=[]){
    const cloned=structuredClone(message,{transfer});this.messages.push(cloned);
    setImmediate(async()=>{if(this.terminated)return;
      try{const result=await this.runtime.handle(cloned);if(result)this.onmessage?.({data:result});}
      catch(e){this.onmessage?.({data:{id:cloned.id,error:String(e),assets:this.runtime.assets()}});}
    });
  }
  terminate(){this.terminated=true;}
}
test('register-once transfers sole optical/source buffers; warm frames send IDs without optical or PSF arrays; reset reacquires assets',async()=>{
  const fixture=fixtures[1],raw=new Uint8ClampedArray(fixture.background),worker=new FakeWorker();
  const client=new PhysicsWorkerClient(worker,raw,reason=>client.dispose(reason));assert.equal(raw.byteLength,0);
  client.invalidate(1);
  const p=packed(fixture.level),expectedBytes=p.rgba.byteLength,ref=await client.registerOptical(p);
  assert.equal(p.rgba.byteLength,0);assert.equal(client.info().opticalPackedBytes,expectedBytes);
  const input={...fixture,background:new Uint8ClampedArray(0),card:new Float32Array(0),nearEnergy:new Float32Array(0),infinityEnergy:energy(fixture.infinity),opticalLayer:ref};
  const first=await client.render(input,'same',1),second=await client.render(input,'same',1);
  assert.deepEqual(first.data,second.data);assert.equal(second.profile.backgroundConvolveMs,undefined);
  const expected=gunzipSync(fs.readFileSync('static/validation/'+fixture.expectedFile));
  assert.ok(first.data.every((v,i)=>Math.abs(v-expected[i])<=1),'registered Worker agrees with independent Python');
  assert.equal(worker.messages.filter(m=>m.kind==='psf').length,1);
  assert.equal(worker.messages.filter(m=>m.kind==='optical').length,1);
  for(const m of worker.messages.filter(m=>m.kind==='render')){
    assert.equal(m.input.opticalLayer,undefined);assert.equal(m.input.nearEnergy,undefined);assert.equal(m.input.infinityEnergy,undefined);assert.equal(m.input.card.byteLength,0);
  }
  // Replacing the source drops backgrounds while preserving the registered optical/PSF assets.
  client.source(new Uint8ClampedArray(fixture.background));await client.render(input,'same',1);
  assert.equal(worker.messages.filter(m=>m.kind==='psf').length,1);
  client.dispose('restart');assert.equal(worker.terminated,true);
  const w2=new FakeWorker(),c2=new PhysicsWorkerClient(w2,new Uint8ClampedArray(fixture.background),r=>c2.dispose(r));
  assert.equal(c2.getOptical(ref.key),undefined);
  const reloaded=await c2.registerOptical(packed(fixture.level));c2.invalidate(2);
  assert.deepEqual((await c2.render({...input,opticalLayer:reloaded},'same',2)).data,first.data);c2.dispose('done');
});

test('obsolete versions skip work, cold FFT cache survives cancellation, and cooperative near work stops at a yield',async()=>{
  const f=fixtures[1],p=packed(f.level);let runtime,invalidated=false;
  runtime=new PhysicsWorkerRuntime(async()=>{if(!invalidated){invalidated=true;await runtime.handle({kind:'invalidate',version:2});}});
  await runtime.handle({source:new Uint8ClampedArray(f.background)});
  await runtime.handle({kind:'optical',id:1,layer:p});await runtime.handle({kind:'psf',id:2,key:'infinity',energy:energy(f.infinity)});
  const input={...f,card:new Float32Array(0),infinityKey:'infinity',opticalKey:p.key};
  await runtime.handle({kind:'invalidate',version:1});
  assert.equal((await runtime.handle({kind:'render',id:3,version:1,input,backgroundKey:'bg'})).cancelled,true);
  const next=await runtime.handle({kind:'render',id:4,version:2,input,backgroundKey:'bg'});
  assert.ok(next.data);assert.equal(next.profile.backgroundConvolveMs,undefined);
  assert.equal((await runtime.handle({kind:'render',id:5,version:1,input,backgroundKey:'bg'})).cancelled,true);
  let current=true,yields=0;
  const background=[0,1,2].map(()=>new Float32Array(f.width*f.height).fill(.2));
  const result=await renderOpticalImageLatest(f,p,background,{},()=>current,async()=>{yields++;current=false;},0);
  assert.equal(result,null);assert.equal(yields,1);
});
