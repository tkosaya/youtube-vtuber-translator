const statusEl = document.querySelector("#status");
const providerInfoEl = document.querySelector("#providerInfo");
const toggleEl = document.querySelector("#toggle");
const toggleAudioEl = document.querySelector("#toggleAudio");
const optionsEl = document.querySelector("#options");
const exportLogsEl = document.querySelector("#exportLogs");
const logMsgEl = document.querySelector("#logMsg");

let currentCaptionStatus = null;
let isAudioRunning = false;
let activeTabId = null;

init();

async function init() {
  optionsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());
  exportLogsEl?.addEventListener("click", handleExportLogs);
  toggleEl.addEventListener("click", toggleCaption);
  toggleAudioEl.addEventListener("click", toggleAudio);
  await refresh();
}

async function handleExportLogs() {
  if (logMsgEl) logMsgEl.textContent = "匯出中...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "TRIGGER_EXPORT_LOGS" });
    if (res?.ok) {
      if (logMsgEl) logMsgEl.textContent = "✅ 已儲存至 Downloads/vtuber-translator-logs/";
    } else {
      if (logMsgEl) logMsgEl.textContent = `❌ ${res?.error || "匯出失敗"}`;
    }
  } catch (err) {
    if (logMsgEl) logMsgEl.textContent = `❌ ${err.message}`;
  }
  setTimeout(() => { if (logMsgEl) logMsgEl.textContent = ""; }, 4000);
}

async function refresh() {
  const tab = await getActiveTab();
  activeTabId = tab?.id;

  if (!tab?.id || !tab.url?.includes("youtube.com")) {
    providerInfoEl.textContent = "尚未在 YouTube 頁面";
    statusEl.textContent = "請先打開 YouTube 影片或直播分頁。";
    toggleEl.disabled = true;
    toggleAudioEl.disabled = true;
    return;
  }

  // 取得當前設定
  const settingsRes = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const settings = settingsRes?.settings || {};
  const liveEngine = settings.liveEngine || "gemini-live";
  const provider = settings.provider || "gemini";
  const model = provider === "gemini" ? (settings.geminiModel || "gemini-3.8-flash") : (settings.openaiModel || "gpt-4o-mini");
  const activeKey = provider === "gemini" ? (settings.geminiApiKey || settings.apiKey) : (settings.openaiApiKey || settings.apiKey);
  const geminiKey = settings.geminiApiKey || settings.apiKey;

  if (liveEngine === "gemini-live") {
    providerInfoEl.textContent = `聽譯引擎：⚡ Gemini Live 串流 (${settings.geminiLiveModel || "gemini-3.8-live"})`;
  } else if (liveEngine === "browser-local") {
    providerInfoEl.textContent = "聽譯引擎：🖥️ Chrome 本機串流 (免金鑰、零費用)";
  } else {
    providerInfoEl.textContent = `聽譯引擎：☁️ 遠端切片 (${provider === "gemini" ? "Gemini" : "OpenAI"} ${model})`;
  }

  // 直播聽譯按鈕控制
  if (liveEngine === "gemini-live") {
    toggleAudioEl.disabled = !geminiKey;
  } else if (liveEngine === "browser-local") {
    toggleAudioEl.disabled = false;
  } else {
    toggleAudioEl.disabled = !activeKey;
  }

  // 字幕翻譯按鈕 (需 API Key 進行文字批次處理)
  toggleEl.disabled = !activeKey;

  // 查詢音訊聽譯狀態
  try {
    const audioRes = await chrome.runtime.sendMessage({ type: "GET_AUDIO_STATUS" });
    isAudioRunning = Boolean(audioRes?.state?.running && audioRes?.state?.tabId === tab.id);
  } catch (_) {
    isAudioRunning = false;
  }

  // 查詢字幕監聽狀態
  try {
    currentCaptionStatus = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
  } catch (_error) {
    currentCaptionStatus = null;
  }

  render(liveEngine, activeKey, geminiKey);
}

