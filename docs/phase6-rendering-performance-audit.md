# Phase 6 — Rendering Performance Audit & GPU Feasibility

日期：2026-11-07。審查基準：`4a0f221`，工作樹開始時乾淨。本階段只新增分析文件；沒有修改 renderer、光學資料、UI、依賴，也沒有新增 Performance Debug Mode。

## 結論與決策

**值得做有明確驗收門檻的 WebGL2 composition PoC；先處理影像所有權／快取與最新輸入排程，再以同一批測例比較 CPU 與 GPU。** 暖快取的剩餘成本確實在 CPU 合成、重複 Worker cloning 和排程；高密度另有可重現的 decoded-cache thrashing。只換 `texImage2D` 或重用小型 scratch buffer，無法解決主要延遲。

這是程式審查、目前 production build 的桌機瀏覽器量測與 CPU profiling 所支持的結論，**不是 iPhone 11 的已測瓶頸或速度保證**。實體手機的 GPU 執行、compositor、scanout、觸控事件等待仍須下一階段實測。PoC 不需要改 ray tracing、PSF、預計算影像或採用 WebGPU；也不會消除冷背景 FFT、未快取下載或其他 IOL 的動態 FFT。

## 1. 基準、工具與證據範圍

已讀本機 `README.md`、`AGENTS.md`、近期 Git history，以及下列實作：

- `src/routes/+page.svelte` 的 slider/store 更新；`src/components/IolScene.svelte` 的 schedule/flush、載入、Worker、split 與 present。
- `src/lib/render/psf/{optical-images,optical-image-math,worker,scene,library,geometry,display}.ts`。
- `src/lib/render/{asset-loading,scene-assets}.ts`、既有 Gaussian WebGL context 與資源生命週期。
- `optics/export_optical_images.py`、現有 PNG/PSF manifests、`tests/benchmark-psf.mjs`、光學測試與 `/validation`。
- [Phase 5 格式、數值與量測](precomputed-optical-images.md)、[初始載入修正](initial-loading-reliability.md)；README 與舊 raw results 作歷史證據，沒有當作目前版本的重新量測。

歷史脈絡：

| Commit | 已解決的成本／保留的限制 |
| --- | --- |
| `01e764e` | 完整 2D PSF FFT 在 Worker；bounded mobile sampling、背景快取與過時畫面丟棄 |
| `696da78` | 前景只算完整必要 support／可見 source；背景 encoded bytes 重用；明確 linear-light display，移除 slider 額外 rAF queue |
| `31df9ff` / `f597d9f` | 取消過時 PSF 下載、受限預載；保留原始 PNG/native image 路徑 |
| `1d84ad4` | Aspheric 31 nodes × 兩密度預卷積，消除 near FFT；保留 CPU angular integration/composition |
| `4a0f221` | 字卡與背景獨立載入、PNG streaming/限時/重試、錯誤恢復；未移除逐幀 optical arrays cloning |

本次使用現有 `canvas[data-profile]`、Resource Timing、PerformanceObserver long tasks、DevTools Protocol CPU throttle、Node Inspector CPU sampling；另在**忽略的本機腳本**包裝 Worker.postMessage、Canvas readback 和 SHA-256 計時。沒有加入產品內 instrumentation。Node 的分段診斷副本只插入計時，逐個輸出 SHA-256 與原函式相同。

環境：Windows、Node v24.22.1、Chrome 156.0.8078.80 headless、實際 Intel Graphics / ANGLE D3D11（不是 SwiftShader），390×844 CSS viewport、scene/sample grid 390×621、DPR=1。標準設定 170/25.4 = 6.692913 CSS px/mm、觀看 0.4 m；高密度設定 Card Match 420 px，即 7.780660 CSS px/mm、觀看 1 m。viewport／桌機 CPU throttle **不等於手機硬體**。本次 4× page throttle 下 Worker 本體沒有同比變慢，不能把它稱為全 pipeline 的 4× 手機模擬。

原始本機證據均留在已忽略的 `optics/outputs/`：`phase6-browser.{mjs,json}`、`phase6-fallback.json`、`phase6-extra.{mjs,json}`、`phase6-cpu.{mjs,json}`、`phase6.cpuprofile`、計時副本 `phase6-instrumented.ts`。以下表格保存主要結果，使報告不依賴這些未追蹤檔案。

## 2. 目前 pipeline：各種 cache hit 的意義不同

