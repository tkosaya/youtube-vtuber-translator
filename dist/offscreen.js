// Offscreen Document: 負責音訊擷取、Gemini Multimodal Live (WebSocket)、本機辨識 與 遠端切片引擎
let currentStream = null;
let audioContext = null;
let isRunning = false;
let currentTabId = null;
let currentSettings = null;
let currentEngine = "gemini-live";

// --- 引擎 1：Gemini Multimodal Live API (WebSocket 雙向即時串流) ---
let liveWs = null;
let pcmAudioContext = null;
let pcmProcessor = null;
let isLiveSetupComplete = false;
let liveAccumulatedText = "";
let liveClearTimer = null;

// --- 引擎 2：本機串流模式 (browser-local) 狀態 ---
let recognition = null;
let localTranslator = null;
let localTranslateTimer = null;
let localSessionId = 0;
let localUtteranceId = 0;
let localRevision = 0;
let localRetryCount = 0;
const MAX_LOCAL_RETRIES = 3;

// --- 引擎 3：舊版切片模式 (legacy-audio) 佇列與狀態 ---
let mediaRecorder = null;
let recordTimer = null;
let audioQueue = [];
let isProcessingQueue = false;
let rateLimitCooldownUntil = 0;

// --- 診斷與全歷程日誌系統 ---
let sessionStartTime = 0;
let sessionId = "";
let chunkSequence = 0;
let currentSessionLogs = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_OFFSCREEN_CAPTURE") {
    startCapture(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "STOP_OFFSCREEN_CAPTURE") {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "UPDATE_OFFSCREEN_SETTINGS") {
    currentSettings = { ...currentSettings, ...message.payload };
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "RUN_COMPATIBILITY_PROBE") {
    runCompatibilityProbe()
      .then((report) => sendResponse({ ok: true, report }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "GENERATE_LOGS_EXPORT") {
    const payload = generateLogsExportData();
    sendResponse({ ok: true, payload });
    return true;
  }

  if (message?.type === "GET_TRANSLATION_LOGS") {
    sendResponse({
      ok: true,
      logs: currentSessionLogs,
      sessionId,
      chunkCount: chunkSequence,
      sessionStartTime
    });
    return true;
  }

  if (message?.type === "CLEAR_TRANSLATION_LOGS") {
    currentSessionLogs = [];
    chunkSequence = 0;
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ==========================================
// 日誌紀錄與格式化導出核心
// ==========================================
function logEvent(eventType, data = {}) {
  const timestamp = new Date().toISOString();
  const entry = {
    sessionId,
    timestamp,
    eventType,
    ...data
  };
  currentSessionLogs.push(entry);
  if (currentSessionLogs.length > 1000) {
    currentSessionLogs.shift();
  }

  const colorMap = {
    SESSION_START: "color: #10b981; font-weight: bold;",
    SESSION_STOP: "color: #6b7280; font-weight: bold;",
    CHUNK_RECORDED: "color: #3b82f6;",
    API_RESPONSE: "color: #8b5cf6; font-weight: bold;",
    SUBTITLE_DISPLAYED: "color: #06b6d4; font-weight: bold;",
    CHUNK_DROPPED: "color: #ef4444; font-weight: bold;",
    ERROR: "color: #dc2626; font-weight: bold;"
  };
  const style = colorMap[eventType] || "color: #64748b;";
  console.log(`%c[VTuber-Log] [${eventType}]%c ${JSON.stringify(data)}`, style, "color: inherit;");
  return entry;
}

function generateLogsExportData() {
  const jsonlContent = currentSessionLogs.map(e => JSON.stringify(e)).join("\n");

  const apiResponses = currentSessionLogs.filter(e => e.eventType === "API_RESPONSE");
  const drops = currentSessionLogs.filter(e => e.eventType === "CHUNK_DROPPED");
  const errors = currentSessionLogs.filter(e => e.eventType === "ERROR");
  const avgLatency = apiResponses.length > 0
    ? Math.round(apiResponses.reduce((sum, e) => sum + (e.apiLatencyMs || 0), 0) / apiResponses.length)
    : 0;
  const maxLatency = apiResponses.length > 0
    ? Math.max(...apiResponses.map(e => e.apiLatencyMs || 0))
    : 0;
  const minLatency = apiResponses.length > 0
    ? Math.min(...apiResponses.map(e => e.apiLatencyMs || 0))
    : 0;
  const bufferHolds = currentSessionLogs.filter(e => e.eventType === "API_RESPONSE" && e.isIncomplete);

  let md = `# VTuber 直播聽譯效能與語意分析紀錄\n\n`;
  md += `- **會話代號 (Session ID)**: \`${sessionId || "session_" + Date.now()}\`\n`;
  md += `- **引擎與模型**: \`${currentEngine}\` (${currentSettings?.geminiModel || currentSettings?.model || "default"})\n`;
  md += `- **目標語言**: ${currentSettings?.targetLang || "繁體中文"}\n`;
  md += `- **切片長度**: ${currentSettings?.audioSliceSeconds || 1.8} 秒\n`;
  md += `- **記錄時間**: ${sessionStartTime ? new Date(sessionStartTime).toLocaleString() : new Date().toLocaleString()}\n`;
  md += `- **總處理切片數**: ${chunkSequence} 片\n`;
  md += `- **API 響應次數**: ${apiResponses.length} 次\n`;
  md += `- **平均 API 延遲**: ${avgLatency} ms (最小: ${minLatency} ms, 最大: ${maxLatency} ms)\n`;
  md += `- **語意緩衝 (Buffer) 暫存次數**: ${bufferHolds.length} 次\n`;
  md += `- **丟包次數 (Dropped)**: ${drops.length} 次\n`;
  md += `- **錯誤次數 (Errors)**: ${errors.length} 次\n\n`;

  md += `## 🕒 聽譯事件時間軸明細\n\n`;
  md += `| 時間 (UTC) | 切片# | 事件類型 | 耗時(ms) | Buffer | 原始回傳 (Raw Text) | 最終輸出 (Output) |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const e of currentSessionLogs) {
    const timeStr = e.timestamp ? e.timestamp.slice(11, 23) : "-";
    const chunkStr = e.chunkId ? `#${e.chunkId}` : "-";
    const latencyStr = typeof e.apiLatencyMs === "number" ? `${e.apiLatencyMs}ms` : "-";
    const bufStr = typeof e.bufferCount === "number" ? `${e.bufferCount}片 (${e.totalBufferDurationSec || 0}s)` : "-";
    const rawStr = (e.rawOutput || "").replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 60) || "-";
    const outStr = (e.displayedText || e.text || e.completedSentences?.join("；") || e.detail || e.reason || e.error || "-").replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 60);

    md += `| ${timeStr} | ${chunkStr} | ${e.eventType} | ${latencyStr} | ${bufStr} | ${rawStr} | ${outStr} |\n`;
  }

  return {
    sessionId: sessionId || `session_${Date.now()}`,
    jsonlContent,
    markdownContent: md,
    count: currentSessionLogs.length
  };
}

