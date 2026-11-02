Project Goal

基於 IOLsimulator_mobile(https://github.com/raywentsai/IOLsimulator_mobile) 開發以 optrace(https://github.com/drocheam/optrace)為基礎的 physics-based IOL Vision Simulator。利用眼球及 IOL 光學模型、ray tracing 和 PSF-based rendering，模擬不同 IOL、物距、瞳孔及角膜條件下的成像，整合至桌機與手機皆可使用的互動式網頁。

Development Rules

* Frontend：保留 SvelteKit / TypeScript 架構，使用 npm 管理依賴。網頁僅負責載入 PSF、影像渲染與互動，不在瀏覽器執行 Python 光學計算。
* Optics：Python 離線計算獨立於 optics/，以 uv 管理環境及依賴。參考 /workspace/IOLsimulator_optrace 的 offline_rendering_v3.1，優先沿用 optrace 既有功能，避免重複實作。
* Modularity：將 IOL geometry、eye model、PSF calculation 與 browser rendering 分離；Python 與 TypeScript 透過明確定義的 PSF data format 及 metadata 銜接。
* Scientific integrity：統一物理單位、座標系統及 defocus 定義，記錄重要假設與參數來源。

Directory & File Management

* src/：SvelteKit / TypeScript 程式碼。
* static/：網頁所需資源，包括經處理的 PSF。
* optics/：Python 光學模型、必要生成程式及離線輸出。
* docs/：設計說明、參數來源及驗證報告。
* tests/：必要測試與數值驗證。
* .github/workflows/：自動建置與部署。

依實際需求建立資料夾，不建立空白架構。暫存檔及環境檔案不納入 Git；僅保留必要的程式碼、資料與研究紀錄，移除不再使用的冗餘檔案。

Git Usage

* 僅在使用者明確指示 commit 或 push 時執行。以完成的開發階段為單位整理提交，避免不必要的 Git history。
* 不修改或推送至原始 IOLsimulator_mobile repository。