```text
input → store 立即更新 → schedule：version++、dirty、取消過時下載
  → 閒置時 16 ms timer／忙碌時等既有 flush 結束
  → PSF manifest、sampling、選 optical level
  → optical cache：miss 才 download → PNG decode → canvas readback
      → SHA-256 → unpack 為兩個 Float32Array；hit 直接取同一 Promise
  → infinity PSF（mixed/dynamic 另取 near PSF 與 raster card）
  → postMessage(input) structured clone
  → Worker：背景 cache miss 才 cover sample + infinity FFT
  → precomputed：面積積分 f/a + linear composite + sRGB RGBA bytes
       或 dynamic：near PSF resample + FFT + composite/encode
  → RGBA buffer transferable 回主執行緒
  → split 時 CPU 複製右半部 → texImage2D 整張 RGBA
  → WebGL1 shader：sRGB decode → linear bilinear display → sRGB encode
  → GPU completion → browser compositor → 實體螢幕（現有 profile 未量到）
```

### 2.1 Precomputed、暖 cache 與 dynamic fallback

`loadOpticalImage` 只接受 Aspheric、符合原 PSF hash、128–8192 pixels/tan(theta) 的 X/Y 密度，選實際 source density 足夠的最低 level。其餘模型、超出密度範圍／無合適 level、載入／hash／解碼失敗會走原 dynamic renderer。模型、瞳孔與角膜仍是既有固定資料；不存在可任意套用其他眼模型的快取。

`asphericRendering='precomputed'` 表示取得 layer，**不表示 optical cache hit**。`optical-images.ts` 沒有匯出 optical hit/miss 與各 decode 階段時間；現有 `psfDownloads` 僅描述 PSF。`library.ts` 的 `cacheHit=1` 也可能命中尚未完成的共享 Promise。甚至 Gaussian profile 也可能寫出 `asphericRendering='dynamic'`；判讀必須同時確認已選 Physics、存在該 lens 的 Worker metrics，不能只看這個欄位。

標準暖測試中只有一個 infinity PSF 常駐，`nearLoad={}`、`nearConvolveMs=0`，沒有背景重卷積。Resource Timing／canvas hooks 確認 2.4/2.5/2.6 D 各第一次解碼後，往返不再 PNG decode；因此下表暖更新不是下載或 FFT 卡住。

強制阻斷 optical PNG 的獨立頁面則確認 dynamic fallback：初次 near FFT 39.4 ms、背景 FFT 286.2 ms；下一個 2.6 D 的背景已重用，near FFT 32.0 ms，Worker 合計 48.7 ms。此頁沿用 Card Match 420 px、觀看 40 cm。失敗路徑另含有意設計的重試等待，下一次 input→submit 353.8 ms 不能全歸因於 FFT。不要在連線失敗時為追求低延遲無條件反覆嘗試壞掉的 asset；可評估短期失敗狀態快取並保留明確 retry。

### 2.2 Optical loading、decoding、caching

下載有 HTTP body streaming、bytes/signature 檢查、限時／一次重試；PNG Blob URL/native Image 解碼後畫到 2D canvas，`getImageData` 取得 opaque RGBA，SHA-256 驗證 decoded bytes，再在**主執行緒**同步 unpack。Numeric PNG 沒有 sRGB 編碼；alpha=255 防止資料位元被 premultiply 改壞。瀏覽器 loader 未另外驗證 encoded-file hash，但 decoded hash 已驗證實際數值。

- 瀏覽器 HTTP cache 命中，仍可能重做 PNG decode、canvas readback、hash 和 unpack；這不同於 decoded optical cache 命中。
- optical LRU 為 `8 × width × height` bytes，最多 16 MiB，計入 pending reservation；不包括 Worker 副本、PNG/canvas/RGBA 暫存、crypto 內部拷貝或 GPU。
- 完成 frame 後閒置 150 ms 才預載 ±0.1 D；每張 >4 MiB 不預載。save-data、慢網路、已回報 deviceMemory<4 GB 時跳過。Safari 沒提供這些提示時不能推論裝置很寬裕。
- cancel 會移除並 abort 過時 pending fetch/image；已執行的同步 readback/unpack、已開始的 hash 不會因此回溯取消。完成 hash 後也沒有額外 stale 檢查才 unpack。
- infinity／其他 lens 的提前 load、正式 Promise.all、makeSide 再取 PSF，共享 cache Promise，並非三次網路下載。

### 2.3 Worker cloning 與 CPU 合成

`IolScene.compute()` 的 `postMessage({id,input,backgroundKey})` **沒有 transfer list**。每一 frame 都 clone optical foreground、alpha 與 513² infinity Float32 PSF，即使 Worker 已有同一背景。原背景 1024×1536 RGBA 在 Worker 初始化時才 transfer 一次；輸出 RGBA 也已 transfer 回來，這兩端不需要再「優化成 transferable」。

