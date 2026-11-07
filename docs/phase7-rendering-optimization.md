# Phase 7 — Rendering Performance Optimization

2026-11-07；比較基準 `8968c2f`。實作範圍為排程、Worker 資產生命週期與 packed optical cache；未更動眼模型、96 個 PSF、62 個 optical PNG、angular sampling policy、Gaussian 曲線或 display shader，未加入 GPU composition。

## 實作

- **最新輸入排程**：移除 IOL 額外固定 16 ms timer，Svelte 完成同批 store 更新後以 microtask 啟動工作。render key 包含 engine、有效 lens/split、物距、校正、觀看距離、viewport/DPR 與 background revision；Physics 不因無關 Gaussian sigma 更新重算。同一 key 不重排程。仍只有一個進行中的 scene 與一個最新 dirty 狀態，兩眼保持同一版本後才顯示。
- **取消過時合成**：版本更新立即通知 Worker；precomputed CPU integration 每 8 rows 檢查時間，約每 6 ms budget 透過 MessageChannel yield，讀取新版本後停止過時工作，不回傳／顯示該 RGBA。冷背景 FFT 完成後也先讓新輸入更新，再決定是否做 near work。同步 FFT 本體仍無法中途取消；不使用反覆 terminate 來丟掉熱背景。
- **Worker 資產註冊**：新增 `worker-client.ts` / `worker-runtime.ts` 與 byte LRU。optical identity 是 file + authenticated decoded hash；PSF identity 是 energy hash + dimensions。每個 residency 只註冊一次，frame 傳 ID 與物理參數。大 optical buffer 用 transfer 移交唯一所有權；主端 pending entry 完成後移除，只保留小 metadata／Worker residency snapshot。PSF 主端既有共享 cache 仍有效，首次註冊 clone 一次，之後不逐幀 clone。背景 source 與輸出 RGBA 原已使用 transfer，延續此設計。
- **直接使用 packed samples**：Worker 保留 opaque RGBA8 的 f12/a12 bytes，每 cell 4 bytes，不配置兩張 Float32 planes。4096 項 Float32 LUT 的值與原 `f12/4095 → Float32` 完全相同；之後維持原 Float64 overlap/row accumulation、linear-light premultiplied composition 與 sRGB rounding。aligned little-endian 平台每 cell 用一個 Uint32 view 讀取；其他 byte order／alignment 走 byte 路徑，沒有改寫已驗證 bytes。
- **預算與失效**：Worker optical LRU **14 MiB**，足以保留最大相鄰 3.9/4 D packed pair **12.606 MiB**，比舊 16 MiB 展開 cache 留更多上限空間。Worker PSF cache 最多六個 513² Float32（約 6.02 MiB）；背景維持兩個、hit 更新 LRU。渲染中的資產 pin 到結束，避免 yield 時被淘汰。背景替換只移交新 source／清背景，不清 optical/PSF；Worker error/timeout/reset 則清 registry、拒絕 pending，下一次 render 重新取得資產。離開 IOL 場景會 abort loader、terminate Worker、清 cache。

未增加啟動預載：仍閒置 150 ms 後最多兩鄰居；保留原先的 <=4 MiB expanded envelope，現在相當於 <=2 MiB packed，並遵守 save-data／慢網路／低記憶體提示。大高密度鄰居不猜測預載；首次大跳躍仍需等待下載。main pending-load reservations 也有 14 MiB 上限；PNG image、canvas、hash 暫存另計，這不是整頁 RAM 總上限。

## 修改前後比較

同一 Windows / Chrome 156.0.8078.80 headless、Intel/ANGLE D3D11，無 CPU/network throttle；390×844 CSS viewport、390×621 sample grid、DPR 1。封存基準 production build 與修改後 build 依序測量，使用相同本機 HTTP server／輸入事件與 profiling wrappers。標準：170/25.4 CSS px/mm、觀看 40 cm；高密度：Card Match 420 px（7.780660 CSS px/mm）、觀看 100 cm，8192 level。

