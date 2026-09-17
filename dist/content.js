const DEFAULT_CONTENT_SETTINGS = {
  batchSeconds: 12,
  minBatchLines: 3,
  fontSize: 28,
  backgroundOpacity: 0.72,
  maxSubtitleLines: 3
};

const state = {
  enabled: false,
  audioMode: false,
  status: "未啟用",
  lastError: "",
  lastCaption: "",
  lastTranslation: "",
  displayLines: [], // 多行字幕佇列：{ text, clean, isIncomplete, timestamp }
  interimSource: "",
  lastLatencyMs: 0,
  lastBufferCount: 0,
  dropNotice: "",
  dropNoticeTimer: null,
  engine: "gemini-live",
  sessionId: 0,
  utteranceId: 0,
  lastRevision: 0,
  pending: [],
  recentContext: [],
  translatedBySource: new Map(),
  lastFlushAt: Date.now(),
  currentVideoId: "",
  settings: { ...DEFAULT_CONTENT_SETTINGS },
  overlay: null,
  overlayText: null,
  overlayMeta: null
};

init();

async function init() {
  await refreshSettings();
  ensureOverlay();
  observeNavigation();
  setInterval(tick, 700);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SET_ENABLED") {
    state.enabled = Boolean(message.enabled);
    if (state.enabled) {
      state.audioMode = false;
    } else {
      state.displayLines = [];
      state.lastTranslation = "";
      state.interimSource = "";
    }
    state.status = state.enabled ? "等待字幕" : "未啟用";
    state.lastError = "";
    updateOverlay();
    sendResponse(getPublicStatus());
    return true;
  }

  if (message?.type === "SET_AUDIO_MODE") {
    state.audioMode = Boolean(message.enabled);
    if (state.audioMode) {
      state.enabled = false;
      state.engine = message.engine || "gemini-live";
      if (state.engine === "gemini-live") {
        state.status = "🎙️ 正在連線 Gemini Live 伺服器...";
      } else if (state.engine === "browser-local") {
        state.status = "🎙️ 本機串流聽譯中 (辨識日文中...)";
      } else {
        state.status = "🎙️ 遠端切片聽譯中 (聆聽音訊中...)";
      }
      state.lastError = "";
      state.dropNotice = "";
    } else {
      state.displayLines = [];
      state.lastTranslation = "";
      state.interimSource = "";
      state.status = "待命";
    }
    updateOverlay();
    sendResponse(getPublicStatus());
    return true;
  }

  if (message?.type === "LIVE_SUBTITLE_UPDATE") {
    // 檢查 sessionId (更換直播或重新連線)
    if (message.sessionId && message.sessionId !== state.sessionId) {
      state.sessionId = message.sessionId;
      state.utteranceId = message.utteranceId || 0;
      state.lastRevision = message.revision || 0;
      state.lastError = "";
      state.dropNotice = "";
    }

    // 版本淘汰機制：防網路或異步競態導致字幕倒序
    if (typeof message.utteranceId === "number") {
      if (message.utteranceId < state.utteranceId) {
        // 舊句子的遲到結果，丟棄
        return true;
      }
      if (message.utteranceId === state.utteranceId && typeof message.revision === "number") {
        if (message.revision < state.lastRevision) {
          // 同一句但版本較舊，丟棄
          return true;
        }
        state.lastRevision = message.revision;
      } else if (message.utteranceId > state.utteranceId) {
        state.utteranceId = message.utteranceId;
        state.lastRevision = message.revision || 0;
      }
    }

    if (message.engine) state.engine = message.engine;
    if (message.statusText) state.status = message.statusText;

    if (message.error) {
      state.lastError = message.error;
    } else {
      state.lastError = "";
    }

    if (message.dropNotice) {
      state.dropNotice = message.dropNotice;
      if (state.dropNoticeTimer) clearTimeout(state.dropNoticeTimer);
      state.dropNoticeTimer = setTimeout(() => {
        state.dropNotice = "";
        updateOverlay();
      }, 4000);
    } else if (message.translatedText) {
      // 成功收到新譯文時清除丟包提示
      state.dropNotice = "";
    }

    if (typeof message.apiLatencyMs === "number") {
      state.lastLatencyMs = message.apiLatencyMs;
    }
    if (typeof message.bufferCount === "number") {
      state.lastBufferCount = message.bufferCount;
    }

    if (message.sourceText) {
      state.interimSource = message.sourceText;
    }

    if (message.translatedText) {
      state.lastTranslation = message.translatedText;
      addOrUpdateTranslationLines(message.translatedText, message.isIncomplete);
      state.interimSource = ""; // 繁中出爐後清除暫時日文
      state.status = state.engine === "gemini-live" ? "🎙️ Gemini Live 極速聽譯" : (state.engine === "browser-local" ? "🎙️ 本機串流聽譯" : "🎙️ 遠端切片聽譯");
    }

    updateOverlay();
    sendResponse(getPublicStatus());
    return true;
  }

  if (message?.type === "GET_STATUS") {
    sendResponse(getPublicStatus());
    return true;
  }

  if (message?.type === "SETTINGS_UPDATED") {
    refreshSettings().then(() => {
      updateOverlay();
      sendResponse(getPublicStatus());
    });
    return true;
  }

  return false;
});

