import {linearToSrgb} from './convolve.ts';
export const OPTICAL_CACHE_BYTES=14*1024*1024;
import type {SceneInput,BlurredBackground,SceneProfile} from './scene.ts';

export interface OpticalImageLevel {
  file:string;width:number;height:number;density:number;bytes:number;
  pixelsPerTanTheta:[number,number];extentTanTheta:[number,number,number,number];
  decodedRgbaSha256:string;fileSha256:string;
}
export interface OpticalImageLayer {
  level:OpticalImageLevel;foreground:Float32Array;alpha:Float32Array;
}
export interface OpticalImageRef {key:string;level:OpticalImageLevel}
export interface PackedOpticalImageLayer extends OpticalImageRef {rgba:Uint8ClampedArray}
export function opticalImageKey(level:OpticalImageLevel):string {return `${level.file}:${level.decodedRgbaSha256}`;}
export function validatePackedOpticalImage(rgba:Uint8ClampedArray,level:OpticalImageLevel):void {
  if(rgba.length!==level.width*level.height*4)throw new Error('Optical image shape mismatch');
  for(let i=0;i<rgba.length;i+=4){
    if(rgba[i+3]!==255)throw new Error('Optical data PNG must be opaque');
    if(((rgba[i]<<4)|(rgba[i+1]>>4))>(((rgba[i+1]&15)<<8)|rgba[i+2]))throw new Error('Optical premultiplied radiance exceeds coverage');
  }
}
// Identical to unpackOpticalImage's Float32 assignment, without expanded planes.
const opticalValues=Float32Array.from({length:4096},(_,i)=>i/4095);
const littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;

export function unpackOpticalImage(rgba:Uint8ClampedArray,level:OpticalImageLevel):OpticalImageLayer {
  if(rgba.length!==level.width*level.height*4)throw new Error('Optical image shape mismatch');
  const foreground=new Float32Array(level.width*level.height),alpha=new Float32Array(foreground.length);
  for(let i=0;i<foreground.length;i++) {
    const r=rgba[4*i],g=rgba[4*i+1],b=rgba[4*i+2];
    if(rgba[4*i+3]!==255)throw new Error('Optical data PNG must be opaque');
    const f=(r<<4)|(g>>4),a=((g&15)<<8)|b;
    if(f>a)throw new Error('Optical premultiplied radiance exceeds coverage');
    foreground[i]=f/4095;alpha[i]=a/4095;
  }
  return {level,foreground,alpha};
}

export function angularDisplayDensity(input:Pick<SceneInput,'cssPxPerMm'|'viewingDistanceM'|'renderScale'|'renderScaleY'>):[number,number] {
  const p=input.cssPxPerMm*input.viewingDistanceM*1000;
  return [p*input.renderScale,p*(input.renderScaleY??input.renderScale)];
}

export type AreaWeights=Array<Array<[number,number]>>;
export function angularAreaWeights(start:number,count:number,anchor:number,targetPitch:number,sourceLo:number,sourcePitch:number,sourceCount:number):AreaWeights {
  if(!Number.isFinite(targetPitch)||targetPitch<=0||!Number.isFinite(sourcePitch)||sourcePitch<=0)throw new Error('Invalid angular sampling');
  const rows:AreaWeights=[];
  for(let i=start;i<start+count;i++) {
    const lo=((i-anchor)/targetPitch-sourceLo)*sourcePitch,hi=lo+sourcePitch/targetPitch;
    const row:Array<[number,number]>=[];
    for(let j=Math.max(0,Math.floor(lo));j<Math.min(sourceCount,Math.ceil(hi));j++) {
      const weight=Math.max(0,Math.min(hi,j+1)-Math.max(lo,j))/(hi-lo);
      if(weight>0)row.push([j,weight]);
    }
    rows.push(row);
  }
  return rows;
}

