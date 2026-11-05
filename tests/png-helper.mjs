import fs from 'node:fs';
import {inflateSync} from 'node:zlib';
import assert from 'node:assert/strict';

// Read the lossless RGB8 data PNGs without a platform/browser image library.
export function readRgbPng(path) {
  const bytes=fs.readFileSync(path),chunks=[];let width,height;
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  for(let p=8;p<bytes.length;) {
    const length=bytes.readUInt32BE(p),kind=bytes.toString('ascii',p+4,p+8),data=bytes.subarray(p+8,p+8+length);
    if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[9],2);assert.equal(data[12],0);}
    if(kind==='IDAT')chunks.push(data);
    p+=length+12;
  }
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*3,rgb=new Uint8Array(stride*height),rgba=new Uint8ClampedArray(width*height*4);
  const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)];assert.ok(filter<=4);
    for(let x=0;x<stride;x++) {
      const i=y*stride+x,a=x>=3?rgb[i-3]:0,b=y?rgb[i-stride]:0,c=y&&x>=3?rgb[i-stride-3]:0;
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?((a+b)>>1):paeth(a,b,c);rgb[i]=(raw[y*(stride+1)+x+1]+predictor)&255;
    }
  }
  for(let i=0;i<width*height;i++){rgba[4*i]=rgb[3*i];rgba[4*i+1]=rgb[3*i+1];rgba[4*i+2]=rgb[3*i+2];rgba[4*i+3]=255;}
  return {width,height,rgba};
}
