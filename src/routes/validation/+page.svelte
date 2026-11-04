<script lang="ts">
  import {onMount} from 'svelte';
  import {base} from '$app/paths';
  import {loadPsf} from '../../lib/render/psf/library';
  import type {SceneInput} from '../../lib/render/psf/scene';
  import {PsfDisplay} from '../../lib/render/psf/display';
  import {srgbToLinear,linearToSrgb} from '../../lib/render/psf/convolve';
  let state='Running independent Python / Worker / WebGL comparison…';
  let rows:Array<{name:string;workerError:number;webglError:number;scaledError:number;milliseconds:number}>=[];
  let canvas:HTMLCanvasElement;
  let midpoint:number|null=null;
  onMount(()=>{
    let cancelled=false;
    let worker!:Worker;
    let renderer:PsfDisplay|null=null;
    void (async()=>{
      try {
        const response=await fetch(`${base}/validation/psf-reference.json`);
        if(!response.ok)throw new Error('Independent reference fixtures unavailable');
        const bundle=await response.json() as {cases:Array<SceneInput & {name:string;expectedRgba:number[]}>};
        worker=new Worker(new URL('../../lib/render/psf/worker.ts',import.meta.url),{type:'module'});
        for(const [index,fixture] of bundle.cases.entries()) {
          const [nearEnergy,infinityEnergy]=await Promise.all([loadPsf(base,fixture.near),loadPsf(base,fixture.infinity)]);
          const input={...fixture,background:new Uint8ClampedArray(fixture.background),card:new Float32Array(fixture.card),nearEnergy,infinityEnergy};
          worker.postMessage({source:input.background});
          const result=await new Promise<{data:Uint8ClampedArray;milliseconds:number}>((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error('Validation worker timeout')),30000);
            worker.onmessage=event=>{clearTimeout(timeout);if(event.data.error)reject(new Error(event.data.error));else resolve(event.data);};
            worker.onerror=()=>{clearTimeout(timeout);reject(new Error('Worker failed'));};
            worker.postMessage({id:index,input,backgroundKey:fixture.name});
          });
          if(cancelled)return;
          let workerError=0,webglError=0,scaledError=0;
          for(let i=0;i<result.data.length;i++)workerError=Math.max(workerError,Math.abs(result.data[i]-fixture.expectedRgba[i]));
          for(const enlarged of [false,true]) {
            renderer?.dispose();renderer=new PsfDisplay(canvas);
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
        renderer?.dispose();renderer=new PsfDisplay(canvas);
        renderer.present(new Uint8ClampedArray([0,0,0,255,255,255,255,255]),2,1,3,1);
        const gl=canvas.getContext('webgl')!,pixel=new Uint8Array(4);
        gl.readPixels(1,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);midpoint=pixel[0];
        if(Math.abs(midpoint-188)>1)throw new Error('Display interpolated in encoded sRGB instead of linear light');
        state='PASS: all Python / Worker / WebGL comparisons';
      }catch(error){state=`FAIL: ${error}`;}
      finally{worker?.terminate();renderer?.dispose();}
    })();
    return()=>{cancelled=true;worker?.terminate();renderer?.dispose();};
  });
</script>
<svelte:head><title>Optics numerical validation</title></svelte:head>
<main>
  <h1>Optics numerical validation</h1>
  <p role="status">{state}</p>
  <p>Identical PSF bins, input radiance, physical pixel scale and padding. Reference: independent Python/SciPy float computation.</p>
  <p>Black/white 50% linear-light display sample: {midpoint??'pending'} / 255 (expected 188).</p>
  <table><thead><tr><th>Model</th><th>Worker max byte error</th><th>WebGL max byte error</th><th>Linear upscale max byte error</th><th>Worker ms</th></tr></thead>
    <tbody>{#each rows as row}<tr><td>{row.name}</td><td>{row.workerError}</td><td>{row.webglError}</td><td>{row.scaledError}</td><td>{row.milliseconds.toFixed(1)}</td></tr>{/each}</tbody>
  </table>
  <canvas bind:this={canvas} aria-label="Validation scene output"></canvas>
  <p><a href={`${base}/`}>Simulator</a></p>
</main>
<style>main{padding:1rem;font-family:system-ui}table{border-collapse:collapse;font-size:.8rem}td,th{padding:.5rem;border:1px solid #bbb}canvas{width:320px;height:240px;image-rendering:pixelated}</style>
