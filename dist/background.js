const DEFAULT_SETTINGS = {
  liveEngine: "gemini-live", // "gemini-live" | "browser-local" | "legacy-audio"
  provider: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-3.8-flash",
  geminiLiveModel: "gemini-3.8-live",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLang: "繁體中文",
  batchSeconds: 12,
  minBatchLines: 3,
  fontSize: 28,
  backgroundOpacity: 0.72,
  glossaryEnabled: true,
  audioSliceSeconds: 1.8,
  maxSubtitleLines: 3,
  autoSaveLogs: true
};

const GLOSSARY_VERSION = "hololive-v1";
const GLOSSARY = [
  ["みこち", "Miko"],
  ["ぺこーら", "Pekora"],
  ["すいちゃん", "Suisei"],
  ["船長", "Marine"],
  ["スバル", "Subaru"],
  ["しゅば", "Shuba"],
  ["ホロメン", "hololive 成員"],
  ["ホロ鯖", "hololive 伺服器"],
  ["35P", "35P"],
  ["星街すいせい", "Hoshimachi Suisei"],
  ["さくらみこ", "Sakura Miko"],
  ["兎田ぺこら", "Usada Pekora"],
  ["大空スバル", "Oozora Subaru"],
  ["宝鐘マリン", "Houshou Marine"]
];

let audioCaptureState = {
  running: false,
  tabId: null,
  engine: "gemini-live"
};

let offscreenCreating = null;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  // 向下相容舊版金鑰
  if (!current.geminiApiKey && current.apiKey?.startsWith("AIza")) {
    patch.geminiApiKey = current.apiKey;
    patch.provider = "gemini";
  } else if (!current.openaiApiKey && current.apiKey?.startsWith("sk-")) {
    patch.openaiApiKey = current.apiKey;
    patch.provider = "openai";
  }
  // 自動升級已退役/不支援之舊模型至最新 gemini-3.8-flash
  if (current.geminiModel && (current.geminiModel.includes("2.5") || current.geminiModel.includes("2.0") || current.geminiModel.includes("1.5"))) {
    patch.geminiModel = "gemini-3.8-flash";
  }
  if (!current.geminiLiveModel || current.geminiLiveModel.includes("2.5") || current.geminiLiveModel.includes("2.0") || current.geminiLiveModel.includes("1.5")) {
    patch.geminiLiveModel = "gemini-3.8-live";
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSLATE_BATCH") {
    translateBatch(message.payload, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  // --- 分頁音訊聽譯控制 ---
  if (message?.type === "START_AUDIO_CAPTURE") {
    startAudioCapture(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "STOP_AUDIO_CAPTURE") {
    stopAudioCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "GET_AUDIO_STATUS") {
    sendResponse({ ok: true, state: audioCaptureState });
    return true;
  }

  // 轉發相容性探針請求給 offscreen.js
  if (message?.type === "RUN_COMPATIBILITY_PROBE") {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: "RUN_COMPATIBILITY_PROBE" }))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // 來自 offscreen.js 的即時字幕更新 (結構化 sessionId/utteranceId/revision)
  if (message?.type === "LIVE_SUBTITLE_UPDATE") {
    const targetTabId = message.tabId || audioCaptureState.tabId;
    if (targetTabId) {
      chrome.tabs.sendMessage(targetTabId, message).catch(() => {});
    }
    return true;
  }

  // --- 日誌與檔案匯出控制 ---
  if (message?.type === "SAVE_LOGS_TO_FILE") {
    saveLogsToFiles(message.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "TRIGGER_EXPORT_LOGS") {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: "GENERATE_LOGS_EXPORT" }))
      .then((res) => {
        if (!res?.ok || !res?.payload) throw new Error(res?.error || "無法取得日誌資料");
        return saveLogsToFiles(res.payload);
      })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "GET_TRANSLATION_LOGS") {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: "GET_TRANSLATION_LOGS" }))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message, logs: [] }));
    return true;
  }

  if (message?.type === "CLEAR_TRANSLATION_LOGS") {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: "CLEAR_TRANSLATION_LOGS" }))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // 向下相容
  if (!settings.geminiApiKey && settings.apiKey?.startsWith("AIza")) {
    settings.geminiApiKey = settings.apiKey;
  }
  if (!settings.openaiApiKey && settings.apiKey?.startsWith("sk-")) {
    settings.openaiApiKey = settings.apiKey;
  }
  return settings;
}

