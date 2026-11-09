import {AssetCache} from './asset-cache.ts';
import {displayColorFunctions} from './display.ts';
import {INACTIVE_OPTICAL_BYTES,OPTICAL_CACHE_BYTES,angularDisplayDensity,packedOpticalBytes,type OpticalImageRef,type PackedOpticalImageLayer} from './optical-image-math.ts';
import type {OpticalImageStore} from './optical-images.ts';
import type {SceneInput,BackgroundTextureData} from './scene.ts';

const vertex=`#version 300 es
  out vec2 uv;
  void main(){vec2 p=vec2((gl_VertexID << 1) & 2,gl_VertexID & 2);
    uv=vec2(p.x,1.-p.y);gl_Position=vec4(p*2.-1.,0.,1.);}`;
const composite=`#version 300 es
  precision highp float;
  precision highp int;
  uniform highp usampler2D optical;
  uniform highp sampler2D background;
  uniform vec2 origin, pitch;
  uniform int left;
  out vec4 rgba;
  ${displayColorFunctions}
  void main(){
    ivec2 pixel=ivec2(gl_FragCoord.xy);
    vec2 lo=origin+vec2(pixel)*pitch,hi=lo+pitch;
    ivec2 begin=max(ivec2(floor(lo)),ivec2(0));
    ivec2 end=min(ivec2(ceil(hi)),textureSize(optical,0));
    vec2 field=vec2(0.);
    // An output cell at most eight source cells wide can touch nine cells.
    for(int dy=0;dy<9;dy++){
      int y=begin.y+dy;if(y>=end.y)break;
      float wy=max(0.,min(hi.y,float(y+1))-max(lo.y,float(y)))/pitch.y;
      for(int dx=0;dx<9;dx++){
        int x=begin.x+dx;if(x>=end.x)break;
        float wx=max(0.,min(hi.x,float(x+1))-max(lo.x,float(x)))/pitch.x;
        uvec3 v=texelFetch(optical,ivec2(x,y),0).rgb;
        uvec2 packed12=uvec2((v.r<<4u)|(v.g>>4u),((v.g&15u)<<8u)|v.b);
        field+=vec2(packed12)*(wx*wy/4095.);
      }
    }
    float a=clamp(field.y,0.,1.),f=clamp(field.x,0.,a);
    vec3 bg=texelFetch(background,pixel-ivec2(left,0),0).rgb;
    // Preserve the CPU sRGB sample grid before linear-light display reconstruction.
    rgba=vec4(floor(255.*encode(vec3(f)+(1.-a)*bg)+.5)/255.,1.);
  }`;
const present=`#version 300 es
  precision highp float;
  uniform sampler2D image;
  uniform ivec2 size;
  in vec2 uv;
  out vec4 rgba;
  ${displayColorFunctions}
  vec3 sampleLinear(ivec2 p){return decode(texelFetch(image,clamp(p,ivec2(0),size-1),0).rgb);}
  void main(){
    vec2 p=uv*vec2(size)-.5,f=fract(p);ivec2 a=ivec2(floor(p));
    vec3 linear=mix(mix(sampleLinear(a),sampleLinear(a+ivec2(1,0)),f.x),mix(sampleLinear(a+ivec2(0,1)),sampleLinear(a+ivec2(1,1)),f.x),f.y);
    rgba=vec4(encode(linear),1.);
  }`;

function program(gl:WebGL2RenderingContext,fragment:string,names:string[]){
  const p=gl.createProgram()!;
  try{
    for(const [type,source]of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const){
      const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
        const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(`GPU shader: ${message}`);
      }
      gl.attachShader(p,shader);gl.deleteShader(shader);
    }
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(`GPU program: ${gl.getProgramInfoLog(p)}`);
    return {program:p,uniform:Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(p,name)]))};
  }catch(e){gl.deleteProgram(p);throw e;}
}

export type GpuGeometry=Pick<SceneInput,'width'|'height'|'cardWidth'|'cssPxPerMm'|'viewingDistanceM'|'renderScale'|'renderScaleY'>;
export type GpuSide={ref:OpticalImageRef;backgroundKey:string;left:number;right:number};
export class GpuDisplayError extends Error {}

export function gpuSampling(input:GpuGeometry,ref:OpticalImageRef){
  const [px,py]=angularDisplayDensity(input),[sx,sy]=ref.level.pixelsPerTanTheta;
  const pitchX=sx/px,pitchY=sy/py;
  if(!Number.isFinite(pitchX+pitchY)||Math.min(px,py)<128||Math.max(px,py)>8192||
    Math.min(pitchX,pitchY)<1-1e-7||Math.max(pitchX,pitchY)>8||!packedOpticalBytes(ref.level,ref.columns))return null;
  const anchorX=Math.round((input.width-input.cardWidth)/2)+input.cardWidth/2;
  const [x0,,y0]=ref.level.extentTanTheta;
  return {originX:(-anchorX/px-x0)*sx-(ref.columns?.[0]??0),originY:(-input.height/py-y0)*sy,pitchX,pitchY};
}