async function refreshSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (response?.ok) {
    state.settings = { ...DEFAULT_CONTENT_SETTINGS, ...response.settings };
  }
}

function observeNavigation() {
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    resetForVideo();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function resetForVideo() {
  state.currentVideoId = getVideoId();
  state.displayLines = [];
  state.lastCaption = "";
  state.lastTranslation = "";
  state.interimSource = "";
  state.dropNotice = "";
  state.lastLatencyMs = 0;
  state.lastBufferCount = 0;
  if (state.dropNoticeTimer) clearTimeout(state.dropNoticeTimer);
  state.dropNoticeTimer = null;
  state.sessionId = 0;
  state.utteranceId = 0;
  state.lastRevision = 0;
  state.pending = [];
  state.recentContext = [];
  state.translatedBySource.clear();
  state.lastFlushAt = Date.now();
  state.status = state.enabled ? "等待字幕" : (state.audioMode ? "待命中" : "未啟用");
  state.lastError = "";
  updateOverlay();
}

function tick() {
  ensureOverlay();
  if (!state.enabled || state.audioMode) return;

  const videoId = getVideoId();
  if (videoId !== state.currentVideoId) resetForVideo();

  const caption = readVisibleCaption();
  if (!caption) {
    state.status = "等待字幕";
    updateOverlay();
    return;
  }

  if (caption !== state.lastCaption) {
    state.lastCaption = caption;
    state.status = "收集字幕";
    addPendingCaption(caption);
    renderKnownTranslation(caption);
  }

  maybeFlush();
}

function readVisibleCaption() {
  const selectors = [
    ".ytp-caption-segment",
    ".caption-window .ytp-caption-segment",
    ".ytp-caption-window-container span"
  ];
  const parts = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const text = node.textContent?.trim();
      if (text) parts.push(text);
    }
    if (parts.length) break;
  }
  return compactText(parts.join(" "));
}

function addPendingCaption(text) {
  const id = stableHash(`${getVideoId()}:${text}`);
  if (!state.pending.some((item) => item.text === text) && !state.translatedBySource.has(text)) {
    state.pending.push({ id, text });
  }
  state.recentContext.push(text);
  state.recentContext = state.recentContext.slice(-8);
}

function renderKnownTranslation(source) {
  const translation = state.translatedBySource.get(source);
  if (translation) {
    state.lastTranslation = translation;
    addOrUpdateTranslationLines(translation, false);
    state.status = "已啟用";
    updateOverlay();
  }
}

function maybeFlush() {
  if (!state.pending.length) return;
  const elapsedSeconds = (Date.now() - state.lastFlushAt) / 1000;
  const shouldFlush =
    state.pending.length >= Number(state.settings.minBatchLines || 3) ||
    elapsedSeconds >= Number(state.settings.batchSeconds || 12);

  if (!shouldFlush) return;
  const lines = state.pending.splice(0, 8);
  state.lastFlushAt = Date.now();
  translate(lines);
}

async function translate(lines) {
  state.status = "翻譯中";
  updateOverlay();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      payload: {
        videoId: getVideoId(),
        lines,
        context: state.recentContext.join("\n")
      }
    });

    if (!response?.ok) throw new Error(response?.error || "翻譯失敗");
    for (const item of response.translations || []) {
      if (item.source && item.translation) {
        state.translatedBySource.set(compactText(item.source), compactText(item.translation));
      }
    }

    const latest = [...lines].reverse().map((line) => state.translatedBySource.get(line.text)).find(Boolean);
    if (latest) {
      state.lastTranslation = latest;
      addOrUpdateTranslationLines(latest, false);
    }
    state.status = "已啟用";
    state.lastError = "";
  } catch (error) {
    state.status = "錯誤";
    state.lastError = error?.message || String(error);
  }
  updateOverlay();
}

