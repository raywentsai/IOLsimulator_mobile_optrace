import test from 'node:test';
import assert from 'node:assert/strict';
import {convolvePair,reflectIndex,srgbToLinear,linearToSrgb} from '../src/lib/render/psf/convolve.ts';
import {scalePsf,pixelsPerRetinalMm,objectVergence,mobileSampling,calibratedCssPxPerMm} from '../src/lib/render/psf/geometry.ts';
import {renderScene} from '../src/lib/render/psf/scene.ts';

test('minimal full FFT convolution preserves all tails and energy against direct spatial convolution',()=>{
  for(const [width,height,kw,kh] of [[1,1,3,5],[8,5,5,3],[17,9,7,9]]) {
    const a=Float32Array.from({length:width*height},(_,i)=>(i*13%31)/31),b=Float32Array.from(a,x=>1-x);
    const data=Float64Array.from({length:kw*kh},(_,i)=>(i*7%19)+1),sum=data.reduce((a,b)=>a+b,0);
    for(let i=0;i<data.length;i++)data[i]/=sum;
    const outputs=convolvePair(a,b,width,height,{width:kw,height:kh,data},'zero',true);
    const ow=width+kw-1,oh=height+kh-1;
    for(const [channel,input] of [[0,a],[1,b]]) {
      const expected=new Float64Array(ow*oh);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let ky=0;ky<kh;ky++)for(let kx=0;kx<kw;kx++)expected[(y+ky)*ow+x+kx]+=input[y*width+x]*data[ky*kw+kx];
      assert.equal(outputs[channel].length,expected.length);
      assert.ok(outputs[channel].every((v,i)=>Math.abs(v-expected[i])<1e-6));
      assert.ok(Math.abs(outputs[channel].reduce((s,v)=>s+v,0)-input.reduce((s,v)=>s+v,0))<1e-5);
    }
  }
});

test('visible-source crop and cached background agree with direct full-card linear composition',()=>{
  const entry={width:3,height:3,retinalExtentMm:[-.02,.02,-.02,.02],retinalMmPerTanTheta:17};
  const energy=new Float32Array([0,.125,.125,0,.25,.125,.125,.125,.125]);
  for(const [width,height,cw,ch] of [[7,5,3,2],[7,5,19,17],[8,6,10,4]]) {
    const card=Float32Array.from({length:cw*ch},(_,i)=>(i*7%17)/17);
    const background=Array.from({length:3},(_,c)=>Float32Array.from({length:width*height},(_,i)=>(i+c*3)%13/13));
    const input={width,height,card,cardWidth:cw,cardHeight:ch,near:entry,nearEnergy:energy,cssPxPerMm:3,viewingDistanceM:.4,renderScale:1};
    const kernel=scalePsf(energy,entry,pixelsPerRetinalMm(entry,3,.4,1));
    const rx=kernel.width>>1,ry=kernel.height>>1,left=Math.round((width-cw)/2),top=height-ch;
    const expected=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      let fg=0,alpha=0;
      for(let ky=0;ky<kernel.height;ky++)for(let kx=0;kx<kernel.width;kx++) {
        const sx=x-left+rx-kx,sy=y-top+ry-ky;
        if(sx>=0&&sx<cw&&sy>=0&&sy<ch){const e=kernel.data[ky*kernel.width+kx];fg+=card[sy*cw+sx]*e;alpha+=e;}
      }
      const i=y*width+x;
      for(let c=0;c<3;c++)expected[4*i+c]=Math.round(255*linearToSrgb(fg+(1-alpha)*background[c][i]));
      expected[4*i+3]=255;
    }
    const cold=renderScene(input,background),warm=renderScene(input,background);
    assert.deepEqual(warm,cold);
    assert.ok(cold.every((v,i)=>Math.abs(v-expected[i])<=1));
  }
});

test('nonseparable asymmetric convolution has correct centre, orientation, edges and packed channels',()=>{
  const width=9,height=7;
  const a=Float32Array.from({length:width*height},(_,i)=>((i*17)%59)/59);
  const b=Float32Array.from(a,x=>1-x);
  const kernel={width:3,height:5,data:Float64Array.from([0,1,0,2,0,3,4,1,0,0,5,2,1,0,3],x=>x/25)};
  const reference=(image,padding)=>Float32Array.from(image,(_,i)=>{
    const x=i%width,y=Math.floor(i/width);let sum=0;
    for(let ky=0;ky<5;ky++)for(let kx=0;kx<3;kx++) {
      const sx=x+1-kx,sy=y+2-ky;
      if(padding==='zero'&&(sx<0||sy<0||sx>=width||sy>=height))continue;
      sum+=kernel.data[ky*3+kx]*image[reflectIndex(sy,height)*width+reflectIndex(sx,width)];
    }
    return sum;
  });
  for(const padding of ['reflect','zero']) {
    const output=convolvePair(a,b,width,height,kernel,padding);
    for(const [channel,image] of [[0,a],[1,b]]) {
      const expected=reference(image,padding);
      assert.ok(output[channel].every((x,i)=>Math.abs(x-expected[i])<2e-6));
    }
  }
});

