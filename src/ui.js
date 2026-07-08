import chalk from 'chalk';
import { state } from './state.js';
import { getGroup, getTopic } from './db.js';

const ESC = '\x1b';
const CSI = ESC + '[';
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;
const CUP = (row, col) => `${CSI}${row};${col}H`;
const CLEAR_LINE = `${CSI}2K`;

let termRows = 0, termCols = 0;
let inputBuffer = '';
let inputCursor = 0;

// 消息历史：{ type: 'system'|'command'|'message', text, isSelf? }
const messages = [];

// ---------- 显示宽度计算 ----------
function getDisplayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF) ||
        (code >= 0x20000 && code <= 0x2FFFF)) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// ---------- 按显示宽度换行 ----------
function wrapTextByWidth(text, maxWidth) {
  if (maxWidth < 1) return [];
  const lines = [];
  let currentLine = '';
  let currentWidth = 0;
  for (const ch of text) {
    const chWidth = getDisplayWidth(ch);
    if (currentWidth + chWidth > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = ch;
      currentWidth = chWidth;
    } else {
      currentLine += ch;
      currentWidth += chWidth;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// ---------- 终端初始化 ----------
export function initTerminal() {
  termRows = process.stdout.rows || 30;
  termCols = process.stdout.columns || 80;
  process.stdout.write(`${CSI}?1049h`);
  process.stdout.write(CLEAR + HOME);
  process.stdout.write(`${CSI}2;${termRows - 1}r`);
  fullRedraw();
}

export function restoreTerminal() {
  process.stdout.write(`${CSI}?1049l`);
}

// ---------- 状态栏 ----------
export function updateStatus(groupName, topicName) {
  const connected = state.transport ? Array.from(state.transport.sessions.values()).filter(s => s.established && s.pubkey).length : 0;
  let online = 1;
  if (state.currentGroupId && state.currentTopicId) {
    for (const [, status] of state.peerStatus) {
      if (status.groupId === state.currentGroupId && status.topicId === state.currentTopicId) {
        online++;
      }
    }
  }
  const line = ` 群组: ${groupName || '无'}  话题: ${topicName || '无'}  连接: ${connected}  在线: ${online}`;
  process.stdout.write(CUP(1, 1));
  process.stdout.write(CLEAR_LINE);
  process.stdout.write(line);
}

// ---------- 完全重绘屏幕 ----------
function fullRedraw() {
  // 清空整个屏幕
  process.stdout.write(CLEAR + HOME);

  // 重绘状态栏
  const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
  const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
  updateStatus(g ? g.name : '无', t ? t.name : '无');

  const availRows = termRows - 3;
  const maxWidth = termCols - 2;

  // 生成所有消息行（带颜色）
  const allLines = [];
  for (const entry of messages) {
    let colorFn;
    if (entry.type === 'system') colorFn = chalk.gray;
    else if (entry.type === 'command') colorFn = chalk.cyan;
    else if (entry.type === 'message') colorFn = entry.isSelf ? chalk.green : chalk.blue;
    const wrapped = wrapTextByWidth(entry.text, maxWidth);
    for (const line of wrapped) {
      allLines.push(colorFn ? colorFn(line) : line);
    }
  }

  // 只显示最后 availRows 行
  const start = Math.max(0, allLines.length - availRows);
  const displayLines = allLines.slice(start);

  for (let i = 0; i < displayLines.length; i++) {
    process.stdout.write(CUP(2 + i, 1));
    process.stdout.write(CLEAR_LINE);
    process.stdout.write(displayLines[i]);
  }
  // 清空剩余行
  for (let i = displayLines.length; i < availRows; i++) {
    process.stdout.write(CUP(2 + i, 1));
    process.stdout.write(CLEAR_LINE);
  }

  drawInputLine();
}

// ---------- 输入行 ----------
function drawInputLine() {
  process.stdout.write(CUP(termRows, 1));
  process.stdout.write(CLEAR_LINE);
  process.stdout.write('> ' + inputBuffer);
  const prefixWidth = 2;
  const cursorPos = prefixWidth + getDisplayWidth(inputBuffer.slice(0, inputCursor));
  process.stdout.write(CUP(termRows, cursorPos + 1));
}

// ---------- 对外 API ----------
export function appendMessage(text, isSelf = false) {
  messages.push({ type: 'message', text, isSelf });
  fullRedraw();
}

export function appendSystemMessage(text) {
  messages.push({ type: 'system', text });
  fullRedraw();
}

export function appendCommandMessage(text) {
  messages.push({ type: 'command', text });
  fullRedraw();
}

// 格式化消息（纯文本，不含颜色）
export function formatMessage(displayName, text, time) {
  return `{${time}} (${displayName}) ${text}`;
}

// ---------- 键盘输入 ----------
export function setupInput(onLineCallback) {
  process.stdin.removeAllListeners('data');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    const key = chunk.toString();
    if (key === '\x03') {
      process.exit(0);
    } else if (key === '\r' || key === '\n') {
      const text = inputBuffer.trim();
      if (text) {
        onLineCallback(text);
      }
      inputBuffer = '';
      inputCursor = 0;
      drawInputLine();
    } else if (key === '\x7f' || key === '\b') {
      if (inputCursor > 0) {
        const before = inputBuffer.slice(0, inputCursor - 1);
        const after = inputBuffer.slice(inputCursor);
        inputBuffer = before + after;
        inputCursor--;
        drawInputLine();
      }
    } else if (key === '\x1b') {
      // ignore
    } else if (key.startsWith('\x1b[')) {
      // ignore arrow keys
    } else {
      const before = inputBuffer.slice(0, inputCursor);
      const after = inputBuffer.slice(inputCursor);
      inputBuffer = before + key + after;
      inputCursor += key.length;
      drawInputLine();
    }
  });
}

// ---------- 窗口大小变化 ----------
export function onResize() {
  termRows = process.stdout.rows;
  termCols = process.stdout.columns;
  process.stdout.write(`${CSI}2;${termRows - 1}r`);
  fullRedraw();
}