// ==========================================
// 核心啟動與停止管線
// ==========================================
async function startCapture({ streamId, tabId, settings }) {
  stopCapture();
  currentTabId = tabId;
  currentSettings = settings;
  currentEngine = settings?.liveEngine || "gemini-live";

  sessionStartTime = Date.now();
  sessionId = `session_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  chunkSequence = 0;
  currentSessionLogs = [];
  logEvent("SESSION_START", {
    engine: currentEngine,
    tabId: currentTabId,
    model: currentSettings?.geminiModel || currentSettings?.model || "default",
    sliceSeconds: currentSettings?.audioSliceSeconds || 1.8
  });

  console.log(`[VTuber Translator] 啟動聽譯，當前引擎：${currentEngine}，會話代號：${sessionId}`);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  currentStream = stream;

  // 1. Web Audio API 防靜音回放：接回揚聲器，確保使用者聽得到聲音
  audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  isRunning = true;

  // 2. 根據 liveEngine 啟動對應引擎
  if (currentEngine === "gemini-live") {
    await startGeminiLiveEngine(stream, source, audioContext);
  } else if (currentEngine === "browser-local") {
    await startBrowserLocalEngine(stream);
  } else {
    startLegacyAudioEngine();
  }
}

function stopCapture() {
  if (isRunning && sessionId) {
    logEvent("SESSION_STOP", {
      totalChunks: chunkSequence,
      totalEvents: currentSessionLogs.length,
      durationSeconds: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0
    });
  }

  isRunning = false;
  
  // 停止各引擎
  stopGeminiLiveEngine();
  stopBrowserLocalEngine();
  stopLegacyAudioEngine();

  if (audioContext) {
    try {
      audioContext.close();
    } catch (_) {}
    audioContext = null;
  }

  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  currentTabId = null;
}

// ==========================================
// 引擎 1：Gemini Multimodal Live API (WebSocket 雙向串流)
// ==========================================
async function startGeminiLiveEngine(stream, sourceNode, actx) {
  const apiKey = currentSettings?.geminiApiKey || currentSettings?.apiKey;
  let model = currentSettings?.geminiLiveModel || "gemini-3.8-live";
  if (!model || model.includes("2.5") || model.includes("2.0") || model.includes("1.5")) {
    model = "gemini-3.8-live";
  }

  if (!apiKey) {
    notifyContentError("尚未設定 Gemini API Key，請至設定頁面填寫。");
    return;
  }

  isLiveSetupComplete = false;
  liveAccumulatedText = "";

  const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
  console.log(`[VTuber Translator] 正在連線 Gemini Live WebSocket (${model})...`);

  try {
    liveWs = new WebSocket(endpoint);
  } catch (err) {
    notifyContentError(`WebSocket 初始化失敗: ${err.message}`);
    return;
  }

  const glossaryText = currentSettings?.glossaryEnabled && Array.isArray(currentSettings?.glossary)
    ? currentSettings.glossary.map(([s, t]) => `${s} => ${t}`).join("\n")
    : "";

  liveWs.onopen = () => {
    console.log("[VTuber Translator] Gemini Live WebSocket 已連線，發送 setup 握手...");
    const setupMsg = {
      setup: {
        model: model.startsWith("models/") ? model : `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede"
              }
            }
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [
            {
              text: [
                "你是一位專業的日本 VTuber 直播即時同傳翻譯。",
                "請仔細聆聽傳入音訊中的日語發音，並即時將其翻譯為道地、自然口語的繁體中文。",
                glossaryText ? `VTuber 人名與專屬術語對照：\n${glossaryText}` : "",
                "規則：",
                "1. 請只輸出翻譯後的繁體中文，絕對不要輸出日文原文、引號、說明或括號備註。",
                "2. 直播背景常有遊戲音樂或音效，請自動忽略背景音樂，專注辨識說話者的日語聲音並即時翻譯。",
                "3. 當說話者停頓時，請立即輸出已辨識句子的繁體中文翻譯，不要延遲等待。",
                "4. 當聽見主播說話時，請盡快以串流文字輸出翻譯，即使是一小段短語也請立即輸出。"
              ].filter(Boolean).join("\n\n")
            }
          ]
        }
      }
    };
    liveWs.send(JSON.stringify(setupMsg));
  };

  liveWs.onmessage = async (event) => {
    try {
      let textData = event.data;
      if (event.data instanceof Blob) {
        textData = await event.data.text();
      }
      const msg = JSON.parse(textData);

      if (msg.error) {
        console.warn("[VTuber Translator] Gemini Live 伺服器錯誤:", msg.error);
        notifyContentError(`Gemini Live 錯誤: ${msg.error.message || JSON.stringify(msg.error)}`);
        return;
      }

      if (msg.setupComplete) {
        isLiveSetupComplete = true;
        console.log("[VTuber Translator] Gemini Live 握手完成，開始音訊串流！");
        chrome.runtime.sendMessage({
          type: "LIVE_SUBTITLE_UPDATE",
          tabId: currentTabId,
          engine: "gemini-live",
          statusText: "🎙️ 已連線就緒，正在聆聽主播說話...",
          error: null
        }).catch(() => {});
        return;
      }

      // 提取文字（支援 modelTurn.parts 與 outputTranscription）
      let newText = "";
      if (msg?.serverContent?.outputTranscription?.text) {
        newText += msg.serverContent.outputTranscription.text;
      }
      const parts = msg?.serverContent?.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.text) {
            newText += part.text;
          }
        }
      }

      // 若收到日文語音辨識原文，傳遞給畫面即時顯示
      const inputSource = msg?.serverContent?.inputTranscription?.text;
      if (inputSource) {
        chrome.runtime.sendMessage({
          type: "LIVE_SUBTITLE_UPDATE",
          tabId: currentTabId,
          engine: "gemini-live",
          sourceText: inputSource.trim(),
          error: null
        }).catch(() => {});
      }

      if (newText) {
        console.log("[VTuber Translator] 收到翻譯文字:", newText);
        if (liveClearTimer) {
          clearTimeout(liveClearTimer);
          liveClearTimer = null;
        }
        liveAccumulatedText += newText;
        chrome.runtime.sendMessage({
          type: "LIVE_SUBTITLE_UPDATE",
          tabId: currentTabId,
          engine: "gemini-live",
          translatedText: liveAccumulatedText.trim(),
          error: null
        }).catch(() => {});
      }

      if (msg?.serverContent?.interrupted) {
        // 保持現有譯文，不因主播緊接著說話打斷而閃白清空
        console.log("[VTuber Translator] 收到打斷信號 (保留當前字幕，繼續串流)");
      }

      if (msg?.serverContent?.turnComplete) {
        // 主播說完一句話，等待 3.5 秒後淡出清空，準備下一句
        if (liveClearTimer) clearTimeout(liveClearTimer);
        liveClearTimer = setTimeout(() => {
          liveAccumulatedText = "";
        }, 3500);
      }
    } catch (err) {
      console.warn("[VTuber Translator] 解析 Live API 訊息錯誤:", err);
    }
  };

  liveWs.onerror = (e) => {
    console.warn("[VTuber Translator] Gemini Live WebSocket 報錯:", e);
    notifyContentError("Gemini Live WebSocket 連線失敗，請檢查 API Key 或網路。");
  };

  liveWs.onclose = (e) => {
    console.log(`[VTuber Translator] Gemini Live 連線關閉: code=${e.code}, reason=${e.reason}`);
    if (isRunning) {
      notifyContentError(`Gemini Live 連線已中斷 (代碼: ${e.code}${e.reason ? `, 原因: ${e.reason}` : ""})`);
    }
  };

  // 建立靜音增益節點以驅動 ScriptProcessor，避免二次播放產生重音回授
  const silentGain = actx.createGain();
  silentGain.gain.value = 0;
  silentGain.connect(actx.destination);

  pcmProcessor = actx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(pcmProcessor);
  pcmProcessor.connect(silentGain);

  let frameCounter = 0;
  let speechFrames = 0;
  let silenceFrames = 0;
  let lastAudioStreamEnd = Date.now();

  pcmProcessor.onaudioprocess = (e) => {
    if (!isRunning || !liveWs || liveWs.readyState !== WebSocket.OPEN || !isLiveSetupComplete) return;

    const inputData = e.inputBuffer.getChannelData(0);

    let sum = 0;
    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
    const rms = Math.sqrt(sum / inputData.length);

    frameCounter++;
    if (frameCounter % 30 === 0) {
      console.log(`[VTuber Translator] 實時傳輸音訊中... (分頁音量 RMS: ${rms.toFixed(4)})`);
    }

    if (rms > 0.012) {
      speechFrames++;
      silenceFrames = 0;
    } else {
      silenceFrames++;
    }

    // 主動氣口切分判定：
    // 1. 主播說話滿 1 秒後，出現 150ms 的短暫氣口/換氣 (silenceFrames >= 2)
    // 2. 或主播連珠炮連續說話滿 2.5 秒 (speechFrames >= 28，約 2.4 秒)
    // 發送 audioStreamEnd 強制通知 Gemini 伺服器結算並立即輸出這一段的翻譯！
    const now = Date.now();
    if ((speechFrames >= 12 && silenceFrames >= 2) || speechFrames >= 28) {
      if (now - lastAudioStreamEnd > 1500) {
        lastAudioStreamEnd = now;
        speechFrames = 0;
        silenceFrames = 0;
        console.log("[VTuber Translator] 檢測到氣口或滿 2.5 秒，發送 audioStreamEnd 觸發即時同傳！");
        liveWs.send(JSON.stringify({
          realtimeInput: {
            audioStreamEnd: true
          }
        }));
      }
    }

    // 將分頁原生採樣率 (例如 48000Hz) 精確重採樣為標準 16000Hz 16-bit PCM
    const pcm16 = downsampleAndConvertToInt16(inputData, actx.sampleRate, 16000);
    const base64Audio = pcmBufferToBase64(pcm16.buffer);

    // 依 Google Gemini Live API 官方規範傳送 realtimeInput.audio
    liveWs.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Audio
        }
      }
    }));
  };
}

