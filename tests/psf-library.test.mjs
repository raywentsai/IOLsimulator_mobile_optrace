import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {objectVergence,PSF_MODELS,scalePsf,pixelsPerRetinalMm} from '../src/lib/render/psf/geometry.ts';
import {renderScene} from '../src/lib/render/psf/scene.ts';

const manifest=JSON.parse(fs.readFileSync('static/psf/manifest.json','utf8'));
function energy(entry) {
  const bytes=gunzipSync(fs.readFileSync(`static/psf/${entry.file}`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
}
test('library has all 96 distinct nodes, nonnegative normalized energy, and >99% capture',()=>{
  assert.equal(manifest.entries.length,96);
  for(const model of Object.values(PSF_MODELS)) {
    const nodes=manifest.entries.filter(e=>e.model===model).map(e=>e.objectVergenceD).sort((a,b)=>a-b);
    assert.deepEqual(nodes,[0,...Array.from({length:31},(_,i)=>(i+10)/10)]);
    for(let i=10;i<=40;i++)assert.ok(nodes.includes(objectVergence(-i/10)));
  }
  for(const entry of manifest.entries) {
    const data=energy(entry);assert.equal(data.length,entry.width*entry.height);
    assert.ok(data.every(x=>Number.isFinite(x)&&x>=0));
    assert.ok(Math.abs(data.reduce((s,x)=>s+x,0)-1)<1e-6);
    assert.ok(entry.captureFraction>.99);
    assert.deepEqual(entry.center,[(entry.width-1)/2,(entry.height-1)/2]);
  }
});

const fixtures=JSON.parse(fs.readFileSync('static/validation/psf-reference.json','utf8')).cases;
test('independent Python reference covers every supported optical model',()=>{
  assert.deepEqual(fixtures.map(f=>f.name).sort(),Object.values(PSF_MODELS).sort());
});
for(const fixture of fixtures)test(`Python/browser scene agreement: ${fixture.name}`,()=>{
  const input={...fixture,background:new Uint8ClampedArray(fixture.background),card:new Float32Array(fixture.card),nearEnergy:energy(fixture.near),infinityEnergy:energy(fixture.infinity)};
  const px=pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScale);
  const py=pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY);
  const kernel=scalePsf(input.nearEnergy,input.near,px,py);
  assert.equal(kernel.width,fixture.kernelWidth);assert.equal(kernel.height,fixture.kernelHeight);
  assert.ok(kernel.data.every((v,i)=>Math.abs(v-fixture.expectedScaledKernel[i])<1e-10));
  const actual=renderScene(input);
  const max=Math.max(...actual.map((v,i)=>Math.abs(v-fixture.expectedRgba[i])));
  assert.ok(max<=1,`max sRGB byte difference ${max}`);
});
