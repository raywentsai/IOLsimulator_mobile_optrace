# Phase 9B WebGL2 光學合成

本頁記錄 Phase 9B 的驗收方式。現行正式首頁直接使用優化後的 WebGL2 路徑，數值驗證頁也會自動測試可用的 GPU。 [現行設定](phase13-acuity-calibration.md#渲染與驗證)

以 `ff4059c` 為 CPU 基準。公開站以 `?composition=gpu` 開啟 GPU 驗收路徑，Physics 標籤會顯示 GPU 或 CPU。`validation?composition=gpu` 可執行數值驗證。實體手機尚未量測，因此一般入口使用 CPU。Gaussian 與 CPU Physics 共用原有 WebGL1 畫布，GPU 使用獨立的 WebGL2 畫布。[Phase 6 的原型驗收條件](phase6-rendering-performance-audit.md)

## 取樣、排程與資產

- 既有 OPTrace PSF 及光學 PNG 沿用。下載、解碼、驗證和 Phase 9A 的可見欄位裁切共用同一個 loader。GPU 以 `RGBA8UI` 和 `texelFetch` 還原 f12/a12，依完整場景 anchor 計算每個像素的 X/Y 面積重疊。單一方向最多跨八個來源像素寬，超出時沿用 CPU 的面積積分。
- Worker 在背景失效時用同一套 infinity PSF FFT，傳出需要的線性 RGB 區域。GPU 合成 `f + (1 − a) × background`，先輸出與 CPU 一致的 8-bit sRGB 取樣網格，再按 DPR 做 linear-light 顯示重建。雙眼在相同版本一次提交，保留原有奇數寬度的分界。GPU 只需 WebGL2 核心格式和 highp fragment precision。[Khronos WebGL2 規格](https://registry.khronos.org/webgl/specs/latest/2.0/)
- 第一張就緒的 GPU 畫面立即提交，同次更新週期的其餘輸入合併到下一次繪製機會。過時的資產等待或畫面仍可取消。暖機命中時只切換已註冊的紋理及參數，每幀 Worker 畫面資料為 0 bytes。任何一側走 dynamic FFT、GPU 初始化或上傳失敗、context loss，皆由 CPU 完整提交同一版本。
- 14 MiB 的 packed optical 預算由當前路徑持有。切換時釋放舊路徑的光學資產，避免為 CPU 回退常駐兩份，回退或首次切換可能重新解碼。GPU 線性背景紋理另有 7 MiB 上限，按每像素 16 bytes 保守計帳。顯示緩衝和驅動程式配置另計。

## 量測

同一台 Windows／Intel D3D11 桌機、Chrome 156、390 × 844 CSS viewport、DPR 3。暖機後由 slider input 量到正確版本的畫面提交。標準組 40 cm、6.693 CSS px/mm，輪替 2.4–2.6 D。高密度組 100 cm、7.781 CSS px/mm，往返 3.9／4.0 D。連續輸入每組 23 筆、相隔 16.67 ms，從最後輸入計算。這些數字不含 OS 觸控及實體螢幕掃描延遲。

| 情境 | 樣本 | CPU 中位數 / p95 | WebGL2 中位數 / p95 |
| --- | ---: | ---: | ---: |
| Aspheric 單眼 | 30 | 10.4 / 11.9 ms | 7.6 / 8.2 ms |
| Spherical 單眼 | 30 | 9.6 / 12.6 ms | 8.0 / 8.4 ms |
| Vivity-like 單眼 | 30 | 9.9 / 11.9 ms | 7.7 / 8.5 ms |
| 一般雙眼 | 30 | 9.5 / 10.2 ms | 7.5 / 8.6 ms |
| 高密度單眼 | 16 | 27.1 / 31.6 ms | 7.6 / 9.1 ms |
| 高密度雙眼 | 16 | 9.2 / 10.3 ms | 8.1 / 9.4 ms |
| 一般雙眼連續輸入 | 8 組 | 9.9 / 11.2 ms | 1.5 / 2.6 ms |
| 高密度雙眼連續輸入 | 6 組 | 9.3 / 10.5 ms | 1.5 / 2.3 ms |

一般連續輸入八組共提交 180／184 張畫面，高密度六組提交 130／133 張。逐筆暖測收到上一張後立即送下一個值，GPU 排程會合併同一繪製週期內的輸入。一般雙眼原本每幀回傳 968,760 bytes，高密度雙眼回傳 305,724 bytes，GPU 紋理命中時兩者皆降為零。

獨立原型使用有效的 GPU timer query，在 DPR 3 的三組情境量得兩個 pass 的 GPU 中位數約 0.84–0.92 ms，每組 20 次，p95 皆低於 1.0 ms。這些查詢及 readback 只用於測試。

冷載入以 200 kB/s、150 ms 延遲及 4× 頁面 CPU 限速各測兩次。背景完成前的近景約 2.4–2.5 秒，完整 Gaussian 約 6.9–7.5 秒。背景就緒後切入 Vivity Physics，CPU 約 2.27–2.97 秒，GPU 約 2.46–2.85 秒。首次 GPU 路徑需傳入線性背景 RGB，測試網格為 2,906,280 bytes，較 CPU 首張 968,760-byte RGBA 大，後續只在背景失效時傳輸。

高密度雙眼測試後，Chrome DevTools 的主執行緒與 Worker JavaScript backing storage 合計由 26.96 降至 13.16 MiB。GPU 路徑另計約 13.81 MiB 光學紋理、6.95 MiB 背景紋理、0.29 MiB 合成網格及 8.31 MiB 的一個 DPR 3 色彩緩衝。這些數字分別量測或估算資源，不能推算瀏覽器總 RAM、驅動程式緩衝數量或實機峰值。

## 驗證

- Chrome 和桌面 Playwright WebKit 26.5 各比對全部 170 個光學影像級別，三種面積取樣倍率共 510 組。包含非等比 X/Y、奇偶寬度、裁切和接近 8 倍的 footprint。GPU 與 CPU 最大差均為 1 sRGB byte。三種 IOL 各 1.0、2.5、4.0 D 的九個 Python fixture 同樣符合 1 byte 門檻。
- Chrome 的正式 build 對 Phase 9A、桌面 WebKit 的正式 build 對同版 CPU 路徑，逐像素比對九個一般雙眼畫面及兩個 100 cm 高密度畫面，DPR 3 顯示最大差 1 byte。兩種引擎都驗證了三種 IOL、Gaussian 往返、校正、最新連續輸入及 context loss 後的 CPU 回退。Chrome 另測了預計算資產缺失、超出取樣範圍及模擬 GPU 上傳失敗。58 項 Node 測試、型別檢查及 production build 通過。
- WebKit 自 Safari 15 起提供 WebGL2。桌面 WebKit 搭配 iPhone 11 視窗設定只驗證瀏覽器引擎，iPhone 11 Safari 實機的觸控延遲、峰值記憶體與長時間滑動仍需驗收。冷網路、未快取資產與 Worker 的 infinity FFT 仍影響首次顯示時間。[WebKit Safari 15 官方說明](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)