function stopGeminiLiveEngine() {
  if (liveClearTimer) {
    clearTimeout(liveClearTimer);
    liveClearTimer = null;
  }
  if (pcmProcessor) {
    try {
      pcmProcessor.disconnect();
    } catch (_) {}
    pcmProcessor = null;
  }
  if (liveWs) {
    try {
      liveWs.close();
    } catch (_) {}
    liveWs = null;
  }
  isLiveSetupComplete = false;
  liveAccumulatedText = "";
}

function downsampleAndConvertToInt16(buffer, inSampleRate, outSampleRate = 16000) {
  if (!inSampleRate || inSampleRate === outSampleRate) {
    const pcm16 = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  const ratio = inSampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const pcm16 = new Int16Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    const sample = count > 0 ? accum / count : (buffer[offsetBuffer] || 0);
    const s = Math.max(-1, Math.min(1, sample));
    pcm16[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return pcm16;
}

function pcmBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ==========================================
// 引擎 2：本機串流引擎 (browser-local)
// ==========================================
async function startBrowserLocalEngine(stream) {
  localSessionId = Date.now();
  localUtteranceId = 0;
  localRevision = 0;
  localRetryCount = 0;

  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    notifyContentError("無法取得分頁音訊軌 (audioTrack)");
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    notifyContentError("瀏覽器不支援 Web Speech API，請改用 Gemini Live 串流模式。");
    return;
  }

  try {
    localTranslator = await getOrCreateLocalTranslator();
  } catch (err) {
    notifyContentError(`本機翻譯不可用: ${err.message}`);
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "ja-JP";
  recognition.continuous = true;
  recognition.interimResults = true;

  if ("processLocally" in recognition) {
    try {
      recognition.processLocally = true;
    } catch (_) {}
  }

  recognition.onstart = () => {
    chrome.runtime.sendMessage({
      type: "LIVE_SUBTITLE_UPDATE",
      tabId: currentTabId,
      sessionId: localSessionId,
      statusText: "🎙️ 本機串流聽譯中 (辨識日文中...)",
      engine: "browser-local"
    }).catch(() => {});
  };

  recognition.onresult = (event) => {
    if (!isRunning) return;

    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const res = event.results[i];
      const text = res[0]?.transcript || "";
      if (res.isFinal) {
        finalTranscript += text;
      } else {
        interimTranscript += text;
      }
    }

    const isFinal = Boolean(finalTranscript);
    const activeText = (finalTranscript || interimTranscript).trim();

    if (!activeText) return;

    localRevision += 1;
    const currentRev = localRevision;

    if (isFinal) {
      localUtteranceId += 1;
    }

    if (localTranslateTimer) clearTimeout(localTranslateTimer);

    if (isFinal) {
      translateAndPublishLocal(activeText, localSessionId, localUtteranceId, currentRev, true);
    } else {
      localTranslateTimer = setTimeout(() => {
        translateAndPublishLocal(activeText, localSessionId, localUtteranceId, currentRev, false);
      }, 500);
    }
  };

  recognition.onerror = (event) => {
    console.warn("[VTuber Translator] 本機辨識錯誤:", event.error);
    if (!isRunning) return;

    if (event.error === "not-allowed") {
      notifyContentError("麥克風/音訊軌存取被拒絕。");
    } else if (event.error === "language-not-supported") {
      notifyContentError("Chrome 限制擴充功能存取本機日文語音模型，請改用 Gemini Live 模式。");
    } else if (event.error !== "no-speech") {
      notifyContentError(`語音辨識暫停 (${event.error})`);
    }
  };

  recognition.onend = () => {
    if (isRunning && localRetryCount < MAX_LOCAL_RETRIES) {
      localRetryCount += 1;
      try {
        startRecognitionWithTrack(recognition, audioTrack);
      } catch (_) {}
    }
  };

  try {
    startRecognitionWithTrack(recognition, audioTrack);
  } catch (err) {
    notifyContentError(`音訊軌輸入失敗: ${err.message}，請改用 Gemini Live 模式。`);
  }
}

function startRecognitionWithTrack(recInstance, audioTrack) {
  try {
    recInstance.start(audioTrack);
  } catch (err) {
    if (err instanceof TypeError || String(err).includes("parameter")) {
      throw new Error("當前 Chrome 版本之 SpeechRecognition 不支援接收 audioTrack 參數");
    }
    throw err;
  }
}

function stopBrowserLocalEngine() {
  if (localTranslateTimer) {
    clearTimeout(localTranslateTimer);
    localTranslateTimer = null;
  }
  if (recognition) {
    try {
      recognition.abort();
    } catch (_) {}
    recognition = null;
  }
  localTranslator = null;
}

async function translateAndPublishLocal(japaneseText, sessionId, utteranceId, revision, isFinal) {
  if (!isRunning || !japaneseText) return;

  try {
    let translated = "";
    if (localTranslator) {
      translated = await localTranslator.translate(japaneseText);
    } else {
      translated = japaneseText;
    }

    chrome.runtime.sendMessage({
      type: "LIVE_SUBTITLE_UPDATE",
      tabId: currentTabId,
      sessionId,
      utteranceId,
      revision,
      isFinal,
      sourceText: japaneseText,
      translatedText: translated.trim(),
      engine: "browser-local",
      error: null
    }).catch(() => {});
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "LIVE_SUBTITLE_UPDATE",
      tabId: currentTabId,
      sessionId,
      utteranceId,
      revision,
      isFinal,
      sourceText: japaneseText,
      translatedText: "",
      engine: "browser-local",
      error: `本機翻譯錯誤: ${err.message}`
    }).catch(() => {});
  }
}