| Aspheric case | optical Float32 bytes | 每次 input clone，另含 infinity | 回傳 RGBA |
| --- | ---: | ---: | ---: |
| 2.5 D，4096 level | 1,637,424（1.562 MiB） | 2,690,100（2.565 MiB） | 968,760（0.924 MiB） |
| 4 D，4096 level | 3,372,072（3.216 MiB） | 4,424,748（4.220 MiB） | 同上 |
| 4 D，8192 level | 13,488,288（12.863 MiB） | 14,540,964（13.867 MiB） | 同上 |

這些是實際 typed-array payload，不是估計的壓縮 PNG 大小；metadata 額外少量。若每秒送 30 次，標準 2.5 D 就有約 77 MiB/s 的 input clone，高密度 4 D 約 416 MiB/s；這是流量成本模型，不是目前可持續 FPS。

`workerRoundTripMs - workerMs` 包含主執行緒 serialization、Worker deserialize／排程、回訊息與主執行緒喚醒，不能命名為純 transfer 時間。本次直接包裝同步 postMessage 得到：標準 20 ms burst 每次約 1.5–2.5 ms；高密度大 layer 約 6.4–8.4 ms。回傳 transfer 不代表整段往返為零成本。

`renderOpticalImage()` 每次重新建立 wx/wy、小型 row buffers 與整張 RGBA：

1. 以 source cell 和 output pixel 的 overlap，分別算 X/Y weights。
2. 對每個目標 y，把相關 source rows 的**完整 source width**累加進 Float64 rowF/rowA，再在可見 x 範圍做水平加權。
3. 用 `f + (1-a) * background[c][i]` 合成；每個 RGB channel 呼叫 `linearToSrgb`，包含冪次運算，round 成 byte。
4. 前景 support 外直接複製已快取的背景 encoded bytes。沒有重新編碼整張背景；第一次建立 encoded background 的時間則包含在 composite metric。

因此「CPU resampling」不是唯一剩餘成本，RGB 合成／sRGB encoding 尤其值得關注。

### 2.4 GPU upload、呈現與 profile 邊界

`PsfDisplay.present()` 現在是 WebGL1，逐幀 `texImage2D` 上傳完整 390×621 RGBA，並重設 texture params、查詢 uniforms/attribute。shader 在 device-resolution buffer 中解碼四鄰點，在 linear light 插值再編碼；沒有 GPU optical composition。

`uploadMs`、`drawSubmitMs` 都是 JS API wall time。它們短不代表 GPU 執行／呈現已完成。桌機在提交後另行 `gl.finish()` 的一次 queue drain 是 0 ms，也不能代表手機 scanout；此檢查沒有放進產品 hot path。現有 `inputToSubmitMs` 起於 `schedule()`，沒有包含 OS 觸控到 JS 事件的等待，終點也沒有包含 GPU completion/compositor/scanout。測試腳本另外從 dispatch input 到 profile mutation 計時，仍不是 photon latency。

## 3. 本次量測結果與瓶頸排序

### 3.1 標準暖 cache

固定標準條件，輸入序列 -2.6/-2.5/-2.6/-2.5/-2.4/-2.5/-2.6/-2.5/-2.4 D；排除前兩筆 initial/JIT/未解碼節點後，取後七筆中位數。所有筆均 precomputed、near FFT=0、背景不重算。各欄獨立中位數，不應相加當成單一 frame。

| metric | 正常 CPU | page 4× throttle |
| --- | ---: | ---: |
| input→submit | 29.4 ms | 43.4 ms |
| queueMs | 16.6 ms | 22.4 ms |
| opticalImageCompositeMs | 7.8 ms | 7.1 ms |
| Worker round trip | 11.6 ms | 17.8 ms |
| uploadMs | 0.2 ms | 0.3 ms |
| drawSubmitMs | 0.1 ms | 0.2 ms |

本次 Worker 未同比 throttle，表中不能推算 iPhone 的絕對時間。也不能與歷史 IAB 的 Phase 5「111 ms」直接作版本改善比較：本階段未改程式，瀏覽器／排程環境不同。

初次 Physics：input→submit 408.3 ms，其中背景 FFT 281.6 ms、background sample 8.0 ms、PSF scale 6.0 ms、首次 optical composite（含背景 encode／JIT）29.1 ms。觀看距離／校正／grid／model 改變會失效背景；此次切到高密度時背景 FFT 613.9 ms，input→submit 878.8 ms。**冷載入與物距暖滑動是不同瓶頸。**

