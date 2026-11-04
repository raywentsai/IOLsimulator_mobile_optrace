import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSceneAsset} from '../src/lib/render/scene-assets.ts';

test('scene download retries a transient response, preserves bytes and identifies permanent errors',async()=>{
  const original=globalThis.fetch;
  try {
    let calls=0;
    globalThis.fetch=async()=>++calls===1?new Response('',{status:503}):new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
    const result=await fetchSceneAsset('/project/background.png');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()),new Uint8Array([1,2,3]));assert.equal(calls,2);
    calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:404});};
    await assert.rejects(fetchSceneAsset('/project/card.svg'),/\/project\/card.svg.*HTTP 404/);assert.equal(calls,1);
    globalThis.fetch=async()=>new Response('<html>error</html>',{headers:{'content-type':'text/html'}});
    await assert.rejects(fetchSceneAsset('/project/card.svg'),/Invalid image response/);
  }finally{globalThis.fetch=original;}
});

test('scene loading times out after two attempts and cancellation stops retries',async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async(_,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));};
    await assert.rejects(fetchSceneAsset('/slow.png',undefined,5),/slow.png.*timed out/);assert.equal(calls,2);
    calls=0;const controller=new AbortController();
    const pending=fetchSceneAsset('/slow.png',controller.signal,100);
    controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
