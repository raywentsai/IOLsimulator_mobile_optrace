# Phase 11 模型與資料一致性

**Simulation Method** 分為 **Acuity-derived** 與 **Physics-based (optrace)**。兩種方法各自保存主鏡與比較鏡的選擇。切換時以該方法的選單與資料重新提交畫面，避免舊畫面搭配新鏡片名稱。

## Physics-based (optrace)

| 顯示名稱 | 既有 PSF／光學影像鍵 | 幾何來源 |
| --- | --- | --- |
| Synthetic Spherical Monofocal | `spherical_monofocal_dc_v1` | 專案的近軸匹配合成對照，含既有二次 sag 校正。 |
| Alcon Aspheric Monofocal | `aspheric_monofocal_dc_v1` | 採用 optrace 論文算例的 Alcon AcrySof IQ SN60WF 基礎幾何。 |
| Synthetic Refractive EDOF | `vivity_inspired_v2_1_dc_v1` | 使用 Garzón 等人的徑向屈光力資料及假設表面，模擬 Vivity-like 光學特性。 |

Alcon 基礎幾何與論文配套程式的數值一致。前表面半徑為 21.557 mm，後表面半徑為 −22 mm，圓錐常數為 −42.1929，中央厚度為 0.593 mm。配套程式引用 Alcon 專利 US7350916B2。專案現有 PSF 另含凍結的前表面二次 sag 遠距校正，以及 3 mm 瞳孔、平均角膜與 D65 photopic Y 條件。EDOF 模型的假設與推導記在原始模型檔。這些條件界定了本專案可重播的光學模擬。 [2024 年模型論文](https://pmc.ncbi.nlm.nih.gov/articles/PMC11343009/) · [2025 年成像論文](https://pubmed.ncbi.nlm.nih.gov/41533878/) · [optrace 論文算例](https://github.com/drocheam/optrace/blob/adad608acedb08c2d99688613fa01034865c9d47/examples/IOL_target_imaging.py) · [本專案來源記錄](../optics/PROVENANCE.md)

UI、PSF manifest 的 `modelIdentities` 和各預計算光學影像 manifest 的 `identity` 使用同一份模型資料。PSF manifest 的 `models` 保留凍結的來源快照以供追溯。與 Phase 10B 比對，96 個 PSF 檔、170 張光學影像、對應的光學參數與雜湊逐一相同。

## Acuity-derived

| 商業 IOL | 光學設計 | 現階段曲線 |
| --- | --- | --- |
| Alcon AcrySof SN60AT | 球面單焦 | 型號專屬曲線待補。 |
| Alcon AcrySof IQ SN60WF | 非球面單焦 | 型號專屬曲線待補。 |
| Alcon AcrySof IQ Vivity | 非繞射折射式 EDOF，DFT015 與 DAT015 同屬該系列 | 沿用 `vivity` 的舊版取樣，標示為 legacy curve。 |

SN60AT 的球面設計可由光學台研究確認。SN60WF 是 optrace 論文使用的非球面單焦參考型號，在 Acuity-derived 仍需自己的臨床 defocus curve。FDA 標籤分別列出 Vivity DFT015 與 DAT015。Pantanelli 等人的文章在前言提到 DFT015、方法則寫 DAT015，因此現有取樣標示為 Vivity 系列資料，待下一階段核對取樣與植入型號。 [球面設計的實測研究](https://pubmed.ncbi.nlm.nih.gov/40067659/) · [Alcon SN60WF 型號](https://www.myalcon.com/uk/professional/cataract-surgery/iols/acrysof-iq-monofocal/) · [FDA Vivity 型號資料](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?id=P930014S126) · [Pantanelli 等人](https://pmc.ncbi.nlm.nih.gov/articles/PMC10050137/)

舊版把 enVista 的中性非球面曲線放在球面模型名稱下，也把 TECNIS ZCB00 的非球面曲線與 Alcon 幾何共用選項。這兩份資料以實際鏡片名稱保留在資料檔中，供後續來源審查。SN60AT 與 SN60WF 選項顯示 **Clinical defocus curve pending**，分割檢視仍可顯示具有曲線的一側。預設主鏡選用有曲線的 Vivity，預設比較鏡為 SN60WF。Gaussian blur 的映射與既有曲線取樣值沿用 Phase 10B。

下一階段將為 SN60AT 與 SN60WF 選定同型號的臨床研究，記錄量測條件、曲線來源與取樣方式，並重新擷取 Vivity。手機驗收可先在 Acuity-derived 選 SN60AT 與 Vivity 進行分割檢視，再切到 Physics-based (optrace) 選擇兩個光學模型，最後切回確認各自選擇及校正仍正確。

## 驗證

60 項自動測試通過。Chrome 與 Playwright WebKit 的手機模擬驗證兩套選單、主鏡與比較鏡的選擇還原、缺曲線時的半邊遮罩、校正與九組 WebGL2 光學參考。Phase 10 重播確認 40 cm 的方向預取與暖路徑、100 cm 的三種取樣網格，以及 20 cm 往返 CPU／GPU 時的暖資產都能使用。桌面 40 cm 暖幀 p95 為 8.9–9.1 ms，Phase 10B 為 8.8–9.1 ms。首次造訪的預取命中會隨資產完成時間變動。