test('physical angular scale follows viewing distance, calibration and rendering resolution',()=>{
  const entry={width:3,height:3,retinalExtentMm:[-.03,.03,-.03,.03],retinalMmPerTanTheta:17};
  const energy=new Float32Array([0,.125,0,.125,.5,.125,0,.125,0]);
  for(const ppm of [3,5,8])for(const distance of [.2,.4,1])for(const scale of [.5,1,2]) {
    const px=pixelsPerRetinalMm(entry,ppm,distance,scale);
    assert.ok(Math.abs((.03*px)/(ppm*scale)/(distance*1000)-.03/17)<1e-12);
    const kernel=scalePsf(energy,entry,px);
    assert.ok(Math.abs(kernel.data.reduce((a,b)=>a+b,0)-1)<1e-12);
    const cx=kernel.data.reduce((s,e,i)=>s+e*((i%kernel.width)-(kernel.width>>1)),0);
    assert.ok(Math.abs(cx)<1e-10);
  }
});

test('vergence conversion uses near-positive library nodes and rejects extrapolation',()=>{
  for(let i=10;i<=40;i++)assert.equal(objectVergence(-i/10),i/10);
  assert.throws(()=>objectVergence(.5));assert.throws(()=>objectVergence(-4.1));assert.throws(()=>objectVergence(0));
});

test('pinch zoom preserves physical PSF angular size for calibrations made at any zoom',()=>{
  for(const calibrationZoom of [1,1.5,2])for(const currentZoom of [1,1.5,2]) {
    const baseCssPxPerMm=5,measured=baseCssPxPerMm/calibrationZoom;
    const cssPxPerMm=calibratedCssPxPerMm(measured,calibrationZoom,currentZoom);
    assert.ok(Math.abs(cssPxPerMm*currentZoom-baseCssPxPerMm)<1e-12);
    const screenPx=pixelsPerRetinalMm({retinalMmPerTanTheta:17},cssPxPerMm,.4,1)*.01;
    const physicalMm=screenPx*currentZoom/baseCssPxPerMm;
    assert.ok(Math.abs(physicalMm/400-.01/17)<1e-12);
  }
});

test('linear luminance encoding round trips and preserves black/white energy',()=>{
  for(let i=0;i<=255;i++)assert.ok(Math.abs(linearToSrgb(srgbToLinear(i/255))-i/255)<1e-12);
  assert.ok(Math.abs(Math.round(255*linearToSrgb(.5))-188)<=1);
});

test('extreme supported calibrations fit the mobile FFT memory bound without changing angular scale',()=>{
  for(const [cssWidth,cssHeight] of [[390,622],[640,640],[1280,720]])for(const ppm of [2,7.8])for(const distance of [.2,1])for(const demand of [1,4]) {
    const sampling=mobileSampling(cssWidth,cssHeight,ppm,distance,demand,28,1528/1170,17);
    assert.ok(sampling.width<=640&&sampling.height<=640);
    assert.equal(sampling.scaleX,sampling.width/cssWidth);
    assert.equal(sampling.scaleY,sampling.height/cssHeight);
    const px=pixelsPerRetinalMm({retinalMmPerTanTheta:17},ppm,distance,sampling.scaleX);
    const py=pixelsPerRetinalMm({retinalMmPerTanTheta:17},ppm,distance,sampling.scaleY);
    const energy=new Float32Array([0,0,0,0,1,0,0,0,0]);
    const kernel=scalePsf(energy,{width:3,height:3,retinalExtentMm:[-.25,.25,-.25,.25]},px,py);
    const p2=n=>2**Math.ceil(Math.log2(n)),rx=kernel.width>>1,ry=kernel.height>>1;
    const cw=Math.max(1,Math.round(28*1528/1170*distance*demand*ppm*sampling.scaleX));
    const ch=Math.max(1,Math.round(28*distance*demand*ppm*sampling.scaleY));
    assert.ok(p2(sampling.width+4*rx)*p2(sampling.height+4*ry)<=2097152);
    assert.ok(p2(cw+6*rx)*p2(ch+6*ry)<=2097152);
    assert.ok(Math.abs(px/sampling.scaleX/ppm/(distance*1000)-1/17)<1e-12);
  }
});
