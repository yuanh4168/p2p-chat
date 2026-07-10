// src/ui.js - 重写，支持多行输入、鼠标滚轮、光标点击定位

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
const CLEAR_SCREEN = `${CSI}3J`;

// 终端尺寸
let termRows = 0, termCols = 0;

// ---------- 状态 ----------
const allMessages = [];          // 完整消息列表 { type, text, isSelf? }
let scrollOffset = 0;            // 从顶部跳过的消息条数（用于滚动）
let inputBuffer = '';
let cursorPos = 0;              // 在 inputBuffer 中的索引
let maxInputLength = 2000;      // 可配置

let newMessageFlag = false;     // 是否有新消息在屏幕外

// 是否启用鼠标跟踪
let mouseEnabled = false;

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

// 按显示宽度截断/换行
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

// ---------- 输入行计算 ----------
// 输入字符串按显示宽度拆分成多行，第一行带 "> " 前缀
function computeInputLines(input, maxCols) {
  const prefix = '> ';
  const prefixWidth = getDisplayWidth(prefix);
  const firstLineMax = maxCols - prefixWidth;
  if (firstLineMax < 1) return []; // 终端太窄

  const plain = getPlainText(input);
  const lines = [];
  let remaining = input;
  let plainRemaining = plain;
  let lineCount = 0;
  let pos = 0;
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
    // 按显示宽度截取
    let width = 0;
    let idx = 0;
    let plainIdx = 0;
    let linePlain = '';
    while (idx < remaining.length && width < maxLen) {
      const ch = remaining[idx];
      if (ch === '\x1b') {
        // 跳过 ANSI 序列，它们不影响宽度
        let end = idx + 1;
        while (end < remaining.length && remaining[end] !== 'm') end++;
        if (end < remaining.length) {
          // 保留 ANSI 序列
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
    // 如果 idx 没有推进（可能是空格等），强制推进
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
    lines.push(prefix); // 空输入显示 "> "
  }
  return lines;
}

// 获取输入光标在屏幕上的行列位置（基于当前输入行）
function getInputCursorScreenPos(input, cursorPos, maxCols) {
  const lines = computeInputLines(input, maxCols);
  // 计算光标在输入字符串中的位置
  let charCount = 0;
  let lineIndex = 0;
  let colInLine = 0;
  let plainIndex = 0;
  const plain = getPlainText(input);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prefix = i === 0 ? '> ' : '';
    const linePlain = getPlainText(line).slice(prefix.length); // 去掉前缀
    const lineLen = linePlain.length;
    if (cursorPos <= charCount + lineLen) {
      lineIndex = i;
      const offset = cursorPos - charCount;
      // 计算该偏移在行中的显示宽度（考虑前缀）
      const before = linePlain.slice(0, offset);
      const widthBefore = getDisplayWidth(prefix) + getDisplayWidth(before);
      colInLine = widthBefore;
      break;
    }
    charCount += lineLen;
  }
  if (lineIndex >= lines.length) {
    // 光标可能在末尾
    const lastLine = lines[lines.length - 1];
    const prefix = lines.length === 1 ? '> ' : '';
    const lastPlain = getPlainText(lastLine).slice(prefix.length);
    lineIndex = lines.length - 1;
    colInLine = getDisplayWidth(prefix) + getDisplayWidth(lastPlain);
  }
  // 屏幕行：从底部向上数，第0行是最后一行
  const inputLineCount = lines.length;
  const startRow = termRows - inputLineCount; // 输入区域起始行（0-indexed）
  const row = startRow + lineIndex;
  // 列是 1-indexed，colInLine 是从0开始的宽度
  const col = colInLine + 1;
  return { row, col };
}

// ---------- 渲染 ----------
function render() {
  if (!termRows || !termCols) return;

  // 1. 清屏
  process.stdout.write(CLEAR + HOME);

  // 2. 状态行（第0行）
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
  process.stdout.write(CUP(1, 1) + CLEAR_LINE + statusLine);

  // 3. 计算输入区域占用的行数
  const inputLines = computeInputLines(inputBuffer, termCols);
  const inputLineCount = inputLines.length;

  // 4. 分隔线（在输入区域上方）
  const separatorRow = termRows - inputLineCount - 1; // 0-indexed
  if (separatorRow >= 1) {
    process.stdout.write(CUP(separatorRow + 1, 1) + CLEAR_LINE);
    const sep = '─'.repeat(termCols);
    process.stdout.write(sep);
  }

  // 5. 绘制输入区域
  for (let i = 0; i < inputLines.length; i++) {
    const row = termRows - inputLineCount + i;
    process.stdout.write(CUP(row + 1, 1) + CLEAR_LINE + inputLines[i]);
  }

  // 6. 绘制消息区域（在分隔线之上，状态行之下）
  const msgStartRow = 2; // 状态行占第1行（1-indexed），所以消息从第2行开始
  const msgEndRow = separatorRow; // 分隔线之前的行（1-indexed）
  const msgAvailableRows = Math.max(0, msgEndRow - msgStartRow + 1);

  // 根据滚动偏移决定显示哪些消息
  // allMessages 从旧到新
  const totalMsgs = allMessages.length;
  let startIndex = totalMsgs - msgAvailableRows - scrollOffset;
  if (startIndex < 0) startIndex = 0;
  const endIndex = Math.min(totalMsgs, startIndex + msgAvailableRows);
  const visibleMsgs = allMessages.slice(startIndex, endIndex);

  // 清空消息区域
  for (let r = msgStartRow; r <= msgEndRow; r++) {
    process.stdout.write(CUP(r, 1) + CLEAR_LINE);
  }

  // 绘制消息
  for (let i = 0; i < visibleMsgs.length; i++) {
    const msg = visibleMsgs[i];
    const row = msgStartRow + i;
    let text = msg.text;
    // 应用颜色
    if (msg.type === 'message') {
      text = msg.isSelf ? chalk.green(text) : chalk.blue(text);
    } else if (msg.type === 'system') {
      text = chalk.gray(text);
    } else if (msg.type === 'command') {
      text = chalk.yellow(text);
    }
    // 按宽度换行（可能多行）
    const lines = wrapTextByWidth(text, termCols - 1);
    for (let j = 0; j < lines.length && row + j <= msgEndRow; j++) {
      process.stdout.write(CUP(row + j + 1, 1) + CLEAR_LINE + lines[j]);
    }
  }

  // 7. 新消息提示（右下角）
  if (newMessageFlag) {
    // 判断是否在底部
    const atBottom = (scrollOffset === 0);
    if (!atBottom) {
      const indicatorRow = msgEndRow;
      const indicatorCol = termCols - 1;
      process.stdout.write(CUP(indicatorRow, indicatorCol) + chalk.yellow('↓'));
    }
  }

  // 8. 将光标定位到输入光标位置
  const { row, col } = getInputCursorScreenPos(inputBuffer, cursorPos, termCols);
  // 确保行列在有效范围内
  const finalRow = Math.min(row + 1, termRows);
  const finalCol = Math.min(col, termCols);
  process.stdout.write(CUP(finalRow, finalCol));

  // 刷新输出
  process.stdout.write('');
}

// ---------- 对外 API ----------
export function appendMessage(text, isSelf = false) {
  allMessages.push({ type: 'message', text, isSelf });
  // 如果当前滚动偏移为0（即在底部），保持滚动到底部；否则标记新消息
  if (scrollOffset === 0) {
    // 保持滚动到底部，自动显示新消息
  } else {
    newMessageFlag = true;
  }
  render();
}

export function appendSystemMessage(text) {
  const timeStr = getTimeStr();
  allMessages.push({ type: 'system', text: `[${timeStr}] ${text}` });
  if (scrollOffset === 0) {
    // 在底部
  } else {
    newMessageFlag = true;
  }
  render();
}

export function appendCommandMessage(text) {
  if (!text.startsWith('[')) {
    const timeStr = getTimeStr();
    text = `[${timeStr}] ${text}`;
  }
  allMessages.push({ type: 'command', text });
  if (scrollOffset === 0) {
    // 在底部
  } else {
    newMessageFlag = true;
  }
  render();
}

export function appendRaw(text) {
  allMessages.push({ type: 'raw', text });
  if (scrollOffset === 0) {
    // 在底部
  } else {
    newMessageFlag = true;
  }
  render();
}

export function formatMessage(displayName, text, time) {
  return `{${time}} (${displayName}) ${text}`;
}

// ---------- 输入处理 ----------
function handleKey(key) {
  if (key === '\x03') { // Ctrl+C
    process.exit(0);
    return;
  }

  if (key === '\r' || key === '\n') {
    // 发送消息
    const text = inputBuffer.trim();
    if (text) {
      // 通过回调发送
      if (onLineCallback) onLineCallback(text);
    }
    inputBuffer = '';
    cursorPos = 0;
    newMessageFlag = false; // 发送后重置提示
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
      if (cursorPos > 0) {
        cursorPos--;
        render();
      }
      return;
    } else if (code === 'C') { // Right
      if (cursorPos < inputBuffer.length) {
        cursorPos++;
        render();
      }
      return;
    } else if (code === 'A') { // Up
      // 移动到上一行（按显示宽度）
      const lines = computeInputLines(inputBuffer, termCols);
      const plain = getPlainText(inputBuffer);
      let charCount = 0;
      let lineStart = 0;
      let lineEnd = 0;
      let foundLine = -1;
      for (let i = 0; i < lines.length; i++) {
        const linePlain = getPlainText(lines[i]).slice(i === 0 ? 2 : 0); // 去掉前缀
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
        // 上一行
        const prevLineStart = charCount - getPlainText(lines[foundLine - 1]).slice(foundLine - 1 === 0 ? 2 : 0).length;
        const prevLineLen = getPlainText(lines[foundLine - 1]).slice(foundLine - 1 === 0 ? 2 : 0).length;
        // 保持列位置
        const currentCol = cursorPos - lineStart;
        const targetCol = Math.min(currentCol, prevLineLen);
        cursorPos = prevLineStart + targetCol;
        render();
      }
      return;
    } else if (code === 'B') { // Down
      const lines = computeInputLines(inputBuffer, termCols);
      const plain = getPlainText(inputBuffer);
      let charCount = 0;
      let lineStart = 0;
      let lineEnd = 0;
      let foundLine = -1;
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
    // 其他 escape 序列忽略
    return;
  }

  // 鼠标事件（escape sequence: \x1b[M...）
  if (key.startsWith('\x1b[M')) {
    // 解析鼠标事件
    const bytes = key.slice(3);
    if (bytes.length >= 3) {
      const b = bytes.charCodeAt(0);
      const x = bytes.charCodeAt(1) - 32;
      const y = bytes.charCodeAt(2) - 32;
      const button = b & 0x03;
      const isWheel = (b & 0x40) !== 0; // 高位标志
      if (isWheel) {
        const delta = (button === 0) ? -1 : (button === 1 ? 1 : 0);
        if (delta !== 0) {
          // 滚轮滚动消息区域
          const totalMsgs = allMessages.length;
          const inputLines = computeInputLines(inputBuffer, termCols);
          const inputLineCount = inputLines.length;
          const separatorRow = termRows - inputLineCount - 1;
          const msgStartRow = 2;
          const msgEndRow = separatorRow;
          const msgAvailableRows = Math.max(0, msgEndRow - msgStartRow + 1);
          const maxScroll = Math.max(0, totalMsgs - msgAvailableRows);
          let newOffset = scrollOffset - delta;
          if (newOffset < 0) newOffset = 0;
          if (newOffset > maxScroll) newOffset = maxScroll;
          if (newOffset !== scrollOffset) {
            scrollOffset = newOffset;
            // 如果滚动到了底部，清除新消息标志
            if (scrollOffset === 0) newMessageFlag = false;
            render();
          }
        }
      } else {
        // 鼠标点击，用于定位光标
        // 检查点击是否在输入区域
        const inputLines = computeInputLines(inputBuffer, termCols);
        const inputLineCount = inputLines.length;
        const startRow = termRows - inputLineCount; // 0-indexed
        const endRow = termRows - 1;
        if (y >= startRow && y <= endRow) {
          const lineIndex = y - startRow;
          const lineStr = inputLines[lineIndex] || '';
          const prefix = lineIndex === 0 ? '> ' : '';
          const prefixWidth = getDisplayWidth(prefix);
          const plainLine = getPlainText(lineStr).slice(prefix.length);
          // 计算点击位置对应的字符索引
          let col = x - 1; // 0-indexed
          // 减去前缀宽度
          if (col < prefixWidth) col = 0;
          else col -= prefixWidth;
          // 找到该列对应的字符位置
          let charOffset = 0;
          let width = 0;
          for (let i = 0; i < plainLine.length; i++) {
            const ch = plainLine[i];
            const w = getDisplayWidth(ch);
            if (width + w / 2 > col) break;
            width += w;
            charOffset++;
          }
          // 计算全局位置
          let globalPos = 0;
          for (let i = 0; i < lineIndex; i++) {
            const prevLine = inputLines[i];
            const prevPlain = getPlainText(prevLine).slice(i === 0 ? 2 : 0);
            globalPos += prevPlain.length;
          }
          globalPos += charOffset;
          cursorPos = Math.min(globalPos, inputBuffer.length);
          render();
        }
      }
    }
    return;
  }

  // 普通字符输入
  if (key.length === 1 && key >= ' ') {
    if (inputBuffer.length >= maxInputLength) {
      // 提示用户超限，可以显示一条系统消息
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

let onLineCallback = null;

export function setupInput(onLine) {
  onLineCallback = onLine;
  process.stdin.removeAllListeners('data');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  // 启用鼠标跟踪
  if (!mouseEnabled) {
    process.stdout.write(`${CSI}?1000h`); // 启用鼠标事件
    process.stdout.write(`${CSI}?1002h`); // 启用鼠标移动（可选）
    mouseEnabled = true;
  }

  process.stdin.on('data', (chunk) => {
    const key = chunk.toString();
    handleKey(key);
  });
}

export function restoreTerminal() {
  if (mouseEnabled) {
    process.stdout.write(`${CSI}?1000l`);
    process.stdout.write(`${CSI}?1002l`);
    mouseEnabled = false;
  }
  process.stdout.write(`${CSI}?1049l`);
}

// ---------- 初始化 ----------
export function initTerminal() {
  termRows = process.stdout.rows || 30;
  termCols = process.stdout.columns || 80;
  process.stdout.write(`${CSI}?1049h`);
  process.stdout.write(CLEAR + HOME);
  process.stdout.write(`${CSI}2;${termRows - 1}r`);
  render();
}

export function onResize() {
  termRows = process.stdout.rows;
  termCols = process.stdout.columns;
  process.stdout.write(`${CSI}2;${termRows - 1}r`);
  render();
}

// 导出更新状态（供外部调用）
export function updateStatus(groupName, topicName) {
  // 由 render 自己获取状态，这里可以触发重绘
  render();
}