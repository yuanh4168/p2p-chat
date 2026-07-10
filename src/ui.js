import chalk from 'chalk';
import { state } from './state.js';
import { getGroup, getTopic } from './db.js';
import { getTimeStr } from './utils.js';

const ESC = '\x1b';
const CSI = ESC + '[';
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;
const CUP = (row, col) => `${CSI}${row};${col}H`;
const CLEAR_LINE = `${CSI}2K`;

let termRows = 0, termCols = 0;
let inputBuffer = '';
let inputCursor = 0;

// 消息历史
const messages = [];

// ---------- 显示宽度计算 ----------
function getDisplayWidth(str) {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
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
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = [];
  let currentLine = '';
  let currentWidth = 0;
  let plainIndex = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x1b') {
      let end = i + 1;
      while (end < text.length && text[end] !== 'm') end++;
      if (end < text.length) {
        const seq = text.slice(i, end + 1);
        currentLine += seq;
        i = end;
        continue;
      }
    }
    const chPlain = plain[plainIndex] || '';
    const chWidth = getDisplayWidth(chPlain);
    plainIndex++;
    if (currentWidth + chWidth > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
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
  process.stdout.write(CLEAR + HOME);

  const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
  const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
  updateStatus(g ? g.name : '无', t ? t.name : '无');

  const availRows = termRows - 3;
  const maxWidth = termCols - 2;

  const allLines = [];
  for (const entry of messages) {
    let lines;
    if (entry.type === 'raw') {
      lines = entry.text.split('\n');
    } else {
      lines = wrapTextByWidth(entry.text, maxWidth);
    }
    for (const line of lines) {
      const hasAnsi = line.includes('\x1b');
      let output = line;
      if (!hasAnsi) {
        if (entry.type === 'message') {
          output = entry.isSelf ? chalk.green(line) : chalk.blue(line);
        } else if (entry.type === 'system') {
          output = chalk.gray(line);
        } else if (entry.type === 'command') {
          output = chalk.yellow(line);
        }
      }
      allLines.push(output);
    }
  }

  const start = Math.max(0, allLines.length - availRows);
  const displayLines = allLines.slice(start);

  for (let i = 0; i < displayLines.length; i++) {
    process.stdout.write(CUP(2 + i, 1));
    process.stdout.write(CLEAR_LINE);
    process.stdout.write(displayLines[i]);
  }
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
  const timeStr = getTimeStr();
  messages.push({ type: 'system', text: `[${timeStr}] ${text}` });
  fullRedraw();
}

export function appendCommandMessage(text) {
  if (!text.startsWith('[')) {
    const timeStr = getTimeStr();
    text = `[${timeStr}] ${text}`;
  }
  messages.push({ type: 'command', text });
  fullRedraw();
}

export function appendRaw(text) {
  messages.push({ type: 'raw', text });
  fullRedraw();
}

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
    } else if (key.startsWith('\x1b[')) {
      // 方向键：左右移动光标
      const code = key.slice(2);
      if (code === 'D' && inputCursor > 0) {
        inputCursor--;
        drawInputLine();
      } else if (code === 'C' && inputCursor < inputBuffer.length) {
        inputCursor++;
        drawInputLine();
      }
    } else if (key === '\x1b') {
      // ignore
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