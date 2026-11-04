import { convolvePair, linearToSrgb, srgbToLinear } from './convolve.ts';
import { scalePsf, pixelsPerRetinalMm, type PsfEntry } from './geometry.ts';

export interface SceneInput {
  width:number; height:number;
  background:Uint8ClampedArray; backgroundWidth:number; backgroundHeight:number;
  card:Float32Array; cardWidth:number; cardHeight:number;
  near:PsfEntry; nearEnergy:Float32Array; infinity:PsfEntry; infinityEnergy:Float32Array;
  cssPxPerMm:number; viewingDistanceM:number; renderScale:number; renderScaleY?:number;
}

export type SceneProfile = Record<string,number>;
export type BlurredBackground=[Float32Array,Float32Array,Float32Array]&{encoded?:Uint8ClampedArray};

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

export function blurBackground(input:SceneInput,profile:SceneProfile={}):BlurredBackground {
  const start=performance.now();
  const channels=sampleBackground(input);
  const sampled=performance.now();profile.backgroundSampleMs=sampled-start;
  const kernel=scalePsf(input.infinityEnergy,input.infinity,pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const scaled=performance.now();profile.backgroundScaleMs=scaled-sampled;
  const [r,g]=convolvePair(channels[0],channels[1],input.width,input.height,kernel);
  const [b]=convolvePair(channels[2],new Float32Array(channels[2].length),input.width,input.height,kernel);
  profile.backgroundConvolveMs=performance.now()-scaled;
  return [r,g,b];
}

export function renderScene(input:SceneInput,background=blurBackground(input),profile:SceneProfile={}):Uint8ClampedArray {
  const start=performance.now();
  const {width,height,card,cardWidth,cardHeight}=input;
  const kernel=scalePsf(input.nearEnergy,input.near,pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const scaled=performance.now();profile.nearScaleMs=scaled-start;
  const rx=kernel.width>>1,ry=kernel.height>>1;
  const cardLeft=Math.round((width-cardWidth)/2),cardTop=height-cardHeight;
  // Exclude only source samples that cannot contribute to any screen pixel,
  // even at the outermost PSF support. Keep the original raster and placement.
  const x0=Math.max(0,-cardLeft-rx),y0=Math.max(0,-cardTop-ry);
  const x1=Math.min(cardWidth,width-cardLeft+rx),y1=Math.min(cardHeight,height-cardTop+ry);
  const cw=x1-x0,ch=y1-y0,w=cw+2*rx,h=ch+2*ry;
  // Compute the complete linear convolution directly from the card. The old
  // path first padded the card, then padded it twice again inside the FFT.
  // N+K-1 keeps every tail sample with no extra image-domain zero margins.
  const colour=new Float32Array(cw*ch),mask=new Float32Array(cw*ch).fill(1);
  for(let y=0;y<ch;y++)colour.set(card.subarray((y+y0)*cardWidth+x0,(y+y0)*cardWidth+x1),y*cw);
  const [foreground,alpha]=convolvePair(colour,mask,cw,ch,kernel,'zero',true);
  const convolved=performance.now();profile.nearConvolveMs=convolved-scaled;
  // Same bottom-centred physical card in both engines; preserve PSF tails outside it.
  const left=cardLeft+x0-rx,top=cardTop+y0-ry;
  if(!background.encoded) {
    background.encoded=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<width*height;i++) {
      for(let c=0;c<3;c++)background.encoded[4*i+c]=Math.round(255*linearToSrgb(background[c][i]));
      background.encoded[4*i+3]=255;
    }
  }
  const output=new Uint8ClampedArray(background.encoded);
  // Outside the complete foreground PSF support, the static infinity image
  // is identical. Reuse its encoded bytes; composite inside in linear light.
  for(let y=Math.max(0,top);y<Math.min(height,top+h);y++) for(let x=Math.max(0,left);x<Math.min(width,left+w);x++) {
    const px=x-left,py=y-top;
    const i=y*width+x,p=py*w+px,a=Math.max(0,Math.min(1,alpha[p]));
    const fg=Math.max(0,Math.min(a,foreground[p]));
    for(let c=0;c<3;c++) output[4*i+c]=Math.round(255*linearToSrgb(fg+(1-a)*background[c][i]));
    output[4*i+3]=255;
  }
  profile.compositeEncodeMs=performance.now()-convolved;
  return output;
}