Node 原函式補充測試：同一真實 optical PNG、預先 encoded 的 synthetic linear RGB 背景，每組 12 次，排除前 3 次取中位數。診斷副本與原函式輸出 hash 完全相同：

| demand / level / target density | 原函式 | 分段：vertical rows | 分段：horizontal weights + RGB composition/encoding | Node structuredClone |
| --- | ---: | ---: | ---: | ---: |
| 1 D / 4096 / 2677 | 2.33 ms | 0.16 ms | 1.94 ms | 1.08 ms |
| 2.5 D / 4096 / 2677 | 7.44 ms | 0.49 ms | 6.97 ms | 2.14 ms |
| 4 D / 4096 / 2677 | 13.66 ms | 1.05 ms | 12.54 ms | 4.70 ms |
| 1 D / 8192 / 7781 | 12.39 ms | 0.65 ms | 11.75 ms | 2.47 ms |
| 2.5 D / 8192 / 7781 | 22.96 ms | 2.13 ms | 20.50 ms | 6.19 ms |
| 4 D / 8192 / 7781 | 23.24 ms | 2.97 ms | 19.77 ms | 10.93 ms |

分段版本有計時開銷，與原函式時間不要求精確相加；synthetic background 不當作完整 browser scene benchmark。權重配置約 0.03–0.09 ms、RGBA 複製約 0.08–0.25 ms。Inspector 僅在暖 render 工作負載啟用，983 個 samples 中 `renderOpticalImage` 516、`linearToSrgb` 427、GC 36：sRGB transfer 約佔 43.4% samples，兩個主要函式合計約 96%。這支持 GPU composition／encoding 的方向，但不能說單是面積權重建立就佔大多數。

### 3.2 高密度：decoded cache thrashing 是獨立問題

1 m / 420 px Card Match 下仍採 390×621 grid，選 8192 level。4.0 D Float32 layer 12.863 MiB，3.9 D 約 12.348 MiB，合計約 25.212 MiB >16 MiB；而兩張各 >4 MiB，鄰居預載跳過。

實際 -4/-3.9/-4/-3.9/-4 D：input→submit 分別 122.4/84.6/84.5/75.7/86.9 ms；第一筆 composite 55.0 ms，後四筆 19.0–21.2 ms。hooks 記錄同尺寸 1446×1166、1416×1143 反覆 drawImage/readback/hash：readback 約 11.8–14.0 ms、hash 3.7–4.3 ms，外加 draw/unpack／解碼成本。**第二次到同一 D 也不是 decoded cache hit**；即使 HTTP cache 很快，仍反覆付解碼／數值展開成本。不要只把這一組稱為「暖網路等於暖 rendering」。

### 3.3 快速滑動與 split

單一 `busy` + `dirty` 會合併等待中的狀態，過時結果不送去顯示；沒有無限 Worker 訊息佇列。下載可取消，**同步 Worker 計算不可被版本更新中斷**。`finally` 才處理最新 dirty state，所以使用者仍會等待舊工作剩餘時間；持續滑動也可能一直看到上一張已完成影像。

- 標準 5 次 / 20 ms burst 最後 2.4 D 正確，最後 input→完成 profile 約 11.0 ms；page 4× 為 25.6 ms，這是各一次壓力觀察，非 p95 或手機承諾。
- 高密度 5 次 / 5 ms burst，前四個狀態有合併，但仍完成一個已過時的 4 D Worker request，再送最新 3.9 D。最後 input→profile 89.4 ms，最新 frame `queueMs=23.9`、Worker round trip 33.5 ms，另含新 layer 重新 decode。它證明過時運算與快取抖動可疊加。
- mixed Aspheric/Vivity：`makeSide` 依序 await，兩邊皆完成才呈現。冷比較約 450.4 ms；下一個 2.6 D 約 98.9 ms，其中 Aspheric Worker 22.3 ms、Vivity Worker 39.5 ms（near FFT 31.2 ms）、split copy 0.1 ms。PSF load 仍可能包括首次資料準備，這不是完全暖 cache 的統計。GPU 化 Aspheric 也不能讓 Vivity FFT 消失。
- 相同 lens split 已重用 left result，沒有再算一遍；不同 lens 目前都算整張再捨棄各半邊。網路早已並行，共用一個 Worker 是控制 FFT 記憶體峰值的既有設計；不建議直接開第二個完整 FFT Worker。
- schedule 沒有完整 render-key 去重。resize/viewport、衍生 blur stores 等重複通知仍可能使同物理設定重算；這是程式上的機會，尚未量出它是主要耗時。不要把正常的狀態合併誤報為已證實的大量重複 frame。

