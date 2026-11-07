# Phase 8 渲染效能分析

Phase 7 基準為 `857c988`。兩版 production build 使用同一台 Windows 桌機、Chrome 156 headless、390 × 844 CSS viewport、DPR 3 與手機觸控模擬。暖測在無網路或 CPU 限速下執行。一般條件為 40 cm、6.693 CSS px/mm、390 × 621 取樣網格，高密度雙眼為 100 cm、7.781 CSS px/mm、219 × 349 取樣網格。延遲從派發 slider input 到相符版本的 canvas profile 更新，包含 Worker 往返和 WebGL 提交。實體螢幕的 scanout 和觸控延遲需要手機量測。

## 暖更新與連續滑動

| 情境 | 次數 | Phase 7 中位 / p95 | Phase 8 中位 / p95 |
| --- | ---: | ---: | ---: |
| Aspheric 單眼 | 30 | 10.5 / 11.4 ms | 10.5 / 12.4 ms |
| Spherical 單眼 | 30 | 41.6 / 47.4 ms | 10.4 / 11.3 ms |
| Vivity-like 單眼 | 30 | 42.6 / 45.0 ms | 9.8 / 11.8 ms |
| Aspheric + Vivity-like 雙眼 | 30 | 53.1 / 56.9 ms | 20.7 / 22.8 ms |
| 高密度雙眼 3.9 ↔ 4.0 D | 16 | 91.5 / 99.5 ms | 81.7 / 95.5 ms |
| 一般雙眼連續輸入，最後一筆到提交 | 8 組 | 82.6 / 95.1 ms | 20.3 / 26.6 ms |
| 高密度雙眼連續輸入，最後一筆到提交 | 6 組 | 106.8 / 160.6 ms | 84.1 / 101.5 ms |

每組連續輸入有 23 筆，計時器間隔 16.67 ms。一般雙眼循環 2.4、2.5、2.6 D，高密度循環 3.9、4.0 D。Phase 8 一般雙眼八組共提交 39 個畫面，Phase 7 提交 8 個。高密度六組兩版各提交 6 個，均在拖曳結束後。快速操作時會取消舊版本的 Worker 工作，兩側齊備才提交。瀏覽器觸控事件測試確認放開後的最終畫面與滑桿一致。延遲表中的少量 burst 樣本用來定位問題。

一般雙眼 30 筆的兩側 CPU 合成時間加總中位約 **19.0 ms**，超過 60 Hz 的 16.7 ms 更新間隔。影像查找與保留約 0.2 ms，兩側 Worker 往返扣除 Worker 時間約 0.4 ms，split copy 與 WebGL upload 提交各約 0.1 ms。高密度雙眼則有 **52.8 ms** 影像載入／解碼／註冊，以及 **27.8 ms** 合成。16 次往返重做了 32 次 optical PNG canvas readback 與註冊。合成時間包含 Worker 的 cooperative yield。各項數字是各自的中位數。GPU 命令執行與螢幕呈現尚待 trace。

高密度 8192 的一對 3.9 D packed 影像為 12.606 MiB，一對 4.0 D 為 12.863 MiB。四張合計 **25.469 MiB**，因此 14 MiB Worker cache 只夠目前的一對。圖像在瀏覽器 HTTP cache 中仍需要解碼、讀回和完整性驗證才可重新註冊。暖的一般雙眼沒有這些成本，Worker 的 frame request 只送 ID 與參數。390 × 621 網格每側回傳約 0.924 MiB，使用 transferable buffer，雙眼合併後仍上傳一張相同大小的 RGBA 貼圖。

## 冷載入與記憶體

另用兩個全新 browser contexts 測每版，關閉 HTTP cache，模擬 150 ms 延遲、200 kB/s 下載和 4× page CPU throttle。初始 Gaussian 畫面均沒有 optical PNG 或 optical manifest 請求。資產依使用中的鏡片與距離載入。兩版都使用相同背景和字卡。設定切到 Vivity-like Physics 的資料量包含 PSF manifest、infinity PSF、以及所需 near PSF 或 optical manifest 加 PNG。以下為本機 HTTP 伺服器送出的 body bytes，JSON 以原始內容傳送。

| 情境 | Phase 7 兩次量測 | Phase 8 兩次量測 |
| --- | --- | --- |
| Gaussian 首張部分場景 | 8.91、9.01 s | 8.44、8.66 s |
| Gaussian 背景完整 | 19.53、19.63 s | 19.55、19.78 s |
| 已完成 Gaussian 後首次切到 Vivity-like Physics | 3.49、3.34 s | 3.34、4.16 s |
| 上列 Physics 資源 body | 398,719 bytes | 413,989 bytes |

