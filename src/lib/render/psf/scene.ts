import { convolveWindow, linearToSrgb, reflectIndex, srgbToLinear, type PixelWindow } from './convolve.ts';
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
export interface SceneTarget {
  left:number; right:number; width:number; height:number; stride:number; offset:number;
  data:Uint8ClampedArray<ArrayBuffer>;
}

export function sceneTarget(width:number,height:number,left=0,right=width,data?:Uint8ClampedArray<ArrayBuffer>):SceneTarget {
  return {left,right,width:right-left,height,stride:data?width:right-left,offset:data?left:0,
    data:data??new Uint8ClampedArray((right-left)*height*4)};
}

export function writeBackground(background:BlurredBackground,target:SceneTarget):void {
  const {width,height,stride,offset,data}=target;
  if(!background.encoded) {
    background.encoded=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<width*height;i++) {
      for(let c=0;c<3;c++)background.encoded[4*i+c]=Math.round(255*linearToSrgb(background[c][i]));
      background.encoded[4*i+3]=255;
    }
  }
  if(stride===width)data.set(background.encoded);
  else for(let y=0;y<height;y++)data.set(background.encoded.subarray(4*y*width,4*(y+1)*width),4*(y*stride+offset));
}

// Background images are decoded as sRGB, then interpolated in LINEAR light.
export function sampleBackground(input:SceneInput,window:PixelWindow={left:0,top:0,width:input.width,height:input.height}): BlurredBackground {
  const {width,height,background:src,backgroundWidth:sw,backgroundHeight:sh}=input;
  const {left,top,width:cols,height:rows}=window;
  const channels:BlurredBackground=[new Float32Array(cols*rows),new Float32Array(cols*rows),new Float32Array(cols*rows)];
  const scale=Math.max(width/sw,height/sh),ox=(sw-width/scale)/2,oy=(sh-height/scale)/2;
  const lut=new Float32Array(256);for(let i=0;i<256;i++) lut[i]=srgbToLinear(i/255);
  for(let y=0;y<rows;y++) {
    const sy=Math.max(0,Math.min(sh-1,oy+(reflectIndex(y+top,height)+.5)/scale-.5));
    const y0=Math.floor(sy),y1=Math.min(sh-1,y0+1),ty=sy-y0;
    for(let x=0;x<cols;x++) {
      const sx=Math.max(0,Math.min(sw-1,ox+(reflectIndex(x+left,width)+.5)/scale-.5));
      const x0=Math.floor(sx),x1=Math.min(sw-1,x0+1),tx=sx-x0;
      for(let c=0;c<3;c++) channels[c][y*cols+x]=
        (1-ty)*((1-tx)*lut[src[4*(y0*sw+x0)+c]]+tx*lut[src[4*(y0*sw+x1)+c]])+
        ty*((1-tx)*lut[src[4*(y1*sw+x0)+c]]+tx*lut[src[4*(y1*sw+x1)+c]]);
    }
  }
  return channels;
}

export function blurBackground(input:SceneInput,profile:SceneProfile={},region={left:0,right:input.width}):BlurredBackground {
  const start=performance.now();
  const kernel=scalePsf(input.infinityEnergy,input.infinity,pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.infinity,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const scaled=performance.now();profile.backgroundScaleMs=scaled-start;
  const rx=kernel.width>>1,ry=kernel.height>>1,width=region.right-region.left,height=input.height;
  // Sample the halo in full-scene coordinates, reflecting only at screen edges.
  const sw=width+2*rx,sh=height+2*ry;
  const channels=sampleBackground(input,{left:region.left-rx,top:-ry,width:sw,height:sh});
  const sampled=performance.now();profile.backgroundSampleMs=sampled-scaled;
  const window={left:2*rx,top:2*ry,width,height};
  const [r,g]=convolveWindow(channels[0],channels[1],sw,sh,kernel,window);
  const [b]=convolveWindow(channels[2],new Float32Array(sw*sh),sw,sh,kernel,window);
  profile.backgroundConvolveMs=performance.now()-sampled;
  return [r,g,b];
}

export function renderScene(input:SceneInput,background:BlurredBackground|undefined=undefined,profile:SceneProfile={},
  target=sceneTarget(input.width,input.height)):Uint8ClampedArray<ArrayBuffer> {
  const start=performance.now();
  const {width,height,card,cardWidth,cardHeight}=input;
  background??=blurBackground(input,profile,target);
  writeBackground(background,target);
  const kernel=scalePsf(input.nearEnergy,input.near,pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScale),pixelsPerRetinalMm(input.near,input.cssPxPerMm,input.viewingDistanceM,input.renderScaleY??input.renderScale));
  const scaled=performance.now();profile.nearScaleMs=scaled-start;
  const rx=kernel.width>>1,ry=kernel.height>>1;
  const cardLeft=Math.round((width-cardWidth)/2),cardTop=height-cardHeight;
  // Exclude only source samples that cannot contribute to any screen pixel,
  // even at the outermost PSF support. Keep the original raster and placement.
  const x0=Math.max(0,target.left-cardLeft-rx),y0=Math.max(0,-cardTop-ry);
  const x1=Math.min(cardWidth,target.right-cardLeft+rx),y1=Math.min(cardHeight,height-cardTop+ry);
  const cw=x1-x0,ch=y1-y0;
  if(cw<=0||ch<=0)return target.data;
  const left=cardLeft+x0-rx,top=cardTop+y0-ry;
  const startX=Math.max(target.left,left),startY=Math.max(0,top);
  const endX=Math.min(target.right,left+cw+2*rx),endY=Math.min(height,top+ch+2*ry);
  const window={left:startX-left,top:startY-top,width:endX-startX,height:endY-startY};
  const colour=new Float32Array(cw*ch),mask=new Float32Array(cw*ch).fill(1);
  for(let y=0;y<ch;y++)colour.set(card.subarray((y+y0)*cardWidth+x0,(y+y0)*cardWidth+x1),y*cw);
  const [foreground,alpha]=convolveWindow(colour,mask,cw,ch,kernel,window);
  const convolved=performance.now();profile.nearConvolveMs=convolved-scaled;
  const {data,stride,offset}=target;
  for(let y=startY;y<endY;y++) for(let x=startX;x<endX;x++) {
    const column=x-target.left,i=y*target.width+column,o=4*(y*stride+offset+column);
    const p=(y-startY)*window.width+x-startX,a=Math.max(0,Math.min(1,alpha[p]));
    const fg=Math.max(0,Math.min(a,foreground[p]));
    for(let c=0;c<3;c++)data[o+c]=Math.round(255*linearToSrgb(fg+(1-a)*background[c][i]));
  }
  profile.compositeEncodeMs=performance.now()-convolved;
  return data;
}