時間從 dispatch input 至正確新版本的 `data-profile` 發布，接近 input-to-submit，**不含 OS 觸控等待、實體 GPU completion／compositor／scanout，不是手機 FPS**。

| workload | 次數 | 修改前 median / p95 | 修改後 median / p95 | median 改善 |
| --- | ---: | ---: | ---: | ---: |
| 暖 2.4/2.5/2.6 D 循環 | 30 | 27.7 / 30.3 ms | 9.9 / 13.5 ms | 64% |
| 高密度 3.9 ↔ 4.0 D（兩節點初次已各讀過） | 30 | 80.1 / 92.2 ms | 29.0 / 32.2 ms | 64% |
| 5 次 / 20 ms burst，最後 input → 正確畫面 | 10 bursts | 27.4 / 29.3 ms | 10.9 / 20.0 ms | 60% |
| 高密度 5 次 / 5 ms burst，最後 input → 正確畫面 | 10 bursts | 88.4 / 96.7 ms | 34.7 / 37.4 ms | 61% |

暖 frame `queueMs` 中位 16.6 → 0.1 ms。另測十次 input→物距 DOM 讀值：前後中位約 0.1 / 0.3 ms，最大 0.3 / 1.0 ms；兩者 UI 都立即回應，主要改善是影像更新。十個 burst 的 p95 接近最慢樣本，不能視為大量使用者尾延遲分布。

Worker postMessage instrumentation 確認標準 2.5 D 每次原本 clone **2,690,100 bytes**，高密度 4 D **14,540,964 bytes**（含 optical arrays、infinity PSF）；現在已註冊的 precomputed frame 大型 typed-array payload 為 **0 bytes**，只傳 metadata/IDs。dynamic card 仍有自己的 raster array，不能把它也稱為零資料傳輸。

高密度比較原版重訪同節點仍反覆 readback/hash；新版暖 30 次往返與接續 burst **沒有 optical PNG canvas readback**，Worker 兩張 packed layers 共 13,218,096 bytes，主端完成載入後 packed reservation=0。原本的 HTTP cache 不足以避免 PNG 解碼，這次才保留可直接重用的已驗證 pixels。

CPU optical composite 本體未宣稱全面變快：標準中位約 7.2 → 8.5 ms、高密度約 20.9 → 27.7 ms，包含 packed extraction／cooperative yield 的代價。改善來自移除排程、大型拷貝、反覆 decode/unpack 與過時工作，而非改動光學品質或 sRGB transfer function。混合 Vivity 比較仍受該眼 near FFT 限制；一次 smoke observation 約 66.9 ms，其中 Vivity near FFT 31.9 ms，沒有宣稱 mixed 固定加速比例。

### 記憶體：總量並非單純減半

另以乾淨 browser context、相同高密度往返十次，分別 attach 主執行緒與實際 Worker 的 DevTools Runtime，強制 GC 後取得 `backingStorageSize`（MiB）：

| backing storage 範圍 | 修改前 | 修改後 |
| --- | ---: | ---: |
| 主執行緒 | 13.561 | 1.216 |
| Worker | 13.399 | 26.104 |
| 兩者合計 | **26.960** | **27.320** |

主端下降不代表整頁同幅下降：Worker 現在常駐兩個高密度節點及一份 infinity PSF，而舊版 GC 後 Worker 不留 optical clone、主端只能保留一個高密度展開節點。此 workload 合計增加約 **0.36 MiB（1.3%）**，換得兩節點常駐、零逐幀大 clone／反覆 decode；這是有界的 cache tradeoff。上述是 V8 backing storage，**不是 browser process RSS、GPU/DOM/native PNG buffers 或峰值總 RAM**。載入暫存、FFT scratch 與 driver allocations 仍存在，未宣稱整體手機 peak RAM 已量得下降。

一般 `performance.memory` 不含完整 Worker 範圍且受 GC 影響，因此沒有用單一主端 heap 數字宣稱總 RAM 改善。14 MiB optical、6.02 MiB Worker PSF 與兩個背景的上限可由既有 profile 的 `workerAssets`／`opticalLoads` 檢查，沒有新增產品內 Debug Mode。

