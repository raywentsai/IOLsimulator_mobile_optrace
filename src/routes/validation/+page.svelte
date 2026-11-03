<script lang="ts">
  import {onMount} from 'svelte';
  import {base} from '$app/paths';
  import {loadPsf} from '../../lib/render/psf/library';
  import type {SceneInput} from '../../lib/render/psf/scene';
  import {WebGLRenderer} from '../../lib/render/gl/renderer';
  let state='Running independent Python / Worker / WebGL comparison…';
  let rows:Array<{name:string;workerError:number;webglError:number;milliseconds:number}>=[];
  let canvas:HTMLCanvasElement;
  onMount(()=>{
    let cancelled=false;
    let worker!:Worker;
    let renderer!:WebGLRenderer;
    void (async()=>{
      try {
        const response=await fetch(`${base}/validation/psf-reference.json`);
        if(!response.ok)throw new Error('Independent reference fixtures unavailable');
        const bundle=await response.json() as {cases:Array<SceneInput & {name:string;expectedRgba:number[]}>};
        renderer=new WebGLRenderer(canvas);await renderer.initialize();
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
          canvas.width=fixture.width;canvas.height=fixture.height;
          const staging=document.createElement('canvas');staging.width=fixture.width;staging.height=fixture.height;
          staging.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result.data),fixture.width,fixture.height),0,0);
          const texture=await renderer.loadImageTexture(staging);
          await renderer.render(texture,{width:fixture.width,height:fixture.height,blurSigma:0,nsGrade:0,pscRadius:0,pscDensity:0,pscSoftness:.2,splitView:false,splitPosition:.5});
          const gl=canvas.getContext('webgl')!;
          const readback=new Uint8Array(fixture.width*fixture.height*4);
          gl.readPixels(0,0,fixture.width,fixture.height,gl.RGBA,gl.UNSIGNED_BYTE,readback);
          let workerError=0,webglError=0;
          for(let y=0;y<fixture.height;y++)for(let x=0;x<fixture.width;x++)for(let c=0;c<4;c++) {
            const i=4*(y*fixture.width+x)+c,j=4*((fixture.height-1-y)*fixture.width+x)+c;
            workerError=Math.max(workerError,Math.abs(result.data[i]-fixture.expectedRgba[i]));
            webglError=Math.max(webglError,Math.abs(readback[j]-fixture.expectedRgba[i]));
          }
          renderer.releaseTexture(texture);
          rows=[...rows,{name:fixture.name,workerError,webglError,milliseconds:result.milliseconds}];
          if(workerError>1||webglError>1)throw new Error('Independent render comparison exceeded 1 sRGB byte tolerance');
        }
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
  <table><thead><tr><th>Model</th><th>Worker max byte error</th><th>WebGL max byte error</th><th>Worker ms</th></tr></thead>
    <tbody>{#each rows as row}<tr><td>{row.name}</td><td>{row.workerError}</td><td>{row.webglError}</td><td>{row.milliseconds.toFixed(1)}</td></tr>{/each}</tbody>
  </table>
  <canvas bind:this={canvas} aria-label="Validation scene output"></canvas>
  <p><a href={`${base}/`}>Simulator</a></p>
</main>
<style>main{padding:1rem;font-family:system-ui}table{border-collapse:collapse;font-size:.8rem}td,th{padding:.5rem;border:1px solid #bbb}canvas{width:320px;height:240px;image-rendering:pixelated}</style>