Phase 8 的 Physics 冷路徑增加一段 manifest → PNG 請求。兩次 optical preparation 約 2.16 s，冷背景 FFT 約 279–283 ms。4.16 s 那次的 upload 呼叫區間約 527 ms，另一次約 9 ms，這個區間包含首次顯示和主執行緒／driver 等待。現有兩次結果不足以估計首次切換的穩定差異。Vivity-like 的 1.0、1.1 D 使用 16384 來源級別，首次跳到這兩個節點的資產比 2.5 D 量測更大。

高密度雙眼測試結束後，以 CDP 對主頁和實際 Worker 分別 GC 再讀 V8 backing storage。Phase 7 兩者合計 43.45 MiB，Phase 8 為 27.46 MiB。前者留有 dynamic near PSF cache，後者保留雙眼 packed assets。Phase 8 成功畫面的 packed peak 為 12.86 MiB，且高密度畫面保持在 14 MiB budget。PNG decoder、canvas 暫存、FFT 暫存、driver 和 device buffers 另有配置。這些數字描述 backing storage 和已註冊資產，手機 RSS 與 transient peak 仍待實測。

## 下一階段方案

| 方案 | 預期效益 | 成本、記憶體和相容性 |
| --- | --- | --- |
| CPU 按可見半屏輸出 | 一般雙眼優先。兩側目前各合成完整畫面再裁切，限制輸出可減少水平積分和 sRGB encode。19 ms 是兩側合成的基準，實際節省取決於垂直取樣占比 | 中等修改，沿用 Worker 和 WebGL1。維持全圖座標、字卡 anchor、PSF 尾端與原本的分界線，再對同網格逐 byte 比對。可在基準案例量出接近半屏輸出時的成本 |
| 高密度工作集與貼圖快取 | 高密度雙眼的主要機會是消除 52.8 ms 重解碼。可先離線驗證適用於 4370 左右輸出 pitch 的較緊密來源級別，再測四張能否留在既有 budget | 中等成本，增加可部署資產和密度驗證。直接容納現有四張需約 25.47 MiB packed，較 14 MiB 預算多約 11.47 MiB。GPU 若另持有相同貼圖，要把兩端合計。僅快取壓縮 PNG 仍保留 decode、readback 和驗證成本 |
| WebGL2 完成面積積分與 linear-light composition | 目標是移除暖路徑的 CPU 合成與每 frame RGBA 回傳。在多節點 texture hit 時最有機會改善雙眼連續更新 | 高成本。先取出 f12/a12，再做保守的 cell overlap 和線性合成。packed RGB 上的普通線性插值會混合跨位元欄位。可試兩段可分離面積積分。浮點 FBO 要檢查 extension、format 與 precision。WebGL2 和目前 canvas 的 WebGL1 需要清楚的 context 生命週期。維持 CPU fallback 並在 Safari/iOS 實測 [WebGL2 規格](https://registry.khronos.org/webgl/specs/latest/2.0/) · [浮點 framebuffer extension](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/) · [WebKit 的 Safari 15 WebGL2 支援](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/) |
| 資料傳輸和更新排程 | 單獨調整訊息封裝的效益較小。高密度可將 decode 與快取命中量分開測。一般雙眼的 19 ms 合成超過輸入週期時，對齊 presentation cadence 可減少做一半就取消的工作 | 低至中等成本。Worker 註冊已用 transfer。先量 upload 和 GPU compositor，再決定是否值得改貼圖配置。排程需保留最後輸入、同版本雙眼和有界等待。固定加入一幀等待會提高單眼延遲 |

建議先用 iPhone Safari 和 Android Chrome 量出暖單眼、暖雙眼及高密度 3.9 ↔ 4.0 D 的 frame trace。一般雙眼優先驗證 CPU 半屏輸出，高密度優先驗證工作集大小和 decode 次數。若兩者仍達不到手機更新目標，再用 WebGL2 小規模 PoC 與 CPU 路徑比較數值、median/p95、冷切換及 context recovery。這份報告中的後續方案屬效能評估。

量測以 `canvas[data-profile]`、DevTools Network／CDP 和測試時的 Worker 訊息與 canvas readback 掛鉤取得。本機原始紀錄在忽略的 `optics/outputs/phase8-{warm,cold,functional,ui}.json`。光學與渲染驗證見 [Phase 8 共用流程](phase8-unified-rendering.md)。
