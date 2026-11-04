import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSceneImage} from '../src/lib/render/scene-assets.ts';

test('PNG and SVG retain native URLs and work without fetch/blob support',async()=>{
  const originalImage=globalThis.Image,originalFetch=globalThis.fetch;const requested=[];
  try {
    globalThis.fetch=()=>{throw Error('fetch is unavailable');};
    globalThis.Image=class {naturalWidth=1528;set src(url){this.url=url;requested.push(url);queueMicrotask(()=>this.onload?.());}get src(){return this.url;}removeAttribute(){this.url='';}};
    for(const url of ['/app/background.png','/app/reading-card.svg']) {
      const image=await loadSceneImage(url,new AbortController().signal);
      assert.equal(image.src,url);assert.equal(image.onload,null);assert.equal(image.onerror,null);
    }
    assert.deepEqual(requested,['/app/background.png','/app/reading-card.svg']);
  }finally{globalThis.Image=originalImage;globalThis.fetch=originalFetch;}
});

test('native failure retries once with resource URL and manual retry recovers',async()=>{
  const original=globalThis.Image;let requests=0,fail=true;
  try {
    globalThis.Image=class {naturalWidth=1;set src(url){requests++;queueMicrotask(()=>fail?this.onerror?.():this.onload?.());}removeAttribute(){}};
    await assert.rejects(loadSceneImage('/app/card.svg',new AbortController().signal),/card.svg.*download or decode failed/);
    assert.equal(requests,2);fail=false;
    assert.ok(await loadSceneImage('/app/card.svg',new AbortController().signal));assert.equal(requests,3);
  }finally{globalThis.Image=original;}
});

test('native timeout is bounded and abort prevents retry',async()=>{
  const original=globalThis.Image;let requests=0;
  try {
    globalThis.Image=class {set src(url){requests++;}removeAttribute(){}};
    await assert.rejects(loadSceneImage('/slow.png',new AbortController().signal,5),/slow.png.*timed out/);
    assert.equal(requests,2);requests=0;
    const controller=new AbortController(),pending=loadSceneImage('/slow.svg',controller.signal,100);
    controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(requests,1);
  }finally{globalThis.Image=original;}
});