function splitSentences(text) {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    current += char;

    if (char === "\n") {
      const s = current.trim();
      if (s) sentences.push(s);
      current = "";
      continue;
    }

    if (/[。！？!?]/.test(char)) {
      while (i + 1 < trimmed.length && /[。！？!?」』）\)'"”]/.test(trimmed[i + 1])) {
        i++;
        current += trimmed[i];
      }
      const s = current.trim();
      if (s) sentences.push(s);
      current = "";
      continue;
    }

    if (current.endsWith("...") || current.endsWith("…")) {
      while (i + 1 < trimmed.length && (trimmed[i + 1] === "." || trimmed[i + 1] === "…")) {
        i++;
        current += trimmed[i];
      }
      const hasSubstantiveText = current.replace(/[\s\.\…]+/g, "").length > 0;
      const isEndOrBreak = (i + 1 >= trimmed.length) || /\s/.test(trimmed[i + 1]);
      if (hasSubstantiveText && isEndOrBreak) {
        const s = current.trim();
        if (s) sentences.push(s);
        current = "";
      }
    }
  }

  if (current.trim()) {
    sentences.push(current.trim());
  }

  return sentences.length > 0 ? sentences : [trimmed];
}

function isSimilarSentence(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) {
    const minLen = Math.min(a.length, b.length);
    const maxLen = Math.max(a.length, b.length);
    if (minLen / maxLen > 0.65) return true;
  }
  let commonPrefix = 0;
  while (commonPrefix < a.length && commonPrefix < b.length && a[commonPrefix] === b[commonPrefix]) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (commonSuffix < a.length && commonSuffix < b.length && a[a.length - 1 - commonSuffix] === b[b.length - 1 - commonSuffix]) {
    commonSuffix++;
  }
  const overlap = commonPrefix + commonSuffix;
  const avgLen = (a.length + b.length) / 2;
  return (overlap / avgLen) > 0.65;
}

function addOrUpdateTranslationLines(incomingText, isIncompleteFlag) {
  if (!incomingText) return;
  const rawSentences = splitSentences(incomingText);
  if (!rawSentences.length) return;

  const maxLines = Math.max(1, Math.min(5, Number(state.settings.maxSubtitleLines || 3)));
  const normalize = (s) => s.replace(/[\s。！？!?\.\…（未完）]+/g, "");

  const processed = rawSentences.map((s, idx) => {
    const isLast = idx === rawSentences.length - 1;
    const endsWithDots = s.endsWith("...") || s.endsWith("…") || s.includes("（未完）");
    const isInc = isLast && (typeof isIncompleteFlag === "boolean" ? isIncompleteFlag : endsWithDots);
    const cleanText = s.replace(/（未完）/g, "").trim();
    return {
      text: cleanText,
      clean: normalize(cleanText),
      isIncomplete: isInc,
      timestamp: Date.now()
    };
  });

  for (const item of processed) {
    if (!item.clean) continue;

    if (state.displayLines.length === 0) {
      state.displayLines.push(item);
      continue;
    }

    // 檢查是否已在畫面的完整行中（防同一切片/緩衝重複洗版，支援模糊去重）
    const existingIdx = state.displayLines.findIndex(l => !l.isIncomplete && (l.clean === item.clean || isSimilarSentence(l.clean, item.clean)));
    if (existingIdx !== -1) {
      if (item.text.length > state.displayLines[existingIdx].text.length) {
        state.displayLines[existingIdx].text = item.text;
      }
      continue;
    }

    const lastIdx = state.displayLines.length - 1;
    const lastLine = state.displayLines[lastIdx];

    // 如果最後一行是未完斷句（isIncomplete），新句子正是用來補全/取代它的
    if (lastLine.isIncomplete) {
      lastLine.text = item.text;
      lastLine.clean = item.clean;
      lastLine.isIncomplete = item.isIncomplete;
      lastLine.timestamp = Date.now();
      continue;
    }

    // 全新句子：新增為新的一行
    state.displayLines.push(item);
  }

  // 限制最大顯示行數（超出時滾動移除最舊行）
  while (state.displayLines.length > maxLines) {
    state.displayLines.shift();
  }
}

