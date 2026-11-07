# Phase 8 三種 IOL 共用渲染流程

Spherical Monofocal、Aspheric Monofocal 與 Vivity-like EDOF 共用一條 Physics 預計算路徑。每種模型涵蓋 1.0–4.0 D 的 31 個節點。產生器使用既有 96 個 OPTrace PSF 和 ETDRS 字卡，逐一驗證 PSF hash，再用 Phase 5 的面積取樣與 SciPy 卷積產生 f12/a12 PNG。Git 比對確認 PSF、模型參數與字卡原檔逐 byte 一致。此階段使用既有 PSF 做影像卷積。

## 資產和執行流程

各模型有獨立的 `static/optical-images/<model>.json`，依目前使用的鏡片載入。現有 62 張 Aspheric PNG 沿用原位元。Spherical 與 Vivity-like 各新增 54 張，三種鏡片合計 170 張、50,447,860 bytes，新增的 PNG 共 33,973,442 bytes。Gaussian 啟動時的 optical manifest 與 PNG 請求數為零。

大多數節點提供 4096、8192 pixels/tan(θ) 兩個來源級別。初次收斂審查找出 16 個節點需要較密的來源，這些節點各發布一個通過門檻的級別。Spherical 的 1.0–1.6、1.9 D 與 Vivity-like 的 1.3–1.7 D 使用 8192。Vivity-like 的 1.2 D 使用 12288，1.0、1.1 D 使用 16384。瀏覽器仍在原驗證範圍 128–8192 pixels/tan(θ) 內對輸出網格積分。

兩側各自按模型、屈光度、PSF hash 和實際 X/Y pitch 選擇影像。Worker 共用 14 MiB packed optical LRU、6 個 PSF 槽和 2 個背景槽。同一更新選定的兩張影像在兩側完成前保留，避免載入第二側時淘汰第一側。相同鏡片比較使用一次合成。不同鏡片比較保留 Phase 7 的共同取樣網格，兩側以同一版本送到 WebGL。下載或驗證失敗的鏡片使用 dynamic FFT，另一側可繼續使用預計算影像。驗證頁和模擬器均使用同一個 Worker 註冊與渲染協定。

## 驗證

| 模型 | 16384 來源參考的最大 linear RMSE | 最大 sRGB byte 差 | 最大 coverage 面積相對誤差 |
| --- | ---: | ---: | ---: |
| Aspheric | 0.0009143 | 1 | 0.001832% |
| Spherical | 0.0006719 | 1 | 0.001797% |
| Vivity-like | 0.0007512 | 1 | 0.001638% |

每種鏡片 31 節點 × 9 種輸出密度，共 837 組收斂驗證。四種背景亮度共用相同的面積積分與 linear-light compositing。原有門檻為 linear RMSE ≤ 0.001、sRGB 最大差 ≤ 1 byte、coverage 面積相對誤差 ≤ 0.01%。

49 項 Node 測試涵蓋 96 個 PSF 的能量與 hash、170 個 PNG 的 decoded hash、角度範圍、面積與 centroid、packed 與 Float32 積分的一致性，以及雙眼資產在淘汰下的保留。三種鏡片各有 1.0、2.5、4.0 D 的 Python fixture。相同網格的七組同時比較 dynamic FFT。Spherical 和 Vivity-like 的 1.0 D 以未量化的 16384 SciPy 場積分到輸出網格作為 oracle。瀏覽器的原有三個 dynamic fixtures 也持續驗證背景、前景和 WebGL 線性插值。

重現方式

```powershell
uv run --locked --project optics python optics/export_optical_images.py
uv run --locked --project optics python optics/export_optical_validation.py
uv run --locked --project optics python optics/validate_optical_images.py
npm run test:optics
npm run check
npm run build:gh-pages
```

開啟 `/validation` 可檢查 Python、Worker 和 WebGL。冷載入、連續滑動、記憶體與後續方案見 [Phase 8 效能分析](phase8-performance-analysis.md)。
