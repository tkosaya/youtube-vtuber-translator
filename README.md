# VTuber YouTube Translator (v0.3.5)

專為觀看日本 VTuber 直播與影片打造的 Chrome 擴充功能（Manifest V3）。
提供 **「Gemini Live 串流 (低延遲)」、「Chrome 本機串流 (零費用)」** 與 **「遠端智慧語意切片 (Gemini 3.8 / OpenAI)」** 三大引擎，並內建 **「自動效能日誌與 Agent 診斷共享」** 系統。

---

## 🌟 核心特色

1. **⚡ Gemini Live 串流聽譯（極低延遲首選）**：
   - 使用 Gemini Multimodal Live API 進行全雙工 WebSocket 串流監聽。
   - 延遲低至 ~0.8s - 1.2s，隨講隨翻，無 HTTP 隊列塞車問題。

2. **🧠 智慧語意緩衝區 (Smart Linguistic Buffer) 切片引擎**：
   - 針對遠端切片模式，自動偵測未完句（結尾停在助詞「が、を、に、で、けど、から」等）。
   - 語意未完時自動暫緩並與下一段切片合體，輸出文法最完整道地的繁體中文長句。
   - 支援 3 行平滑滾動字幕，避免字幕被快速覆蓋或單行擁擠。

3. **🖥️ Chrome 本機串流聽譯（零費用）**：
   - 使用 Chrome 內建 Web Speech API 本機辨識（`ja-JP`）與 Built-in AI Translator API。
   - 完全免 API Key、無雲端費用、無 429 頻率限制。

4. **📊 效能日誌與 Agent 共享診斷系統**：
   - 自動記錄每次切片大小、送出時間點、API 毫秒級延遲、Buffer 狀態、字幕顯示時間點與丟包事件。
   - 停止聽譯或手動匯出時，自動存成 `.jsonl` 與 `.md` 檔案（儲存於 `Downloads/vtuber-translator-logs/`），方便直接與 AI Agent 共享進行語速與延遲調校。

5. **🔍 本機相容性診斷探針（Probe Test）**：
   - 內建於設定頁面，一鍵即時檢測當前 Chrome 瀏覽器對 Web Speech 本機辨識、分頁音訊軌輸入與日翻繁中 Translator API 的相容度。

---

## 🛠️ 本地安裝 / 載入教學

1. 打開 Chrome 瀏覽器，網址列進入 `chrome://extensions/`。
2. 開啟右上角的 **「開發人員模式」（Developer mode）**。
3. 點擊 **「載入未打包項目」（Load unpacked）**，並選取資料夾：
   ```text
   D:\GIT\youtube-vtuber-translator\dist
   ```
4. 若先前已載入舊路徑，可移除舊卡片或重新選取至本資料夾。

---

## ⚙️ 聽譯引擎選擇指引

點擊擴充功能圖示 ➔ 進入 **「⚙️ 設定」**：

* **模式 A：⚡ Gemini Live 串流模式 (推薦極低延遲)**
  * 需填入 Google Gemini API Key。
  * 適合追求超低延遲、與主播同頻即時互動的使用者。
* **模式 B：☁️ 遠端切片模式 (智慧語意緩衝)**
  * 支援 Google Gemini 3.8 Flash 或 OpenAI GPT-4o-mini。
  * 切片秒數建議設為 1.8 ~ 3.5 秒，支援 Hololive VTuber 專屬名詞庫與長句自動語意合體。
* **模式 C：🖥️ 本機串流模式 (免 API Key)**
  * 免填寫金鑰，零雲端費用。

---

## 📺 觀看使用方式

1. 打開 YouTube 上的 VTuber 直播頁面。
2. 點擊瀏覽器右上角擴充功能圖示。
3. 點擊按鈕 **「🎙️ 啟動直播聽譯」** 即可立即開始！
4. 畫面上方 HUD 會即時顯示目前健康度（延遲秒數與緩衝狀態）。
5. 點擊 **「⏹️ 停止直播聽譯」** 時，系統會自動在下載資料夾產生該次會話的完整效能與對白紀錄。
