const DEFAULTS = {
  liveEngine: "gemini-live",
  provider: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-3.8-flash",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  targetLang: "繁體中文",
  audioSliceSeconds: 1.8,
  batchSeconds: 12,
  minBatchLines: 3,
  fontSize: 28,
  backgroundOpacity: 0.72,
  glossaryEnabled: true,
  maxSubtitleLines: 3,
  autoSaveLogs: true
};

const fields = Object.keys(DEFAULTS).reduce((acc, key) => {
  acc[key] = document.querySelector(`#${key}`);
  return acc;
}, {});

document.querySelector("#save").addEventListener("click", save);
document.querySelector("#runProbeBtn")?.addEventListener("click", runProbe);
document.querySelector("#exportLogsBtn")?.addEventListener("click", handleExportLogs);
document.querySelector("#clearLogsBtn")?.addEventListener("click", handleClearLogs);

if (fields.liveEngine) {
  fields.liveEngine.addEventListener("change", updateEngineVisibility);
}
if (fields.provider) {
  fields.provider.addEventListener("change", updateProviderVisibility);
}

load();

async function load() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), "apiKey", "model"]);
  const values = { ...DEFAULTS, ...stored };

  // 向下相容舊版單一 apiKey
  if (!values.geminiApiKey && values.apiKey?.startsWith("AIza")) {
    values.geminiApiKey = values.apiKey;
    values.provider = "gemini";
  } else if (!values.openaiApiKey && values.apiKey?.startsWith("sk-")) {
    values.openaiApiKey = values.apiKey;
    values.provider = "openai";
  }

  // 自動升級已退役/不支援之舊模型 (如 gemini-2.5-flash)
  if (values.geminiModel && (values.geminiModel.includes("2.5") || values.geminiModel.includes("2.0") || values.geminiModel.includes("1.5"))) {
    values.geminiModel = "gemini-3.8-flash";
    chrome.storage.local.set({ geminiModel: "gemini-3.8-flash" }).catch(() => {});
  }

  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(values[key]);
    else input.value = values[key] ?? "";
  }

  updateEngineVisibility();
  updateProviderVisibility();
}

function updateEngineVisibility() {
  const engine = fields.liveEngine?.value || "gemini-live";
  const localBox = document.querySelector("#localEngineBox");
  const remoteBox = document.querySelector("#remoteEngineBox");
  const geminiBox = document.querySelector("#geminiFieldset");
  const audioSliceRow = document.querySelector("#audioSliceRow");

  if (engine === "gemini-live") {
    if (localBox) {
      localBox.style.borderColor = "#e2e8f0";
      localBox.style.background = "#ffffff";
      localBox.style.opacity = "0.65";
    }
    if (remoteBox) {
      remoteBox.style.opacity = "1";
    }
    if (geminiBox) {
      geminiBox.style.borderColor = "#2563eb";
      geminiBox.style.background = "#eff6ff";
    }
    if (audioSliceRow) {
      audioSliceRow.style.display = "none";
    }
  } else if (engine === "browser-local") {
    if (localBox) {
      localBox.style.borderColor = "#2563eb";
      localBox.style.background = "#f0fdf4";
      localBox.style.opacity = "1";
    }
    if (remoteBox) {
      remoteBox.style.opacity = "0.65";
    }
    if (audioSliceRow) {
      audioSliceRow.style.display = "none";
    }
  } else {
    // legacy-audio
    if (localBox) {
      localBox.style.borderColor = "#e2e8f0";
      localBox.style.background = "#ffffff";
      localBox.style.opacity = "0.65";
    }
    if (remoteBox) {
      remoteBox.style.opacity = "1";
    }
    if (audioSliceRow) {
      audioSliceRow.style.display = "block";
    }
    updateProviderVisibility();
  }
}

function updateProviderVisibility() {
  const provider = fields.provider?.value || "gemini";
  const geminiBox = document.querySelector("#geminiFieldset");
  const openaiBox = document.querySelector("#openaiFieldset");

  if (geminiBox && openaiBox) {
    if (provider === "gemini") {
      geminiBox.style.borderColor = "#2563eb";
      geminiBox.style.background = "#eff6ff";
      openaiBox.style.borderColor = "#e2e8f0";
      openaiBox.style.background = "#ffffff";
    } else {
      openaiBox.style.borderColor = "#2563eb";
      openaiBox.style.background = "#eff6ff";
      geminiBox.style.borderColor = "#e2e8f0";
      geminiBox.style.background = "#ffffff";
    }
  }
}

