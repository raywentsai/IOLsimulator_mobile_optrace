# Phase 12 展示介面與場景

首頁直接開啟 Physics-based (optrace)。校正入口、鏡片選擇、物距和比較控制都在主畫面，About 提供兩篇 optrace 研究及方法摘要。主鏡與比較鏡仍按模擬方法各自保存。Acuity-derived 保留 target refraction，SN60AT 與 SN60WF 的曲線待補狀態各自顯示。分割線與左右名稱在介面層呈現，兩側共用同一個場景取樣。50 px 的逐格鍵與 25／50／100 cm 快捷鍵共用原物距控制。

校正面板將短邊 53.98 mm 的信用卡比對與眼睛到螢幕的距離放在一起。按 Done 後儲存兩項設定，既有尺寸校正記錄仍可讀取。面板也提醒維持觀看距離、螢幕焦點、亮度與環境照明，並避免縮放。

## 閱讀卡與物理尺度

虛構的英文 **City Walk** 步行指南採 ID-1 名義外框 85.60 × 53.98 mm，使用黑字、白底與 0.22–0.85 mm 的線條。字母大寫高度約 1.0–4.2 mm。字形由 Atkinson Hyperlegible 轉為 SVG 路徑，瀏覽器與離線光學產生器使用同一組向量圖形。外框採完整矩形覆蓋，內容集中在中央兩欄，讓手機視野裁切時仍可比較。預設物距 50 cm 可同時看到街景和近物。 [ISO/IEC 7810](https://www.iso.org/standard/70483.html) · [ID-1 名義尺寸](https://www.iso.org/standard/31432.html?browse=tc) · [字型授權](../optics/ATKINSON_OFL.txt)

使用 `2 atan(實際長度 / (2 × 模擬物距))` 計算視角。螢幕上的物理長度為卡片尺寸乘以「眼到螢幕距離／模擬物距」。例如在 40 cm 看螢幕、模擬物距 25 cm 時，投影寬度約 137 mm，手機會裁掉超出視野的部分。

| 模擬物距 | 卡片水平 × 垂直視角 | 1.0–4.2 mm 字高 |
| --- | ---: | ---: |
| 25 cm | 19.43° × 12.32° | 13.75–57.75 角分 |
| 50 cm | 9.79° × 6.18° | 6.88–28.88 角分 |
| 100 cm | 4.90° × 3.09° | 3.44–14.44 角分 |

## 遠景與光學影像

遠景為本專案以內建 OpenAI image generation 工具製作的虛構街景，採 1024 × 1536 直向原圖。以品質 92、4:4:4 漸進 JPEG 編碼後為 734,715 bytes，前版為 987,962 bytes。窗框、磚牆、樹葉和鋪面提供不同尺度的細節。兩側的遠景各以所選模型的無限遠 PSF 渲染。 [街景資產](../src/lib/assets/images/background.jpg) · [OpenAI 輸出使用條款](https://openai.com/policies/terms-of-use/)

170 張預計算圖以新卡片及原有 PSF 重新卷積，仍覆蓋每個模型 31 個物距節點。背景在瀏覽器另外合成。PSF、模型參數、角取樣公式與線性光合成沿用原方法。卡片、manifest 和光學圖請求使用對應內容雜湊更新快取。超出既有解碼預算的來源級別會交給 CPU dynamic PSF。常用物距的預取仍受網路與記憶體條件限制，GPU 方向預取依序解碼，單件上限為 6 MiB，活躍光學快取上限為 14 MiB。

生成命令在 `optics/` 的 `export_card.py`、`prepare_scene_assets.py`、`export_optical_images.py` 和 `export_optical_validation.py`。卡片產生器使用 FontTools 4.68.0 及 [Google Fonts 的 Atkinson Hyperlegible Regular／Bold](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible)。

街景的生成提示詞如下。

> Use case: photorealistic-natural. Generate a clean, realistic portrait 2:3 outdoor streetscape image for a vision simulator as a distant scene, without overlays. Camera at eye level with deep focus across the entire photograph. A quiet, fictional urban street in soft bright overcast daylight. Across the upper and middle frame a continuous gently receding facade of three- and four-story warm cream masonry and muted red brick buildings, with repeated dark window frames, muntins, fine stonework, a pair of small street trees with natural leaves on the left and right. Similar visual detail on both sides of the central split line and in the central crop of the picture. Bottom quarter is light-gray cobbled sidewalk with detail, softly lit and with restrained contrast so an overlaid reading card will stand out. Frame sky to a narrow strip or omit it. Preserve subtle details and varied frequencies without excessive microcontrast. Realistic lens perspective, natural colors and exposure, optically sharp from sidewalk to buildings, clean textures. No bokeh, tilt-shift, background blur, bloom, HDR halos, sharpening, crushed blacks, artificial grain, watermarks, visible brand names, readable storefront text, people, or vehicles. Output just the portrait scene, no borders.

## 驗證

837 個「模型 × 物距 × 輸出取樣密度」條件以 16384 pixels/tan(θ) 的未量化獨立取樣參考重播。Alcon Aspheric 在 1.0 D 改用 8192 來源級別，Synthetic Refractive EDOF 在 1.7 D 新增通過驗證的 4096 級別。全組最大差為 1 個 sRGB byte，最大線性 RMSE 為 0.000793，最大相對覆蓋面積誤差為 0.000004。九組 Python 影像參考依原角尺度、原錨點裁成可放進既有 GPU 背景預算的視野，涵蓋三個模型在 100、40、25 cm 的場景。

Chromium 157 和 WebKit 26.5 以 iPhone 11 的視窗及觸控設定測試首頁、逐格鍵、距離快捷鍵、分割畫面、校正後重開、切換模擬方法、兩筆 pending 曲線及強制 CPU fallback。兩個引擎的九組 WebGL2、CPU 和 Python 場景比對均在 1 個 sRGB byte 以內。Chromium 另以實際使用的新街景與閱讀卡做分割畫面 GPU／CPU 像素讀回，最大差也是 1 byte。58 項光學與渲染迴歸測試通過，Svelte 型別檢查無錯誤或警告。iPhone 實機 Safari 留待手機驗收。

在桌機 Chromium 模擬手機，關閉快取並以 400 kB/s、80 ms 限速，各重跑兩次。從開頁到提交含背景的第一個 Physics-based 畫面，前版為 4.68–5.04 s（經原有設定選單切換），新版為 3.78–4.28 s。該幀前已載入的資源本體合計由 1.45 MB 降至 1.08 MB。

40 cm 實際觀看距離下，單畫面及分割畫面各六個首次相鄰節點都命中 GPU 預取。暖快取的輸入至提交 p95 分別為 8.9 及 8.7 ms，前版為 9.0 及 9.3 ms。20 cm 實際觀看距離下，1.7／1.8 D 交替的 p95 由 11.6 ms 降為 8.7 ms，兩個節點都能走 WebGL2。較密的來源仍有超過手機快取預算的情況，例如預設觀看距離下的 100 cm 分割場景可走 CPU dynamic 路徑，切回 25 cm 可恢復 WebGL2。這些數字量測的是桌機瀏覽器的提交時間，手機實際畫面更新率須由實機量測。