依目前證據，排序為：**冷狀態的背景 FFT／未快取資源等待；暖狀態的 16 ms 排程＋CPU 合成/encoding＋input cloning；高密度的 cache thrashing／main-thread decode；mixed 的另一眼動態 FFT**。GPU upload submission、split copy、小型權重／row buffer 配置居後；實體手機的 GPU／compositor 是否另有瓶頸尚未證實。

## 4. Task B：CPU／記憶體可行項目

| 項目 | 預期收益與成本 | 風險／優先度 |
| --- | --- | --- |
| Worker 資產 register-once，frame 只送 key 與參數 | 移除重複 1.004 MiB infinity 與 1.56–12.86 MiB optical cloning；不改光學運算 | **高**。建立明確 register/release/reset/ack；單純 transfer 現有 cache arrays 會 detach Promise 裡的資料，不能直接加 transfer list |
| 保留驗證過的 packed RGBA／12-bit 整數，按需 unpack 一個 active layer | 每 cell 4 bytes 取代 8 bytes；3.9/4 D packed 合計約 12.606 MiB，可同時放進 16 MiB packed budget，避免重做 canvas/hash | **高**。CPU 仍需 active Float32，須把 packed＋active＋Worker 總量一起記帳，不能宣稱總 RAM 立刻減半；按原 f12/4095 寫 Float32 可維持基準 |
| single owner：搬一次而非 main/Worker 各留完整 cache | 降低雙份長駐及 allocation/GC；GPU 也可沿用 verified packed asset contract | **高**，中等修改範圍。Worker restart／background replacement 後要可重新取得資產，含取消、generation 與 asset hash |
| 完整 render key 去重，最新輸入優先；評估減少固定 16 ms timer | 桌機暖 frame 約 16.6 ms 明確排程成本；預計降低一次固定等待和不必要 request | **高**。不能逐 input 無限制計算；一個可執行工作＋一個最新狀態。用一次 rAF 或短 task 的選擇要以手機 latency/paint 實測，避免重建兩層排隊；忙碌期間只換最新參數 |
| Worker 逐區塊 yield 後丟棄 obsolete 工作 | 降低 release 後等待舊 frame 的尾延遲 | **中**。事件只能在 yield 才被讀取；逐 row await 可能破壞 throughput。先縮短工作與移除大 payload，再決定是否值得；不用每次 terminate 丟掉熱背景 |
| CPU sRGB encoding LUT／批次化 | profiler 顯示值得評估，收益可能大於 row-buffer 重用 | **中**。LUT 是近似，必須量 transfer-function 誤差和 rounding 邊界，不能默默放寬既有 1-byte gate。單純重用光學場仍不會移除每 frame encoding |
| wx/wy、row buffers、RGBA pool | 配置／GC 減少；權重／copy 本體僅約亞毫秒，主要是尾延遲候選 | **低～中**。weights key 包含 layer、尺寸、scale、整數 anchor；RGBA 已 transfer，若要重用須雙 buffer／歸還所有權，避免 detached/write-after-present |
| pre-resampled f/a cache（只固定 display geometry） | 重訪 D 可略過 area integration；兩個 target Float32 plane 每 node 約 1.848 MiB | **中偏低**。31 nodes 約 57.3 MiB；只留 2–3 個也增加記憶體，仍有 composite/encode。觀看距離、校正、尺寸、anchor 都要失效；GPU 方向較直接 |
| background、source 與 GPU textures 重用 | 背景冷 FFT 已 cache，不能宣稱「新增背景快取」收益；去除逐幀 infinity PSF 傳輸、未變背景只上傳一次才是新增收益 | **高**（傳輸），**低**（單純加 cache）。保留完整 linear background，不以 encoded bytes 當 linear 值合成 |
| `texSubImage2D`、uniform/attribute location 與 texture params 重用 | 減少 API／重配置，現測 upload/draw 僅數個 0.1 ms | **低**，小修改。不能因此宣稱消除主要延遲；需確認 dimensions/format 一致 |

記憶體至少分開記帳：main decoded assets、Worker source/active/cache/FFT scratch、transfer buffers、DOM image/canvas/crypto 暫存、GPU textures/FBO/device buffer。390×621 的一個 linear RGB Float32 背景＋encoded RGBA 約 3.696 MiB；Worker 最多兩個背景約 7.391 MiB，且目前是插入順序淘汰，沒有在 hit 時更新 LRU。原背景 RGBA 約 6 MiB，PSF cache 最多 15×513² Float32 ≈15.06 MiB。極端 FFT 的兩個 complex Float64 arrays 合計可到 64 MiB，GC／其他暫存另計。這些都不在 optical 的 16 MiB 宣告內。