async function getOrCreateLocalTranslator() {
  if (typeof window.translation !== "undefined" && typeof window.translation.createTranslator === "function") {
    const availability = await window.translation.canTranslate({
      sourceLanguage: "ja",
      targetLanguage: "zh-Hant"
    });
    if (availability === "no") {
      throw new Error("Chrome 本機不支援日文到繁體中文翻譯配對");
    }
    return await window.translation.createTranslator({
      sourceLanguage: "ja",
      targetLanguage: "zh-Hant"
    });
  }

  if (typeof window.Translator !== "undefined" && typeof window.Translator.create === "function") {
    return await window.Translator.create({
      sourceLanguage: "ja",
      targetLanguage: "zh-Hant"
    });
  }

  if (typeof window.ai !== "undefined" && window.ai.translator) {
    return await window.ai.translator.create({
      sourceLanguage: "ja",
      targetLanguage: "zh-Hant"
    });
  }

  throw new Error("Chrome Built-in AI Translator 未啟用");
}

// ==========================================
// 引擎 3：遠端切片引擎 (legacy-audio + 智慧語意 Buffer)
// ==========================================
let audioSliceBuffer = [];
let recentTranslationHistory = [];

function startLegacyAudioEngine() {
  audioQueue = [];
  audioSliceBuffer = [];
  recentTranslationHistory = [];
  isProcessingQueue = false;
  rateLimitCooldownUntil = 0;
  scheduleNextLegacySlice();
}

