# Phase 9B 後的手機互動與光學驗證評估

審查基準為 `e38fa5d`，日期為 2026-11-09。使用者回報 Safari 的 GPU 驗收版可用，更新已有感改善，連續滑動仍有延遲感。本次以原始碼、資產清單、公開站 HTTP 回應和先前效能紀錄分析，另以現有取樣與快取函式重播 31 個物距節點。以下提到的實機掉幀原因均須由新量測確認。[Phase 9B 基準](phase9b-gpu-composition.md)

**建議下一階段先做實機量測與物距控制 A/B。** 保留原生滑桿，旁加「靠近／拉遠」逐格鍵，讓使用者能立即選到精確的 0.1 D 節點。畫面保留上一個完整光學結果，並明確區分「想看」與「已顯示」的物距。以實機結果決定優先處理暖快取排程、資產未命中或 GPU 顯示成本。

## 目前延遲可能發生在哪裡

`觸控 → 原生 range input → Svelte store → 排程與資產檢查 → GPU／CPU 提交 → Safari 合成 → 螢幕呈現`

Phase 9B 的高密度雙眼連續輸入 p95 為 2.3 ms，計時從最後一筆輸入到正確版本的提交。桌面 GPU 兩個 pass 的中位數約 0.84–0.92 ms，實機還有事件等待、瀏覽器合成和螢幕掃描。若實測更新機會為 60 Hz，每次相隔約 16.7 ms。提早提交與跨過繪製截止時間，即使只差幾毫秒，實際可見結果也可能相差一次更新。[Phase 9B 量測](phase9b-gpu-composition.md) · [WHATWG rendering opportunities](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)

| 程式證據 | 實機要確認的影響 |
| --- | --- |
| IOL 的 `input` 立即寫 `masterDefocus`。`schedule()` 會讀尺寸、建立 key、換版本、取消舊等待與預取。`flush()` 重算目前及相鄰節點的選擇。`nextGpuPaint` 到提交前才限制同一更新週期的畫面數。 | 快速拖過多節點可能花時間準備已過時的需求，或在 rAF 門檻前後跨過一次呈現機會。相同 key 已有去重，單純再疊一層固定 debounce 會增加等待。 |
| 每個完成畫面都會組合 `profile` 並序列化到 `data-profile`，更新途中也會設定 `status`、進度和 `aria-live` 區。場景尺寸受 `100dvh`、`ResizeObserver` 和 `visualViewport` 影響。 | 用 Safari trace 檢查診斷、DOM 或工具列造成的佈局工作，特別是旋轉、工具列伸縮與縮放。這些是候選成本。 |
| 暖 GPU 每幀仍做面積積分、合成及 RGBA8 中間網格，再以四鄰點做線性光重建。390×621 的場景在 DPR 3 時，最後一段約處理 218 萬個像素。 | 若熱機且兩類紋理都命中，GPU 或 compositor 可能是瓶頸。桌面 timer query 的結果只能當基準。 |
| 未命中時，光學 PNG 會先解碼整張，在主執行緒 `drawImage`／`getImageData`，再驗證 SHA-256、掃描數值、裁切及註冊。背景 key 隨網格、校正、觀看距離、模型及可見區改變，冷背景需由 Worker 重新 FFT。同步 FFT 會在本次計算返回後才處理新版本。 | 第一次到節點、跨網格、切鏡片、縮放及 GPU／CPU 往返要單獨量測。HTTP 快取命中仍可能付出解碼與上傳成本。 |

程式入口為 `scheduleMainDefocusUpdate()`、`IolScene.schedule()`／`flush()`、`OpticalImageLoader` 和 `GpuDisplay.draw()`。[物距控制](../src/routes/+page.svelte) · [場景排程](../src/components/IolScene.svelte) · [光學資產載入](../src/lib/render/psf/optical-images.ts) · [GPU shader](../src/lib/render/psf/gpu-display.ts)

### 用實機優先重播的三個區間

以 390×621 CSS 場景、校正倍率比 1、已發布的 manifest，逐格評估 `mobileSampling`、光學工作集及 `gpuSampling`。這是靜態推算，表中 GPU 資格以資產存在及 WebGL2 正常為前提。