不優先：整包預載 31×兩密度、SharedArrayBuffer／跨來源隔離、第二 FFT Worker、OffscreenCanvas 作為必要條件。光是所有 8192 optical Float32 就約 206.2 MiB，packed 也約 103.1 MiB，不能為 cache hit 全留手機 RAM。延續 lazy loading 與受限鄰居預載。

## 5. Task C：WebGL2 composition PoC

### 5.1 可行的最小範圍

只加速 **Aspheric precomputed 路徑**：保留既有 Python 產物與 infinity 背景 FFT。冷背景完成後，把 Float32 linear RGB 背景 upload 一次；hash 驗證過的 packed numeric RGBA 上傳一次，之後 node cache hit 只 bind texture、更新 mapping uniforms、draw。CPU dynamic 與 Gaussian 保留為回復路徑。先驗證單眼，再處理 mixed split 的同一版本原子呈現。

建議 GPU graph：

1. **水平面積積分**：packed `RGBA8UI` + `usampler2D`/`texelFetch`，逐 cell 解 f12/a12，寫入 `RG32F` intermediate（只需可見 output X × 有關 source Y）。
2. **垂直面積積分＋linear composition**：對 intermediate 做精確 overlap，與同 sample grid 的 linear background 合成，明確 sRGB encode/byte rounding，寫 `RGBA8` sample-grid FBO。
3. **device display**：沿用現有四鄰點 sRGB decode → linear interpolation → encode 的公式，輸出 device-resolution canvas；不逐幀 readPixels。

X/Y 積分可分離是重取樣的性質，不是將原 PSF 假設成可分離。更換 CPU 的 Y→X 累加順序到 GPU X→Y 有浮點差異，必須驗證。

`RG32F` intermediate 需要 `EXT_color_buffer_float` 可 render；讀取 Float32 texture 與渲染進 Float32 target 是不同能力。背景可用 `RGBA32F` nearest/texelFetch，無須 float linear filtering extension。這些能力依 [WebGL2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/) 與 [EXT_color_buffer_float](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/) 定義，runtime 應檢查 format/FBO completeness。

可比較一個不需 float target 的單 pass：每 output sample 直接做 X×Y exact overlap、composition → RGBA8。相容性較簡單，但縮得很小時每 pixel 的 source taps 增加；source/target density ratio 可達數十，不能用四個 taps 取代。兩 pass 可能較省 bandwidth／算術，手機需實測。若 extension／性能不足，直接回既有 CPU；不把 WebGL2 可建立等同於所有進階格式可用。

### 5.2 Optical fidelity 必守條件

- **Packing**：`f=((R<<4)|(G>>4))/4095`，`a=(((G&15)<<8)|B)/4095`；numeric channels 不 sRGB decode。不能先對 packed RGB 做 hardware LINEAR，位元打包通道經插值後不再代表正確 f/a。使用驗證後的 typed-array upload，避免 DOM upload 的色彩轉換；明確設定 unpack、opaque alpha 與 Y orientation。
- **Coordinates**：正 object demand=`-UI defocus`，以既有 0.1 D node 選擇，不插值兩個不同物距。`px=distance_m×1000×calibrated_css_px_per_mm×actualScaleX`，Y 用實際 ScaleY；不能再乘 DPR 或 retinal projection L。光學 L 已用在離線建圖。用 manifest 真正 `pixelsPerTanTheta` 和 extents，不用名義 4096/8192 取代。
- **Footprint/placement**：保留 CPU `anchorX=round((W-cardWidth)/2)+cardWidth/2`、bottom anchor=H，output cell 的邊界是 `(i-anchor)/p` 到 `(i+1-anchor)/p`。保留完整 PSF tails 與原本 off-axis displacement，支援部分 cell、非整數縮放、裁切。source 外為零，不能以 CLAMP_TO_EDGE 將邊緣延伸。GL framebuffer 的 Y 翻轉要逐像素對照。
- **Radiometry**：f 已是 premultiplied scalar radiance，`C=f+(1-a)B`，不用再乘 alpha。先積分 f/a，再以 Float32 linear background 合成；sRGB 編碼只在合成後做。不能用預先編碼的 background 在 sRGB 裡 blend，也不能把 numeric PNG 當 `SRGB8_ALPHA8`。最終 display 為重建另有 decode/encode，是既有正確流程的一部分。
- **Precision/rounding**：highp shader；先 RG32F，不預設 RG16F 足夠。JS weights/row sum 是 Float64，source/background 是 Float32；GPU 累加為 float，不能宣稱 bit-identical。CPU 中間 RGBA byte 的量化順序也要保留，避免直接在 device grid 合成造成另一套結果。明確測試 clamp、round 與 dithering；premultiplied clamp `0≤f≤a≤1` 不可省略。
- **方法選擇**：一般 bilinear、mipmap、CSS resize 不能保證目前 arbitrary footprint 的 conservative cell integration。summed-area table 雖可減 taps，巨大累積值相減會有 cancellation/precision 風險，還多一套資產／前處理；不建議作第一版捷徑。

