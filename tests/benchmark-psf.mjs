import readingCard from '../static/reading-card.json' with { type: 'json' };
// Deterministic CPU benchmark. Run with --expose-gc; results are not phone timings.
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const {sampleBackground,blurBackground,renderScene}=await import(process.env.PSF_BENCH_MODULE??'../src/lib/render/psf/scene.ts');
import {mobileSampling,scalePsf,pixelsPerRetinalMm} from '../src/lib/render/psf/geometry.ts';
const manifest=JSON.parse(fs.readFileSync('static/psf/manifest.json'));
const records=[];
function measure(fn){const t=performance.now();const result=fn();return {result,ms:performance.now()-t};}
for(const extreme of [false,true]) {
  const ppm=extreme?7.78:3.15,distance=extreme?1:.4;
  for(const demand of [2.5,4]) {
    const model='aspheric_monofocal_dc_v1';
    const near=manifest.entries.find(e=>e.model===model&&e.objectVergenceD===demand);
    const infinity=manifest.entries.find(e=>e.model===model&&e.objectVergenceD===0);
    const sampling=mobileSampling(390,622,ppm,distance,demand,readingCard.objectHeightMm,readingCard.objectWidthMm/readingCard.objectHeightMm,Math.min(near.retinalMmPerTanTheta,infinity.retinalMmPerTanTheta));
    const cw=Math.round(readingCard.objectWidthMm*distance*demand*ppm*sampling.scaleX),ch=Math.round(readingCard.objectHeightMm*distance*demand*ppm*sampling.scaleY);
    const read=e=>{const bytes=gunzipSync(fs.readFileSync(`static/psf/${e.file}`));return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));};
    const loaded=measure(()=>[read(near),read(infinity)]);
    const background=new Uint8ClampedArray(1024*1536*4);
    for(let i=0;i<background.length;i++)background[i]=i%4===3?255:(i*13)%256;
    const card=new Float32Array(cw*ch);
    for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)card[y*cw+x]=(x%19<5&&y%23<11)?0:1;
    const input={...sampling,background,backgroundWidth:1024,backgroundHeight:1536,card,cardWidth:cw,cardHeight:ch,near,infinity,nearEnergy:loaded.result[0],infinityEnergy:loaded.result[1],cssPxPerMm:ppm,viewingDistanceM:distance,renderScale:sampling.scaleX,renderScaleY:sampling.scaleY};
    const sample=measure(()=>sampleBackground(input));
    const resample=measure(()=>scalePsf(input.nearEnergy,near,pixelsPerRetinalMm(near,ppm,distance,sampling.scaleX),pixelsPerRetinalMm(near,ppm,distance,sampling.scaleY)));
    global.gc?.();const memoryBefore=process.memoryUsage();
    const bg=measure(()=>blurBackground(input));
    const frames=[];let hash;
    for(let i=0;i<5;i++) {const frame=measure(()=>renderScene(input,bg.result));frames.push(frame.ms);hash=createHash('sha256').update(frame.result).digest('hex');}
    const memoryAfter=process.memoryUsage();
    records.push({extreme,demand,width:input.width,height:input.height,cardWidth:cw,cardHeight:ch,loadDecodeMs:loaded.ms,sampleMs:sample.ms,resampleMs:resample.ms,coldBackgroundMs:bg.ms,foregroundMs:frames,hash,memoryBefore,memoryAfter});
  }
}
const report={node:process.version,platform:process.platform,date:new Date().toISOString(),peakRssKiB:process.resourceUsage().maxRSS,records};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
