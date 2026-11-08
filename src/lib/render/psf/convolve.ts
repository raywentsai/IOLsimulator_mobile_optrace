import type { Kernel } from './geometry.ts';

// Radix-2 FFT, in-place complex pairs. Workers isolate this from UI input.
function fft(a: Float64Array, inverse: boolean): void {
  const n=a.length/2;
  for(let i=1,j=0;i<n;i++) {
    let bit=n>>1;
    for(;j&bit;bit>>=1) j^=bit;
    j^=bit;
    if(i<j) for(let c=0;c<2;c++) { const t=a[2*i+c];a[2*i+c]=a[2*j+c];a[2*j+c]=t; }
  }
  for(let size=2;size<=n;size*=2) {
    const angle=(inverse?2:-2)*Math.PI/size, cr=Math.cos(angle),ci=Math.sin(angle);
    for(let start=0;start<n;start+=size) {
      let wr=1,wi=0;
      for(let k=0;k<size/2;k++) {
        const p=2*(start+k),q=2*(start+k+size/2);
        const tr=wr*a[q]-wi*a[q+1],ti=wr*a[q+1]+wi*a[q];
        a[q]=a[p]-tr;a[q+1]=a[p+1]-ti;a[p]+=tr;a[p+1]+=ti;
        const next=wr*cr-wi*ci;wi=wr*ci+wi*cr;wr=next;
      }
    }
  }
  if(inverse) for(let i=0;i<a.length;i++) a[i]/=n;
}

function fft2(a:Float64Array,w:number,h:number,inverse:boolean):void {
  for(let y=0;y<h;y++) fft(a.subarray(2*y*w,2*(y+1)*w),inverse);
  const column=new Float64Array(2*h);
  for(let x=0;x<w;x++) {
    for(let y=0;y<h;y++) {column[2*y]=a[2*(y*w+x)];column[2*y+1]=a[2*(y*w+x)+1];}
    fft(column,inverse);
    for(let y=0;y<h;y++) {a[2*(y*w+x)]=column[2*y];a[2*(y*w+x)+1]=column[2*y+1];}
  }
}

function power2(n:number):number {return 2**Math.ceil(Math.log2(n));}
export function reflectIndex(i:number,n:number):number {
  if(i>=0&&i<n)return i;
  if(n===1) return 0;
  const period=2*n-2;
  i=((i%period)+period)%period;
  return i<n?i:period-i;
}

export interface PixelWindow {left:number;top:number;width:number;height:number}

// The two real channels are packed as a single complex image; multiplying by
// a real kernel convolves both independently, with no separability assumption.
export function convolvePair(first:Float32Array,second:Float32Array,width:number,height:number,kernel:Kernel,padding:'reflect'|'zero'='reflect',full=false): [Float32Array,Float32Array] {
  if(full&&padding!=='zero')throw new Error('Full convolution requires zero padding');
  const rx=kernel.width>>1,ry=kernel.height>>1;
  const borderX=padding==='reflect'?rx:0,borderY=padding==='reflect'?ry:0;
  const window=full?{left:0,top:0,width:width+2*rx,height:height+2*ry}:
    {left:borderX+rx,top:borderY+ry,width,height};
  return convolveWindow(first,second,width,height,kernel,window,borderX,borderY);
}

// The window is expressed in linear-convolution coordinates. A shorter FFT is
// safe when any circular alias lands strictly before the first retained sample.
export function convolveWindow(first:Float32Array,second:Float32Array,width:number,height:number,kernel:Kernel,
  window:PixelWindow,borderX=0,borderY=0):[Float32Array,Float32Array] {
  if(first.length!==width*height || second.length!==first.length) throw new Error('Image shape mismatch');
  if(kernel.width%2!==1 || kernel.height%2!==1) throw new Error('Kernel must have a defined central bin');
  const {left,top,width:ow,height:oh}=window;
  const sw=width+2*borderX,sh=height+2*borderY;
  const fftSize=(size:number,k:number,start:number,count:number)=>power2(Math.max(size,k,start+count,size+k-1-start));
  const w=fftSize(sw,kernel.width,left,ow),h=fftSize(sh,kernel.height,top,oh);
  if(w*h>2097152) throw new Error('This calibration and viewing distance need too much memory. Reduce viewing distance.');
  const a=new Float64Array(2*w*h),b=new Float64Array(a.length);
  for(let y=0;y<sh;y++){
    const row=(borderY?reflectIndex(y-borderY,height):y)*width;
    for(let x=0;x<sw;x++) {
      const s=row+(borderX?reflectIndex(x-borderX,width):x),t=2*(y*w+x);
      a[t]=first[s];a[t+1]=second[s];
    }
  }
  for(let y=0;y<kernel.height;y++) for(let x=0;x<kernel.width;x++) b[2*(y*w+x)]=kernel.data[y*kernel.width+x];
  fft2(a,w,h,false);fft2(b,w,h,false);
  for(let i=0;i<a.length;i+=2) { const re=a[i]*b[i]-a[i+1]*b[i+1];a[i+1]=a[i]*b[i+1]+a[i+1]*b[i];a[i]=re; }
  fft2(a,w,h,true);
  const out1=new Float32Array(ow*oh),out2=new Float32Array(ow*oh);
  for(let y=0;y<oh;y++) for(let x=0;x<ow;x++) {
    const s=2*((y+top)*w+x+left),t=y*ow+x;
    out1[t]=a[s];out2[t]=a[s+1];
  }
  return [out1,out2];
}

export function srgbToLinear(x:number):number {return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}
export function linearToSrgb(x:number):number {x=Math.max(0,Math.min(1,x));return x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055;}
