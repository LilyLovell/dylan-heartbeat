require("dotenv").config();
const { exec } = require('child_process');
const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require('path');

const DEFAULT_BODY_LIMIT_MB = 50;
const BLOCKED_COMMANDS = ['rm -rf', 'shutdown', 'reboot', 'mkfs', 'dd if=', ':(){', 'chmod 777 /', 'wget', 'curl -o'];

function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
  logger: true,
  bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIMELINE_FILE = "enhanced_messages.json";
const TIMESTAMP_DB_FILE = "./message_timestamps.json";
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up";

// ========================
// 多模态消息处理
// ========================
function shouldForwardMultimodalContent() {
  const mode = (process.env.MULTIMODAL_MODE || "text").trim().toLowerCase();
  return mode === "passthrough" || mode === "vision" || mode === "true";
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
  return { ...msg, content: normalizeContentToText(msg.content) };
}

function prepareMessageForLLM(msg) {
  console.log('multimodal content:', JSON.stringify(msg.content));
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return { ...msg, content: normalizeContentToText(msg.content) };
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) {
  msg.content = msg.content.filter(part => {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text' && !part.text) return false;
    if (part.type === 'input_text' && !part.text) return false;
    return true;
  });
  if (msg.content.length === 0) return null;
  return msg;
}

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }

  if (Array.isArray(value)) return value.map(sanitizeForLog);

  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }

  return value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ========================
// 读取 timeline
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

// ========================
// 保存 timeline（保留 SP）
// ========================
function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  fs.writeJsonSync(TIMELINE_FILE, final, { spaces: 2 });
}

// ========================
// 提取时间戳（支持多种格式）
// ========================
function extractTimestamp(content) {
  if (!content || typeof content !== "string") return null;
  let match = content.match(/（?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  if (match) return new Date(match[1]);
  match = content.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  if (match) return new Date(match[1]);
  match = content.match(/（(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2})）/);
  if (match) return new Date(match[1]);
  match = content.match(/(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2})/);
  if (match) return new Date(match[1]);
  return null;
}

// ========================
// 时间戳记忆库
// ========================
function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try { return fs.readJsonSync(TIMESTAMP_DB_FILE); } catch { return {}; }
}

function saveTimestampDB(db) {
  fs.writeJsonSync(TIMESTAMP_DB_FILE, db, { spaces: 2 });
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  let content = raw.trim();
  content = content
    .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*/, "")
    .replace(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}\s*/, "")
    .replace(/^（\d{4}[-\/]\d{1,2}[-\/]\d{1,2} \d{2}:\d{2}[）\s]*/, "")
    .trim()
    .slice(0, 150);
  return `${msg.role}::${content}`;
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

// ========================
// 消息判断
// ========================
function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  return c.includes("刚刚给绫雪发了 Bark") || c.includes("自动唤醒：本次未发送 Bark");
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return true;
  return false;
}

// ========================
// 构建 Timeline
// ========================
function buildTimeline(kelivoMessages, tsDB) {
  const oldTimeline = loadTimeline();
  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline);

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a, tsDB);
    const timeB = extractTimestampWithMemory(b, tsDB);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) { merged.push(event); continue; }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = extractTimestampWithMemory(merged[i], tsDB);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];
  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          finalMessages.push({ ...pendingSpecial[i], position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)) });
        }
        pendingSpecial = [];
      }
      finalMessages.push({ ...msg, position: realPos });
      realPos++;
    }
  }
  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      finalMessages.push({ ...pendingSpecial[i], position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)) });
    }
  }

  result.push(...finalMessages);
  return result;
}

// ========================
// 追加特殊事件
// ========================
function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5 };
  timeline.push(newEvent);
  saveTimeline(timeline);
  console.log(`\n已记录特殊事件 (position ${newEvent.position}): ${content}\n`);
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;

// ========================
// 预设方案
// ========================
const PRESETS_FILE = "./presets.json";
const ENV_FILE = ".env";
const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL",
  "TARGET_API_KEY",
  "MODEL_NAME",
  "BARK_KEY",
  "CUSTOM_ICON_URL",
  "REQUEST_BODY_LIMIT_MB",
  "MULTIMODAL_MODE",
  "PORT",
  "GATEWAY_BASE_URL",
  "TIME_ZONE",
  "RESTART_COMMAND",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
}

function savePresets(presets) {
  fs.writeJsonSync(PRESETS_FILE, presets, { spaces: 2 });
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged)
      .filter(key => !PREFERRED_ENV_ORDER.includes(key))
      .sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

// ========================
// 安全：放行 /admin，其他仅本地/局域网
// ========================
app.addHook("onRequest", (req, reply, done) => {
  if (req.url.startsWith("/admin")) return done();
  const ip = req.ip || req.connection.remoteAddress;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return done();
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) return done();
  reply.code(403).send("Forbidden");
});

// exec接口

app.get('/admin/exec', async (req, reply) => {
  const { password, command } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!command || typeof command !== 'string') {
    return reply.code(400).send({ error: 'no command' });
  }
  if (BLOCKED_COMMANDS.some(b => command.toLowerCase().includes(b))) {
    return reply.code(403).send({ error: 'blocked command' });
  }
  return new Promise((resolve) => {
    exec(command, { timeout: 15000, cwd: '/root' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.slice(0, 5000) || '',
        stderr: stderr?.slice(0, 2000) || '',
        code: error?.code || 0
      });
    });
  });
});


