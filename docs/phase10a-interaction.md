# Phase 10A 手機物距操作與暖渲染

比較基準是 `7ec3261`，其 app 與 Phase 9B 的 `e38fa5d` 相同。情境沿用 [Phase 9B 後的手機互動與光學驗證評估](post-phase9b-mobile-experience-audit.md)。

## 實作

- 場景尺寸、顯示密度與校正、觀看距離、鏡片、比較模式及背景版本形成獨立的場景配置。單獨改物距時，排程沿用配置，省去量測場景及序列化 render key。
- 首次成功提交的 GPU 節點記下原有光學選擇、可見區和取樣參數。回到相同 0.1 D 節點且全部紋理仍駐留時，直接用原來的兩段 shader 提交。紋理被淘汰、節點首次造訪，或場景配置變動時，走完整驗證流程。CPU 切換與 WebGL context loss 清掉這些紀錄。記錄只保存引用與取樣參數，GPU 紋理快取預算沿用 Phase 9B。
- 暖幀就緒時先提交，之後每個 rAF 門檻只取最新需求。新版本可立即停止等候舊 Worker 回覆。若新幀也需要 Worker，客戶端會等 Worker 到達原有取消檢查點，再交付最新需求，避免重疊運算造成誤降級。按一次「−／＋」沿滑桿各移動 0.1 D，端點停用對應按鍵。兩個按鍵的觸控範圍均為 44×44 CSS px。
- `?diagnostics=1` 才在 canvas 寫入逐幀 `data-profile`，便於量測。一般使用保留場景狀態、距離與載入錯誤提示。GPU 驗收使用 `?composition=gpu`，首頁沿用預設 CPU Physics。

## 桌面瀏覽器重播

同一部 Windows 電腦以 Chrome 156 的 headless 模式、390×844 CSS px、DPR 3，比較兩個正式建置。兩版的場景均為 390×620.75 CSS px，初始取樣網格均為 390×621。先造訪每個節點，再重播 36 筆暖幀或 10 筆邊界幀。下表時間為合成 `input` 到 `data-profile` 發布的毫秒數，包含診斷本身的成本。

| 觀看距離、重播節點（正值為物方屈光度） | Phase 9B 中位／p95 | Phase 10A 中位／p95 | Phase 10A 路徑 |
| --- | ---: | ---: | --- |
| 40 cm 單眼，2.4／2.5／2.6 D | 8.0／8.6 | 7.9／8.9 | 36／36 暖 GPU |
| 40 cm 雙眼，2.4／2.5／2.6 D | 7.7／8.9 | 7.7／8.9 | 36／36 暖 GPU |
| 100 cm 雙眼，1.4／1.5 D | 7.3／8.6 | 7.7／9.2 | 390×621 ↔ 293×466，暖 GPU |
| 100 cm 雙眼，3.0／3.1 D | 7.5／9.4 | 8.1／8.7 | 293×466 ↔ 219×349，暖 GPU |
| 100 cm 雙眼，3.9／4.0 D | 7.7／8.4 | 7.7／8.8 | 219×349，暖 GPU |
| 20 cm Vivity 單眼，1.7／1.8 D | 15.4／23.8 | 16.4／22.5 | 各 5 幀 CPU、GPU，均走完整流程 |

40 cm 的暖 GPU 樣本，Phase 10A 排程到第一次檢查的 p95 為 0.1 ms，畫面門檻等待中位為 7.5–7.6 ms，資產準備為 0 ms，JavaScript 繪圖提交 p95 為 0.1 ms。Phase 9B 的 `queueMs` 從排程清理之後開始計時，且只涵蓋首次喚醒。Phase 9B 的 `opticalLoadMs` 涵蓋部分資產流程。暖更新省下準備與清理，但這批輸入到提交的差距很小。

40 cm 另重播每組 14 筆、間隔 8 ms 的輸入，各 8 組。單眼提交 97→96 幀，雙眼 97→97 幀，兩版所有組別都呈現正確的最後節點。最後輸入到提交的 p95 單眼為 9.0→10.0 ms，雙眼為 8.9→9.5 ms。連續提交間隔的 p95 分別為 11.0→10.7 ms 與 10.9→10.4 ms。瀏覽器重播量到提交與診斷更新，iPhone 的觸控、合成、實際刷新率與呈現延遲需由真機量測。

100 cm 的熱資產仍會重配不同尺寸的 GPU 網格，Phase 10A 跨界時的 JS 提交中位為 0.8 ms，固定網格低於計時精度。20 cm 的 1.7 D 仍受原 GPU 取樣範圍限制而使用 CPU。後端往返觸發原快取轉換，Phase 10A 資產準備中位／p95 為 10.6／13.2 ms，CPU Worker 往返為 3.3／8.4 ms。邊界量測只有 10 筆且有變異，數據用於定位瓶頸。

## 重播與手機驗收

59 項回歸測試通過，包含 Worker 單一執行與跳過過期請求。Chrome 實際 canvas readback 中，40 cm 單眼及雙眼共 6 組暖幀與 Phase 9B 逐位元組相同。Chrome 與 Playwright WebKit 26.5 的 iPhone 11 模擬環境均通過三種 IOL 的 11 組 CPU／GPU 顯示比較及獨立 Python 的 9 組 WebGL2 fixture，最大差異為 1 個 sRGB byte。另驗證逐格鍵的觸控、鍵盤與端點行為，以及 context loss、上傳失敗和缺少光學資產時的 fallback。

將兩版各自建置為 production，從對應的 SvelteKit base path 提供 HTTP 服務。以本機可載入的 Playwright 和 Chrome 執行下列命令。若 Playwright 位於專案之外，將 `PLAYWRIGHT_MODULE` 指到它的絕對模組路徑或 file URL。

```sh
node tests/benchmark-interaction.mjs <Phase-9B-URL> <Phase-10A-URL>
```

在 Safari 的 GPU 驗收頁選 Physics-based (OPTrace PSF)，先來回點擊 2.4／2.5／2.6 D 暖機，再以滑桿快掃並逐格往返。40 cm 依序比單眼和雙眼。100 cm 將校正卡寬設為 420 px，比較 Aspheric／Vivity-like 並跨兩處網格。20 cm 將卡寬設為 270 px，選 Vivity-like 單眼跨 1.7／1.8 D。優先比對放手後最後一幀、跨界時的停頓及逐格操作的精準度。暖幀仍有延遲時，下一步用真機 Safari 時間軸區分 rAF 門檻、GPU 工作與合成，據此決定是否調整排程或處理邊界的資產成本。