function stopLegacyAudioEngine() {
  if (recordTimer) {
    clearTimeout(recordTimer);
    recordTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch (_) {}
  }
  mediaRecorder = null;
  audioQueue = [];
  audioSliceBuffer = [];
  recentTranslationHistory = [];
  isProcessingQueue = false;
}

function scheduleNextLegacySlice() {
  if (!isRunning || !currentStream) return;

  const sliceSeconds = Math.max(1.2, Math.min(15, Number(currentSettings?.audioSliceSeconds || 1.8)));
  const chunks = [];

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  try {
    mediaRecorder = new MediaRecorder(currentStream, { mimeType });
  } catch (err) {
    notifyContentError(`MediaRecorder 初始化失敗: ${err.message}`);
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    if (chunks.length > 0 && isRunning) {
      const blob = new Blob(chunks, { type: mimeType });
      enqueueAudioChunk(blob, mimeType, sliceSeconds);
    }
    if (isRunning) {
      scheduleNextLegacySlice();
    }
  };

  mediaRecorder.start();

  recordTimer = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, sliceSeconds * 1000);
}

function enqueueAudioChunk(blob, mimeType, durationSeconds) {
  if (blob.size < 800) return;

  const chunkId = ++chunkSequence;
  const recordedAtIso = new Date().toISOString();

  const MAX_QUEUE_SIZE = 6;
  if (audioQueue.length >= MAX_QUEUE_SIZE) {
    const dropped = audioQueue.shift();
    logEvent("CHUNK_DROPPED", {
      chunkId: dropped.chunkId,
      droppedDurationSec: dropped.durationSeconds,
      queueSize: audioQueue.length,
      reason: "隊列達到上限 (6 片)，防止延遲滾雪球"
    });
    chrome.runtime.sendMessage({
      type: "LIVE_SUBTITLE_UPDATE",
      tabId: currentTabId,
      engine: "legacy-audio",
      dropNotice: `⚠️ 伺服器處理延遲，已略過 ${dropped.durationSeconds} 秒音訊`
    }).catch(() => {});
  }

  logEvent("CHUNK_RECORDED", {
    chunkId,
    audioBytes: blob.size,
    durationSeconds,
    mimeType,
    recordedAtIso
  });

  audioQueue.push({ chunkId, blob, mimeType, durationSeconds, recordedAtIso, timestamp: Date.now() });
  processAudioQueue();
}