// ========================
// Models
// ========================
app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: "DeepSeek-V4-Pro", object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    console.log("\n============================");
    console.log("收到 Kelivo 完整请求 Body:");
    console.log(JSON.stringify(sanitizeForLog(body), null, 2));
    console.log("============================\n");

    const kelivoMessages = body.messages || [];
    kelivoMessages.forEach((msg, i) => {
  if (Array.isArray(msg.content)) {
    msg.content.forEach((block, j) => {
      console.log(`消息${i} block${j}:`, JSON.stringify(block).substring(0, 200));
    });
  }
});
    const oldTimeline = loadTimeline();

    const tsDB = loadTimestampDB();
    let tsDBDirty = false;
    for (const msg of kelivoMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) saveTimestampDB(tsDB);

    const finalTimeline = buildTimeline(kelivoMessages, tsDB);
    saveTimeline(finalTimeline);

    // Kelivo 发图时 content 常是数组。默认转为文本占位，避免非视觉模型/中转站报错。
    // 如上游支持 OpenAI 兼容视觉格式，可设置 MULTIMODAL_MODE=passthrough 原样转发。
    const llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    const oldEvents = stripPosition(
      oldTimeline.filter(isSpecialEvent).sort((a, b) => {
        const timeA = extractTimestampWithMemory(a, tsDB);
        const timeB = extractTimestampWithMemory(b, tsDB);
        if (timeA && timeB) return timeA - timeB;
        return 0;
      })
    );

    console.log("本次注入的特殊事件数量:", oldEvents.length);
    if (oldEvents.length > 0) console.log("示例事件内容:", oldEvents[0].content.substring(0, 80));

    for (const event of oldEvents) {
      const eventTime = extractTimestampWithMemory(event, tsDB);
      if (!eventTime) { llmMessages.push(event); continue; }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const msgTime = extractTimestampWithMemory(llmMessages[i], tsDB);
        if (msgTime && msgTime >= eventTime) {
          llmMessages.splice(i, 0, event);
          inserted = true;
          break;
        }
      }
      if (!inserted) llmMessages.push(event);
    }



    // 调试打印
    console.log("\n===== 转发给 LLM 的 Messages（前 10 条）=====\n");
    console.log(JSON.stringify(sanitizeForLog(llmMessages.slice(0, 10)), null, 2));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    // === 长期记忆 ===
    const latestUserMsg = [...llmMessages].reverse().find(m => m.role === 'user');
    if (latestUserMsg) fs.writeFileSync('./last_user_time.txt', new Date().toISOString());
    

    // 注入pending消息
    const pendingPath = path.join(__dirname, "pending_messages.json");
    try {
      if (fs.existsSync(pendingPath)) {
        const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
        if (pending.length > 0) {
          const pendingText = pending.map(p => `[${p.time}] ${p.content}`).join('\n');
          const sysIdx = llmMessages.findIndex(m => m.role === 'system');
          if (sysIdx >= 0) {
            llmMessages[sysIdx] = {
              ...llmMessages[sysIdx],
              content: normalizeContentToText(llmMessages[sysIdx].content) + 
                `\n\n【你之前通过Bark给绫雪发过这些消息，她可能是看到通知才来找你的，自然地接上话题就好，不用特意提"Bark"或"推送"】\n${pendingText}`
            };
          }
          fs.writeFileSync(pendingPath, JSON.stringify([], null, 2));
          console.log('已注入pending消息并清空队列');
        }
      }
    } catch (err) {
      console.error('pending消息处理失败:', err.message);
    }

    // 请求模型
    const isStream = body.stream === true;
    const actualUrl = isStream ? TARGET_API_URL : (process.env.WAKE_API_URL || TARGET_API_URL);
    const actualKey = isStream ? process.env.TARGET_API_KEY : (process.env.WAKE_API_KEY || process.env.TARGET_API_KEY);
    const actualModel = isStream ? process.env.MODEL_NAME : (process.env.WAKE_MODEL_NAME || process.env.MODEL_NAME);
    console.log('actualKey:', actualKey ? actualKey.slice(0, 8) + '...' : 'undefined');

    // 终极过滤：清除所有空text block
    for (const msg of llmMessages) {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.filter(part => {
          if (!part || typeof part !== 'object') return false;
          if ((part.type === 'text' || part.type === 'input_text') && !part.text) return false;
          return true;
        });
      }
    }

    // 处理文件附件（kelivo把txt渲染成多张PNG截图 + 文本，只保留文本）
    for (const msg of llmMessages) {
      if (Array.isArray(msg.content)) {
        const hasFileContent = msg.content.some(part =>
          part.type === 'text' && part.text && part.text.includes('## user sent a file:')
        );
        if (hasFileContent) {
          msg.content = msg.content.filter(part => part.type !== 'image_url');
          console.log('文件附件：已移除冗余图片渲染');
        }
      }
    }

     // 判断是否直连Anthropic
    const isAnthropic = actualUrl.includes('anthropic.com');

    // OpenAI格式 → Anthropic格式（图片+工具调用+工具结果）
    function convertToAnthropicFormat(msgs) {
      const result = [];
      for (const msg of msgs) {
        const { reasoning_content, ...cleanMsg } = msg;

        if (cleanMsg.role === 'assistant' && cleanMsg.tool_calls) {
          // assistant的tool_calls → Anthropic的tool_use content block
          const content = [];
          if (cleanMsg.content && typeof cleanMsg.content === 'string' && cleanMsg.content.trim()) {
            content.push({ type: 'text', text: cleanMsg.content });
          }
          for (const tc of cleanMsg.tool_calls) {
            let parsedInput;
            try {
              parsedInput = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {});
            } catch { parsedInput = {}; }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name || '',
              input: parsedInput
            });
          }
          result.push({ role: 'assistant', content });

        } else if (cleanMsg.role === 'tool') {
          // tool结果 → Anthropic的tool_result（塞进user消息）
          const toolResult = {
            type: 'tool_result',
            tool_use_id: cleanMsg.tool_call_id,
            content: typeof cleanMsg.content === 'string' ? cleanMsg.content : JSON.stringify(cleanMsg.content)
          };
        // 连续多个tool结果合并到同一个user消息里
          const last = result[result.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content) &&
              last.content.length > 0 && last.content[0].type === 'tool_result') {
            last.content.push(toolResult);
          } else {
            result.push({ role: 'user', content: [toolResult] });
          }

        } else {
        // 普通消息 转换图片格式
          if (Array.isArray(cleanMsg.content)) {
            const newContent = cleanMsg.content.map(part => {
              if (part.type === 'image_url' && part.image_url?.url) {
                const match = part.image_url.url.match(/^data:(image\/\w+);base64,(.+)/);
                if (match) {
                  return {
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] }
                  };
                }
              }
              return part;
            });
            result.push({ ...cleanMsg, content: newContent });
          } else {
            result.push(cleanMsg);
          }
        }
      }
      return result;
    }

      // OpenAI工具定义 → Anthropic工具定义
       function convertToolsDefinition(tools) {
        if (!tools || !Array.isArray(tools)) return undefined;
        return tools.map(t => {
          if (t.type === 'function' && t.function) {
            return {
              name: t.function.name,
              description: t.function.description || '',
              input_schema: t.function.parameters || { type: 'object', properties: {} }
            };
          }
          return t;
         });
       }

     // 构建请求体（Anthropic格式和OpenAI格式不同）
       let fetchBody;
       if (isAnthropic) {
         const systemMsgs = llmMessages.filter(m => m.role === 'system');
         // 不再过滤tool和tool_calls 交给convertToAnthropicFormat转换
         const nonSystemMsgs = convertToAnthropicFormat(
           llmMessages.filter(m => m.role !== 'system')
         );
         const systemText = systemMsgs.map(m => normalizeContentToText(m.content)).join('\n\n');
         console.log("system末尾100字:", systemText.substring(systemText.length - 100));
         console.log("system总长度:", systemText.length);
         fetchBody = {
           model: actualModel,
           max_tokens: body.max_tokens || 16000,
           thinking: {
             type: "enabled",
             budget_tokens: 8000
           },
           temperature: 1,
           stream: true,
           messages: nonSystemMsgs
         };

       // 转换并添加工具定义
         const anthropicTools = convertToolsDefinition(body.tools);
         if (anthropicTools && anthropicTools.length > 0) {
           fetchBody.tools = anthropicTools;
         }

         if (systemText) {
           const splitIndex = systemText.indexOf('<recent_chats>');
           if (splitIndex > 0) {
             fetchBody.system = [
               { type: "text", text: systemText.substring(0, splitIndex).trim(), cache_control: { type: "ephemeral" } },
               { type: "text", text: systemText.substring(splitIndex).trim() }
             ];
           } else {
             fetchBody.system = [
               { type: "text", text: systemText, cache_control: { type: "ephemeral" } }
             ];
           }
         }
       } else {
       // 中转站：剥离不支持的thinking参数
         const { thinking, output_config, ...cleanBody } = body;
         fetchBody = { ...cleanBody, model: actualModel, messages: llmMessages };
       }


    const response = await fetch(actualUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isAnthropic
          ? { "x-api-key": actualKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${actualKey}` })
      },
      body: JSON.stringify(fetchBody)
    });
    if (!response.ok) {
    const errText = await response.text();
    console.log("上游API错误:", response.status, errText);
  return reply.code(response.status).send(errText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

      reply.raw.writeHead(response.status, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantReply = '';

    if (!isStream) {
      // 非流式（标题/摘要）：直接转发
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
      }
      reply.raw.end();
    } else {
      // 流式：缓冲末尾 检测记忆标记
      let streamBuffer = '';
      const MEM_HOLDBACK = 30;

      function flushContent(text) {
        if (!text) return;
        reply.raw.write(`data: ${JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        })}\n\n`);
      }

       function onDelta(text) {
        assistantReply += text;
        streamBuffer += text;


    if (streamBuffer.length > MEM_HOLDBACK) {
       const safe = streamBuffer.slice(0, streamBuffer.length - MEM_HOLDBACK);
       streamBuffer = streamBuffer.slice(streamBuffer.length - MEM_HOLDBACK);
       flushContent(safe);
     }
   }

        if (isAnthropic) {
        let sseBuffer = '';
        let currentToolIndex = -1;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));

              // 工具调用开始
              if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                currentToolIndex++;
                reply.raw.write(`data: ${JSON.stringify({
                  id: 'chatcmpl-' + Date.now(),
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: actualModel,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, id: data.content_block.id, type: 'function', function: { name: data.content_block.name, arguments: '' } }] }, finish_reason: null }]
                })}\n\n`);
              }

              if (data.type === 'content_block_delta') {
                // 思维链
                if (data.delta?.type === 'thinking_delta' && data.delta?.thinking) {
                  reply.raw.write(`data: ${JSON.stringify({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: actualModel,
                    choices: [{ index: 0, delta: { reasoning_content: data.delta.thinking }, finish_reason: null }]
                  })}\n\n`);
                }
                // 工具参数流
                else if (data.delta?.type === 'input_json_delta' && data.delta?.partial_json !== undefined) {
                  reply.raw.write(`data: ${JSON.stringify({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: actualModel,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, function: { arguments: data.delta.partial_json } }] }, finish_reason: null }]
                  })}\n\n`);
                }
                // 正文
                else if (data.delta?.text) {
                  onDelta(data.delta.text);
                }
              }
            } catch (e) {}
          }
        }
      } else {
      
        let sseBuffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            if (line.includes('[DONE]')) continue;
            try {
              const json = JSON.parse(line.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              const toolCalls = json.choices?.[0]?.delta?.tool_calls;
              if (toolCalls) {
                console.log('[中转站] tool_calls:', JSON.stringify(json));
              }

              if (content) {
                onDelta(content);
              } else {
                reply.raw.write(`data: ${JSON.stringify(json)}\n\n`);
             }

            } catch (e) {}
          }
        }
      }

      // 流结束

      if (streamBuffer) flushContent(streamBuffer);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }

  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口：记录唤醒事件
// ========================
app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content } = req.body;
    if (!content) return reply.code(400).send({ error: "content is required" });
    appendSpecialEvent(content);
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 读取 .env 值
// ========================
function readEnvValue(key) {
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

// ========================
// HTTP Basic Auth
// ========================
function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

// ========================
// 管理页面 GET /admin
// ========================
app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat
    ? `在线（上次心跳: ${new Date(wakeUpLastHeartbeat).toLocaleString("zh-CN")}）`
    : "离线或未启动";

  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const currentIcon = readEnvValue("CUSTOM_ICON_URL");

  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");

  const presets = loadPresets();
  const presetsJson = safeJsonForInlineScript(presets);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${authToken}`);

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT · Runtime</title>
  <!-- 引入思源宋体 -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    @keyframes flicker {
      0%, 100% { opacity: 1; }
      92% { opacity: 1; }
      93% { opacity: 0.8; }
      94% { opacity: 1; }
      96% { opacity: 0.6; }
      97% { opacity: 1; }
    }

    @keyframes scanline {
      0% { transform: translateY(-200px); }
      100% { transform: translateY(100vh); }
    }

    @keyframes glow-pulse {
      0%, 100% { box-shadow: 0 0 5px rgba(0, 255, 255, 0.3), 0 0 20px rgba(0, 255, 255, 0.1); }
      50% { box-shadow: 0 0 10px rgba(0, 255, 255, 0.5), 0 0 40px rgba(0, 255, 255, 0.2); }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(15px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes text-glow {
      0%, 100% { text-shadow: 0 0 10px rgba(0, 255, 255, 0.5), 0 0 40px rgba(0, 255, 255, 0.2); }
      50% { text-shadow: 0 0 20px rgba(0, 255, 255, 0.8), 0 0 60px rgba(0, 255, 255, 0.3); }
    }

    @keyframes vline-breathe {
      0%, 100% { opacity: 0.2; box-shadow: 0 0 4px rgba(255, 0, 128, 0.1); }
      50% { opacity: 0.8; box-shadow: 0 0 15px rgba(255, 0, 128, 0.5); }
    }

    @keyframes vline-breathe-r {
      0%, 100% { opacity: 0.15; box-shadow: 0 0 4px rgba(0, 255, 255, 0.1); }
      50% { opacity: 0.6; box-shadow: 0 0 12px rgba(0, 255, 255, 0.4); }
    }


    body {
      font-family: 'Courier New', 'Consolas', monospace;
      background: #0a0a0f;
      background-image:
        radial-gradient(ellipse at 20% 50%, rgba(0, 255, 255, 0.03) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 50%, rgba(255, 0, 128, 0.03) 0%, transparent 50%);
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 60px 20px;
      color: #c0c0c0;
      position: relative;
      overflow-x: hidden;
      overflow-y: scroll;
    }

        .scan-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 255, 255, 0.015) 2px,
        rgba(0, 255, 255, 0.015) 4px
      );
      pointer-events: none;
      z-index: 1000;
    }

    .scan-overlay::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 200px;
      background: linear-gradient(
        to bottom,
        transparent,
        rgba(0, 255, 255, 0.03),
        transparent
      );
      animation: scanline 8s linear infinite;
      pointer-events: none;
    }

    .container {
      max-width: 500px;
      width: 100%;
      background: rgba(10, 10, 20, 0.85);
      border: 1px solid rgba(0, 255, 255, 0.15);
      border-radius: 2px;
      clip-path: polygon(0 12px, 12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%);
      padding: 40px 32px;
      box-shadow:
        0 0 30px rgba(0, 255, 255, 0.05),
        inset 0 0 60px rgba(0, 0, 0, 0.5);
      animation: fadeIn 0.6s ease-out;
      position: relative;
      z-index: 1;
    }

    .container::before {
      content: '';
      position: absolute;
      top: -1px;
      left: 20%;
      right: 20%;
      height: 1px;
      background: linear-gradient(90deg, transparent, #00ffff, transparent);
      opacity: 0.6;
    }

    h2 {
      text-align: center;
      font-size: 28px;
      font-weight: 700;
      color: #00ffff;
      margin-bottom: 4px;
      letter-spacing: 8px;
      font-family: 'Courier New', monospace;
      text-transform: uppercase;
      animation: text-glow 4s ease-in-out infinite, flicker 10s infinite;
    }

    .subtitle {
      text-align: center;
      font-size: 10px;
      color: #ff0080;
      margin-bottom: 36px;
      letter-spacing: 6px;
      text-transform: uppercase;
      opacity: 0.8;
    }

    .status {
      background: rgba(0, 255, 255, 0.03);
      border: 1px solid rgba(0, 255, 255, 0.1);
      border-radius: 2px;
      padding: 16px 20px;
      margin-bottom: 24px;
      animation: fadeIn 0.8s ease-out;
      position: relative;
    }

    .status::before {
      content: '// STATUS';
      position: absolute;
      top: -8px;
      left: 12px;
      font-size: 9px;
      color: #00ff41;
      letter-spacing: 2px;
      background: #0a0a0f;
      padding: 0 6px;
    }

    .status p {
      margin: 6px 0;
      font-size: 12px;
      color: #808080;
      font-weight: 400;
      line-height: 1.6;
      letter-spacing: 1px;
      font-family: 'Courier New', monospace;
    }

    .status strong {
      color: #00ff41;
      font-weight: 600;
    }

    label {
      display: block;
      margin-top: 18px;
      font-weight: 400;
      font-size: 10px;
      color: #00ffff;
      letter-spacing: 2px;
      text-transform: uppercase;
      opacity: 0.7;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(0, 255, 255, 0.15);
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.4);
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: #e0e0e0;
      transition: all 0.3s ease;
    }

    input:focus {
      outline: none;
      border-color: #00ffff;
      box-shadow: 0 0 15px rgba(0, 255, 255, 0.15), inset 0 0 15px rgba(0, 255, 255, 0.05);
      background: rgba(0, 255, 255, 0.03);
    }

    input::placeholder {
      color: #404050;
      font-size: 11px;
    }

    button {
      width: 100%;
      margin-top: 18px;
      padding: 12px;
      border: none;
      border-radius: 2px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      letter-spacing: 3px;
      font-family: 'Courier New', monospace;
      text-transform: uppercase;
      position: relative;
      overflow: hidden;
    }

    button::after {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
      transition: left 0.5s ease;
    }

    button:hover::after {
      left: 100%;
    }

    button.save {
      background: transparent;
      color: #00ffff;
      border: 1px solid #00ffff;
      box-shadow: 0 0 10px rgba(0, 255, 255, 0.1);
    }

    button.save:hover {
      background: rgba(0, 255, 255, 0.1);
      box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
      transform: translateY(-1px);
    }

    button.save:active {
      transform: translateY(0);
    }

    button.restart {
      background: transparent;
      color: #ff0080;
      border: 1px solid #ff0080;
      box-shadow: 0 0 10px rgba(255, 0, 128, 0.1);
      margin-top: 28px;
    }

    button.restart:hover {
      background: rgba(255, 0, 128, 0.1);
      box-shadow: 0 0 20px rgba(255, 0, 128, 0.3);
      transform: translateY(-1px);
    }

    button.restart:active {
      transform: translateY(0);
    }

    .note {
      margin-top: 16px;
      font-size: 9px;
      color: #404050;
      text-align: center;
      letter-spacing: 1px;
    }

    .presets-box {
      background: rgba(0, 255, 65, 0.02);
      border: 1px solid rgba(0, 255, 65, 0.1);
      border-radius: 2px;
      padding: 20px;
      margin-bottom: 24px;
      animation: fadeIn 0.8s ease-out;
      position: relative;
    }

    .presets-box::before {
      content: '// PRESETS';
      position: absolute;
      top: -8px;
      left: 12px;
      font-size: 9px;
      color: #00ff41;
      letter-spacing: 2px;
      background: #0a0a0f;
      padding: 0 6px;
    }

    .presets-box h3 {
      margin: 0 0 14px 0;
      font-size: 11px;
      color: #00ff41;
      font-weight: 400;
      letter-spacing: 3px;
      text-transform: uppercase;
    }

    .preset-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }

    .preset-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .preset-btn {
      word-wrap: break-word;
      flex: 1;
      padding: 10px 14px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(0, 255, 65, 0.12);
      border-radius: 2px;
      text-align: left;
      font-size: 12px;
      color: #a0a0a0;
      cursor: pointer;
      transition: all 0.3s ease;
      font-family: 'Courier New', monospace;
    }

    .preset-btn:hover {
      background: rgba(0, 255, 65, 0.05);
      border-color: #00ff41;
      color: #00ff41;
      box-shadow: 0 0 15px rgba(0, 255, 65, 0.1);
    }

    .preset-btn span {
      color: #505060;
      font-size: 10px;
      margin-left: 8px;
    }

    .preset-btn:hover span {
      color: rgba(0, 255, 65, 0.5);
    }

    .preset-del {
      flex-shrink: 0;
      width: 48px;
      padding: 8px 12px;
      background: transparent;
      border: 1px solid rgba(255, 0, 128, 0.2);
      border-radius: 2px;
      font-size: 10px;
      color: #ff0080;
      cursor: pointer;
      transition: all 0.3s ease;
      font-family: 'Courier New', monospace;
      letter-spacing: 1px;
    }

    .preset-del:hover {
      background: rgba(255, 0, 128, 0.1);
      border-color: #ff0080;
      box-shadow: 0 0 10px rgba(255, 0, 128, 0.15);
    }

    .add-preset {
      border-top: 1px solid rgba(0, 255, 65, 0.1);
      padding-top: 16px;
    }

    .add-preset strong {
      font-size: 10px;
      color: #00ff41;
      display: block;
      margin-bottom: 8px;
      font-weight: 400;
      letter-spacing: 2px;
      text-transform: uppercase;
      opacity: 0.6;
    }

    .add-preset button {
      background: transparent;
      color: #00ff41;
      border: 1px solid rgba(0, 255, 65, 0.3);
      box-shadow: 0 0 8px rgba(0, 255, 65, 0.08);
      font-size: 10px;
      padding: 10px;
    }

    .add-preset button:hover {
      background: rgba(0, 255, 65, 0.08);
      box-shadow: 0 0 15px rgba(0, 255, 65, 0.2);
    }

    .config-box {
      background: rgba(0, 255, 255, 0.02);
      border: 1px solid rgba(0, 255, 255, 0.1);
      border-radius: 2px;
      padding: 20px;
      animation: fadeIn 0.8s ease-out;
      position: relative;
    }

    .config-box::before {
      content: '// CONFIG';
      position: absolute;
      top: -8px;
      left: 12px;
      font-size: 9px;
      color: #00ffff;
      letter-spacing: 2px;
      background: #0a0a0f;
      padding: 0 6px;
    }

    ::-webkit-scrollbar {
      width: 4px;
    }

    ::-webkit-scrollbar-track {
      background: #0a0a0f;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(0, 255, 255, 0.2);
      border-radius: 2px;
    }

    ::selection {
      background: rgba(0, 255, 255, 0.2);
      color: #00ffff;
    }

    .hud-decor {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 999;
    }

    .hud-corner {
      position: absolute;
      width: 50px;
      height: 50px;
    }

    .hud-corner.tl {
      top: 16px;
      left: 16px;
      border-top: 1px solid rgba(0, 255, 255, 0.3);
      border-left: 1px solid rgba(0, 255, 255, 0.3);
    }

    .hud-corner.tr {
      top: 16px;
      right: 16px;
      border-top: 1px solid rgba(0, 255, 255, 0.3);
      border-right: 1px solid rgba(0, 255, 255, 0.3);
    }

    .hud-corner.bl {
      bottom: 16px;
      left: 16px;
      border-bottom: 1px solid rgba(0, 255, 255, 0.3);
      border-left: 1px solid rgba(0, 255, 255, 0.3);
    }

    .hud-corner.br {
      bottom: 16px;
      right: 16px;
      border-bottom: 1px solid rgba(0, 255, 255, 0.3);
      border-right: 1px solid rgba(0, 255, 255, 0.3);
    }

    .hud-label {
      position: absolute;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 2px;
      opacity: 0.4;
    }

    .hud-label.top-left {
      top: 20px;
      left: 52px;
      color: #00ffff;
    }

    .hud-label.top-right {
      top: 20px;
      right: 52px;
      color: #00ff41;
    }

    .hud-label.bottom-left {
      bottom: 20px;
      left: 52px;
      color: #ff0080;
    }

    .hud-label.bottom-right {
      bottom: 20px;
      right: 52px;
      color: #00ffff;
    }

    .hud-vline {
      position: absolute;
      top: 10%;
      left: 40px;
      width: 2px;
      height: 45%;
      background: linear-gradient(
        to bottom,
        transparent,
        #ff0080,
        #ff0080,
        transparent
      );
      opacity: 0.6;
      box-shadow: 0 0 8px rgba(255, 0, 128, 0.3);
      animation: vline-breathe 3s ease-in-out infinite;
    }

    .hud-vline-r {
      position: absolute;
      top: 50%;
      right: 40px;
      width: 1px;
      height: 25%;
      background: linear-gradient(
        to bottom,
        transparent,
        #00ffff,
        transparent
      );
      opacity: 0.3;
      box-shadow: 0 0 6px rgba(0, 255, 255, 0.2);
      animation: vline-breathe-r 3s ease-in-out infinite;
      animation-delay: 1.5s;
    }

    .hud-triangle {
      position: absolute;
      font-size: 14px;
      opacity: 0.2;
      animation: tri-blink 4s ease-in-out infinite;
    }

    .hud-triangle.t1 {
      top: 12%;
      right: 60px;
      color: #ff0080;
      animation-delay: 0s;
    }

    .hud-triangle.t2 {
      top: 45%;
      left: 55px;
      color: #00ffff;
      animation-delay: 1.5s;
    }

    .hud-triangle.t3 {
      bottom: 25%;
      right: 45px;
      color: #00ff41;
      animation-delay: 3s;
    }

    @keyframes tri-blink {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 0.7; }
    }

   @media (min-width: 1200px) {
     .hud-label {
       font-size: 13px;
       opacity: 0.5;
     }
  
     .hud-corner {
       width: 70px;
       height: 70px;
     }

     .hud-vline {
       height: 50%;
       width: 3px;
     }

     .hud-vline-r {
       height: 30%;
       width: 2px;
     }

     .hud-triangle {
       font-size: 18px;
     }
   }


  </style>
