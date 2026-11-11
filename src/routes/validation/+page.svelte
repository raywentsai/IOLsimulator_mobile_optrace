<script lang="ts">
  import {onMount} from 'svelte';
  import {base} from '$app/paths';
  import readingCard from '../../../static/reading-card.json';
  import {loadPsf} from '../../lib/render/psf/library';
  import {backgroundRegionKey,type SceneInput} from '../../lib/render/psf/scene';
  import {PsfDisplay} from '../../lib/render/psf/display';
  import {GpuDisplay} from '../../lib/render/psf/gpu-display';
  import {srgbToLinear,linearToSrgb} from '../../lib/render/psf/convolve';
  import {OpticalImageLoader} from '../../lib/render/psf/optical-images';
  import {PhysicsWorkerClient} from '../../lib/render/psf/worker-client';
  import {loadBackgroundAsset} from '../../lib/render/background-asset';
  import backgroundInfo from '../../lib/assets/images/background.json';
  let state='Running independent Python / Worker / WebGL comparison…';
  let rows:Array<{name:string;workerError:number;webglError:number;scaledError:number|null;milliseconds:number}>=[];
  let canvas:HTMLCanvasElement;
  let midpoint:number|null=null;
  let backgroundVerified=false;
  let gpuState='';
  onMount(()=>{
    let cancelled=false;
    const controller=new AbortController();
    const client=new PhysicsWorkerClient(new Worker(new URL('../../lib/render/psf/worker.ts',import.meta.url),{type:'module'}),
      new Uint8ClampedArray(0),reason=>client.dispose(reason));
    let gpu:GpuDisplay|null=null,gpuError=0,gpuCases=0;
    if(new URLSearchParams(window.location.search).get('composition')==='gpu'){
      try{gpu=new GpuDisplay(document.createElement('canvas'));gpuState='Running WebGL2 optical comparison…';}
      catch{gpuState='WebGL2 unavailable. CPU validation continues.';}
    }
    const images=new OpticalImageLoader({
      getOptical:key=>client.getOptical(key),
      registerOptical:async layer=>{if(gpu)await gpu.registerOptical(layer);return client.registerOptical(layer);}
    });
    client.invalidate(1);
    let renderer:PsfDisplay|null=null;
    void (async()=>{
      try {
        const response=await fetch(`${base}/validation/psf-reference.json`);
        if(!response.ok)throw new Error('Independent reference fixtures unavailable');
        const bundle=await response.json() as {cases:Array<SceneInput & {name:string;expectedRgba:number[]}>};
        for(const fixture of bundle.cases) {
          const [nearEnergy,infinityEnergy]=await Promise.all([loadPsf(base,fixture.near),loadPsf(base,fixture.infinity)]);
          const input={...fixture,background:new Uint8ClampedArray(fixture.background),card:new Float32Array(fixture.card),nearEnergy,infinityEnergy};
          if(cancelled)return;
          client.source(input.background);
          const result=await client.render(input,fixture.name,1);
          if(!result.data)throw new Error('Dynamic renderer did not produce an image');
          if(cancelled)return;
          let workerError=0,webglError=0,scaledError=0;
          for(let i=0;i<result.data.length;i++)workerError=Math.max(workerError,Math.abs(result.data[i]-fixture.expectedRgba[i]));
          for(const enlarged of [false,true]) {
            renderer??=new PsfDisplay(canvas);
            const dw=enlarged?fixture.width*2+1:fixture.width,dh=enlarged?fixture.height*2+3:fixture.height;
            renderer.present(result.data,fixture.width,fixture.height,dw,dh);
            const gl=canvas.getContext('webgl')!,readback=new Uint8Array(dw*dh*4);
            gl.readPixels(0,0,dw,dh,gl.RGBA,gl.UNSIGNED_BYTE,readback);
            for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)for(let c=0;c<3;c++) {
              const sx=(x+.5)*fixture.width/dw-.5,sy=(y+.5)*fixture.height/dh-.5,ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;
              const sample=(px:number,py:number)=>srgbToLinear(fixture.expectedRgba[4*(Math.max(0,Math.min(fixture.height-1,py))*fixture.width+Math.max(0,Math.min(fixture.width-1,px)))+c]/255);
              const linear=(1-fy)*((1-fx)*sample(ix,iy)+fx*sample(ix+1,iy))+fy*((1-fx)*sample(ix,iy+1)+fx*sample(ix+1,iy+1));
              const expected=Math.round(255*linearToSrgb(linear)),actual=readback[4*((dh-1-y)*dw+x)+c];
              if(enlarged)scaledError=Math.max(scaledError,Math.abs(actual-expected));
              else webglError=Math.max(webglError,Math.abs(actual-expected));
            }
          }
          rows=[...rows,{name:fixture.name,workerError,webglError,scaledError,milliseconds:result.milliseconds}];
          if(workerError>1||webglError>1||scaledError>1)throw new Error('Independent render comparison exceeded 1 sRGB byte tolerance');
        }
        const opticalResponse=await fetch(`${base}/validation/optical-image-reference.json?v=${readingCard.assetSha256}`);
        if(!opticalResponse.ok)throw new Error('Optical image fixtures unavailable');
        const opticalCases=await opticalResponse.json() as {cases:Array<SceneInput&{name:string;cardFile:string;expectedFile:string;compareDynamic:boolean}>};
        const inflate=async(file:string)=>{
          const response=await fetch(`${base}/validation/${file}?v=${readingCard.assetSha256}`);
          if(!response.ok||!response.body)throw new Error('Compressed optical fixture unavailable');
          return new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        };
        for(const fixture of opticalCases.cases) {
          const empty=new Float32Array(0);
          const [cardBytes,expected,nearEnergy,infinityEnergy,selection]=await Promise.all([
            fixture.compareDynamic?inflate(fixture.cardFile):null,inflate(fixture.expectedFile),
            fixture.compareDynamic?loadPsf(base,fixture.near):empty,loadPsf(base,fixture.infinity),
            images.select(base,fixture.near,fixture.renderScale*1000,(fixture.renderScaleY??fixture.renderScale)*1000)
          ]);
          if(cancelled)return;
          if(!selection)throw new Error('Canonical optical image unavailable');
          const opticalLayer=await images.load(base,selection);
          const input={...fixture,background:new Uint8ClampedArray(fixture.background),
            card:cardBytes?new Float32Array(cardBytes.buffer,cardBytes.byteOffset,cardBytes.byteLength/4):empty,nearEnergy,infinityEnergy};
          if(cancelled)return;
          client.source(input.background);
          const dynamic=fixture.compareDynamic?await client.render(input,fixture.name,1):null;
          if(dynamic&&!dynamic.data)throw new Error('Canonical dynamic renderer did not produce an image');
          const optical=await client.render({...input,card:empty,nearEnergy:empty,opticalLayer},fixture.name,1);
          if(!optical.data)throw new Error('Registered optical renderer did not produce an image');
          if(cancelled)return;
          if(gpu){
            const {width,height}=fixture,backgroundKey=fixture.name,left=0,right=width;
            const prepared=await client.prepareBackgrounds([{input,backgroundKey,left,right}],1);
            const frame=prepared?.backgrounds?.[0];
            if(!frame)throw new Error('GPU validation background unavailable');
            const key=backgroundRegionKey(backgroundKey,left,right);
            gpu.uploadBackground(frame,[key]);
            gpu.draw(input,[{ref:opticalLayer,backgroundKey:key,left,right}],width,height);
            const actual=gpu.readGrid();
            for(let i=0;i<expected.length;i++)gpuError=Math.max(gpuError,Math.abs(actual[i]-expected[i]),Math.abs(actual[i]-optical.data[i]));
            if(gpuError>1)throw new Error('WebGL2 optical comparison exceeded 1 sRGB byte');
            gpuCases++;gpu.clearOptical();gpu.clearBackgrounds();
          }
          let workerError=0,pairError=0;
          for(let i=0;i<expected.length;i++){
            workerError=Math.max(workerError,Math.abs(optical.data[i]-expected[i]));
            if(dynamic?.data)pairError=Math.max(pairError,Math.abs(optical.data[i]-dynamic.data[i]),Math.abs(expected[i]-dynamic.data[i]));
          }
          renderer??=new PsfDisplay(canvas);
          renderer.present(optical.data,fixture.width,fixture.height,fixture.width,fixture.height);
          const gl=canvas.getContext('webgl')!,readback=new Uint8Array(expected.length);
          gl.readPixels(0,0,fixture.width,fixture.height,gl.RGBA,gl.UNSIGNED_BYTE,readback);
          let webglError=0;
          for(let y=0;y<fixture.height;y++)for(let x=0;x<fixture.width;x++)for(let c=0;c<4;c++){
            const i=4*(y*fixture.width+x)+c,j=4*((fixture.height-1-y)*fixture.width+x)+c;
            webglError=Math.max(webglError,Math.abs(readback[j]-expected[i]));
          }
          rows=[...rows,{name:fixture.name,workerError,webglError,scaledError:null,milliseconds:optical.milliseconds}];
          if(workerError>1||pairError>1||webglError>1)throw new Error('Optical image / dynamic FFT / Python canonical comparison failed');
        }
        renderer??=new PsfDisplay(canvas);
        renderer.present(new Uint8ClampedArray([0,0,0,255,255,255,255,255]),2,1,3,1);
        const gl=canvas.getContext('webgl')!,pixel=new Uint8Array(4);
        gl.readPixels(1,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);midpoint=pixel[0];
        if(Math.abs(midpoint-188)>1)throw new Error('Display interpolated in encoded sRGB instead of linear light');
        const asset=await loadBackgroundAsset(controller.signal);
        const surface=document.createElement('canvas');surface.width=asset.image.naturalWidth;surface.height=asset.image.naturalHeight;
        try {
          const ctx=surface.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(asset.image,0,0);
          for(const [x,y,...expected]of backgroundInfo.rgbSamples){
            const rgba=ctx.getImageData(x,y,1,1).data;
            if(expected.some((value,channel)=>Math.abs(value-rgba[channel])>4))throw new Error('Background JPEG browser decode differs from reference');
          }
          backgroundVerified=true;
        }finally{surface.width=1;surface.height=1;asset.release();}
        state='PASS: all Python / Worker / WebGL comparisons';
        if(gpu)gpuState=`PASS: WebGL2 matched CPU and Python within ${gpuError} sRGB byte across ${gpuCases} cases.`;
      }catch(error){state=`FAIL: ${error}`;}
      finally{client.dispose('Validation complete');renderer?.dispose();gpu?.dispose();}
    })();
    return()=>{cancelled=true;controller.abort();images.cancel();client.dispose('Validation disposed');renderer?.dispose();gpu?.dispose();};
  });
