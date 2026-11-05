import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {downloadBlob,loadPngAsset,allowSpeculativeLoads} from '../src/lib/render/asset-loading.ts';
import {readRgbPng} from './png-helper.mjs';

test('streamed progress counts received bytes, retries 503 once, and rejects permanent HTTP/MIME failures',async()=>{
  const original=globalThis.fetch;let calls=0;const progress=[];
  try {
    globalThis.fetch=async()=>++calls===1?new Response('',{status:503}):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3,4,5]));c.close();}}),{headers:{'content-length':'5'}});
    const result=await downloadBlob('/data',new AbortController().signal,{onProgress:p=>progress.push(p)});
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3,4,5]);assert.equal(calls,2);
    assert.ok(progress.some(p=>p.stage==='retry'));assert.ok(progress.some(p=>p.loaded===2));assert.ok(progress.some(p=>p.loaded===5&&p.total===5));
    for(const response of [new Response('',{status:404}),new Response('<html>',{headers:{'content-type':'text/html'}})]){
      calls=0;globalThis.fetch=async()=>{calls++;return response;};
      await assert.rejects(downloadBlob('/background.png',new AbortController().signal,{mime:'image/png'}),/background.png.*(HTTP 404|content type)/);
      assert.equal(calls,1);
    }
  }finally{globalThis.fetch=original;}
});

test('stalled headers/body, total deadline and cancellation terminate the actual request without retry storms',async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));};
    await assert.rejects(downloadBlob('/stalled-headers',new AbortController().signal,{idleMs:8,totalMs:100}),/network stalled/);assert.equal(calls,1);
    globalThis.fetch=async(url,{signal})=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));signal.addEventListener('abort',()=>c.error(Error('aborted')));}}));
    await assert.rejects(downloadBlob('/stalled-body',new AbortController().signal,{idleMs:8,totalMs:100}),/network stalled/);
    await assert.rejects(downloadBlob('/total-deadline',new AbortController().signal,{idleMs:100,totalMs:8}),/time limit/);
    const abort=new AbortController(),pending=downloadBlob('/cancel',abort.signal);abort.abort();await assert.rejects(pending,/cancelled/);
  }finally{globalThis.fetch=original;}
});

test('PNG decode retains Blob URL until release, native decode fallback retains real URL, and corrupt bytes fail clearly',async()=>{
  const originalFetch=globalThis.fetch,originalImage=globalThis.Image,originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  const revoked=[],requests=[];let rejectBlob=false,rejectAll=false;
  try {
    globalThis.fetch=async()=>new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'content-type':'image/png'}});
    URL.createObjectURL=()=> 'blob:png-test';URL.revokeObjectURL=url=>revoked.push(url);
    globalThis.Image=class {naturalWidth=10;set src(url){this.url=url;requests.push(url);queueMicrotask(()=>rejectAll||rejectBlob&&url.startsWith('blob:')?this.onerror?.():this.onload?.());}get src(){return this.url;}removeAttribute(){this.url='';}};
    const asset=await loadPngAsset('/background.png',new AbortController().signal);
    assert.equal(asset.image.src,'blob:png-test');assert.equal(revoked.length,0);asset.release();asset.release();assert.deepEqual(revoked,['blob:png-test']);
    rejectBlob=true;const fallback=await loadPngAsset('/background.png',new AbortController().signal);
    assert.equal(fallback.image.src,'/background.png');assert.equal(requests.filter(u=>u==='/background.png').length,1);fallback.release();
    rejectAll=true;
    await assert.rejects(loadPngAsset('/decode-failure.png',new AbortController().signal),/PNG decode failed after a complete download; native URL also failed/);
    globalThis.fetch=async()=>new Response('broken',{headers:{'content-type':'image/png'}});
    await assert.rejects(loadPngAsset('/bad.png',new AbortController().signal),/bad.png.*invalid PNG/);
  }finally{globalThis.fetch=originalFetch;globalThis.Image=originalImage;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});

test('speculative loads are disabled on metered/slow connections and low-memory devices',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  try {
    for(const [navigator,expected]of [[{connection:{saveData:true}},false],[{connection:{effectiveType:'3g'}},false],[{deviceMemory:2},false],[{connection:{effectiveType:'4g'},deviceMemory:4},true],[{},true]]){
      Object.defineProperty(globalThis,'navigator',{value:navigator,configurable:true});assert.equal(allowSpeculativeLoads(),expected);
    }
  }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}
});

test('optimized background preserves EVERY original RGB sample, while the favicon stays small',()=>{
  const metadata=JSON.parse(fs.readFileSync('src/lib/assets/images/background.json'));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  assert.equal(hash(fs.readFileSync('src/lib/assets/images/background.png')),metadata.fileSha256);
  const {width,height,rgba}=readRgbPng('src/lib/assets/images/background.png'),rgb=new Uint8Array(width*height*3);
  for(let i=0;i<width*height;i++)rgb.set(rgba.subarray(4*i,4*i+3),3*i);
  assert.equal(width,1024);assert.equal(height,1536);
  assert.equal(hash(rgb),'1678f9534ab4afd59440bbde578e32123b462e2b52eee60555f46155c23ebc5c');
  assert.equal(hash(rgb),metadata.rgbSha256);assert.ok(metadata.bytes<2900000);
  assert.ok(fs.statSync('static/favicon.png').size<10000);
});