async function processAudioQueue() {
  if (isProcessingQueue || audioQueue.length === 0 || !isRunning) return;

  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const remainSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    chrome.runtime.sendMessage({
      type: "LIVE_SUBTITLE_UPDATE",
      tabId: currentTabId,
      engine: "legacy-audio",
      statusText: `⏳ API 頻率冷卻中 (剩餘 ${remainSec} 秒)...`
    }).catch(() => {});
    return;
  }

  isProcessingQueue = true;
  const item = audioQueue.shift();
  const chunkId = item.chunkId;
  const apiStart = Date.now();
  const apiSentIso = new Date().toISOString();

  try {
    const provider = currentSettings?.provider || "gemini";

    if (provider === "gemini") {
      const base64 = await blobToBase64(item.blob);
      audioSliceBuffer.push({
        base64,
        mimeType: item.mimeType,
        durationSeconds: item.durationSeconds
      });

      const rawTranslation = await callGeminiAudio(audioSliceBuffer, recentTranslationHistory, currentSettings);
      const apiEnd = Date.now();
      const latencyMs = apiEnd - apiStart;
      const apiRecvIso = new Date().toISOString();
      const trimmed = (rawTranslation || "").trim();

      // 檢查是否標記句子未完結
      const isIncomplete = trimmed.includes("（未完）") || trimmed.endsWith("...") || trimmed.endsWith("…");
      const cleanText = trimmed.replace(/（未完）/g, "").replace(/\.\.\.$/, "").replace(/…$/, "").trim();

      if (isIncomplete && audioSliceBuffer.length < 3) {
        // 語意尚未講完，且 Buffer 未滿 3 片 (未超過 ~5.4 秒)：
        // 未完斷句先不送上屏，留在後台 Buffer 等待下一個切片合體補齊成完整句子！
        const { completedText, incompleteText } = extractCompletedSentences(cleanText);
        console.log(`[VTuber Translator] 語意未完，保留 Buffer (目前累積 ${audioSliceBuffer.length} 片)`);

        logEvent("API_RESPONSE", {
          chunkId,
          apiLatencyMs: latencyMs,
          audioBytes: item.blob.size,
          sliceDurationSec: item.durationSeconds,
          bufferCount: audioSliceBuffer.length,
          totalBufferDurationSec: audioSliceBuffer.reduce((sum, s) => sum + s.durationSeconds, 0),
          apiSentAt: apiSentIso,
          apiReceivedAt: apiRecvIso,
          rawOutput: trimmed,
          isIncomplete: true,
          completedSentences: completedText ? [completedText] : [],
          heldInBuffer: incompleteText,
          displayedText: completedText || null
        });

        if (completedText) {
          // 若前半段有已說完的完整句子，先將完整句子送出顯示，後半截未完句留在 Buffer
          recentTranslationHistory.push(completedText);
          if (recentTranslationHistory.length > 3) recentTranslationHistory.shift();

          logEvent("SUBTITLE_DISPLAYED", {
            chunkId,
            text: completedText,
            displayedAt: new Date().toISOString()
          });

          chrome.runtime.sendMessage({
            type: "LIVE_SUBTITLE_UPDATE",
            tabId: currentTabId,
            engine: "legacy-audio",
            translatedText: completedText,
            isIncomplete: false,
            apiLatencyMs: latencyMs,
            bufferCount: audioSliceBuffer.length,
            sourceText: "",
            statusText: `🎙️ 直播聽譯中 (語意接續中 · 緩衝第 ${audioSliceBuffer.length} 片)...`,
            error: null,
            dropNotice: null
          }).catch(() => {});
        } else {
          // 整句都還在講中途：畫面上不上屏半截話，靜待下個切片合成出完整句子
          chrome.runtime.sendMessage({
            type: "LIVE_SUBTITLE_UPDATE",
            tabId: currentTabId,
            engine: "legacy-audio",
            apiLatencyMs: latencyMs,
            bufferCount: audioSliceBuffer.length,
            statusText: `🎙️ 直播聽譯中 (語意接續中 · 緩衝第 ${audioSliceBuffer.length} 片)...`,
            error: null,
            dropNotice: null
          }).catch(() => {});
        }
      } else {
        // 語意完整 或 Buffer 達到 3 片上限（強制結算）：
        logEvent("API_RESPONSE", {
          chunkId,
          apiLatencyMs: latencyMs,
          audioBytes: item.blob.size,
          sliceDurationSec: item.durationSeconds,
          bufferCount: audioSliceBuffer.length,
          totalBufferDurationSec: audioSliceBuffer.reduce((sum, s) => sum + s.durationSeconds, 0),
          apiSentAt: apiSentIso,
          apiReceivedAt: apiRecvIso,
          rawOutput: trimmed,
          isIncomplete: false,
          completedSentences: cleanText ? [cleanText] : [],
          heldInBuffer: null,
          displayedText: cleanText || null
        });

        if (cleanText) {
          recentTranslationHistory.push(cleanText);
          if (recentTranslationHistory.length > 3) recentTranslationHistory.shift();

          logEvent("SUBTITLE_DISPLAYED", {
            chunkId,
            text: cleanText,
            displayedAt: new Date().toISOString()
          });

          chrome.runtime.sendMessage({
            type: "LIVE_SUBTITLE_UPDATE",
            tabId: currentTabId,
            engine: "legacy-audio",
            translatedText: cleanText,
            isIncomplete: false,
            apiLatencyMs: latencyMs,
            bufferCount: 0,
            sourceText: "",
            statusText: `🎙️ 直播聽譯中 · [遠端切片 (Gemini/OpenAI)]`,
            error: null,
            dropNotice: null
          }).catch(() => {});
        } else if (audioSliceBuffer.length >= 2) {
          audioSliceBuffer = [];
        }
        audioSliceBuffer = [];
      }
    } else {
      const translation = await callOpenAIAudio(item.blob, currentSettings);
      const apiEnd = Date.now();
      const latencyMs = apiEnd - apiStart;

      logEvent("API_RESPONSE", {
        chunkId,
        apiLatencyMs: latencyMs,
        audioBytes: item.blob.size,
        sliceDurationSec: item.durationSeconds,
        rawOutput: translation,
        isIncomplete: false,
        displayedText: translation?.trim() || null
      });

      if (translation && translation.trim()) {
        chrome.runtime.sendMessage({
          type: "LIVE_SUBTITLE_UPDATE",
          tabId: currentTabId,
          engine: "legacy-audio",
          translatedText: translation.trim(),
          apiLatencyMs: latencyMs,
          bufferCount: 0,
          error: null,
          dropNotice: null
        }).catch(() => {});
      }
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    logEvent("ERROR", {
      chunkId,
      error: errMsg,
      apiLatencyMs: Date.now() - apiStart
    });
    if (errMsg.includes("429")) {
      rateLimitCooldownUntil = Date.now() + 8000;
      chrome.runtime.sendMessage({
        type: "LIVE_SUBTITLE_UPDATE",
        tabId: currentTabId,
        engine: "legacy-audio",
        error: "Google 呼叫頻率超限 (429)，自動降頻冷卻 8 秒中..."
      }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        type: "LIVE_SUBTITLE_UPDATE",
        tabId: currentTabId,
        engine: "legacy-audio",
        error: `音訊翻譯錯誤: ${errMsg.slice(0, 120)}`
      }).catch(() => {});
    }
  } finally {
    isProcessingQueue = false;
    if (audioQueue.length > 0 && isRunning) {
      setTimeout(processAudioQueue, 200);
    }
  }
}

