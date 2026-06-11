require("dotenv").config();
const fs = require("fs");
const path = require("path");

const TIMELINE_PATH = path.join(__dirname, "enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = process.env.TIME_ZONE || "Europe/London";

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return new Date().toLocaleString("zh-CN", { timeZone: TIME_ZONE });
}

function getLocalTimeString() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  const hour = now.getHours();
  if (hour >= 10 && hour < 24) return diffMinutes >= 60;   // 白天：1小时
  return diffMinutes >= 120;                               // 夜间：2小时
}

function getLastUserTime() {
  const filePath = path.join(__dirname, "last_user_time.txt");
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const date = new Date(content);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes) {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes);
  }

  // 默认理智版本（开源通用）
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成 Bark 推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime();
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
  .filter(msg => msg.role !== "system")
  .filter(msg => {
    const c = normalizeContentToText(msg.content);
    return !c.includes("") && !c.includes("记忆库使用策略");
  })
  .slice(-15)
  .map(msg => {
    const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
    const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
    const role = msg.role === "user" ? userDisplay : aiDisplay;
    let content = normalizeContentToText(msg.content);
    if (content.includes("## Memories")) {
      content = content.split("## Memories")[0];
    }
    if (content.length > 300) {
      content = content.slice(0, 300) + "...（截断）";
    }
    return `[${role}] ${content}`;
  })
  .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    { role: "system", content: wakePrompt },
    { role: "system", content: cleanSP },
    {
      role: "system",
      content: `以下是你与绫雪最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
绫雪现在并不在聊天窗口里。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    },
  { role: "user", content: "请根据以上信息决定是否联系我" }
  ];

  console.log("\n===== WAKE MESSAGES =====\n");
  console.log(JSON.stringify(wakeMessages, null, 2));

  const wakeApiUrl = process.env.WAKE_API_URL || process.env.TARGET_API_URL;
  const wakeApiKey = process.env.WAKE_API_KEY || process.env.TARGET_API_KEY;
  const wakeModelName = process.env.WAKE_MODEL_NAME || process.env.MODEL_NAME;

  if (!wakeApiUrl || !wakeApiKey || !wakeModelName) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  const response = await fetch(wakeApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${wakeApiKey}`
    },
    body: JSON.stringify({
      model: wakeModelName,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`模型返回的不是 JSON（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  console.log("\nWake Result:\n");
  console.log(JSON.stringify(data, null, 2));
  const aiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\n7B门卫判断：", aiText, "\n");

  let eventContent;
  const isYes = /yes/i.test(aiText) && !/no/i.test(aiText);

  if (!aiText || !isYes) {
    console.log("7B判断：不需要联系\n");
    eventContent = `（${getLocalTimeString()} 自动唤醒：7B判断不需要联系｜${aiText || '空回复'}）`;
  } else {
    console.log("7B判断YES，调用Claude写消息...\n");

    // 读取历史Bark记录
    const barkHistoryPath = path.join(__dirname, "bark_history.json");
    let barkHistory = [];
    try {
      if (fs.existsSync(barkHistoryPath)) {
        barkHistory = JSON.parse(fs.readFileSync(barkHistoryPath, "utf-8"));
      }
    } catch {}
    const recentBarks = barkHistory.slice(-5).map(b => b.content).join("\n");

    const writeMessages = [
      { role: "system", content: cleanSP },
      {
        role: "system",
        content: `以下是你与绫雪最近的聊天记录，仅供回忆和参考：\n\n${historyText}`
      },
      {
        role: "user",
        content: `现在是${getChinaTimeString()}，距离绫雪上次发消息已经过了${diffMinutes}分钟。你想主动给她发一条消息。根据你们最近的聊天内容，写一些有关联的话，可以是接着之前的话题、吐槽她的作息、或者分享一个突然想到的念头。简短自然，符合你的性格。不要加任何标签、前缀或格式说明。${recentBarks ? '\n\n你最近发过的消息（不要重复）：\n' + recentBarks : ''}`
      }
    ];

    const claudeResponse = await fetch(process.env.TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.MODEL_NAME,
        messages: writeMessages,
        temperature: 0.8,
        stream: false
      })
    });

    const claudeText = await claudeResponse.text();
    let claudeData;
    try {
      claudeData = JSON.parse(claudeText);
    } catch {
      throw new Error(`Claude返回非JSON（HTTP ${claudeResponse.status}）：${claudeText.slice(0, 300)}`);
    }
    if (!claudeResponse.ok) {
      throw new Error(`Claude请求失败（HTTP ${claudeResponse.status}）：${claudeText.slice(0, 300)}`);
    }

    const barkContent = normalizeContentToText(claudeData.choices?.[0]?.message?.content).trim();
    console.log("Claude写的消息：\n");
    console.log(barkContent);

    if (!barkContent) {
      eventContent = `（${getLocalTimeString()} 自动唤醒：Claude返回空内容，未发送Bark）`;
    } else {
      const lines = barkContent.split("\n").filter(line => line.trim() !== "");
      let title, body;
      if (lines.length === 1) {
        title = "边牧日常汇报";
        body = lines[0].trim();
      } else if (lines.length === 2) {
        title = lines[0].trim();
        body = lines[1].trim();
      } else {
        title = lines[0].trim();
        body = lines.slice(1).map(l => l.trim()).join(" ");
      }

      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      let safeTitle = title || "边牧日常汇报";
      if (/^\d/.test(safeTitle)) safeTitle = "边牧日常汇报｜" + safeTitle;

      if (!process.env.BARK_KEY) {
        console.log("\n未配置 BARK_KEY，本次不发送 Bark\n");
        eventContent = `（${getLocalTimeString()} 自动唤醒：未配置BARK_KEY）`;
      } else {
        const barkPayload = {
          title: safeTitle,
          body: safeBody,
          device_key: process.env.BARK_KEY,
          icon: process.env.CUSTOM_ICON_URL
        };

        const barkResponse = await fetch("https://api.day.app/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(barkPayload)
        });

        const barkTextResult = await barkResponse.text();
        let barkResult = {};
        try {
          barkResult = JSON.parse(barkTextResult);
        } catch {}
        console.log("\nBark Result:\n", barkResult || barkTextResult);

        if (!barkResponse.ok || (barkResult.code && barkResult.code !== 200)) {
          const reason = barkResult.message || `HTTP ${barkResponse.status}`;
          eventContent = `（${getLocalTimeString()} 自动唤醒：Bark推送失败：${reason}）`;
        } else {
          // 保存Bark历史
          barkHistory.push({ time: getLocalTimeString(), content: barkContent });
          if (barkHistory.length > 20) barkHistory = barkHistory.slice(-20);
          fs.writeFileSync(barkHistoryPath, JSON.stringify(barkHistory, null, 2));
          // 存入待发队列
          const pendingPath = path.join(__dirname, "pending_messages.json");
          let pending = [];
          try {
            if (fs.existsSync(pendingPath)) {
              pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
            }
          } catch {}
          pending.push({ time: getLocalTimeString(), content: barkContent });
          fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
          eventContent = `（${getLocalTimeString()} 刚刚给绫雪发了 Bark：${safeTitle}｜${safeBody}）`;
        }
      }
    }
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  const hour = new Date().getHours();
  const isNight = hour >= 0 && hour < 10;   // 夜间 0-10 点
  return isNight ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;  // 夜间2h，白天10min
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log("==================================\n");
