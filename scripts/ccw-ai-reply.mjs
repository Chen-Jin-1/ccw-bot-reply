import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const md5 = require('./md5.cjs');

const SECRET_KEY = process.env.CCW_SECRET_KEY;
const PROJECT_ID = process.env.CCW_PROJECT_ID;
const COOKIE = process.env.CCW_COOKIE;

const AI_HUB_KEY = '3R5A^5WrN7yszj1v)1x>QztT7FD5_20H';
const AI_BASE = 'https://gandi-main.ccw.site';
const COMMUNITY_BASE = 'https://community-web.ccw.site';

async function abFetch(url, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Date.now();
  const signature = md5('ccw' + body + timestamp, SECRET_KEY);
  const res = await fetch(url, {
    method: 'post',
    body,
    headers: {
      a: signature,
      b: String(timestamp),
      'content-type': 'application/json',
      cookie: COOKIE,
    },
  });
  const json = await res.json();
  if (json.status !== 200) {
    throw new Error(`abFetch error: code=${json.code}, msg=${json.msg}, url=${url}`);
  }
  return json.body;
}

async function aiChat(item) {
  const senderName = item.senderName || '某位用户';
  const senderOid = item.senderOid || '未知OID';
  const userMessage = item.comment || ''; 
  
  // 关键修复：如果 message 为 null，就说明是直接留言，给个默认空字符串
  const botPreviousMessage = item.message || ''; 
  
  const isoTime = new Date().toISOString();

  // 动态生成上下文描述
  let contextStr = '';
  if (botPreviousMessage) {
    // 有上下文：用户是在回复某条消息
    contextStr = `
你之前说：“${botPreviousMessage}”
用户 ${senderName} (OID: ${senderOid}) 刚刚回复说：“${userMessage}”`;
  } else {
    // 无上下文：用户是直接留言
    contextStr = `
用户 ${senderName} (OID: ${senderOid}) 在你的留言板直接留言：“${userMessage}”`;
  }

  const backgroundInfo = `
[系统时间]
当前 UTC 时间：${isoTime}。当用户问时间时，请转换为北京时间（UTC+8）回答

[对话上下文]
${contextStr}

[回复要求]
直接针对用户的最新回复解答，自然、友好
**禁止使用任何 Markdown 格式**（绝对不要使用星号 *、井号 #、反引号 \`、列表符号 - 等，除非用户要求），纯文本回复
**回复内容不要超过 2000 字符`;

  const aiBody = {
    projectId: PROJECT_ID,
    gameWorld: { bg: '你是一个活跃在 CCW（共创世界）社区的智能助手，作者为 Chen-Jin' },
    assistantRole: { 
      name: 'Chen-Jin BOT', 
      bg: backgroundInfo, 
    },
    userRole: { 
      name: senderName,
      bg: `OID: ${senderOid}`
    },
    histories: [], 
    text: userMessage, 
    extra: { lang: 'Chinese' },
  };

  const payload = JSON.stringify(aiBody);
  const ts = Date.now().toString();
  const key = md5(`${payload}\n${ts}`, AI_HUB_KEY);
  const res = await fetch(
    `${AI_BASE}/ai/hub/chat-with-game-assistant?key=${key}&ts=${ts}`,
    {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }
  );
  const json = await res.json();
  if (json.status !== 200) {
    throw new Error(`aiChat error: code=${json.code}, msg=${json.msg}`);
  }
  return json.body.text;
}

async function main() {
  // 1. 未读数
  const stats = await abFetch(
    `${COMMUNITY_BASE}/notification/stats/v2`,
    { countAll: true }
  );
  const n = stats.COMMENT_TO_ME || 0;
  console.log(`[stats] COMMENT_TO_ME = ${n}`);
  if (n <= 0) return;

  // 2. 拉第一页（此时 stats 会清零）
  const pageBody = await abFetch(
    `${COMMUNITY_BASE}/notification/page?page=1&sortType=DESC`,
    { notifyGroup: 'COMMENT_TO_ME', page: 1 }
  );
  const list = pageBody.data || [];
  console.log(`[page] 拉到 ${list.length} 条，将处理前 ${Math.min(n, list.length)} 条`);

  // DESC 新到旧；按 n 截取。若 n > 20（perPage），只处理第一页
  const targets = list.slice(0, n);
  if (targets.length < n) {
    console.log(`[warn] 未读数 ${n} 大于第一页 ${list.length} 条，剩余留待下次`);
  }

  // 3. 逐条处理
  for (const item of targets) {
    const commentText = item.comment || item.message || '';
    const commentId = item.triggeredById;
    const senderName = item.senderName;
    if (!commentId) {
      console.log(`[skip] 缺 triggeredById:`, item);
      continue;
    }
    console.log(`[comment] id=${commentId} sender=${senderName} text=${commentText}`);

    let reply;
    try {
      reply = await aiChat(item);
    } catch (e) {
      console.error(`[ai error] id=${commentId}`, e.message);
      continue; // 单条失败不影响其他条
    }
    if (!reply) {
      console.log(`[skip] AI 回复为空 id=${commentId}`);
      continue;
    }

    try {
      const replyBody = await abFetch(`${COMMUNITY_BASE}/comment/reply`, {
        content: reply,
        replyToId: commentId,
      });
      
      // 假设接口返回的 replyBody 包含 { id: 'xxx' }，直接提取
      const newCommentId = replyBody?.id || replyBody?.oid || '未知';
      console.log(`[reply ok] 回复评论 ID=${commentId} -> 新评论 ID=${newCommentId}`);
    } catch (e) {
      console.error(`[reply error] 回复评论 ID=${commentId} 失败:`, e.message);
      // 发送失败时，把 AI 生成的回复文本打印出来，方便查明原因
      console.log(`[failed reply text]`, reply); 
    }

    // 条间隔，降低风控风险
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});