function render(liveEngine = "gemini-live", hasActiveKey = false, hasGeminiKey = false) {
  // 更新直播聽譯按鈕
  if (isAudioRunning) {
    toggleAudioEl.textContent = "⏹️ 停止直播聽譯";
    toggleAudioEl.classList.add("active");
  } else {
    let engineLabel = "Gemini Live 串流";
    if (liveEngine === "browser-local") engineLabel = "本機串流";
    else if (liveEngine === "legacy-audio") engineLabel = "遠端切片";
    toggleAudioEl.textContent = `🎙️ 啟動直播聽譯 (${engineLabel})`;
    toggleAudioEl.classList.remove("active");
  }

  // 更新字幕翻譯按鈕
  if (currentCaptionStatus?.enabled) {
    toggleEl.textContent = "停用字幕翻譯";
  } else {
    toggleEl.textContent = hasActiveKey ? "啟用字幕翻譯 (有 CC 字幕適用)" : "啟用字幕翻譯 (需先填 API Key)";
  }

  // 狀態文字
  const lines = [];
  if (isAudioRunning) {
    let engineBadge = "⚡ Gemini Live 串流";
    if (liveEngine === "browser-local") engineBadge = "🖥️ 本機串流";
    else if (liveEngine === "legacy-audio") engineBadge = "☁️ 遠端切片";
    lines.push(`🔴【直播聽譯進行中】[${engineBadge}]`);
    lines.push("正在即時監聽分頁音訊並翻譯...");
  } else if (currentCaptionStatus?.enabled) {
    lines.push(`🟢【字幕模式】狀態：${currentCaptionStatus.status || "運作中"}`);
    lines.push(currentCaptionStatus.hasCaption ? "字幕：已偵測到 YouTube 字幕" : "字幕：尚未偵測到（需開啟 CC）");
  } else {
    lines.push("狀態：待命中");
    if (liveEngine === "gemini-live") {
      if (!hasGeminiKey) {
        lines.push("提示：當前為 Gemini Live 模式，請先進入設定填寫 Gemini API Key。");
      } else {
        lines.push("已就緒：點擊「啟動直播聽譯」享受 WebSocket 極低延遲同傳。");
      }
    } else if (liveEngine === "browser-local") {
      lines.push("已就緒：點擊上方「啟動直播聽譯」即可開始（免 API Key）。");
    } else if (!hasActiveKey) {
      lines.push("提示：當前為遠端切片模式，請先進入設定填寫 API Key。");
    } else {
      lines.push("請根據觀看內容選擇上方翻譯模式。");
    }
  }

  if (currentCaptionStatus?.lastError) {
    lines.push(`錯誤：${currentCaptionStatus.lastError}`);
  }

  statusEl.textContent = lines.join("\n");
}

async function toggleCaption() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  
  if (isAudioRunning) {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" });
    isAudioRunning = false;
  }

  const enabled = !currentCaptionStatus?.enabled;
  try {
    currentCaptionStatus = await chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled });
  } catch (err) {
    statusEl.textContent = "請重新整理 YouTube 頁面後再試一次。";
  }
  refresh();
}

async function toggleAudio() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  if (isAudioRunning) {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" });
    isAudioRunning = false;
    refresh();
  } else {
    if (currentCaptionStatus?.enabled) {
      await chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled: false }).catch(() => {});
      currentCaptionStatus.enabled = false;
    }

    try {
      statusEl.textContent = "正在啟動分頁音訊串流...";
      const res = await chrome.runtime.sendMessage({
        type: "START_AUDIO_CAPTURE",
        tabId: tab.id
      });
      if (res?.ok) {
        isAudioRunning = true;
      } else {
        alert(`啟動失敗: ${res?.error || "未知錯誤"}`);
      }
    } catch (err) {
      alert(`啟動錯誤: ${err.message}`);
    }
    refresh();
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
