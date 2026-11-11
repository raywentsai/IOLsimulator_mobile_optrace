import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {AssetCache} from '../src/lib/render/psf/asset-cache.ts';
import {PhysicsWorkerRuntime} from '../src/lib/render/psf/worker-runtime.ts';
import {PhysicsWorkerClient} from '../src/lib/render/psf/worker-client.ts';
import {OPTICAL_CACHE_BYTES,unpackOpticalImage,renderOpticalImage,renderOpticalImageLatest,opticalImageKey,opticalColumns,cropOpticalPixels,
  angularDisplayDensity,validatePackedOpticalImage} from '../src/lib/render/psf/optical-image-math.ts';
import {blurBackground,packBackgroundRgb,renderScene,sceneTarget} from '../src/lib/render/psf/scene.ts';
import {gpuSampling} from '../src/lib/render/psf/gpu-display.ts';
import {opticalWorkingSet} from '../src/lib/render/psf/optical-images.ts';
import {physicsIols} from '../src/lib/data/iol-models.ts';
import {readRgbPng} from './png-helper.mjs';
const libraries=Object.keys(physicsIols).map(model=>JSON.parse(fs.readFileSync(`static/optical-images/${model}.json`)));
const library=libraries.find(value=>value.model==='aspheric_monofocal_dc_v1');
const fixtures=JSON.parse(fs.readFileSync('static/validation/optical-image-reference.json')).cases;
const energy=e=>{const a=gunzipSync(fs.readFileSync('static/psf/'+e.file));return new Float32Array(a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength));};
const packed=level=>({key:opticalImageKey(level),level,rgba:readRgbPng('static/optical-images/'+level.file).rgba});
const slice=(layer,input,left,right)=>{
  const columns=opticalColumns(layer.level,angularDisplayDensity(input)[0],input.width,input.cardWidth,left,right);
  return columns?{...layer,key:opticalImageKey(layer.level,columns),columns,rgba:cropOpticalPixels(layer.rgba,layer.level,columns)}:layer;
};

test('packed CPU integration is byte-identical to Float32 planes across all shipped levels',()=>{
  for(const model of libraries)for(const node of model.entries)for(const level of node.levels){
    const p=packed(level);validatePackedOpticalImage(p.rgba,level);
    const expanded=unpackOpticalImage(p.rgba,level);
    for(const width of [73,74]){
      const density=width===73?128:Math.min(8192,Math.min(...level.pixelsPerTanTheta)*.8);
      const input={width,height:91,cardWidth:Math.round(28*1528/1170*node.objectVergenceD*density/1000),cssPxPerMm:1,viewingDistanceM:1,renderScale:density/1000};
      const background=[0,1,2].map(c=>Float32Array.from({length:width*91},(_,i)=>.05+c*.1+(i%19)/40));
      const expected=renderOpticalImage(input,expanded,background);
      assert.deepEqual(renderOpticalImage(input,p,background),expected,level.file);
      const output=new Uint8ClampedArray(expected.length),mid=Math.floor(width/2);
      for(const [left,right] of [[0,mid],[mid,width]]){
        const crop=background.map(channel=>Float32Array.from({length:(right-left)*91},(_,i)=>
          channel[Math.floor(i/(right-left))*width+left+i%(right-left)]));
        renderOpticalImage(input,slice(p,input,left,right),crop,{},sceneTarget(width,91,left,right,output));
      }
      assert.deepEqual(output,expected,`cropped optical rows are byte-identical for ${level.file}`);
    }
  }
});