// No FFT: integrate premultiplied angular radiance and coverage over each
// display sample, then composite over the independently blurred infinity.
function* opticalRows(input:SceneInput,layer:OpticalImageLayer|PackedOpticalImageLayer,background:BlurredBackground,profile:SceneProfile):Generator<void,Uint8ClampedArray> {
  const start=performance.now(),{width,height}=input,{level}=layer;
  const [px,py]=angularDisplayDensity(input),[sx,sy]=level.pixelsPerTanTheta;
  if(Math.min(px,py)<128||Math.max(px,py)>8192||px>sx+1e-6||py>sy+1e-6)throw new Error('Optical image sampling is outside the validated envelope');
  // Match the existing bottom-centred card's integer centre convention.
  const anchorX=Math.round((width-input.cardWidth)/2)+input.cardWidth/2;
  const [x0,x1,y0,y1]=level.extentTanTheta;
  const left=Math.max(0,Math.floor(anchorX+x0*px)),right=Math.min(width,Math.ceil(anchorX+x1*px));
  const top=Math.max(0,Math.floor(height+y0*py)),bottom=Math.min(height,Math.ceil(height+y1*py));
  const wx=angularAreaWeights(left,Math.max(0,right-left),anchorX,px,x0,sx,level.width);
  const wy=angularAreaWeights(top,Math.max(0,bottom-top),height,py,y0,sy,level.height);
  if(!background.encoded) {
    background.encoded=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<width*height;i++) {
      for(let c=0;c<3;c++)background.encoded[4*i+c]=Math.round(255*linearToSrgb(background[c][i]));
      background.encoded[4*i+3]=255;
    }
  }
  const result=new Uint8ClampedArray(background.encoded);
  const rowF=new Float64Array(level.width),rowA=new Float64Array(level.width);
  // One aligned load per source cell; bytes and their authenticated encoding stay intact.
  const words='rgba' in layer&&littleEndian&&layer.rgba.byteOffset%4===0?new Uint32Array(layer.rgba.buffer,layer.rgba.byteOffset,level.width*level.height):null;
  for(let y=top;y<bottom;y++) {
    rowF.fill(0);rowA.fill(0);
    if(words){
      for(const [iy,weight]of wy[y-top])for(let ix=0;ix<level.width;ix++) {
        const v=words[iy*level.width+ix];
        rowF[ix]+=opticalValues[((v&255)<<4)|((v>>>12)&15)]*weight;
        rowA[ix]+=opticalValues[(((v>>>8)&15)<<8)|((v>>>16)&255)]*weight;
      }
    }else if('rgba' in layer){
      const rgba=layer.rgba;
      for(const [iy,weight]of wy[y-top])for(let ix=0;ix<level.width;ix++) {
        const i=4*(iy*level.width+ix),g=rgba[i+1];
        rowF[ix]+=opticalValues[(rgba[i]<<4)|(g>>4)]*weight;
        rowA[ix]+=opticalValues[((g&15)<<8)|rgba[i+2]]*weight;
      }
    }else for(const [iy,weight]of wy[y-top])for(let ix=0;ix<level.width;ix++) {
      const i=iy*level.width+ix;rowF[ix]+=layer.foreground[i]*weight;rowA[ix]+=layer.alpha[i]*weight;
    }
    for(let x=left;x<right;x++) {
      let f=0,a=0;
      for(const [ix,weight]of wx[x-left]){f+=rowF[ix]*weight;a+=rowA[ix]*weight;}
      a=Math.max(0,Math.min(1,a));f=Math.max(0,Math.min(a,f));const i=y*width+x;
      for(let c=0;c<3;c++)result[4*i+c]=Math.round(255*linearToSrgb(f+(1-a)*background[c][i]));
    }
    if((y-top+1)%8===0)yield;
  }
  profile.opticalImageCompositeMs=performance.now()-start;
  profile.nearConvolveMs=0;
  return result;
}

export function renderOpticalImage(input:SceneInput,layer:OpticalImageLayer|PackedOpticalImageLayer,background:BlurredBackground,profile:SceneProfile={}):Uint8ClampedArray {
  const rows=opticalRows(input,layer,background,profile);
  let next=rows.next();while(!next.done)next=rows.next();return next.value;
}

// Yield only after a time budget; MessageChannel on the Worker avoids nested-timer clamps.
export async function renderOpticalImageLatest(input:SceneInput,layer:PackedOpticalImageLayer,background:BlurredBackground,profile:SceneProfile,
  current:()=>boolean,yieldTask:()=>Promise<void>,budgetMs=6):Promise<Uint8ClampedArray|null> {
  const rows=opticalRows(input,layer,background,profile);let slice=performance.now();
  while(current()){
    const next=rows.next();if(next.done)return next.value;
    if(performance.now()-slice>=budgetMs){await yieldTask();slice=performance.now();}
  }
  rows.return(new Uint8ClampedArray(0));return null;
}