function ensureOverlay() {
  if (state.overlay?.isConnected) return;

  const player = document.querySelector("#movie_player") || document.body;
  const host = document.createElement("div");
  host.id = "vtuber-translator-host";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 58px;
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      justify-content: center;
      padding: 0 24px;
      box-sizing: border-box;
      font-family: Arial, "Noto Sans TC", "Microsoft JhengHei", sans-serif;
    }
    .box {
      max-width: min(92vw, 1100px);
      color: #fff;
      text-align: center;
      line-height: 1.4;
      text-shadow: 0 2px 4px #000, 0 0 8px #000;
      border-radius: 8px;
      padding: 10px 18px;
      white-space: normal;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(4px);
    }
    .subtitles-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
    }
    .sub-line {
      word-break: break-word;
      transition: all 0.2s ease-in-out;
    }
    .sub-line-history {
      font-size: 0.86em;
      opacity: 0.65;
      color: #cbd5e1;
    }
    .sub-line-current {
      font-size: 1.0em;
      opacity: 1;
      font-weight: 500;
      color: #ffffff;
    }
    .sub-line-incomplete {
      color: #bae6fd;
    }
    .interim-source {
      font-size: 0.65em;
      opacity: 0.85;
      margin-top: 5px;
      color: #7dd3fc;
    }
    .meta {
      margin-top: 6px;
      font-size: 12px;
      opacity: 0.75;
    }
  `;

  const box = document.createElement("div");
  box.className = "box";
  const text = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "meta";
  box.append(text, meta);
  shadow.append(style, box);

  if (player !== document.body) {
    const computed = getComputedStyle(player);
    if (computed.position === "static") player.style.position = "relative";
  }
  player.appendChild(host);

  state.overlay = host;
  state.overlayText = text;
  state.overlayMeta = meta;
  updateOverlay();
}

function updateOverlay() {
  if (!state.overlay || !state.overlayText || !state.overlayMeta) return;
  const box = state.overlay.shadowRoot.querySelector(".box");
  box.style.fontSize = `${Number(state.settings.fontSize || 28)}px`;
  box.style.background = `rgba(0, 0, 0, ${Number(state.settings.backgroundOpacity || 0.72)})`;

  const hasLines = state.displayLines && state.displayLines.length > 0;
  const visible = (state.enabled || state.audioMode) && (hasLines || state.lastTranslation || state.interimSource || state.status !== "已啟用");
  state.overlay.style.display = visible ? "flex" : "none";

  if (hasLines) {
    const total = state.displayLines.length;
    const linesHtml = state.displayLines.map((line, idx) => {
      const isCurrent = idx === total - 1;
      const lineClass = isCurrent ? "sub-line sub-line-current" : "sub-line sub-line-history";
      const incClass = line.isIncomplete ? " sub-line-incomplete" : "";
      return `<div class="${lineClass}${incClass}">${escapeHtml(line.text)}</div>`;
    }).join("");

    let contentHtml = `<div class="subtitles-container">${linesHtml}</div>`;
    if (state.interimSource) {
      contentHtml += `<div class="interim-source">▶ ${escapeHtml(state.interimSource)}</div>`;
    }
    state.overlayText.innerHTML = contentHtml;
  } else if (state.interimSource) {
    state.overlayText.textContent = `▶ ${state.interimSource}`;
  } else if (state.lastError) {
    state.overlayText.innerHTML = `<div style="color: #f87171; font-size: 0.85em;">⚠️ ${escapeHtml(state.lastError)}</div>`;
  } else {
    state.overlayText.textContent = state.status;
  }

  // 狀態欄與丟包提醒
  const metaParts = [];
  if (state.dropNotice) {
    metaParts.push(state.dropNotice);
  }
  if (state.lastError && hasLines) {
    metaParts.push(`⚠️ ${state.lastError.slice(0, 120)}`);
  } else if (state.audioMode) {
    let engineName = "Gemini Live 串流 (極速同傳)";
    if (state.engine === "browser-local") engineName = "本機串流 (零費用)";
    else if (state.engine === "legacy-audio") engineName = "遠端切片 (Gemini/OpenAI)";
    let metaText = `🎙️ 直播聽譯中 · [${engineName}]`;
    if (state.lastLatencyMs > 0) {
      metaText += ` | ⚡ 延遲: ${(state.lastLatencyMs / 1000).toFixed(2)}s`;
    }
    if (typeof state.lastBufferCount === "number" && state.lastBufferCount > 0) {
      metaText += ` | 📦 緩衝: ${state.lastBufferCount}片`;
    }
    metaParts.push(metaText);
  } else {
    metaParts.push(state.status);
  }
  state.overlayMeta.textContent = metaParts.join(" | ");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getPublicStatus() {
  return {
    enabled: state.enabled,
    audioMode: state.audioMode,
    status: state.status,
    lastError: state.lastError,
    hasCaption: Boolean(state.lastCaption),
    videoId: getVideoId()
  };
}

function getVideoId() {
  return new URL(location.href).searchParams.get("v") || location.pathname;
}

function compactText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