| 條件 | 從程式推得的結果 | 建議重播 |
| --- | --- | --- |
| 40 cm，6.693 CSS px/mm，Aspheric + Vivity-like | 31／31 格符合 GPU 資格，網格維持 390×621。 | 暖機後 2.4、2.5、2.6 D 往返，隔離事件、GPU 和呈現延遲。 |
| 100 cm，420 px 卡片配對，Aspheric + Vivity-like | 31／31 格符合 GPU 資格，但網格在 1.5 D 由 390×621 變成 293×466，在 3.1 D 變成 219×349。背景 key 隨之改變。62 個當前節點×側別資產中，55 個的完整解碼加裁切預估超過現有單件預取門檻 2 MiB。 | 跨 1.4／1.5 和 3.0／3.1 D，另測固定網格內的 3.9／4.0 D。記錄每次背景及光學紋理的命中。 |
| 20 cm，270 px 卡片配對，Vivity-like 單眼或與 Aspheric 比較 | 23／31 格符合 GPU 資格。1.0–1.7 D 的較密來源超過 8 倍 footprint，使用 CPU 面積積分。切換後端會清除原後端的資產快取。 | 反覆跨 1.7／1.8 D，另測只在 CPU 區或 GPU 區內拖曳，檢查轉換及重解碼的成本。 |

## 物距控制與畫面回饋

目前物距有 31 格，對應 1.0–4.0 D、100–25 cm。0.1 D 在 1.0→1.1 D 約移動 9.1 cm，在 3.9→4.0 D 約移動 0.6 cm。建議以 D 為精確步階、cm 為可讀的等值，並將**模擬物距**與校正面板的**眼睛到螢幕距離**分開標示。快速掃過 30 個間隔時，在每秒 60 次更新機會下，逐格呈現至少需要約 0.5 秒。探索操作可略過已被取代的指令，受控實驗則應依指定順序呈現每一格。

| 操作方式 | 建議 |
| --- | --- |
| 左右逐格鍵 | **優先加入，保留滑桿。** 使用「拉遠／靠近」文字及方向圖示，點一次走一格 0.1 D。以 44×44 CSS px 為觸控目標設計值，保留鍵盤、VoiceOver 與端點狀態。對比兩張圖時可精確往返，也免除拖曳的動作負擔。[WAI 拖曳替代](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements) · [WAI 觸控目標](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced) |
| 保留原生滑桿 | 手指與目標讀值即時回應。暖資產一個呈現機會最多提交一個最新版本，放手優先完成最後一格。避免同時在 slider 和 renderer 各加一層 rAF。試驗單一呈現門檻與現有「第一張立即提交」策略，逐一量測點擊和拖曳。 |
| 長按重複、精細拖曳或常用停點 | 第二順位。長按可試 350 ms 後每秒 6–10 格，這是 A/B 的起始值。下個重複指令依畫面就緒調節，放開、取消及離開頁面即停止。常用停點可先試 25、40、50、100 cm，均取已存在的精確節點。其餘節點可從逐格鍵或滑桿進入。 |
| 顯示狀態與受控比較 | 等待期間保留上一張完整畫面，只有目標和呈現不同時才顯示兩個值，例如「已顯示 40 cm · 更新至 38 cm」。將鏡片、模式與物距和畫面版本一起提交。以短延遲顯示非緊急進度，錯誤及重試保持可達。受控比較可提供固定順序、穩定畫面後的停留時間和 A/B 點選。一般探索沿用即時滑桿。 |

光學畫面採離散節點的完整切換。CSS 動畫可用於按鈕等介面回饋。混合相鄰 PSF 畫面、拉伸舊字卡或在拖曳時切到 Gaussian，應歸到另行驗證的模擬方法。保留原生控制及瀏覽器縮放，針對目前同時監聽 pointer／touch 的地方量測後再去重。若確認點擊延遲來自手勢判定，可在逐格按鈕小範圍測試 `touch-action: manipulation`。[WebKit fast tapping](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)

拖曳速率值得做條件式 A/B。暖 GPU 跟隨可用的繪製機會。若 trace 顯示 CPU 或冷資產段反覆中止下載，可試將渲染請求限在每秒 30 次，或等現有工作到可取消點再接管最新需求。滑桿讀值維持即時，放手的最終需求可立即接管。比較實際顯示頻率、最後一格的 p95 及多餘傳輸量，再決定這些條件是否值得節流。

## 渲染、資產與手機 Web 優化順序