function extractCompletedSentences(text) {
  if (!text) return { completedText: "", incompleteText: "" };
  const trimmed = text.trim();
  if (!trimmed) return { completedText: "", incompleteText: "" };

  // 尋找最後一個句子終止標點：[。！？!?\n]，包含後續的引號或括號
  const match = trimmed.match(/^(.*[。！？!?\n][」』）\)'"”]*)(.*)$/s);
  if (match) {
    const completed = match[1].trim();
    const remaining = match[2].trim();
    return {
      completedText: completed,
      incompleteText: remaining
    };
  }

  return {
    completedText: "",
    incompleteText: trimmed
  };
}

async function callGeminiAudio(sliceBuffer, historyList, settings) {
  const apiKey = settings?.geminiApiKey || settings?.apiKey;
  let model = settings?.geminiModel || "gemini-3.8-flash";
  if (!model || model.includes("2.5") || model.includes("2.0") || model.includes("1.5")) {
    model = "gemini-3.8-flash";
  }
  const targetLang = settings?.targetLang || "繁體中文";

  if (!apiKey) {
    throw new Error("尚未設定 Gemini API Key，請至設定頁面填寫。");
  }

  const glossaryText = settings?.glossaryEnabled && Array.isArray(settings?.glossary)
    ? settings.glossary.map(([s, t]) => `${s} => ${t}`).join("\n")
    : "";

  const recentHistoryText = historyList && historyList.length > 0
    ? historyList.slice(-2).map((t, idx) => `前文 ${idx + 1}: ${t}`).join("\n")
    : "";

  const prompt = [
    `你是一位專業的日文 VTuber 直播即時同傳翻譯。`,
    `請仔細聆聽傳入音訊中的日語發音，並將其翻譯為自然、道地、口語化的${targetLang}。`,
    glossaryText ? `VTuber 專用詞彙與稱呼對照：\n${glossaryText}` : "",
    recentHistoryText ? `前幾句已完成之直播翻譯上下文（供你理解主詞與話題語境，切勿重複輸出前文）：\n${recentHistoryText}` : "",
    `規則：`,
    `1. 請只輸出翻譯後的${targetLang}，切勿加入任何前綴說明、原文標記或引號。`,
    `2. 若傳入音訊僅有遊戲背景音樂、尖叫或無清晰說話內容，請直接回傳空字串。`,
    `3. 重要語意完整度標記：若音訊末尾的主播說話明顯尚未講完（例如停在助詞「が、を、に、で、けど、から、ので」或動詞/複合句中途，語意明顯未完），請務必在翻譯結果結尾標註「...（未完）」。`,
    `4. 若音訊末尾已是一句語意完整的句子，請正常輸出整句完整翻譯，絕對不要加「...（未完）」。`
  ].filter(Boolean).join("\n\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = sliceBuffer.map(item => ({
    inlineData: {
      mimeType: item.mimeType.split(";")[0],
      data: item.base64
    }
  }));
  parts.push({ text: prompt });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: parts
        }
      ],
      generationConfig: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function callOpenAIAudio(blob, settings) {
  const apiKey = settings?.openaiApiKey || settings?.apiKey;
  if (!apiKey) {
    throw new Error("尚未設定 OpenAI API Key，請至設定頁面填寫。");
  }

  const formData = new FormData();
  formData.append("file", blob, "audio.webm");
  formData.append("model", "whisper-1");
  formData.append("language", "ja");

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!whisperRes.ok) {
    const errText = await whisperRes.text();
    throw new Error(`Whisper ${whisperRes.status}: ${errText.slice(0, 200)}`);
  }

  const whisperData = await whisperRes.json();
  const japaneseText = whisperData?.text?.trim();
  if (!japaneseText) return "";

  const targetLang = settings?.targetLang || "繁體中文";
  const model = settings?.openaiModel || "gpt-4o-mini";
  const translateRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
          content: `你是一位日文 VTuber 同傳翻譯，請將用戶輸入的日文字幕轉譯為口語化的${targetLang}。只輸出譯文，不要附帶解釋。`
        },
        { role: "user", content: japaneseText }
      ]
    })
  });

  if (!translateRes.ok) {
    const errText = await translateRes.text();
    throw new Error(`GPT ${translateRes.status}: ${errText.slice(0, 200)}`);
  }

  const gptData = await translateRes.json();
  return gptData?.choices?.[0]?.message?.content?.trim() || "";
}