test('byte LRU retains both high-density neighbours, touches hits, accounts replacement and protects active assets',()=>{
  const cache=new AssetCache(OPTICAL_CACHE_BYTES);
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

test('texture-backed LRU releases replaced, evicted and cleared allocations exactly once',()=>{
  const released=[],cache=new AssetCache(6,value=>released.push(value));
  cache.set('left','left texture',3);cache.set('right','right texture',3);
  cache.set('left','replacement',3);cache.get('right');
  cache.set('other','other texture',3,['right']);
  cache.clear();cache.clear();
  assert.deepEqual(released,['left texture','replacement','right texture','other texture']);
  assert.deepEqual(cache.info(),{keys:[],bytes:0});
});

test('both selected lenses fit in the shared budget and the pending side survives eviction',async()=>{
  for(let index=0;index<31;index++){
    const sizes=libraries.map(model=>Math.max(...model.entries[index].levels.map(level=>4*level.width*level.height)));
    sizes.sort((a,b)=>b-a);
    assert.ok(sizes[0]+sizes[1]<=OPTICAL_CACHE_BYTES);
  }
  const at=(model,demand)=>packed(model.entries.find(e=>e.objectVergenceD===demand).levels.at(-1));
  const left=at(library,3.9),previous=at(library,4),right=at(libraries.find(m=>m.model==='vivity_inspired_v2_1_dc_v1'),3.9);
  const worker=new FakeWorker();
  const client=new PhysicsWorkerClient(worker,new Uint8ClampedArray(0),reason=>client.dispose(reason));
  try{
    client.invalidate(1);
    await client.registerOptical(left);
    await client.registerOptical(previous);
    // Left is the oldest asset, but it is needed by this version of the split.
    await client.reserveOptical(1,[left.key,right.key]);
    await client.registerOptical(right);
    assert.ok(client.getOptical(left.key));
    assert.ok(client.getOptical(right.key));
    assert.equal(client.getOptical(previous.key),undefined);
    client.invalidate(2);
    await client.reserveOptical(1,[left.key,right.key]);
    await client.registerOptical(at(library,4));
    assert.equal(client.getOptical(left.key),undefined);
  }finally{client.dispose('done');}
});

// Actual structuredClone/transfer semantics, asynchronous message boundaries and runtime.
class FakeWorker {
  messages=[];terminated=false;
  runtime=new PhysicsWorkerRuntime(()=>new Promise(r=>setImmediate(r)));
  postMessage(message,transfer=[]){
    const cloned=structuredClone(message,{transfer});this.messages.push(cloned);
    setImmediate(async()=>{if(this.terminated)return;
      try{
        const result=await this.runtime.handle(cloned);
        if(result)this.onmessage?.({data:structuredClone(result,{transfer:result.data?[result.data.buffer]:result.backgrounds?.map(frame=>frame.pixels.buffer)??[]})});
      }
      catch(e){this.onmessage?.({data:{id:cloned.id,error:String(e),assets:this.runtime.assets()}});}
    });
  }
  terminate(){this.terminated=true;}
}

test('inactive Worker retains a recent optical frame only when its layers fit together',async()=>{
  const vivity=libraries.find(model=>model.model==='vivity_inspired_v2_1_dc_v1');
  const left=packed(vivity.entries.find(node=>node.objectVergenceD===1.7).levels[0]);
  const right=packed(library.entries.find(node=>node.objectVergenceD===1.7).levels[0]);
  const worker=new FakeWorker(),client=new PhysicsWorkerClient(worker,new Uint8ClampedArray(0),reason=>client.dispose(reason));
  try{
    client.invalidate(1);
    await client.registerOptical(left);
    await client.registerOptical(right);
    client.retainOptical([left.key]);
    await client.reserveOptical(1,[left.key]);
    assert.deepEqual(worker.runtime.assets().optical.keys,[left.key]);
    assert.ok(client.getOptical(left.key));
    assert.equal(client.getOptical(right.key),undefined);
    await client.registerOptical(packed(right.level));
    client.retainOptical([left.key,right.key]);
    await client.reserveOptical(1,[left.key]);
    assert.equal(worker.runtime.assets().optical.bytes,0);
    assert.equal(client.getOptical(left.key),undefined);
  }finally{client.dispose('done');}
});

test('GPU background preparation transfers only requested linear regions and shares the CPU blur cache',async()=>{
  const f=fixtures[0],width=37,height=43,backgroundWidth=7,backgroundHeight=9;
  const background=Uint8ClampedArray.from({length:backgroundWidth*backgroundHeight*4},(_,i)=>i%4===3?255:i*71%256);
  const input={...f,width,height,backgroundWidth,backgroundHeight,background:background.slice(),infinityEnergy:energy(f.infinity)};
  const worker=new FakeWorker(),client=new PhysicsWorkerClient(worker,input.background,reason=>client.dispose(reason));
  try{
    const left=Math.floor(width/2),right=width,backgroundKey='gpu-test';
    const expected=packBackgroundRgb(blurBackground({...input,background},{},{left,right}));
    client.invalidate(1);
    const miss=await client.prepareBackgrounds([{input,left,right,backgroundKey}],1);
    assert.deepEqual(miss.backgrounds[0],{key:'gpu-test:18:37',width:19,height,pixels:expected});
    assert.ok(miss.profiles[0].backgroundConvolveMs>0);
    const hit=await client.prepareBackgrounds([{input,left,right,backgroundKey}],1);
    assert.equal(hit.profiles[0].backgroundConvolveMs,undefined);
    assert.deepEqual(hit.backgrounds[0].pixels,expected);
    const request=worker.messages.find(m=>m.kind==='backgrounds').frames[0];
    assert.equal(request.background,undefined);assert.equal(request.infinityEnergy,undefined);assert.equal(request.card,undefined);
    client.invalidate(2);
    assert.equal(await client.prepareBackgrounds([{input,left,right,backgroundKey}],1),undefined);
    client.source(Uint8ClampedArray.from(background,x=>255-x));
    const fresh=await client.prepareBackgrounds([{input,left,right,backgroundKey}],2);
    assert.notDeepEqual(fresh.backgrounds[0].pixels,expected);
    const optical=await client.registerOptical(packed(f.level));
    assert.ok(client.getOptical(optical.key));client.clearOptical();assert.equal(client.getOptical(optical.key),undefined);
    await client.prepareBackgrounds([{input,left,right,backgroundKey}],2);
    assert.equal(client.info().opticalPackedBytes,0);
  }finally{client.dispose('done');}
});

test('Worker frame handoff waits for the active frame and skips superseded requests',async()=>{
  const f=fixtures[0],worker=new FakeWorker();
  const entered=Promise.withResolvers(),checkpoint=Promise.withResolvers();
  worker.runtime=new PhysicsWorkerRuntime(()=>{
    entered.resolve();
    return checkpoint.promise;
  });
  const client=new PhysicsWorkerClient(worker,new Uint8ClampedArray(f.background),reason=>client.dispose(reason));
  const frames=[{input:{...f,infinityEnergy:energy(f.infinity)},left:0,right:f.width,backgroundKey:'handoff'}];
  const posted=()=>worker.messages.filter(m=>m.kind==='backgrounds').map(m=>m.version);
  try{
    client.invalidate(1);
    const first=client.prepareBackgrounds(frames,1);
    await entered.promise;
    client.invalidate(2);
    const obsolete=client.prepareBackgrounds(frames,2).catch(error=>error);
    await new Promise(resolve=>setImmediate(resolve));
    client.invalidate(3);
    const latest=client.prepareBackgrounds(frames,3).catch(error=>error);
    await new Promise(resolve=>setImmediate(resolve));
    const whileActive=posted();
    checkpoint.resolve();
    const [cancelled,skipped,result]=await Promise.all([first,obsolete,latest]);
    assert.deepEqual(whileActive,[1]);
    assert.equal(cancelled.cancelled,true);
    assert.equal(skipped,undefined);
    assert.ok(result?.backgrounds,result?.message);
    assert.equal(result.backgrounds.length,1);
    assert.deepEqual(posted(),[1,3]);
  }finally{client.dispose('done');}
});

test('GPU area footprint preserves odd anchors and crop offsets and rejects oversized tap counts',()=>{
  const level={pixelsPerTanTheta:[4096,4100],extentTanTheta:[-.02,.02,-.1,.01],width:180,height:450};
  const input={width:101,height:143,cardWidth:72,cssPxPerMm:1,viewingDistanceM:1,renderScale:.512,renderScaleY:.514};
  const full=gpuSampling(input,{level});
  const cropped=gpuSampling(input,{level,columns:[20,110]});
  assert.equal(full.pitchX,8);assert.equal(full.originY,cropped.originY);
  assert.equal(full.originX-cropped.originX,20);
  assert.equal(gpuSampling({...input,renderScale:.511},{level}),null);
  assert.equal(gpuSampling({...input,renderScaleY:.512},{level}),null);
});

test('mixed split returns one output buffer matching two full renders and transfers the dynamic raster',async()=>{
  const [a,b]=[fixtures[1],fixtures[7]],{width,height}=a,mid=Math.floor(width/2);
  const background=Uint8ClampedArray.from({length:21*17*4},(_,i)=>i%4===3?255:i*71%256);
  const bytes=gunzipSync(fs.readFileSync('static/validation/'+b.cardFile));
  const card=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const input=fixture=>({...fixture,background,backgroundWidth:21,backgroundHeight:17,
    infinityEnergy:energy(fixture.infinity),nearEnergy:energy(fixture.near),card});
  const left=input(a),right=input(b),layer=packed(a.level);
  const fullLeft=renderOpticalImage(left,layer,blurBackground(left)),fullRight=renderScene(right);
  const worker=new FakeWorker(),client=new PhysicsWorkerClient(worker,background.slice(),reason=>client.dispose(reason));
  try{
    client.invalidate(1);
    const selected=slice(layer,left,0,mid);
    await client.registerOptical(layer);
    const opticalLayer=await client.sliceOptical(selected);
    assert.ok(opticalLayer&&client.getOptical(selected.key));
    assert.equal(worker.messages.filter(m=>m.kind==='optical').length,1);
    const result=await client.renderFrame([
      {input:{...left,card:new Float32Array(0),opticalLayer},backgroundKey:a.name},
      {input:right,backgroundKey:b.name}
    ],1,true);
    assert.equal(card.byteLength,0);
    assert.equal(worker.messages.filter(m=>m.kind==='render').length,1);
    assert.equal(result.data.length,width*height*4);
    assert.equal(result.profiles[0].nearConvolveMs,0);
    assert.ok(result.profiles[1].nearConvolveMs>0);
    for(let i=0;i<result.data.length;i++){
      const expected=Math.floor(i/4)%width<mid?fullLeft[i]:fullRight[i];
      assert.ok(Math.abs(result.data[i]-expected)<=1,`split byte ${i}`);
    }
  }finally{client.dispose('done');}
});

test('100 cm comparison retains both eyes at two adjacent dense nodes within the existing cache',async()=>{
  const width=219,height=349,cssPxPerMm=7.780659503519822,mid=Math.floor(width/2);
  const models=[library,libraries.find(m=>m.model==='vivity_inspired_v2_1_dc_v1')];
  let fullBytes=0;
  const sides=models.map((model,index)=>[3.9,4].map(demand=>{
    const level=model.entries.find(e=>e.objectVergenceD===demand).levels.at(-1);
    const input={width,height,cssPxPerMm,viewingDistanceM:1,renderScale:width/390,
      cardWidth:Math.round(28*1528/1170*cssPxPerMm*demand*width/390)};
    fullBytes+=level.width*level.height*4;
    return slice(packed(level),input,index===0?0:mid,index===0?mid:width);
  }));
  const chosen=opticalWorkingSet(sides.map(([current,next])=>[current,null,next]));
  assert.ok(fullBytes>OPTICAL_CACHE_BYTES);
  assert.deepEqual(chosen.selections,sides.map(([current])=>current));
  const worker=new FakeWorker(),client=new PhysicsWorkerClient(worker,new Uint8ClampedArray(0),reason=>client.dispose(reason));
  try{
    for(const layer of sides.flat())await client.registerOptical(layer);
    for(const layer of sides.flat())assert.ok(client.getOptical(layer.key));
    assert.equal(client.info().opticalEntries,4);
    assert.ok(client.info().opticalPackedBytes<OPTICAL_CACHE_BYTES);
  }finally{client.dispose('done');}
});

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
    const frame=m.frames[0];
    assert.equal(frame.opticalLayer,undefined);assert.equal(frame.nearEnergy,undefined);assert.equal(frame.infinityEnergy,undefined);assert.equal(frame.card.byteLength,0);
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
  const frames=[{...f,card:new Float32Array(0),infinityKey:'infinity',opticalKey:p.key,backgroundKey:'bg'}];
  await runtime.handle({kind:'invalidate',version:1});
  assert.equal((await runtime.handle({kind:'render',id:3,version:1,frames})).cancelled,true);
  const next=await runtime.handle({kind:'render',id:4,version:2,frames});
  assert.ok(next.data);assert.equal(next.profiles[0].backgroundConvolveMs,undefined);
  assert.equal((await runtime.handle({kind:'render',id:5,version:1,frames})).cancelled,true);
  let current=true,yields=0;
  const background=[0,1,2].map(()=>new Float32Array(f.width*f.height).fill(.2));
  const result=await renderOpticalImageLatest(f,p,background,{},()=>current,async()=>{yields++;current=false;},0);
  assert.equal(result,null);assert.equal(yields,1);
});