</head>
<body>
  <div class="scan-overlay"></div>
  <div class="hud-decor">
  <div class="hud-corner tl"></div>
  <div class="hud-corner tr"></div>
  <div class="hud-corner bl"></div>
  <div class="hud-corner br"></div>
  <div class="hud-label top-left">SYS.0x7F2A</div>
  <div class="hud-label top-right">NODE.ACTIVE</div>
  <div class="hud-label bottom-left">MEM.ALLOC</div>
  <div class="hud-label bottom-right">RES.0x00FF</div>
  <div class="hud-vline"></div>
  <div class="hud-vline-r"></div>
  <div class="hud-triangle t1">&#9651;</div>
  <div class="hud-triangle t2">&#9651;</div>
  <div class="hud-triangle t3">&#9661;</div>
  </div>

    <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">Runtime · AI Residency</div>

    <div class="status">
      <p>Gateway <strong>运行中 (${serverUptime}秒)</strong></p>
      <p>Auto Wakeup <strong>${wakeUpStatus}</strong></p>
    </div>

    <!-- 预设方案 -->
    <div class="presets-box">
      <h3>预设方案</h3>
      <div class="preset-list" id="presetList"></div>
      <div class="add-preset">
        <strong>保存当前配置为新预设</strong>
        <input id="presetName" placeholder="预设名称，例如：DeepSeek / Claude">
        <button onclick="savePreset()">保存为预设</button>
      </div>
    </div>

    <!-- 配置表单 -->
    <div class="config-box">
      <form id="configForm" onsubmit="saveConfig(event)">
        <label>API URL</label>
        <input name="target_url" id="f_url" value="${escapeHtml(currentUrl)}">
        <label>API Key</label>
        <input name="target_key" id="f_key" placeholder="留空不修改">
        <label>Model Name</label>
        <input name="model_name" id="f_model" value="${escapeHtml(currentModel)}">
        <label>Bark Key</label>
        <input name="bark_key" id="f_bark" placeholder="留空不修改">
        <label>Bark Icon URL</label>
        <input name="custom_icon" id="f_icon" value="${escapeHtml(currentIcon)}" placeholder="可选">
        <button type="submit" class="save">保存配置</button>
      </form>
    </div>

    <button onclick="restartServices()" class="restart">一键重启所有服务</button>
    <div class="note">修改配置后保存，点击重启按钮生效</div>
  </div>

  <script>
    // ====== 以下脚本保持不变 ======
    const AUTH_HEADER = ${authHeaderJson};
    let presets = ${presetsJson};

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderPresets() {
      const list = document.getElementById("presetList");
      if (!presets.length) {
        list.innerHTML = '<div style="color:#aaa;font-size:12px;font-style:italic;">还没有预设，保存当前配置即可创建。</div>';
        return;
      }
      list.innerHTML = presets.map((p, idx) => {
        return '<div class="preset-item">' +
          '<button class="preset-btn" onclick="applyPreset(' + idx + ')">' + escapeHtmlText(p.name) + '<span>' + escapeHtmlText(p.model_name) + '</span></button>' +
          '<button class="preset-del" onclick="deletePreset(' + idx + ')">删除</button>' +
        '</div>';
      }).join("");
    }

    function applyPreset(idx) {
      const p = presets[idx];
      document.getElementById("f_url").value = p.target_url || "";
      document.getElementById("f_model").value = p.model_name || "";
      if (p.target_key) document.getElementById("f_key").value = p.target_key;
      document.querySelector(".config-box").scrollIntoView({ behavior: "smooth" });
    }

    async function saveConfig(event) {
      event.preventDefault();
      const payload = {
        target_url: document.getElementById("f_url").value.trim(),
        target_key: document.getElementById("f_key").value.trim(),
        model_name: document.getElementById("f_model").value.trim(),
        bark_key: document.getElementById("f_bark").value.trim(),
        custom_icon: document.getElementById("f_icon").value.trim()
      };

      if (!payload.target_url || !payload.model_name) {
        alert("请填写 API 地址和模型名称");
        return;
      }

      try {
        const resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) {
          document.getElementById("f_key").value = "";
          document.getElementById("f_bark").value = "";
          alert("配置已保存，现在可以点击重启按钮让新配置生效。");
        } else {
          alert("保存失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    async function savePreset() {
      const name = document.getElementById("presetName").value.trim();
      const target_url = document.getElementById("f_url").value.trim();
      const target_key = document.getElementById("f_key").value.trim();
      const model_name = document.getElementById("f_model").value.trim();
      if (!name) { alert("请填写预设名称"); return; }
      if (!target_url || !model_name) { alert("请先填写 API 地址和模型名称"); return; }

      const resp = await fetch("/admin/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name, target_url, target_key, model_name })
      });
      const r = await resp.json();
      if (r.success) {
        const existing = presets.findIndex(p => p.name === name);
        const entry = { name, target_url, target_key, model_name };
        if (existing >= 0) presets[existing] = entry;
        else presets.push(entry);
        renderPresets();
        document.getElementById("presetName").value = "";
        alert("预设已保存：" + name);
      } else {
        alert("保存失败：" + (r.error || "未知错误"));
      }
    }

    async function deletePreset(idx) {
      const p = presets[idx];
      if (!confirm("删除预设「" + p.name + "」？")) return;
      await fetch("/admin/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name: p.name })
      });
      presets.splice(idx, 1);
      renderPresets();
    }

    async function restartServices() {
      if (!confirm("确定要重启 Gateway 和 wake_up 吗？")) return;
      try {
        const resp = await fetch("/admin/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: "{}"
        });
        const result = await resp.json();
        if (result.success) {
          alert("重启成功！页面稍后自动刷新。");
          setTimeout(() => location.reload(), 3000);
        } else {
          alert("重启失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    renderPresets();
  </script>
</body>
</html>`;

  reply.type("text/html").send(html);
});
// ========================
// 管理保存 POST /admin/save
// ========================
app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { target_url, target_key, model_name, bark_key, custom_icon } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });
    console.log("\n✅ .env 已更新，可通过管理页重启服务\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>已保存</title></head>
<body style="text-align:center;font-family:-apple-system,sans-serif;padding:40px;">
  <h2>✅ 配置已保存</h2>
  <p>现在可以返回管理页，点击重启按钮让新配置生效。</p>
  <a href="/admin">← 返回设置</a>
</body></html>`);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 保存预设方案
// ========================
app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name 必填" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 删除预设方案
// ========================
app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 心跳接口
// ========================
app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

// ========================
// 记忆管理页面 GET /admin/memories
// ========================
function buildMemoriesHtml(mem, fErr) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cards = mem.map(m => {
    const v = m.valence != null ? Number(m.valence) : null;
    const a = m.arousal != null ? Number(m.arousal) : null;
    const imp = m.importance != null ? Number(m.importance) : null;
    const vc = v != null ? (v < 0 ? 'negative' : v > 0 ? 'positive' : '') : '';
    const ct = m.created_at ? new Date(m.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '?';
    const at = m.last_accessed_at ? new Date(m.last_accessed_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '--';
    const c = esc(m.content);
    let h = '<div class="card"><div class="hd"><span class="cid">#'+m.id+'</span><div class="meta">';
    if(m.resolved) h += '<span class="t res">resolved</span>';
    if(v!=null) h += '<span class="t '+vc+'">val '+v.toFixed(2)+'</span>';
    if(a!=null) h += '<span class="t">aro '+a.toFixed(2)+'</span>';
    if(imp!=null) h += '<span class="t">imp '+imp+'</span>';
    h += '<span class="t">acc '+(m.activation_count||0)+'</span>';
    h += '</div></div><div class="cc">'+c+'</div>';
    h += '<div class="ft"><span>'+ct+'</span><span>last: '+at+'</span></div></div>';
    return h;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ombre Brain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#e0e0e0;font-family:system-ui;padding:20px}h1{color:#c792ea;font-size:1.3em;margin-bottom:12px}a.bk{color:#89ddff;text-decoration:none;font-size:.9em}.st{color:#888;font-size:.85em;margin-bottom:16px}.err{color:#ff5370;border:1px solid #ff5370;border-radius:6px;padding:10px;margin-bottom:12px}.card{background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:14px;margin-bottom:10px}.card:hover{border-color:#c792ea}.hd{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px}.cid{color:#c792ea;font-weight:700;font-size:.95em}.meta{display:flex;gap:6px;flex-wrap:wrap}.t{font-size:.72em;padding:2px 8px;border-radius:10px;background:#16213e;color:#89ddff}.t.res{background:#1a3a2a;color:#c3e88d}.t.negative{background:#3a1a1a;color:#ff5370}.t.positive{background:#1a2a3a;color:#82aaff}.cc{font-size:.85em;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#ccc;max-height:200px;overflow-y:auto}.cc::-webkit-scrollbar{width:4px}.cc::-webkit-scrollbar-thumb{background:#444;border-radius:2px}.ft{margin-top:8px;font-size:.73em;color:#666;display:flex;gap:16px}</style></head>
<body><a class="bk" href="/admin">← back</a><h1>🧠 Ombre Brain</h1>
<div class="st">${fErr?'':mem.length+' memories'}</div>${fErr?'<div class="err">'+fErr+'</div>':''}${cards}</body></html>`;
}

app.get("/admin/memories", { preHandler: basicAuth }, async (req, reply) => {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  let memories = [];
  let fetchError = null;
  try {
    const res = await fetch(sbUrl + "/rest/v1/memories?select=id,content,valence,arousal,importance,resolved,activation_count,created_at,last_accessed_at&order=id.desc", {
      headers: { apikey: sbKey, Authorization: "Bearer " + sbKey }
    });
    if (!res.ok) throw new Error("Supabase " + res.status);
    memories = await res.json();
  } catch (e) { fetchError = e.message; }
  reply.type("text/html").send(buildMemoriesHtml(memories, fetchError));
});


// ========================
// 管理页一键重启
// ========================
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readRestartCommand();

  // 立即回复，避免重启时连接中断
  reply.send({ success: true, output: `重启指令已发送：${restartCommand}` });
  
  // 稍后重启。默认只重启本项目的两个进程；可通过 RESTART_COMMAND 自定义。
  const { exec } = require("child_process");
  exec(restartCommand, (err, stdout, stderr) => {
    if (err) {
      console.error("重启失败:", stderr);
    } else {
      console.log("服务已重启:", stdout);
    }
  });
});

// ========================
// 测试 Bark
// ========================
app.get("/test-bark", async (req, reply) => {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const formattedTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  appendSpecialEvent(`（${formattedTime} 刚刚给绫雪发了Bark：怎么还不睡。）`);
  reply.send({ success: true });
});

// ========================
// 启动服务
// ========================
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
});
