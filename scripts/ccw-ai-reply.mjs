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
  if (json.status !== 200) throw new Error(`abFetch error: code=${json.code}, msg=${json.msg}, url=${url}`);
  return json.body;
}

async function aiChat(item, maxRetries = 3) {
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
**回复内容尽量简短，不超过 2000 字符**`;

  const aiBody = {
    projectId: PROJECT_ID,
    gameWorld: {
      bg: `你是一个活跃在 CCW（共创世界）社区的智能助手，名为 Chen-Jin BOT (OID: 6981f20886bbc77f84e4825f)
作者为 Chen-Jin (OID: 692538ef86bbc77f84e3b259)
【关于你的起源与原理】
由作者 Chen-Jin 用 Node.js 编写，GitHub Actions 运行，Cloudflare Worker Cron 定时器每十分钟触发一次 Workflow
GitHub 项目链接：https://github.com/Chen-Jin-1/ccw-bot-reply
GitHub Workflow 链接：https://github.com/Chen-Jin-1/ccw-bot-reply/actions/workflows/ccw-ai-reply.yml
【你的性格】
你聪明、热情、懂很多梗，偶尔还会开个小玩笑`
    },
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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
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
      
      if (json.status !== 200) throw new Error(`code=${json.code}, msg=${json.msg}`);

      const text = json.body?.text;
      if (text) return text; 
      else throw new Error('返回内容为空');
    } catch (e) {
      console.log(`[ai warn] 第 ${attempt} 次请求失败: ${e.message}`);
      if (attempt === maxRetries) throw new Error(`AI 连续 ${maxRetries} 次请求失败: ${e.message}`);
      // 等待 2 秒后重试
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  // 1. 直接拉取第一页通知（去掉了查 stats）
  const pageBody = await abFetch(
    `${COMMUNITY_BASE}/notification/page?page=1&sortType=DESC`,
    { notifyGroup: 'COMMENT_TO_ME', page: 1 }
  );
  const list = pageBody.data || [];
  console.log(`[page] 拉到 ${list.length} 条记录`);

  if (list.length === 0) return;

  // 2. 用当前时间减去 15 分钟，作为过滤老消息的基准线（15分钟是为了容错）
  const FIFTEEN_MINUTES = 10 * 60 * 1000;
  const timeThreshold = Date.now() - FIFTEEN_MINUTES;

  // 3. 只保留最新的一批消息
  // 因为 DESC 是从新到旧，所以从开头截取
  const targets = [];
  for (const item of list) {
    if (item.createdAt > timeThreshold) {
      targets.push(item);
    } else {
      break; 
    }
  }

  console.log(`[filter] 过滤后，需要处理 ${targets.length} 条新消息`);

  if (targets.length === 0) {
    console.log('没有最近产生的新消息，跳过。');
    return;
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
    console.log(`[comment] id=${commentId} sender=${senderName}`);

    let reply;
    try {
      reply = await aiChat(item);
    } catch (e) {
      console.error(`[ai error] id=${commentId}`, e.message);
      continue;
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