</script>
<svelte:head><title>Optics numerical validation</title></svelte:head>
<main>
  <h1>Optics numerical validation</h1>
  <p role="status">{state}</p>
  {#if gpuState}<p data-gpu-validation>{gpuState}</p>{/if}
  <p>Python/SciPy references use identical PSF bins, physical pixel scale and padding. Dense optical grids are area integrated to the display grid.</p>
  <p>Black/white 50% linear-light display sample: {midpoint??'pending'} / 255 (expected 188).</p>
  <p>Background JPEG browser decode: {backgroundVerified?'PASS — dimensions and reference samples match':'pending'}.</p>
  <table><thead><tr><th>Model</th><th>Worker max byte error</th><th>WebGL max byte error</th><th>Linear upscale max byte error</th><th>Worker ms</th></tr></thead>
    <tbody>{#each rows as row}<tr><td>{row.name}</td><td>{row.workerError}</td><td>{row.webglError}</td><td>{row.scaledError??'—'}</td><td>{row.milliseconds.toFixed(1)}</td></tr>{/each}</tbody>
  </table>
  <canvas bind:this={canvas} aria-label="Validation scene output"></canvas>
  <p><a href={`${base}/`}>Simulator</a></p>
</main>
<style>main{padding:1rem;font-family:system-ui}table{border-collapse:collapse;font-size:.8rem}td,th{padding:.5rem;border:1px solid #bbb}canvas{width:320px;height:240px;image-rendering:pixelated}</style>
