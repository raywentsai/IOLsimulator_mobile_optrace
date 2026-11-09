import assert from 'node:assert/strict';

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error('Pass the baseline and candidate app URLs in that order');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const slider = '[aria-label="Holding distance"]';
const labels = { zcb00: 'Aspheric Monofocal', vivity: 'Vivity-like EDOF' };

function button(page, name) {
  return page.getByRole('button', { name, exact: true });
}

async function waitForFrame(page, fields) {
  await page.waitForFunction(fields => {
    const data = JSON.parse(document.querySelector('canvas[data-profile]')?.dataset.profile ?? '{}');
    return Object.entries(fields).every(([key, value]) => data[key] === value);
  }, fields, { timeout: 45000 });
}

async function setup(page, url, { split, lens, distance, card }) {
  url = new URL(url);
  url.searchParams.set('composition', 'gpu');
  url.searchParams.set('diagnostics', '1');
  await page.goto(url.href);
  await button(page, 'Done').click();
  await waitForFrame(page, { backgroundReady: true });
  if (lens !== 'zcb00') {
    await button(page, 'Primary IOL').click();
    await button(page, labels[lens]).click();
    await button(page, 'Done').click();
  }
  if (split) await button(page, 'Compare').click();
  if (card !== undefined) {
    await button(page, 'Calibrate').click();
    for (const [id, value] of [['calibrate-card-size', card], ['calibrate-viewing-distance', distance]]) {
      await page.locator('#' + id).evaluate((input, value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    }
    await button(page, 'Done').click();
  }
  await button(page, 'Settings').click();
  await button(page, 'Physics-based (OPTrace PSF)').click();
  await button(page, 'Done').click();
  await waitForFrame(page, { engine: 'psf', lens, compareLens: split ? 'vivity' : null, viewingDistanceM: distance });
}

async function drive(page, values, interval = 0) {
  return page.evaluate(({ slider, values, interval }) => new Promise((resolve, reject) => {
    const input = document.querySelector(slider);
    const canvas = document.querySelector('canvas[data-profile]');
    const frames = [], sent = [];
    const observer = new MutationObserver(() => {
      const at = performance.now();
      const p = JSON.parse(canvas.dataset.profile);
      const demand = sent.findLast(entry => entry.value === p.objectVergenceD && entry.at <= (p.submittedAtMs ?? at));
      frames.push({ at, ms: demand ? at - demand.at : null, p });
      if (demand && demand === sent[values.length - 1]) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve({ frames, count: sent.length });
      }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Final distance was not presented: ' + values.at(-1)));
    }, 30000);
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-profile'] });
    values.forEach((value, index) => {
      const dispatch = () => {
        input.value = -value;
        sent.push({ value, at: performance.now() });
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      if (interval) setTimeout(dispatch, index * interval);
      else dispatch();
    });
  }), { slider, values, interval });
}

function distribution(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const percentile = q => +ordered[Math.ceil(ordered.length * q) - 1].toFixed(2);
  return { median: percentile(.5), p95: percentile(.95) };
}

const reports = [];
try {
  for (const [version, url] of [['before', baseline], ['after', candidate]]) {
    for (const scenario of [
      { name: '40 cm single', split: false, lens: 'zcb00', distance: .4, groups: [[2.4, 2.5, 2.6]] },
      { name: '40 cm split', split: true, lens: 'zcb00', distance: .4, groups: [[2.4, 2.5, 2.6]] },
      { name: '100 cm split', split: true, lens: 'zcb00', distance: 1, card: 420, groups: [[1.4, 1.5], [3, 3.1], [3.9, 4]] },
      { name: '20 cm single', split: false, lens: 'vivity', distance: .2, card: 270, groups: [[1.7, 1.8]] }
    ]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        await setup(page, url, scenario);
        const bounds = await page.locator('[data-scene-state]').boundingBox();
        if (scenario.distance === .4) {
          const visits = [];
          for (const value of [2.6, 2.7, 2.8, 2.9, 3, 3.1]) {
            await page.waitForTimeout(80);
            visits.push((await drive(page, [value])).frames.at(-1));
          }
          const result = { version, scenario: scenario.name, firstVisits: visits.map(({ p }) => p.path),
            inputToProfile: distribution(visits.map(visit => visit.ms)) };
          reports.push(result);
          console.error(JSON.stringify(result));
        }
        for (const group of scenario.groups) {
          for (const value of group) await drive(page, [value]);
          const samples = [], bursts = [];
          const warm = scenario.distance === .4;
          for (let i = 0; i < (warm ? 36 : 10); i++) samples.push(await drive(page, [group[i % group.length]]));
          if (warm) {
            for (let i = 0; i < 8; i++) {
              const values = Array.from({ length: 14 }, (_, j) => group[(i + j) % group.length]);
              bursts.push(await drive(page, values, 8));
            }
          }
          const frames = samples.flatMap(sample => sample.frames);
          const paths = frames.reduce((counts, { p }) => {
            const key = p.path ?? p.composition;
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
          }, {});
          if (warm && version === 'after') assert.equal((paths['warm-gpu'] ?? 0) + (paths['prefetched-gpu'] ?? 0), samples.length);
          const metric = key => distribution(frames.map(({ p }) => p[key]));
          const result = { version, scenario: scenario.name, group, scene: [bounds.width, bounds.height], paths,
            modes: [...new Set(frames.map(({ p }) => `${p.objectVergenceD} D ${p.composition} ${p.width}×${p.height}`))],
            inputToProfile: distribution(samples.map(sample => sample.frames.at(-1).ms)),
            queue: metric('queueMs'), assetsReady: metric('assetsReadyMs'), paintWait: metric('paintWaitMs'), opticalLoad: metric('opticalLoadMs'),
            worker: metric('workerRoundTripMs'), drawSubmit: metric('drawSubmitMs'),
            packedOpticalBytes: Math.max(...frames.map(({ p }) => (p.gpuAssets?.opticalBytes ?? 0) + (p.workerAssets?.opticalPackedBytes ?? 0))),
            ...(bursts.length && { burst: {
              lastInputToProfile: distribution(bursts.map(run => run.frames.at(-1).ms)),
              frames: bursts.reduce((n, run) => n + run.frames.length, 0),
              inputs: bursts.reduce((n, run) => n + run.count, 0),
              frameGaps: distribution(bursts.flatMap(run => run.frames.slice(1).map((frame, index) => frame.at - run.frames[index].at)))
            } })
          };
          reports.push(result);
          console.error(JSON.stringify(result));
        }
      } finally {
        await context.close();
      }
    }
  }
  console.log(JSON.stringify({ browser: browser.version(), reports }, null, 2));
} finally {
  await browser.close();
}