async function save() {
  const patch = {};
  for (const [key, input] of Object.entries(fields)) {
    if (!input) continue;
    if (input.type === "checkbox") patch[key] = input.checked;
    else if (input.type === "number") patch[key] = Number(input.value);
    else patch[key] = input.value.trim();
  }

  await chrome.storage.local.set(patch);
  notifyContentScripts();
  
  chrome.runtime.sendMessage({
    type: "UPDATE_OFFSCREEN_SETTINGS",
    payload: patch
  }).catch(() => {});

  const msg = document.querySelector("#message");
  msg.textContent = "已儲存設定！直播聽譯引擎設定已即時更新。";
  setTimeout(() => {
    msg.textContent = "";
  }, 4000);
}

async function notifyContentScripts() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" }).catch(() => {});
  }
}

// 執行本機相容性探針診斷
async function runProbe() {
  const statusEl = document.querySelector("#probeStatus");
  const reportEl = document.querySelector("#probeReport");
  const btn = document.querySelector("#runProbeBtn");

  btn.disabled = true;
  statusEl.textContent = "診斷中，請稍候...";
  reportEl.style.display = "flex";

  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_COMPATIBILITY_PROBE" });
    if (!res?.ok) throw new Error(res?.error || "背景通訊超時");

    const r = res.report;
    statusEl.textContent = "診斷完成";

    setProbeItem("pWebSpeech", r.webSpeechSupported ? "✅ Web Speech API：瀏覽器原生支援" : "❌ Web Speech API：不支援", r.webSpeechSupported ? "ok" : "err");
    setProbeItem("pProcessLocally", r.processLocallySupported ? "✅ 本機辨識 (processLocally)：支援 (Chrome 139+)" : "⚠️ 本機辨識 (processLocally)：不支援 (可能回退雲端或受限)", r.processLocallySupported ? "ok" : "warn");
    setProbeItem("pAudioTrack", r.audioTrackParamAccepted ? "✅ 分頁音訊軌輸入：語法支援" : "⚠️ 分頁音訊軌輸入：呼叫被拒絕 (Chrome 可能僅限實體麥克風)", r.audioTrackParamAccepted ? "ok" : "warn");
    setProbeItem("pJapanesePack", r.japaneseSpeechAvailable === "available" ? "✅ 日文語音套件：已就緒" : `⚠️ 日文語音套件：${r.japaneseSpeechAvailable}`, r.japaneseSpeechAvailable === "available" ? "ok" : "warn");
    setProbeItem("pTranslator", r.translatorApiAvailable.includes("available") ? `✅ Built-in AI Translator：${r.translatorApiAvailable}` : "❌ Built-in AI Translator：未啟用 (可至 chrome://flags 檢查)", r.translatorApiAvailable.includes("available") ? "ok" : "err");
    setProbeItem("pTranslatePair", r.translatorPairAvailable === "readily" || r.translatorPairAvailable === "after-download" ? `✅ 日翻繁中 (ja ➔ zh-Hant)：支援 (${r.translatorPairAvailable})` : `⚠️ 日翻繁中配對狀態：${r.translatorPairAvailable}`, r.translatorPairAvailable === "readily" ? "ok" : "warn");

  } catch (err) {
    statusEl.textContent = `診斷失敗: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function setProbeItem(id, text, level) {
  const el = document.querySelector(`#${id}`);
  if (el) {
    el.textContent = text;
    el.className = `probe-item ${level}`;
  }
}

async function handleExportLogs() {
  const statusEl = document.querySelector("#logsStatusMsg");
  const btn = document.querySelector("#exportLogsBtn");
  if (statusEl) statusEl.textContent = "正在生成並匯出日誌...";
  if (btn) btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "TRIGGER_EXPORT_LOGS" });
    if (res?.ok) {
      if (statusEl) {
        statusEl.textContent = `✅ 已成功匯出日誌文件至 Downloads/vtuber-translator-logs/！共 ${res.count || 0} 筆事件。`;
        setTimeout(() => { statusEl.textContent = ""; }, 5000);
      }
    } else {
      if (statusEl) statusEl.textContent = `❌ 匯出日誌失敗：${res?.error || "無作用中的紀錄或背景無回應"}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ 匯出出錯: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleClearLogs() {
  const statusEl = document.querySelector("#logsStatusMsg");
  const btn = document.querySelector("#clearLogsBtn");
  if (btn) btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "CLEAR_TRANSLATION_LOGS" });
    if (res?.ok) {
      if (statusEl) {
        statusEl.textContent = "🗑️ 已清空目前會話日誌！";
        setTimeout(() => { statusEl.textContent = ""; }, 3000);
      }
    } else {
      if (statusEl) statusEl.textContent = `❌ 清空失敗：${res?.error || "未知錯誤"}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ 清空出錯: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
