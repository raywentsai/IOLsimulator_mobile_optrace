# Phase 13 Gaussian / Acuity Calibration

從 Simulator → Settings → Gaussian / Acuity Calibration 進入，或開啟 `/acuity-calibration/`。校準刺激以眼睛至螢幕 **30 cm** 計算。主模擬器首次開啟也預設以 30 cm 觀看，使用者已儲存的觀看距離優先套用。主模擬器初始物距為 −3.3 D（30.3 cm），採現有 0.1 D 步進最接近 30 cm 的格點。

兩頁共用 53.98 mm 信用卡短邊校正及儲存格式。校正線比可用寬度長時會轉為垂直。校準頁用信用卡更新螢幕比例時保留主模擬器已設定的觀看距離。舊校正若缺 DPR 記錄，首次開啟 Landolt C 頁面時需重新比對信用卡。

## 幾何與取樣

Landolt C 的內徑為外徑的 3/5，環寬與缺口均為外徑的 1/5。方向由八個方位中隨機選取。每像素以 4 × 4 子樣本積分覆蓋率。 [ISO 8596:2017](https://www.iso.org/standard/69042.html)

- `MAR′ = 10^logMAR`。外徑視角為 `5 MAR′`，以眼到螢幕距離 `d = 300 mm` 和外徑角 `θ`（弧度）計算平面外徑 `2d tan(θ/2)`。0.0 logMAR 的外徑約 0.436 mm，缺口約 0.087 mm。
- 有效 CSS px/mm 為 `校正 CSS px/mm × 校正 zoom / 目前 zoom × 校正 DPR / 目前 DPR`。渲染像素密度為有效 CSS px/mm 乘以 `目前 DPR × 目前 zoom`。這項縮放補償假設使用同一螢幕。
- 等向 Gaussian 的各軸標準差為 `σrender = σarcmin × π/10800 × 300 × rendering px/mm`。在同一像素密度下，30 cm 的線性尺寸與像素 σ 都是 40 cm 時的 75%。校準頁以 ±4σ 截斷並正規化離散 Gaussian 權重，沿水平與垂直軸卷積顯示編碼值。
- 缺口低於 2 個渲染像素時顯示取樣提示。非零 σ 至少為 0.75 渲染像素，角度步進為 0.25 arcmin，上限 12 arcmin，畫布每邊上限 512 px。例如 5 CSS px/mm、3× DPR 的手機，0.0 logMAR 缺口約 1.31 px，0.2 logMAR 約 2.07 px。

## 手動紀錄

校正信用卡短邊後保持 30 cm 距離，以 **Larger C / Smaller C** 變更視標 logMAR，以 **− / +** 獨立調整 σ。切換大小會選擇缺口方向並保留 σ。可手動記下視標 logMAR、最後可辨識與首次無法辨識的 σ（arcmin），以及裝置、亮度和矯正條件供後續分析。畫面同時顯示取樣網格上的缺口與 σ 像素數。

這個操作工具和主模擬器共用角度轉像素的換算與 Gaussian 權重定義。校準頁在原生取樣網格直接卷積。主模擬器使用 WebGL 的相鄰權重插值、0.05 texel 量化和大 σ 多次卷積。 [Phase 13B 的 VA 至 σ 校準結果](phase13b-gaussian-calibration.md)

## 渲染與驗證

正式首頁直接選用 WebGL2 加速路徑。當 WebGL2 不可用或畫面超出該路徑的條件時，Physics-based 使用 CPU 合成。數值驗證頁會視裝置支援情形自動比對 WebGL2、CPU 和 Python。

Chromium 和 WebKit 的 iPhone 13 模擬通過 30 cm 校正、切換 C 大小時的 σ 保留、VA 標籤、預設 WebGL2 路徑及停用 WebGL2 時的 CPU 回退。九組 WebGL2／CPU／Python 比對的最大差為 1 個 sRGB 量化階。觸控與螢幕實際呈現仍待 iPhone 實機驗收。

同機 Chromium 在兩版都校正為 40 cm 觀看距離、361 CSS px 卡片短邊後重播互動。暖快取輸入至畫面提交的 p95，單畫面由 7.5 ms 到 5.7 ms，分割由 5.8 ms 到 7.1 ms，取樣的暖幀均走 WebGL2。新版單畫面與分割各出現一次首次切換未命中預取，分別在約 21 ms、35 ms 提交。新版從 3.3 D 啟動，前版從 2.0 D 啟動，移到比較區間前已預取的格點可能不同。
