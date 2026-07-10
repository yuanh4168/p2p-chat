// src/ui.js - 自适应窗口（实时读取终端尺寸）、无鼠标捕获、双缓冲、中文支持

import chalk from 'chalk';
import { state } from './state.js';
import { getGroup, getTopic } from './db.js';
import { getTimeStr } from './utils.js';

const ESC = '\x1b';
const CSI = ESC + '[';
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;
const CUP = (r, c) => `${CSI}${r};${c}H`;
const CLEAR_LINE = `${CSI}2K`;

// ---------- 全局变量（由 render 实时更新） ----------
let termRows = 0;
let termCols = 0;

// ---------- 状态 ----------
const allMessages = [];
let inputBuffer = '';
let cursorPos = 0;
const maxInputLength = 2000;

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

function getPlainText(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function wrapTextByWidth(text, maxWidth) {
  const plain = getPlainText(text);
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

// ---------- 输入行拆分 ----------
function computeInputLines(input, maxCols) {
  const prefix = '> ';
  const prefixWidth = getDisplayWidth(prefix);
  const firstLineMax = maxCols - prefixWidth;
  // 即使宽度不足，也强制返回至少一行
  if (firstLineMax < 1) {
    return [prefix + input.slice(0, 1)]; // 显示至少一个字符
  }

  const plain = getPlainText(input);
  const lines = [];
  let remaining = input;
  let plainRemaining = plain;
  let lineCount = 0;
  while (plainRemaining.length > 0) {
    let maxLen;
    let prefixStr = '';
    if (lineCount === 0) {
      maxLen = firstLineMax;
      prefixStr = prefix;
    } else {
      maxLen = maxCols;
      prefixStr = '';
    }
    let width = 0;
    let idx = 0;
    let plainIdx = 0;
    let linePlain = '';
    while (idx < remaining.length && width < maxLen) {
      const ch = remaining[idx];
      if (ch === '\x1b') {
        let end = idx + 1;
        while (end < remaining.length && remaining[end] !== 'm') end++;
        if (end < remaining.length) {
          linePlain += remaining.slice(idx, end + 1);
          idx = end + 1;
          continue;
        }
      }
      const chPlain = plainRemaining[plainIdx] || '';
      const chWidth = getDisplayWidth(chPlain);
      if (width + chWidth > maxLen) break;
      linePlain += ch;
      width += chWidth;
      idx++;
      plainIdx++;
    }
    if (idx === 0 && remaining.length > 0) {
      linePlain += remaining[0];
      idx = 1;
    }
    const lineStr = prefixStr + linePlain;
    lines.push(lineStr);
    remaining = remaining.slice(idx);
    plainRemaining = plainRemaining.slice(plainIdx);
    lineCount++;
  }
  if (lines.length === 0) {
    lines.push(prefix);
  }
  return lines;
}

// 获取光标在屏幕上的行列
function getInputCursorScreenPos(input, cursorPos, maxCols) {
  const lines = computeInputLines(input, maxCols);
  let charCount = 0;
  let lineIndex = 0;
  let colInLine = 0;
  const plain = getPlainText(input);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prefix = i === 0 ? '> ' : '';
    const linePlain = getPlainText(line).slice(prefix.length);
    const lineLen = linePlain.length;
    if (cursorPos <= charCount + lineLen) {
      lineIndex = i;
      const offset = cursorPos - charCount;
      const before = linePlain.slice(0, offset);
      const widthBefore = getDisplayWidth(prefix) + getDisplayWidth(before);
      colInLine = widthBefore;
      break;
    }
    charCount += lineLen;
  }
  if (lineIndex >= lines.length) {
    const lastLine = lines[lines.length - 1];
    const prefix = lines.length === 1 ? '> ' : '';
    const lastPlain = getPlainText(lastLine).slice(prefix.length);
    lineIndex = lines.length - 1;
    colInLine = getDisplayWidth(prefix) + getDisplayWidth(lastPlain);
  }
  const inputLineCount = lines.length;
  const startRow = termRows - inputLineCount;
  const row = startRow + lineIndex;
  const col = colInLine + 1;
  return { row, col };
}

// ---------- 双缓冲渲染 ----------
function render() {
  // 每次渲染实时读取终端尺寸
  const rows = process.stdout.rows || 30;
  const cols = process.stdout.columns || 80;
  termRows = rows;
  termCols = cols;

  const out = [];

  out.push(CLEAR + HOME);

  // ---- 状态行（第1行） ----
  const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
  const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
  const groupName = g ? g.name : '无';
  const topicName = t ? t.name : '无';
  const connected = state.transport ? Array.from(state.transport.sessions.values()).filter(s => s.established && s.pubkey).length : 0;
  let online = 1;
  if (state.currentGroupId && state.currentTopicId) {
    for (const [, status] of state.peerStatus) {
      if (status.groupId === state.currentGroupId && status.topicId === state.currentTopicId) {
        online++;
      }
    }
  }
  const statusLine = ` 群组: ${groupName}  话题: ${topicName}  连接: ${connected}  在线: ${online}`;
  out.push(CUP(1, 1) + CLEAR_LINE + statusLine);

  // ---- 输入区域行数 ----
  const inputLines = computeInputLines(inputBuffer, termCols);
  const inputLineCount = inputLines.length;

  // ---- 分隔线位置（0‑indexed） ----
  const separatorRow = termRows - inputLineCount - 1; // 分隔线所在行（0‑indexed）
  if (separatorRow >= 1) {
    out.push(CUP(separatorRow + 1, 1) + CLEAR_LINE);
    out.push('─'.repeat(termCols));
  }

  // ---- 绘制输入区域 ----
  for (let i = 0; i < inputLines.length; i++) {
    const row = termRows - inputLineCount + i;
    out.push(CUP(row + 1, 1) + CLEAR_LINE + inputLines[i]);
  }

  // ---- 消息区域：从第2行到分隔线上一行 ----
  const msgStartRow = 2; // 1‑indexed
  const msgEndRow = separatorRow; // 1‑indexed，等于分隔线所在行的上一行（因为分隔线在 separatorRow+1 行）
  const availableRows = Math.max(0, msgEndRow - msgStartRow + 1);

  // 清空消息区域（从第2行到 msgEndRow）
  for (let r = msgStartRow; r <= msgEndRow; r++) {
    out.push(CUP(r, 1) + CLEAR_LINE);
  }

  // 获取要显示的消息（最新 availableRows 条）
  const totalMsgs = allMessages.length;
  const startIndex = Math.max(0, totalMsgs - availableRows);
  const visibleMsgs = allMessages.slice(startIndex);

  // 绘制消息
  for (let i = 0; i < visibleMsgs.length; i++) {
    const msg = visibleMsgs[i];
    const row = msgStartRow + i;
    if (row > msgEndRow) break;
    let text = msg.text;
    if (msg.type === 'message') {
      text = msg.isSelf ? chalk.green(text) : chalk.blue(text);
    } else if (msg.type === 'system') {
      text = chalk.gray(text);
    } else if (msg.type === 'command') {
      text = chalk.yellow(text);
    }
    const wrapped = wrapTextByWidth(text, termCols - 1);
    for (let j = 0; j < wrapped.length && row + j <= msgEndRow; j++) {
      out.push(CUP(row + j + 1, 1) + CLEAR_LINE + wrapped[j]);
    }
  }

  // ---- 光标定位 ----
  const { row, col } = getInputCursorScreenPos(inputBuffer, cursorPos, termCols);
  const finalRow = Math.min(row + 1, termRows);
  const finalCol = Math.min(col, termCols);
  out.push(CUP(finalRow, finalCol));

  // 一次性写入
  process.stdout.write(out.join(''));
}

// ---------- 对外 API ----------
export function appendMessage(text, isSelf = false) {
  allMessages.push({ type: 'message', text, isSelf });
  render();
}

export function appendSystemMessage(text) {
  const timeStr = getTimeStr();
  allMessages.push({ type: 'system', text: `[${timeStr}] ${text}` });
  render();
}

export function appendCommandMessage(text) {
  if (!text.startsWith('[')) {
    const timeStr = getTimeStr();
    text = `[${timeStr}] ${text}`;
  }
  allMessages.push({ type: 'command', text });
  render();
}

export function appendRaw(text) {
  allMessages.push({ type: 'raw', text });
  render();
}

export function formatMessage(displayName, text, time) {
  return `{${time}} (${displayName}) ${text}`;
}

// ---------- 键盘输入 ----------
let onLineCallback = null;

function handleKey(key) {
  if (key === '\x03') {
    process.exit(0);
    return;
  }

  if (key === '\r' || key === '\n') {
    const text = inputBuffer.trim();
    if (text) {
      if (onLineCallback) onLineCallback(text);
    }
    inputBuffer = '';
    cursorPos = 0;
    render();
    return;
  }

  if (key === '\x7f' || key === '\b') {
    if (cursorPos > 0) {
      const before = inputBuffer.slice(0, cursorPos - 1);
      const after = inputBuffer.slice(cursorPos);
      inputBuffer = before + after;
      cursorPos--;
      render();
    }
    return;
  }

  // 方向键
  if (key.startsWith('\x1b[')) {
    const code = key.slice(2);
    if (code === 'D') { // Left
      if (cursorPos > 0) { cursorPos--; render(); }
      return;
    } else if (code === 'C') { // Right
      if (cursorPos < inputBuffer.length) { cursorPos++; render(); }
      return;
    } else if (code === 'A') { // Up
      const lines = computeInputLines(inputBuffer, termCols);
      let charCount = 0;
      let foundLine = -1;
      let lineStart = 0, lineEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        const linePlain = getPlainText(lines[i]).slice(i === 0 ? 2 : 0);
        const len = linePlain.length;
        if (cursorPos >= charCount && cursorPos <= charCount + len) {
          foundLine = i;
          lineStart = charCount;
          lineEnd = charCount + len;
          break;
        }
        charCount += len;
      }
      if (foundLine > 0) {
        const prevLineStart = charCount - getPlainText(lines[foundLine - 1]).slice(foundLine - 1 === 0 ? 2 : 0).length;
        const prevLineLen = getPlainText(lines[foundLine - 1]).slice(foundLine - 1 === 0 ? 2 : 0).length;
        const currentCol = cursorPos - lineStart;
        const targetCol = Math.min(currentCol, prevLineLen);
        cursorPos = prevLineStart + targetCol;
        render();
      }
      return;
    } else if (code === 'B') { // Down
      const lines = computeInputLines(inputBuffer, termCols);
      let charCount = 0;
      let foundLine = -1;
      let lineStart = 0, lineEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        const linePlain = getPlainText(lines[i]).slice(i === 0 ? 2 : 0);
        const len = linePlain.length;
        if (cursorPos >= charCount && cursorPos <= charCount + len) {
          foundLine = i;
          lineStart = charCount;
          lineEnd = charCount + len;
          break;
        }
        charCount += len;
      }
      if (foundLine < lines.length - 1) {
        const nextLineStart = charCount;
        const nextLineLen = getPlainText(lines[foundLine + 1]).slice(foundLine + 1 === 0 ? 2 : 0).length;
        const currentCol = cursorPos - lineStart;
        const targetCol = Math.min(currentCol, nextLineLen);
        cursorPos = nextLineStart + targetCol;
        render();
      }
      return;
    }
    return;
  }

  // 普通字符（中文等）
  if (key.length > 0 && key >= ' ') {
    if (inputBuffer.length >= maxInputLength) {
      appendSystemMessage(`已达到最大输入长度 ${maxInputLength} 字符`);
      return;
    }
    const before = inputBuffer.slice(0, cursorPos);
    const after = inputBuffer.slice(cursorPos);
    inputBuffer = before + key + after;
    cursorPos += key.length;
    render();
  }
}

export function setupInput(onLine) {
  onLineCallback = onLine;
  process.stdin.removeAllListeners('data');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  // 不启用任何鼠标捕获，让终端处理选择
  process.stdin.on('data', (chunk) => {
    const key = chunk.toString();
    handleKey(key);
  });
}

export function restoreTerminal() {
  process.stdout.write(`${CSI}?1049l`);
}

export function initTerminal() {
  // 切换到备用屏幕
  process.stdout.write(`${CSI}?1049h`);
  process.stdout.write(CLEAR + HOME);
  render();
}

export function onResize() {
  render();
}

export function updateStatus(groupName, topicName) {
  render();
}