### 5.3 Texture cache、記憶體與相容性

GPU cache key 至少含 model、PSF/card identity、node、level、encoding/version、decoded hash；background key 含 source identity、model/infinity PSF、W/H、ppm、distance、actual X/Y scale。背景換成真實照片、Worker reset、context loss 要清楚失效。用 byte-budget LRU，保護目前與待呈現節點，upload 完成後才切換；不要保留整庫。固定大小 storage 可採 texStorage2D + texSubImage2D，切 D 命中只 bind；miss 仍要下載／驗證／upload，GPU 不會消除 miss latency。

估算同一 390×621 grid 的顯式 GPU allocations（不含 driver 對齊與額外 buffering）：

| 資源 | 約 MiB |
| --- | ---: |
| 4 D packed RGBA8UI texture | 6.432 |
| 3.9 D packed texture | 6.174 |
| linear background RGBA32F | 3.696 |
| 水平 RG32F intermediate，390×1166 | 3.469 |
| RGBA8 composition target，390×621 | 0.924 |
| device color buffer，DPR=2／3 | 3.696／8.315 |

兩大 optical textures + 上述工作資源 + DPR=2 color buffer 約 **24.4 MiB**；這不是整個 GPU process 記憶體。driver/瀏覽器可能多重緩衝，既有 Gaussian textures/FBO、CPU 資產和 decode 暫存仍會存在。若另留兩個背景或雙 intermediate 要再加；RGBA16F 可降低背景容量但須單獨驗證精度。不要把 reduced per-frame bandwidth 說成零 GPU memory 成本。

WebKit 已在 Safari 15/iOS 15 引入 WebGL2 與 Metal backend，因此以 iPhone 11、合適 iOS/Safari 版本為目標合理；這是功能可行性，仍須實機 shader/FBO/context-loss 驗證。[WebKit 官方說明](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)

目前桌機 capability probe：MAX_TEXTURE_SIZE=16384、fragment highp precision=23、float color target／timer extension 可用；最大 optical 尺寸僅 1446×1166。不能把桌機 limits 套到手機，必須 query、建立 FBO、確認 shader 編譯，再啟用路徑。

**現有 canvas 已由 Gaussian renderer 建立 WebGL1，不能直接對同一 canvas 取得 WebGL2。** 本次實測回 null；這也符合 [HTML canvas context mode 規則](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-getcontext)。`dispose()` 只刪資源不更換 context mode。PoC 建議用獨立 canvas／明確 engine renderer lifecycle，避免為了測 composition 先遷移整個 Gaussian renderer；要處理切換可見性、尺寸、事件與 context 數量。WebGL context 之間也不能直接共享 texture。mixed split 的 dynamic bytes 可上傳至 GPU 路徑的 texture，但兩眼應保持同一 request version；不能一邊新一邊舊來掩飾 latency。

現有 `PsfDisplay` 只在 lost 時 throw；PoC 必須測 context lost/restore、刪除 textures/FBO/program、tab background/foreground、旋轉、低記憶體與 reload recovery。不能同時留下大量隱藏 canvas 和 texture caches。

### 5.4 預期收益、限制與 PoC 驗收

命中 texture cache 後，可移除每 frame optical Float32 clone、CPU row/area integration、RGB encode loop、整張 RGBA 回傳／上傳；背景 texture 只在背景改變時更新。這正對應本次暖 frame 的約 8–23 ms CPU work 與 3–15 ms 等級往返額外成本；這些是可移除成本範圍，**不是淨加速保證**，必須扣掉 GPU passes、同步、cache miss/upload 與 browser presentation。固定 16 ms queue 若不處理，GPU 變快後仍會留下。

數值驗收分開三種參考，不能混在一起：