type PreparedSide=Pick<GpuSide,'backgroundKey'|'left'|'right'>&{
  opticalKey:string;samples:NonNullable<ReturnType<typeof gpuSampling>>;
};

export function prepareGpuSides(input:GpuGeometry,sides:GpuSide[]):PreparedSide[]{
  return sides.map(({ref,backgroundKey,left,right})=>{
    const samples=gpuSampling(input,ref);
    if(!samples)throw new GpuDisplayError('GPU sampling unavailable');
    return {opticalKey:ref.key,backgroundKey,left,right,samples};
  });
}

export class GpuDisplay implements OpticalImageStore {
  private gl:WebGL2RenderingContext;
  private integrate:ReturnType<typeof program>;
  private output:ReturnType<typeof program>;
  private buffer:WebGLFramebuffer;
  private grid:WebGLTexture;
  private spareGrid:{texture:WebGLTexture;width:number;height:number}|null=null;
  private width=0;
  private height=0;
  private maxSize:number;
  private maxViewport:Int32Array;
  private optical:AssetCache<{ref:OpticalImageRef;texture:WebGLTexture}>;
  private backgrounds:AssetCache<WebGLTexture>;
  private reserved:readonly string[]=[];
  private canvas:HTMLCanvasElement;
  constructor(canvas:HTMLCanvasElement) {
    this.canvas=canvas;
    const gl=canvas.getContext('webgl2',{alpha:false,depth:false,stencil:false,antialias:false,failIfMajorPerformanceCaveat:true});
    if(!gl||(gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT)?.precision??0)<23)throw new GpuDisplayError('WebGL2 high precision unavailable');
    this.gl=gl;
    this.maxSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxViewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.integrate=program(gl,composite,['optical','background','origin','pitch','left']);
    try{this.output=program(gl,present,['image','size']);}
    catch(error){gl.deleteProgram(this.integrate.program);throw error;}
    const buffer=gl.createFramebuffer(),grid=gl.createTexture();
    if(!buffer||!grid){gl.deleteProgram(this.integrate.program);gl.deleteProgram(this.output.program);gl.deleteFramebuffer(buffer);gl.deleteTexture(grid);throw new GpuDisplayError('GPU composition target unavailable');}
    this.buffer=buffer;this.grid=grid;
    this.optical=new AssetCache(OPTICAL_CACHE_BYTES,value=>gl.deleteTexture(value.texture));
    // Account for drivers that store RGB32F with a fourth component.
    this.backgrounds=new AssetCache(7*1024*1024,texture=>gl.deleteTexture(texture));
    gl.disable(gl.DITHER);gl.disable(gl.BLEND);
  }
  private bind(texture:WebGLTexture,unit=0){const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);}
  private pixels(texture:WebGLTexture,width:number,height:number,internal:number,format:number,type:number,data:ArrayBufferView|null){
    const gl=this.gl;
    if(width<1||height<1||width>this.maxSize||height>this.maxSize)throw new GpuDisplayError('GPU texture dimensions unsupported');
    this.bind(texture);
    gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,format,type,data);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw new GpuDisplayError('GPU texture allocation failed');
  }
  getOptical(key:string):OpticalImageRef|undefined {return this.optical.get(key)?.ref;}
  reserveOptical(keys:readonly string[]):void {this.reserved=keys;}
  retainFrame(sides:PreparedSide[]):void {
    this.reserved=[];
    this.optical.retain(sides.map(side=>side.opticalKey),INACTIVE_OPTICAL_BYTES);
    this.backgrounds.retain(sides.map(side=>side.backgroundKey));
  }
  clearOptical():void {this.reserved=[];this.optical.clear();}
  async registerOptical(layer:PackedOpticalImageLayer):Promise<OpticalImageRef> {
    const {key,level,columns,rgba}=layer,gl=this.gl;
    const resident=this.getOptical(key);
    if(resident)return resident;
    const texture=gl.createTexture(),ref={key,level,columns};
    if(!texture)throw new GpuDisplayError('GPU optical texture unavailable');
    const width=columns?columns[1]-columns[0]:level.width;
    try{
      this.optical.set(key,{ref,texture},rgba.byteLength,this.reserved);
      this.pixels(texture,width,level.height,gl.RGBA8UI,gl.RGBA_INTEGER,gl.UNSIGNED_BYTE,rgba);
      return ref;
    }catch(error){
      if(!this.optical.delete(key))gl.deleteTexture(texture);
      throw new GpuDisplayError(String(error));
    }
  }
  hasBackground(key:string):boolean {return !!this.backgrounds.get(key);}
  hasFrame(sides:PreparedSide[]):boolean {
    return sides.every(side=>this.optical.has(side.opticalKey)&&this.backgrounds.has(side.backgroundKey));
  }
  clearBackgrounds():void {this.backgrounds.clear();}
  uploadBackground({key,width,height,pixels}:BackgroundTextureData,retain:readonly string[]):void {
    const gl=this.gl,texture=gl.createTexture();
    if(!texture)throw new GpuDisplayError('GPU background texture unavailable');
    try{
      this.backgrounds.set(key,texture,width*height*16,retain);
      this.pixels(texture,width,height,gl.RGB32F,gl.RGB,gl.FLOAT,pixels);
    }catch(error){if(!this.backgrounds.delete(key))gl.deleteTexture(texture);throw error;}
  }
  draw(input:GpuGeometry,sides:GpuSide[],displayWidth:number,displayHeight:number){
    if(!this.drawResident(input,prepareGpuSides(input,sides),displayWidth,displayHeight))
      throw new GpuDisplayError('GPU frame assets unavailable');
  }
  drawResident({width,height}:Pick<GpuGeometry,'width'|'height'>,sides:PreparedSide[],displayWidth:number,displayHeight:number):boolean {
    const gl=this.gl;
    if(gl.isContextLost())throw new GpuDisplayError('WebGL2 context lost');
    const sources=[];
    for(const side of sides){
      const optical=this.optical.get(side.opticalKey),background=this.backgrounds.get(side.backgroundKey);
      if(!optical||!background)return false;
      sources.push({side,optical:optical.texture,background});
    }
    if(displayWidth>this.maxViewport[0]||displayHeight>this.maxViewport[1])throw new GpuDisplayError('GPU display dimensions unsupported');
    const resizeDisplay=this.canvas.width!==displayWidth||this.canvas.height!==displayHeight;
    if(this.canvas.width!==displayWidth)this.canvas.width=displayWidth;
    if(this.canvas.height!==displayHeight)this.canvas.height=displayHeight;
    if(resizeDisplay&&(gl.drawingBufferWidth!==displayWidth||gl.drawingBufferHeight!==displayHeight))throw new GpuDisplayError('GPU display allocation failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.buffer);
    const resizeGrid=width!==this.width||height!==this.height;
    if(resizeGrid){
      const spare=this.spareGrid;
      if(this.width&&this.width*this.height*4<=1024*1024){
        const texture=spare?.texture??gl.createTexture();
        if(!texture)throw new GpuDisplayError('GPU composition target unavailable');
        this.spareGrid={texture:this.grid,width:this.width,height:this.height};
        this.grid=texture;
      }else{
        if(spare)gl.deleteTexture(spare.texture);
        this.spareGrid=null;
      }
      if(this.grid!==spare?.texture||width!==spare.width||height!==spare.height)
        this.pixels(this.grid,width,height,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.grid,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new GpuDisplayError('GPU composition target unavailable');
      this.width=width;this.height=height;
    }
    const integrate=this.integrate.uniform;
    gl.useProgram(this.integrate.program);gl.uniform1i(integrate.optical,0);gl.uniform1i(integrate.background,1);
    for(const {side,optical,background} of sources){
      const {samples}=side;
      this.bind(optical);this.bind(background,1);
      gl.uniform2f(integrate.origin,samples.originX,samples.originY);gl.uniform2f(integrate.pitch,samples.pitchX,samples.pitchY);
      gl.uniform1i(integrate.left,side.left);gl.viewport(side.left,0,side.right-side.left,height);gl.drawArrays(gl.TRIANGLES,0,3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,displayWidth,displayHeight);this.bind(this.grid);
    gl.useProgram(this.output.program);gl.uniform1i(this.output.uniform.image,0);gl.uniform2i(this.output.uniform.size,width,height);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if((resizeGrid||resizeDisplay)&&gl.getError()!==gl.NO_ERROR)throw new GpuDisplayError('GPU composition draw failed');
    return true;
  }
  readGrid(){
    const gl=this.gl,result=new Uint8Array(this.width*this.height*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.buffer);gl.readPixels(0,0,this.width,this.height,gl.RGBA,gl.UNSIGNED_BYTE,result);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);return result;
  }
  info(){return {opticalBytes:this.optical.info().bytes,backgroundBytes:this.backgrounds.info().bytes,gridBytes:this.width*this.height*4,
    spareGridBytes:this.spareGrid?this.spareGrid.width*this.spareGrid.height*4:0};}
  dispose():void {
    const gl=this.gl;
    this.clearOptical();this.clearBackgrounds();gl.deleteTexture(this.grid);gl.deleteTexture(this.spareGrid?.texture??null);gl.deleteFramebuffer(this.buffer);
    gl.deleteProgram(this.integrate.program);gl.deleteProgram(this.output.program);
  }
}