| 優先次序 | 建議試驗與取捨 |
| --- | --- |
| **P1 暖畫面快速路徑** | 將「場景幾何版本」和「目前 D」分開。以 ResizeObserver／實際縮放更新尺寸快照，對固定校正、鏡片和取樣網格預索引 31 格的選擇結果。只有當前資產已就緒才走短路徑，命中時直接換紋理及 uniform。診斷 JSON 降為測試開關或抽樣。延後短暫 loading 區的 DOM 更新。以 trace 驗證每筆輸入的 JS、layout、過時工作數。工具列伸縮、轉向與 pinch zoom 要重驗實體角尺度。 |
| **P1 精準預取與快取** | 目前光學預取在穩定 150 ms 後開始，每次最多兩個相鄰格的小資產，且取消政策著重當前格。以有限位元組試「拖曳方向的下一格／放手點」及單個可接管的下載，在回頭或快速大跳時取消。記錄命中、過期下載量和淘汰次數。對混合 GPU／CPU 區段，以 A/B 比較固定短段後端，或在總預算內轉移／重用已有區域，降低切換時整批清除。極慢連線延續前景優先。 |
| **P2 無損資產與主執行緒** | 170 個光學 PNG 共 50.45 MB，單件 36.7–830.9 kB，96 個壓縮 PSF 共 18.39 MB。這些是全庫大小。高密度 Aspheric 4.0 D 雙眼條件的單側可見欄位只留約 0.97 MB packed bytes，完整來源約 6.74 MB decoded，載入時仍解碼整張。可先試一個高密度節點的**可驗證無損裁區／瓦片**，保留對應角座標及邊緣重疊所需的來源格，評估壓縮後下載量、請求數、解碼、峰值及兩側切換。另比較精確 f12/a12 二進位封裝與 PNG 的端到端成本。傳輸格式需重建出同一組已驗證的樣本。將大型解碼／讀回移至 Worker 的方案以能力偵測和 iPhone 實測為條件。[WebKit OffscreenCanvas 支援](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/#offscreen-canvas) |
| **P2 冷載入與重訪** | 公開站抽樣顯示背景 JPEG 987,962 bytes，字卡 SVG 617,990 bytes、gzip 約 103,479 bytes，抽樣的背景、SVG、Vivity PNG 和 manifest 都回傳 `max-age=600`。先量測字卡解析、首個可用近景、首個完整 Physics 及 GPU 初始化。背景已減量約 65%，字卡若再壓縮優先驗證向量路徑、角尺寸及各密度光柵一致。若臨床網路重訪仍慢，試用內容雜湊版本 URL 或讓使用者明確預備「指定鏡片與物距區間」的有界快取，避免整庫預載。版本清單、PSF、光學影像和校正紀錄應能對應同一次比較。Safari 可能清除站點儲存，需測缺漏及更新復原。[RFC 8246](https://datatracker.ietf.org/doc/html/rfc8246) · [WebKit 儲存政策](https://webkit.org/blog/14403/updates-to-storage-policy/) |
| **P3 GPU、FFT 或背景快取** | 若暖機已證實 GPU 受限，再評估讓完全無前景交集的像素提早跳過積分、減少每格重算的重疊權重，或對相同解析度測試等價的呈現路徑。若長停頓集中在網格變化，優先比較預備相鄰網格的背景，或用獨立參考驗證涵蓋整段物距的共用網格。先量測相同網格和 DPR 下的收益，再考慮搬動 WebGL context 至 Worker。維持既有角度取樣門檻、FFT 支撐、線性光處理與顯示精度。任何網格、內部數值格式或濾波替換都需過光學門檻。 |

手機端也可量測隱藏頁面的工作與持續拖曳耗電。僅在頁面可見時作推測性工作，返回後用最新狀態恢復。保持單一呈現隊列，避免常駐動畫循環、同步 GPU 讀回、整頁樣式變更和大量 DOM 進度事件。這些改動分別與原版 A/B，以便辨認節能、排程和網路收益。[WebKit Web content power usage](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) · [Khronos GPU timer query](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)

## 下一階段的實機量測及採用門檻

1. **先做相同手機的基線。** 記錄 iPhone 型號、iOS／Safari、實際觀看距離、卡片校正、DPR、電源模式和網路。用 Safari Web Inspector 的 Frames、Network、Layout & Rendering 對齊事件、開始準備、資產到齊、背景 FFT、GPU 提交和顯示序號。分開記錄 HTTP 暖／解碼冷、GPU 暖、背景未命中、後端切換、縮放／轉向。連續拖曳需自訂時間戳或 trace，Event Timing 排除了 `pointermove` 等連續事件。[Web Inspector iOS 遠端檢查](https://webkit.org/web-inspector/enabling-web-inspector/) · [WebKit Frames](https://webkit.org/web-inspector/timelines-tab/) · [W3C Event Timing](https://www.w3.org/TR/event-timing/)
2. **量到真的出現在螢幕。** QA 用畫面版本標記配合高幀率攝影，記錄指尖／觸控起點到正確畫面，以及放手到最終畫面。標記要和該光學畫面同步提交，放在比較區之外。以未開 Inspector 的錄影交叉檢查，rAF 和 GPU timer 用來定位延遲。報告 p50／p95、最長停頓、實際出現的不同節點、過時請求、重新解碼和 context loss。同一場景至少 30 次點擊或重複滑動。操作 A/B 另記到達指定 D 的時間、超過／回調次數、誤認「目前畫面」的次數。
3. **先設定採用條件，再選優化。** 可先試「暖機時正確畫面的 p95 在兩次實測更新間隔內」，若為 60 Hz 約 33 ms，並追蹤超過三個更新間隔的停頓。持續滑動要同時呈現有效變化與收尾正確，操作完成率和可讀性也要提升。若主要落後在暖區，做排程與快速路徑。若集中在首訪或轉折，做精準預取與快取。只有證據指向 GPU 執行才改 shader。逐格鍵與滑桿使用相同節點、校正及光學驗證門檻。

## 與 OPTrace 論文接軌的驗證層次

Mendroch 團隊 2024 年以實測鏡片幾何及模擬分析 EDoF 設計，2025 年以多波長視網膜影像展示兩款 EDoF 的情境差異。這個 App 的可貢獻方向是把可追溯的離線條件接到可重播、可校正的手機比較。現有公開庫固定為 3 mm 瞳孔、平均角膜、D65 photopic Y 權重及 HURB，瀏覽器以無色差的 photopic-Y PSF 合成。Vivity-like 為合成模型。畫面為兩種情境的並排比較，ETDRS 樣式字卡用於展示。對照論文時要把鏡片幾何、光譜、瞳孔、物距、參考平面、縮放及顯示方式列在同一張條件表。條件有差異時以對照分析呈現。[2024 設計分析](https://pubmed.ncbi.nlm.nih.gov/39167376/) · [2025 多波長影像](https://pubmed.ncbi.nlm.nih.gov/41533878/) · [本專案光學來源](../optics/PROVENANCE.md) · [字卡定義](../static/reading-card.json)

| 層次 | 後續需要的證據 |
| --- | --- |
| 數值與顯示忠實度 | 無損封裝驗證 decoded hash，沿用現有 CPU／GPU／Python 比對的 ≤1 sRGB byte 門檻與相應的線性 RMSE、coverage 面積／重心門檻。確認 PSF 能量與尾部、分割邊界、X/Y 角尺度、兩眼同版本、所有 0.1 D 節點可達。兩條校正路徑的縮放比寫法不同，跨模式與 pinch zoom 以實體長度及已知角尺寸交叉驗證。研究量測另記錄亮度、環境光、顯示色彩設定及校正狀態。[既有收斂驗證](phase8-unified-rendering.md) · [顯示校正](../src/lib/optics/calibration.ts) · [Physics 尺度](../src/lib/render/psf/geometry.ts) |
| 光學外部驗證 | 選一個可取得資料且條件對得上的 OPTrace 算例，記錄模型版本、PSF hash、鏡片量測、光譜與瞳孔。與獨立光學台的 through-focus MTF、PSF 能量／形狀和同尺度字卡結果比較，預先界定量測誤差與可接受差距。再擴展到不同瞳孔、角膜和照明。論文圖可作可重播的情境來源，光學台資料用於外部驗證。[OPTrace IOL 算例](https://drocheam.github.io/optrace/examples.html) |
| 臨床用途驗證 | 先以研究展示／諮詢輔助定義用途，由臨床合作方設計前瞻性、重複性及外部驗證。若用途延伸到術後預測，需以配對的術前／術後結果、實際植入型號及條件，檢查 through-focus 視力、對比敏感度或病人報告結果，報告一致性、變異及失敗族群。其他自適應光學模擬器的研究可作研究設計參考，臨床效度需由本 App 的驗證建立。[術前／術後模擬比較研究](https://pubmed.ncbi.nlm.nih.gov/31799048/) |

可重播比較的最小紀錄包含 App commit、模型與 PSF／字卡版本、呈現的 D 節點、實際觀看距離、校正快照、比較順序及前後端路徑。用這組條件連結論文算例和手機畫面，臨床資料另由合作方依研究方案管理。