// --- Offscreen Document 生命週期管理 ---
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capturing tab audio for real-time live stream translation"
  });
  await offscreenCreating;
  offscreenCreating = null;
}

async function startAudioCapture(tabId) {
  const settings = await getSettings();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreenDocument();

  const res = await chrome.runtime.sendMessage({
    type: "START_OFFSCREEN_CAPTURE",
    payload: {
      streamId,
      tabId,
      settings: {
        ...settings,
        glossary: GLOSSARY
      }
    }
  });

  if (!res?.ok) {
    throw new Error(res?.error || "無法啟動音訊錄製");
  }

  audioCaptureState = { running: true, tabId, engine: settings.liveEngine || "gemini-live" };

  // 通知分頁切換為直播音訊監聽狀態
  chrome.tabs.sendMessage(tabId, {
    type: "SET_AUDIO_MODE",
    enabled: true
  }).catch(() => {});
}

async function saveLogsToFiles(payload) {
  if (!payload || (!payload.jsonlContent && !payload.markdownContent)) {
    return { ok: false, error: "無日誌內容可供匯出" };
  }
  const { jsonlContent, markdownContent, sessionId } = payload;
  const baseName = `${sessionId || "session_" + Date.now()}`;
  const savedFiles = [];

  try {
    if (jsonlContent) {
      const jsonlUri = "data:application/x-jsonlines;charset=utf-8," + encodeURIComponent(jsonlContent);
      await chrome.downloads.download({
        url: jsonlUri,
        filename: `vtuber-translator-logs/${baseName}.jsonl`,
        saveAs: false,
        conflictAction: "overwrite"
      });
      savedFiles.push(`vtuber-translator-logs/${baseName}.jsonl`);
    }

    if (markdownContent) {
      const mdUri = "data:text/markdown;charset=utf-8," + encodeURIComponent(markdownContent);
      await chrome.downloads.download({
        url: mdUri,
        filename: `vtuber-translator-logs/${baseName}.md`,
        saveAs: false,
        conflictAction: "overwrite"
      });
      savedFiles.push(`vtuber-translator-logs/${baseName}.md`);
    }

    console.log(`[VTuber Translator] 成功輸出日誌文件:`, savedFiles);
    return { ok: true, savedFiles, count: payload.count };
  } catch (err) {
    console.error("[VTuber Translator] 輸出日誌檔案失敗:", err);
    throw err;
  }
}

async function stopAudioCapture() {
  const settings = await getSettings();

  // 若啟用了自動存檔，於關閉前請求 offscreen 匯出並儲存日誌文件
  if (settings.autoSaveLogs !== false) {
    try {
      const logRes = await chrome.runtime.sendMessage({ type: "GENERATE_LOGS_EXPORT" });
      if (logRes?.ok && logRes?.payload) {
        await saveLogsToFiles(logRes.payload);
      }
    } catch (e) {
      console.warn("[VTuber Translator] 自動儲存日誌通知失敗 (可能尚未開始錄音):", e);
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: "STOP_OFFSCREEN_CAPTURE" });
  } catch (_) {}

  const prevTabId = audioCaptureState.tabId;
  audioCaptureState = { running: false, tabId: null, engine: "gemini-live" };

  if (prevTabId) {
    chrome.tabs.sendMessage(prevTabId, {
      type: "SET_AUDIO_MODE",
      enabled: false
    }).catch(() => {});
  }
}

// --- CC 字幕批次翻譯核心 (一般影片保持原樣) ---
async function translateBatch(payload) {
  const settings = await getSettings();
  const sourceLines = normalizeLines(payload?.lines || []);
  const videoId = String(payload?.videoId || "unknown");
  const context = String(payload?.context || "").slice(0, 1000);

  const provider = settings.provider || "gemini";
  const activeKey = provider === "gemini" ? settings.geminiApiKey : settings.openaiApiKey;

  if (!activeKey) {
    return { ok: false, error: `請先在設定中輸入 ${provider.toUpperCase()} API Key。` };
  }
  if (!sourceLines.length) {
    return { ok: true, translations: [] };
  }

  const cached = await readCachedTranslations(videoId, settings, sourceLines);
  const missing = sourceLines.filter((line) => !cached.has(line.text));

  if (missing.length) {
    const translated = provider === "gemini"
      ? await callGeminiText(settings, missing, context)
      : await callOpenAIText(settings, missing, context);

    await writeCachedTranslations(videoId, settings, translated);
    for (const item of translated) cached.set(item.source, item.translation);
  }

  return {
    ok: true,
    translations: sourceLines.map((line) => ({
      id: line.id,
      source: line.text,
      translation: cached.get(line.text) || ""
    }))
  };
}

