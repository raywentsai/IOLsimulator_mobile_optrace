import { convolvePair, linearToSrgb, srgbToLinear } from './convolve.ts';
import { scalePsf, pixelsPerRetinalMm, type PsfEntry } from './geometry.ts';

export interface SceneInput {
  width:number; height:number;
  background:Uint8ClampedArray; backgroundWidth:number; backgroundHeight:number;
  card:Float32Array; cardWidth:number; cardHeight:number;
  near:PsfEntry; nearEnergy:Float32Array; infinity:PsfEntry; infinityEnergy:Float32Array;
  cssPxPerMm:number; viewingDistanceM:number; renderScale:number; renderScaleY?:number;
}

// Background images are decoded as sRGB, then interpolated in LINEAR light.
export function sampleBackground(input:SceneInput): [Float32Array,Float32Array,Float32Array] {
  const {width,height,background:src,backgroundWidth:sw,backgroundHeight:sh}=input;
  const channels=[new Float32Array(width*height),new Float32Array(width*height),new Float32Array(width*height)] as [Float32Array,Float32Array,Float32Array];
  const scale=Math.max(width/sw,height/sh),ox=(sw-width/scale)/2,oy=(sh-height/scale)/2;
  const lut=new Float32Array(256);for(let i=0;i<256;i++) lut[i]=srgbToLinear(i/255);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const sx=Math.max(0,Math.min(sw-1,ox+(x+.5)/scale-.5)),sy=Math.max(0,Math.min(sh-1,oy+(y+.5)/scale-.5));
    const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),tx=sx-x0,ty=sy-y0;
    for(let c=0;c<3;c++) channels[c][y*width+x]=
      (1-ty)*((1-tx)*lut[src[4*(y0*sw+x0)+c]]+tx*lut[src[4*(y0*sw+x1)+c]])+
      ty*((1-tx)*lut[src[4*(y1*sw+x0)+c]]+tx*lut[src[4*(y1*sw+x1)+c]]);
  }
  return channels;
}

export function blurBackground(input:SceneInput):[Float32Array,Float32Array,Float32Array] {
  const channels=sampleBackground(input);
  const kernel=scalePsf(input.infinityEnergy,input.infinity,pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const [r,g]=convolvePair(channels[0],channels[1],input.width,input.height,kernel);
  const [b]=convolvePair(channels[2],new Float32Array(channels[2].length),input.width,input.height,kernel);
  return [r,g,b];
}

export function renderScene(input:SceneInput,background=blurBackground(input)):Uint8ClampedArray {
  const {width,height,card,cardWidth,cardHeight}=input;
  const kernel=scalePsf(input.nearEnergy,input.near,pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const rx=kernel.width>>1,ry=kernel.height>>1,w=cardWidth+2*rx,h=cardHeight+2*ry;
  const colour=new Float32Array(w*h),mask=new Float32Array(w*h);
  for(let y=0;y<cardHeight;y++) for(let x=0;x<cardWidth;x++) {
    const t=(y+ry)*w+x+rx;colour[t]=card[y*cardWidth+x];mask[t]=1;
  }
  const [foreground,alpha]=convolvePair(colour,mask,w,h,kernel,'zero');
  // Same bottom-centred physical card in both engines; preserve PSF tails outside it.
  const left=Math.round((width-cardWidth)/2)-rx,top=height-cardHeight-ry;
  const output=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const px=x-left,py=y-top,inside=px>=0&&px<w&&py>=0&&py<h;
    const i=y*width+x,p=py*w+px,a=inside?Math.max(0,Math.min(1,alpha[p])):0;
    const fg=inside?Math.max(0,Math.min(a,foreground[p])):0;
    for(let c=0;c<3;c++) output[4*i+c]=Math.round(255*linearToSrgb(fg+(1-a)*background[c][i]));
    output[4*i+3]=255;
  }
  return output;
}