## 驗證

- **40/40 Node tests**；新測試涵蓋全部 62 levels、低密度／裁切／奇偶 anchor 的 packed 與 Float32 結果逐 byte 相同；byte LRU、active pin、真正 structuredClone/transfer detach、register-once、來源替換、Worker restart、stale version 與 cooperative cancellation。既有 96 PSF hash／非負能量／normalization、物理尺度／zoom、padding、Python fixtures 均通過。
- **Svelte check 0 errors / 0 warnings**，production build 成功。環境仍有既有 Browserslist 過舊、Vite config override 與 Svelte `untrack` 匯出 build warnings，沒有更新依賴來掩蓋它們。
- **實際瀏覽器 `/validation` PASS**：原三模型 Worker/WebGL native 最大誤差 0，linear upscale <=1 byte；Aspheric 1/2.5/4 D 最大誤差 <=1 byte。Aspheric fixtures 現在經過新的 `PhysicsWorkerClient`、packed transfer/registration 與 Worker ID renderer，而非只驗證舊直接 input 路徑。每 fixture 建新 Worker，因此該頁 Worker ms 包含冷背景 FFT，不能拿來當暖互動 benchmark。黑白 midpoint=188；原背景 PNG 每個 RGB sample 驗證通過。
- **實際 canvas RGB(A) 比較**：QA 專用 preserveDrawingBuffer 下，基準與新版 Gaussian 以及標準 Physics 1/2.5/4 D，全部 channel 最大差 0；高密度 4 D readback 也相同。產品沒有啟用 preserveDrawingBuffer，也沒有逐幀 readPixels。
- **互動／恢復**：相同 input/viewport 重複事件不重發 frame；31 個高密度節點均走 precomputed、near FFT=0、cache 不超預算。Gaussian↔Physics、Aspheric/Vivity mixed split、相同 lens split、Spherical dynamic、校正／觀看距離、背景失敗→retry 保留 registered assets、Worker error→重建、optical PNG 失敗→dynamic→恢復，均完成瀏覽器測試，無 page errors。Presbyopia/Cataract controls、comparison 與返回 IOL 另作 smoke test；原 renderer/數據未修改。

實體 iPhone/Android 尚待此次 Pages 發布後驗收；這些桌機數字不構成手機速度承諾。冷背景 FFT、未快取網路、其他 lens 動態卷積仍可能延遲；CPU composition／encoding 也仍存在。若手機暖狀態仍慢，下一階段可依 Phase 6 建議測 WebGL2 composition，無須先改光學資產。

## 重現與發布

標準命令：`npm run test:optics`、`npm run check`、`npm run build:gh-pages`，再開 `/validation`。CI 已使用 Node 24／npm 執行相同 gates。本機 shell 未提供 npm executable，使用已安裝的 Node 直接執行 test runner、svelte-check 與 Vite，未安裝／更換依賴。

本機原始紀錄及 QA scripts 保留於忽略的 `optics/outputs/phase7-*`：`before.json`、`after-final.json`、`memory.json`、`functional.json`、`visual.json`、`ui.json`、tests/check/build logs，以及封存 baseline build。latency script 的 warm/high 各 30 次，排除各節點首次載入；高密度原版即使如此仍會 decoded-cache miss，已分開記錄。memory script 在 timing workload 之外 GC；數值 readback 也與 latency 分開，避免同步 GPU readback 改變公平比較。

發布整理為一次階段 commit，push 至 `raywentsai/IOLsimulator_mobile_optrace` 的 main，使用既有 GitHub Actions build/deploy workflow；部署狀態與公開站點的最終 smoke/validation 在 chat 回報。線上驗收：[Simulator](https://raywentsai.github.io/IOLsimulator_mobile_optrace/)、[Numerical validation](https://raywentsai.github.io/IOLsimulator_mobile_optrace/validation)。
