export const displayColorFunctions=`
  vec3 decode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
  vec3 encode(vec3 c){c=clamp(c,0.,1.);return mix(12.92*c,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}`;

// Explicit linear-light reconstruction of the computed sRGB sample grid at
// device resolution. CSS/compositor interpolation of encoded sRGB is avoided.
export class PsfDisplay {
  private gl:WebGLRenderingContext;
  private program:WebGLProgram;
  private buffer:WebGLBuffer;
  private texture:WebGLTexture;
  private canvas:HTMLCanvasElement;
  constructor(canvas:HTMLCanvasElement) {
    this.canvas=canvas;
    const gl=canvas.getContext('webgl');
    if(!gl)throw new Error('WebGL is unavailable');
    this.gl=gl;
    const vertex=`attribute vec2 position;varying vec2 uv;void main(){uv=vec2(position.x*.5+.5,.5-position.y*.5);gl_Position=vec4(position,0.,1.);}`;
    const fragment=`precision highp float;
      uniform sampler2D image;uniform vec2 size;varying vec2 uv;
      ${displayColorFunctions}
      vec3 sampleLinear(vec2 p){return decode(texture2D(image,(clamp(p,vec2(0.),size-1.)+.5)/size).rgb);}
      void main(){
        vec2 p=uv*size-.5,a=floor(p),f=fract(p);
        vec3 linear=mix(mix(sampleLinear(a),sampleLinear(a+vec2(1.,0.)),f.x),mix(sampleLinear(a+vec2(0.,1.)),sampleLinear(a+vec2(1.,1.)),f.x),f.y);
        gl_FragColor=vec4(encode(linear),1.);
      }`;
    const compile=(type:number,source:string)=>{
      const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(`Display shader: ${message}`);}
      return shader;
    };
    const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
    this.program=gl.createProgram()!;gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error('Display shader link failed');
    this.buffer=gl.createBuffer()!;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    this.texture=gl.createTexture()!;
  }
  present(data:Uint8ClampedArray,width:number,height:number,displayWidth:number,displayHeight:number):{uploadMs:number;drawSubmitMs:number} {
    const gl=this.gl,start=performance.now();
    if(gl.isContextLost())throw new Error('Graphics context lost; please reload');
    if(this.canvas.width!==displayWidth)this.canvas.width=displayWidth;
    if(this.canvas.height!==displayHeight)this.canvas.height=displayHeight;
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    const uploaded=performance.now();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,displayWidth,displayHeight);
    gl.disable(gl.BLEND);gl.useProgram(this.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    const position=gl.getAttribLocation(this.program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    gl.uniform1i(gl.getUniformLocation(this.program,'image'),0);gl.uniform2f(gl.getUniformLocation(this.program,'size'),width,height);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    return {uploadMs:uploaded-start,drawSubmitMs:performance.now()-uploaded};
  }
  dispose():void {this.gl.deleteTexture(this.texture);this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program);}
}