function normalizeLines(lines) {
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    const text = compactText(line?.text || "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push({ id: String(line?.id || stableHash(text)), text });
  }
  return result.slice(0, 8);
}

// --- Gemini 文本翻譯 ---
async function callGeminiText(settings, lines, context) {
  const apiKey = settings.geminiApiKey || settings.apiKey;
  const model = settings.geminiModel || "gemini-2.5-flash";

  const glossaryText = settings.glossaryEnabled
    ? GLOSSARY.map(([source, target]) => `${source} => ${target}`).join("\n")
    : "disabled";

  const prompt = [
    `Translate Japanese VTuber/YouTube captions into ${settings.targetLang}.`,
    "Use natural spoken subtitle style.",
    "Preserve names, nicknames, memes, and VTuber terms according to the glossary.",
    "Do not invent missing content. If the source is fragmented, translate only what is present.",
    "Return only a JSON array of objects with 'source' and 'translation' keys. Example: [{\"source\":\"...\",\"translation\":\"...\"}]",
    "",
    "Glossary:",
    glossaryText,
    "",
    "Recent context:",
    context || "(none)",
    "",
    "Lines to translate (JSON array):",
    JSON.stringify(lines.map((line) => line.text), null, 2)
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const parsed = parseJsonArray(text);
  const bySource = new Map(parsed.map((item) => [compactText(item.source), compactText(item.translation)]));

  return lines.map((line) => ({
    source: line.text,
    translation: bySource.get(line.text) || compactText(parsed.shift()?.translation || "")
  }));
}

// --- OpenAI 文本翻譯 ---
async function callOpenAIText(settings, lines, context) {
  const apiKey = settings.openaiApiKey || settings.apiKey;
  const model = settings.openaiModel || settings.model || "gpt-4o-mini";

  const glossaryText = settings.glossaryEnabled
    ? GLOSSARY.map(([source, target]) => `${source} => ${target}`).join("\n")
    : "disabled";

  const prompt = [
    `Translate Japanese VTuber/YouTube captions into ${settings.targetLang}.`,
    "Use natural spoken subtitle style.",
    "Preserve names, nicknames, memes, and VTuber terms according to the glossary.",
    "Do not invent missing content. If the source is fragmented, translate only what is present.",
    "Return only JSON: an array of objects with source and translation strings.",
    "",
    "Glossary:",
    glossaryText,
    "",
    "Recent context:",
    context || "(none)",
    "",
    "Lines:",
    JSON.stringify(lines.map((line) => line.text), null, 2)
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a Japanese subtitle translator. Output only valid JSON array."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonArray(text);
  const bySource = new Map(parsed.map((item) => [compactText(item.source), compactText(item.translation)]));

  return lines.map((line) => ({
    source: line.text,
    translation: bySource.get(line.text) || compactText(parsed.shift()?.translation || "")
  }));
}

function parseJsonArray(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error("translation response is not a JSON array");
  return parsed.map((item) => ({
    source: String(item.source || ""),
    translation: String(item.translation || "")
  }));
}

async function readCachedTranslations(videoId, settings, lines) {
  const keys = lines.map((line) => cacheKey(videoId, settings, line.text));
  const stored = await chrome.storage.local.get(keys);
  const result = new Map();
  for (const line of lines) {
    const value = stored[cacheKey(videoId, settings, line.text)];
    if (typeof value === "string" && value) result.set(line.text, value);
  }
  return result;
}

async function writeCachedTranslations(videoId, settings, items) {
  const patch = {};
  for (const item of items) {
    if (item.translation) patch[cacheKey(videoId, settings, item.source)] = item.translation;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

function cacheKey(videoId, settings, source) {
  const provider = settings.provider || "gemini";
  return `cache:${videoId}:${provider}:${settings.targetLang}:${GLOSSARY_VERSION}:${stableHash(source)}`;
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function compactText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function readableError(error) {
  return error?.message || String(error);
}
