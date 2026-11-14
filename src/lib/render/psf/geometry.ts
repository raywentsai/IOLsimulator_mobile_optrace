import { calculateEffectiveCssPixelsPerMillimeter } from '../../optics/calibration.ts';

export interface PsfEntry {
  model: string;
  objectVergenceD: number;
  file: string;
  width: number;
  height: number;
  center: [number, number];
  retinalExtentMm: [number, number, number, number];
  retinalMmPerTanTheta: number;
  captureFraction: number;
  sha256: string;
}

export function objectVergence(defocusD: number): number {
  if (!Number.isFinite(defocusD) || defocusD > -1 || defocusD < -4) {
    throw new Error('Near PSF requires UI defocus in [-4, -1] D');
  }
  // UI defocus = -1/distance_m; library object vergence = +1/distance_m.
  return Math.round(-defocusD * 10) / 10;
}

export function pixelsPerRetinalMm(entry: PsfEntry, cssPxPerMm: number, viewingDistanceM: number, renderScale: number): number {
  if (![cssPxPerMm, viewingDistanceM, renderScale, entry.retinalMmPerTanTheta].every(x => Number.isFinite(x) && x > 0)) {
    throw new Error('Invalid physical display scale');
  }
  // x_ret = L*tan(theta); x_screen = viewing_distance*tan(theta).
  return viewingDistanceM * 1000 * cssPxPerMm * renderScale / entry.retinalMmPerTanTheta;
}

export interface Kernel { data: Float64Array; width: number; height: number }

export function calibratedCssPxPerMm(cssPxPerMmAtCalibration:number,calibrationScale:number,currentScale:number):number {
  return calculateEffectiveCssPixelsPerMillimeter(cssPxPerMmAtCalibration,currentScale,calibrationScale);
}

export function mobileSampling(cssWidth:number,cssHeight:number,ppm:number,distanceM:number,vergence:number,cardHeightMm:number,aspect:number,minProjectionMm:number):{width:number;height:number;scaleX:number;scaleY:number} {
  let scale=Math.min(1,640/Math.max(cssWidth,cssHeight));
  const fftSize=(n:number)=>2**Math.ceil(Math.log2(n));
  for(let attempt=0;attempt<24;attempt++) {
    const width=Math.max(1,Math.round(cssWidth*scale)),height=Math.max(1,Math.round(cssHeight*scale));
    const scaleX=width/cssWidth,scaleY=height/cssHeight;
    const px=distanceM*1000*ppm/minProjectionMm;
    const rx=Math.ceil(.25*px*scaleX+.5),ry=Math.ceil(.25*px*scaleY+.5);
    const cw=Math.max(1,Math.round(cardHeightMm*aspect*distanceM*vergence*ppm*scaleX));
    const ch=Math.max(1,Math.round(cardHeightMm*distanceM*vergence*ppm*scaleY));
    if(fftSize(width+4*rx)*fftSize(height+4*ry)<=2097152 && fftSize(cw+6*rx)*fftSize(ch+6*ry)<=2097152) {
      return {width,height,scaleX,scaleY};
    }
    scale*=.75;
  }
  throw new Error('Unable to sample this display safely');
}

export function scalePsf(energy: Float32Array, entry: PsfEntry, pxPerMm: number, pxPerMmY=pxPerMm): Kernel {
  const [x0,x1,y0,y1] = entry.retinalExtentMm;
  if (energy.length !== entry.width * entry.height || !(pxPerMm > 0)) throw new Error('Invalid PSF grid');
  const rx = Math.ceil(Math.max(Math.abs(x0),Math.abs(x1))*pxPerMm + .5);
  const ry = Math.ceil(Math.max(Math.abs(y0),Math.abs(y1))*pxPerMmY + .5);
  const width = 2*rx+1, height = 2*ry+1;
  if (width > 2049 || height > 2049) throw new Error('PSF exceeds supported display sampling');
  const intermediate = new Float64Array(entry.height * width);
  const data = new Float64Array(width * height);
  const dx = (x1-x0)*pxPerMm/entry.width, dy = (y1-y0)*pxPerMmY/entry.height;
  for (let sy=0; sy<entry.height; sy++) {
    for (let sx=0; sx<entry.width; sx++) {
      const e = energy[sy*entry.width+sx];
      if (!Number.isFinite(e) || e<0) throw new Error('Invalid PSF energy');
      const a=x0*pxPerMm+sx*dx, b=a+dx;
      for(let tx=Math.max(-rx,Math.floor(a+.5));tx<=Math.min(rx,Math.ceil(b+.5)-1);tx++) {
        const overlap=Math.max(0,Math.min(b,tx+.5)-Math.max(a,tx-.5))/dx;
        intermediate[sy*width+tx+rx] += e*overlap;
      }
    }
  }
  for(let sy=0;sy<entry.height;sy++) {
    const a=y0*pxPerMmY+sy*dy, b=a+dy;
    for(let ty=Math.max(-ry,Math.floor(a+.5));ty<=Math.min(ry,Math.ceil(b+.5)-1);ty++) {
      const overlap=Math.max(0,Math.min(b,ty+.5)-Math.max(a,ty-.5))/dy;
      for(let x=0;x<width;x++) data[(ty+ry)*width+x]+=intermediate[sy*width+x]*overlap;
    }
  }
  const sum=data.reduce((a,b)=>a+b,0);
  if (!(sum>0) || Math.abs(sum-1)>1e-5) throw new Error('PSF failed energy conservation');
  for(let i=0;i<data.length;i++) data[i]/=sum;
  return {data,width,height};
}