1. **同一 optical layer／target grid 的 GPU 對現有 CPU**：首先 1/2.5/4 D，再全部 31 nodes；涵蓋兩密度、128 與上限、level 切換、非整數 X/Y scale、奇偶 cardWidth/anchor、screen cropping、20/40/100 cm、270/420 px 校正、pinch zoom、native 與 DPR 2/3 顯示。沿用既有最大 1 sRGB byte gate，另記 linear f/a RMSE、coverage area/centroid、f≤a，失敗要追查，不能直接放寬容差。
2. **Python 與 dynamic canonical fixtures**：既有 `/validation` 繼續通過（本次重跑三模型 native 0、display upscale≤1；三個 Aspheric optical cases≤1；黑白 midpoint=188，背景 RGB decode PASS）。粗網格 dynamic 與 converged angular field 原本可能不同，不能拿跨格點差異當作 GPU bug，也不能掩蓋新的 GPU 誤差。
3. **高密度收斂與能量**：延續 Phase 5 的獨立 SciPy reference；GPU 對 CPU 一致不代表彼此都一定正確。RG16F、mipmap 或新積分算法若另提案，要重新做能量／centroid／影像驗證。

效能驗收以**實體 iPhone 11 Safari + 至少一台 Android**為主，桌機只做 regression：固定相同實體校正、觀看距離、sample grid、DPR、node 順序、背景狀態；分列 cold、HTTP warm/decoded miss、decoded/GPU hit、forced fallback、high-density alternating、mixed split、快速拖動及 release。每組至少 30 次，報 median/p95、最後 input→正確版本、長任務、cache miss/eviction、持續滑動的畫面更新間隔與記憶體估算；不要只報平均 FPS。

用現有 profile + Safari Web Inspector／Chrome Performance timeline 對齊 input、JS、Worker、render/presentation；有 extension 才非同步讀 GPU timer query，discard disjoint results，遵循 [Khronos timer query 規則](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)。不要逐幀 finish/readPixels 影響真實排程。rAF 或 frame trace 是呈現代理，實體 input-to-photon 需另用高速攝影／顯示量測；若沒量到就清楚命名 input-to-submit。

建議 go/no-go：數值門檻全過，實機暖 Aspheric 與高密度 release 的 median/p95 均改善（以相同條件 **至少約 30%** 為 PoC 投資門檻），cache 受控、無 context-loss／mixed regression，才整合成預設自動路徑。30% 是下一階段建議驗收值，不是已實現收益；若手機 GPU passes／記憶體成本抵銷收益，就保留 CPU 優化方案。

## 6. 建議實作順序與本階段完成檢查

1. **先建立可比較的實機基線**：重用現有 profile／DevTools，不加新 Debug Mode；確認用戶常用條件究竟是 decoded hit、cache thrash、fallback、cold background 或 mixed FFT。把結果名稱分清 submit／presentation。
2. **小範圍 CPU/data-flow 修改**：register-once asset IDs、單一所有權／總 byte budget、verified packed cache、完整 render-key 與最新輸入排程。先驗證 transferable 的 detach、restart/reset、cancel、hash identity。保留既有 optical math。
3. **限定 Aspheric 的 WebGL2 PoC**：獨立 canvas，packed texture cache、保守面積積分、linear background composition、同 sample grid 的最終 display；比較單／雙積分 pass。先不動 optics 產物、Gaussian、其他 lens FFT。
4. **依實機證據整合**：通過 fidelity/latency/memory gates 才決定啟用；接著做 mixed split 原子更新、context recovery。再考慮 RG16F、pool/LUT 等較小或需額外精度驗證的優化。

本次已完成程式／README／Git history 審查、production 瀏覽器 cold/warm/high-density/burst/mixed/fallback 檢查、CPU sampling／數值診斷與上述 B/C 評估。針對本次依賴的數值基準，13 個 optical-images/psf-math tests 通過；production build 成功，既有 Vite config、過舊 Browserslist、Svelte `untrack` 匯出 warnings 仍存在；未把成功 build 解讀為無 warnings。實際 `/validation` 通過。未實作 GPU renderer、未宣稱實體手機性能已驗證。

本機重現：使用既有 npm scripts `npm run build:gh-pages`、`npm run preview:gh-pages`，或改 preview port 後調整本機 probe URL；`node --test tests/optical-images.test.mjs tests/psf-math.test.mjs`，開 `/validation`。本次 shell 無 npm executable，直接呼叫已安裝的 `node node_modules/vite/bin/vite.js build` / `preview --base=/IOLsimulator_mobile_optrace/`（未重新安裝／更換依賴）。若保留本機 raw probes，可用 `node optics/outputs/phase6-browser.mjs`、`node optics/outputs/phase6-extra.mjs`、`node optics/outputs/phase6-cpu.mjs`；Playwright 路徑與 port 為本機環境，跨機器須調整。
