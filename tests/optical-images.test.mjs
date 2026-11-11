import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readRgbPng} from './png-helper.mjs';
import {unpackOpticalImage,renderOpticalImage,angularAreaWeights,angularDisplayDensity} from '../src/lib/render/psf/optical-image-math.ts';
import {renderScene} from '../src/lib/render/psf/scene.ts';
import {srgbToLinear} from '../src/lib/render/psf/convolve.ts';
import {physicsIols} from '../src/lib/data/iol-models.ts';
import {opticalWorkingSet,selectOpticalLevel} from '../src/lib/render/psf/optical-images.ts';
import readingCard from '../static/reading-card.json' with { type: 'json' };
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const psfs=JSON.parse(fs.readFileSync('static/psf/manifest.json')).entries;
const energy=e=>{const bytes=gunzipSync(fs.readFileSync(`static/psf/${e.file}`));return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));};

test('optical cache planning includes both eyes and each adjacent slider transition',()=>{
  const nodes=(model,miB)=>[0,1,2].map(i=>({key:`${model}:${i}`,level:{width:miB*256,height:1024}}));
  const left=nodes('left',3),right=nodes('right',3),large=nodes('large',6),oversized=nodes('oversized',8);
  // Both transitions fit in 12 MiB even though all three nodes total 18 MiB.
  assert.deepEqual(opticalWorkingSet([left,right]).selections,[left[0],right[0]]);
  assert.deepEqual(opticalWorkingSet([large,right]).selections,[large[0],null]);
  assert.deepEqual(opticalWorkingSet([oversized,right]).selections,[null,right[0]]);
  assert.deepEqual(opticalWorkingSet([oversized]).selections,[null]);
});

test('density-limited levels are skipped only above their audited limit on either axis',()=>{
  let verified=0;
  for (const model of Object.keys(physicsIols)) {
    const library=JSON.parse(fs.readFileSync(`static/optical-images/${model}.json`));
    for (const {levels} of library.entries) {
      for (const [index,level] of levels.entries()) {
        const limit=level.maxOutputDensity;
        if (limit===undefined) continue;
        assert.equal(selectOpticalLevel(levels,limit,limit),level);
        assert.equal(selectOpticalLevel(levels,limit+1,limit),levels[index+1]);
        assert.equal(selectOpticalLevel(levels,limit,limit+1),levels[index+1]);
        verified++;
      }
    }
  }
  assert.ok(verified>0);
});

for(const model of Object.keys(physicsIols))test(`31 optical nodes authenticate original PSFs and numeric PNG samples: ${model}`,()=>{
  const library=JSON.parse(fs.readFileSync(`static/optical-images/${model}.json`));
  assert.equal(library.model,model);assert.equal(library.entries.length,31);
  assert.deepEqual(library.entries.map(e=>e.objectVergenceD),Array.from({length:31},(_,i)=>(i+10)/10));
  const card=fs.readFileSync('static/reading-card.svg','utf8').replaceAll('\r\n','\n');
  assert.equal(hash(card),library.cardSvgCanonicalSha256);
  assert.equal(library.cardSvgCanonicalSha256,readingCard.assetSha256);
  assert.deepEqual(library.physicalCardMm,[85.60,53.98]);
  for(const node of library.entries) {
    assert.equal(node.psfSha256,psfs.find(p=>p.model===library.model&&p.objectVergenceD===node.objectVergenceD).sha256);
    for(const level of node.levels) {
      const file=`static/optical-images/${level.file}`;
      assert.equal(hash(fs.readFileSync(file)),level.fileSha256);
      const {width,height,rgba}=readRgbPng(file);
      assert.equal(width,level.width);assert.equal(height,level.height);
      assert.equal(hash(rgba),level.decodedRgbaSha256);
      const [left,right,top,bottom]=level.cardExtentTanTheta;
      assert.ok(Math.abs(right-left-85.60*node.objectVergenceD/1000)<1e-12);
      assert.ok(Math.abs(bottom-top-53.98*node.objectVergenceD/1000)<1e-12);
      const layer=unpackOpticalImage(rgba,level),[px,py]=level.pixelsPerTanTheta,[x0,x1,y0,y1]=level.extentTanTheta;
      assert.ok(Math.abs((x1-x0)*px-width)<1e-8);assert.ok(Math.abs((y1-y0)*py-height)<1e-8);
      assert.ok(Math.abs(layer.alpha.reduce((s,a)=>s+a,0)/(level.cardPixels[0]*level.cardPixels[1])-1)<1e-4);
      assert.ok(level.centroidErrorTanTheta*Math.max(px,py)<.05,'coverage centroid preserves the PSF displacement');
    }
  }
});

const fixtures=JSON.parse(fs.readFileSync('static/validation/optical-image-reference.json')).cases;
for(const fixture of fixtures)test(`Optical PNG / independent Python: ${fixture.name}`,()=>{
  const bytes=gunzipSync(fs.readFileSync(`static/validation/${fixture.cardFile}`));assert.equal(hash(bytes),fixture.cardSha256);
  const card=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const expected=gunzipSync(fs.readFileSync(`static/validation/${fixture.expectedFile}`));assert.equal(hash(expected),fixture.expectedSha256);
  const layer=unpackOpticalImage(readRgbPng(`static/optical-images/${fixture.level.file}`).rgba,fixture.level);
  const input={...fixture,card,nearEnergy:energy(fixture.near),infinityEnergy:energy(fixture.infinity)};
  const background=fixture.background.slice(0,3).map(c=>new Float32Array(fixture.width*fixture.height).fill(srgbToLinear(c/255)));
  const dynamic=fixture.compareDynamic?renderScene(input,background):null;
  const precomputed=renderOpticalImage(input,layer,background);
  let dynamicError=0,imageError=0,pairError=0;
  for(let i=0;i<expected.length;i++) {
    if(dynamic){
      dynamicError=Math.max(dynamicError,Math.abs(dynamic[i]-expected[i]));
      pairError=Math.max(pairError,Math.abs(precomputed[i]-dynamic[i]));
    }
    imageError=Math.max(imageError,Math.abs(precomputed[i]-expected[i]));
  }
  assert.ok(dynamicError<=1,`dynamic/Python ${dynamicError}`);
  assert.ok(imageError<=1,`optical/Python ${imageError}`);
  assert.ok(pairError<=1,`optical/dynamic ${pairError}`);
});

test('angular area integration conserves field energy under calibration/distance/resolution changes',()=>{
  const sourceCount=8,sourcePitch=4096,sourceLo=-4/sourcePitch;
  const source=Float64Array.from([.1,.3,.6,.2,.9,.4,.7,.2]);
  for(const target of [128,256,512,800,2000,4096]) {
    const weights=angularAreaWeights(0,24,12,target,sourceLo,sourcePitch,sourceCount);
    const projected=weights.map(row=>row.reduce((sum,[i,w])=>sum+source[i]*w,0));
    assert.ok(Math.abs(projected.reduce((s,v)=>s+v,0)/target-source.reduce((s,v)=>s+v,0)/sourcePitch)<1e-12);
    for(const distance of [.2,.4,1]) {
      const scale=.75,ppm=target/(1000*distance*scale);
      const [px,py]=angularDisplayDensity({cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:scale,renderScaleY:scale*.99});
      assert.ok(Math.abs(px-target)<1e-10);assert.ok(Math.abs(py-target*.99)<1e-10);
    }
  }
});
