#!/usr/bin/env node
// Gemini-only injector for the step-by-step reporting protocol.
// 仅对 Gemini 模型生效的分步回报协议注入脚本。
// Reads the Antigravity hook payload from stdin and writes a hook response JSON to stdout.
// 从标准输入（stdin）读取 Antigravity 钩子载荷，并将钩子响应 JSON 写入标准输出（stdout）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Plugin root directory and protocol file path.
// 插件根目录与协议正文（AGENTS.md）路径。
const ROOT = path.resolve(__dirname, '..');
const PROTOCOL = path.join(ROOT, 'protocol', 'AGENTS.md');

// Directory for per-conversation injection markers and optional debug logs.
// 存放单会话注入标记文件与可选调试日志的目录。
const STATE_DIR = path.join(process.env.PLUGIN_DATA || os.tmpdir(), 'gemini-step-report');

// Create an empty file named "DEBUG" in the plugin root to enable debug logging.
// 在插件根目录创建空文件 "DEBUG" 即可开启调试日志。
const DEBUG = fs.existsSync(path.join(ROOT, 'DEBUG'));

// Regex matching target models that receive the protocol (override via GEMINI_STEP_REPORT_MODEL_RE).
// 匹配需要注入协议的目标模型正则表达式（可通过环境变量 GEMINI_STEP_REPORT_MODEL_RE 覆盖）。
const MODEL_RE = new RegExp(process.env.GEMINI_STEP_REPORT_MODEL_RE || 'gemini', 'i');

// Short reminder injected at the start of subsequent user turns to keep the rules salient.
// 在后续每轮用户消息开始时注入的简短提醒，用于保持规则注意力。
const REMINDER =
  '[Step-report protocol reminder] Multi-step task? Plan first, ask when unsure, ' +
  'post a \u3010\u6b65\u9aa4 N/M \u5b8c\u6210\u3011 report after every step in first person, never more than 3 silent tool rounds, ' +
  'all user-facing text in Simplified Chinese.';

// Escape non-ASCII characters so Windows console code pages cannot corrupt the output JSON.
// 将非 ASCII 字符转义为 \uXXXX，避免 Windows 控制台代码页导致 JSON 乱码。
function out(obj) {
  const s = JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  process.stdout.write(s);
}

// Append a timestamped line to debug.log when DEBUG mode is enabled.
// 在开启 DEBUG 模式时，向 debug.log 追加带时间戳的日志。
function log(line) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'debug.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch (_) { /* ignore logging errors / 忽略日志写入错误 */ }
}

// Wrap plain text into an Antigravity hook systemMessage step object.
// 将纯文本包装为 Antigravity 钩子要求的 systemMessage 注入步骤对象。
function sysMsg(text) {
  return { systemMessage: { systemMessage: text } };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  // Parse the hook event payload safely; fall back to an empty object on malformed input.
  // 安全解析钩子事件载荷；若输入格式异常则回退为空对象。
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch (e) { log('bad json: ' + e.message); }

  const ev = p.hookEventName || '';
  const model = String(p.modelName || '');
  const conv = String(p.conversationId || 'unknown').replace(/[^\w.-]/g, '_');
  const isGemini = MODEL_RE.test(model);

  log(`${ev} model=${model} gemini=${isGemini} conv=${conv} inv=${p.invocationNum} init=${p.initialNumSteps} input=${JSON.stringify(String(p.lastUserInput || '').slice(0, 40))}`);

  // Skip injection for non-Gemini models (e.g., Claude).
  // 非 Gemini 模型（如 Claude）直接跳过，不注入任何内容。
  if (!isGemini) return out({});

  // Track whether this conversation has already received the full protocol.
  // 通过标记文件记录当前会话是否已注入过完整协议。
  const marker = path.join(STATE_DIR, conv + '.injected');
  const steps = [];

  if (!fs.existsSync(marker)) {
    // First invocation in this conversation: inject the full AGENTS.md protocol.
    // 当前会话首次触发：注入完整的 AGENTS.md 协议正文。
    let text = '';
    try { text = fs.readFileSync(PROTOCOL, 'utf8'); } catch (e) { log('read protocol failed: ' + e.message); return out({}); }
    steps.push(sysMsg('The following protocol is a mandatory global rule for this conversation:\n\n' + text));
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch (_) { /* ignore marker errors / 忽略标记写入错误 */ }
    log('injected full protocol');
  } else if (ev === 'PreInvocation' && Number(p.invocationNum || 0) === 0) {
    // First model call of a new user turn: inject a short reminder.
    // 新一轮用户对话的首次模型调用：注入简短提醒。
    steps.push(sysMsg(REMINDER));
    log('injected reminder');
  }

  // Return injected steps if any, otherwise an empty JSON object.
  // 若有待注入步骤则返回 injectSteps，否则返回空对象。
  out(steps.length ? { injectSteps: steps } : {});
});