// ==========================================
// 相容性探針
// ==========================================
async function runCompatibilityProbe() {
  const results = {
    webSpeechSupported: false,
    processLocallySupported: false,
    audioTrackParamAccepted: false,
    japaneseSpeechAvailable: "unknown",
    translatorApiAvailable: "unavailable",
    translatorPairAvailable: "no"
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    results.webSpeechSupported = true;
    const testRec = new SpeechRecognition();
    results.processLocallySupported = "processLocally" in testRec;

    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dst = ctx.createMediaStreamDestination();
      osc.connect(dst);
      const fakeTrack = dst.stream.getAudioTracks()[0];
      testRec.start(fakeTrack);
      testRec.stop();
      results.audioTrackParamAccepted = true;
    } catch (err) {
      if (String(err).includes("parameter") || err instanceof TypeError) {
        results.audioTrackParamAccepted = false;
      } else {
        results.audioTrackParamAccepted = true;
      }
    }
  }

  if (typeof window.translation !== "undefined" && typeof window.translation.canTranslate === "function") {
    results.translatorApiAvailable = "available (window.translation)";
    try {
      results.translatorPairAvailable = await window.translation.canTranslate({ sourceLanguage: "ja", targetLanguage: "zh-Hant" });
    } catch (e) {
      results.translatorPairAvailable = `error: ${e.message}`;
    }
  } else if (typeof window.Translator !== "undefined") {
    results.translatorApiAvailable = "available (window.Translator)";
    if (typeof window.Translator.availability === "function") {
      try {
        results.translatorPairAvailable = await window.Translator.availability({ sourceLanguage: "ja", targetLanguage: "zh-Hant" });
      } catch (e) {
        results.translatorPairAvailable = `error: ${e.message}`;
      }
    }
  }

  return results;
}

function notifyContentError(errorText) {
  chrome.runtime.sendMessage({
    type: "LIVE_SUBTITLE_UPDATE",
    tabId: currentTabId,
    error: errorText,
    engine: currentEngine
  }).catch(() => {});
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
