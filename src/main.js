#!/usr/bin/env node
import { initDB, getLocalUser, saveLocalUser, getAllGroups, getGroup, getTopicsByGroup, getDefaultTopic,
         getMessages, saveMessage, getMessage, getLatestMessageIds, getMembers, isMember, addMember,
         isAdmin, getPendingRequests, addJoinRequest, updateRequestStatus, getGroupKey, saveGroup,
         getTopic, saveTopic, getAllConnections, saveConnection, getDBPath,
         getProfile, saveProfileRemote, setLocalNickname, updateUserNickname,
         getDisplayNameWithSelf } from './db.js';
import { generateKeyPair, encryptPrivateKey, decryptPrivateKey, ed25519SecretToX25519, toHex, fromHex,
         sign, verify, sha256, aesEncrypt, aesDecrypt } from './crypto.js';
import { DHTNode } from './dht.js';
import { UDPTransport } from './udp-transport.js';
import { verifyMessage, computeMessageId, storeValidMessage, decryptMessageBody } from './message.js';
import { createGroup, getGroupSymKey, requestJoin } from './group.js';
import { UDP_PORTS } from './config.js';
import { info, error, debug, warn, setupGlobalErrorHandler } from './logger.js';
import chalk from 'chalk';
import { promisify } from 'util';
import { scrypt } from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import readline from 'readline';

setupGlobalErrorHandler();

const execAsync = promisify(exec);
const scryptAsync = promisify(scrypt);

// ---------- 终端控制 ----------
const ESC = '\x1b';
const CSI = ESC + '[';
const CUP = (row, col) => `${CSI}${row};${col}H`;
const CLEAR_LINE = `${CSI}2K`;
const SAVE_CURSOR = `${ESC}s`;
const RESTORE_CURSOR = `${ESC}u`;

let termRows = 0, termCols = 0;
let inputBuffer = '';
let inputCursor = 0;
let renderedLines = [];

function initTerminal() {
    termRows = process.stdout.rows || 30;
    termCols = process.stdout.columns || 80;
    process.stdout.write(`${CSI}?1049h`);
    process.stdout.write(`${CSI}2J${CSI}H`);
    process.stdout.write(`${CSI}2;${termRows - 1}r`);
    updateStatus('无', '无');
    process.stdout.write(CUP(termRows, 1));
    process.stdout.write(CLEAR_LINE);
    process.stdout.write('> ');
    process.stdout.write(CUP(termRows, 3));
}

function restoreTerminal() {
    process.stdout.write(`${CSI}?1049l`);
}

// peerStatus: 存储每个对等节点的当前群组和话题
const peerStatus = new Map();

function updateStatus(groupName, topicName) {
    const connected = transport ? Array.from(transport.sessions.values()).filter(s => s.established && s.pubkey).length : 0;
    // 统计当前话题在线人数（自己 + 同话题的对等节点）
    let online = 1; // 自己
    if (currentGroupId && currentTopicId) {
        for (const [pubkey, status] of peerStatus) {
            if (status.groupId === currentGroupId && status.topicId === currentTopicId) {
                online++;
            }
        }
    }
    const line = ` 群组: ${groupName || '无'}  话题: ${topicName || '无'}  连接: ${connected}  在线: ${online}`;
    process.stdout.write(SAVE_CURSOR);
    process.stdout.write(CUP(1, 1));
    process.stdout.write(CLEAR_LINE);
    process.stdout.write(line);
    process.stdout.write(RESTORE_CURSOR);
}

function renderMessages() {
    const availRows = termRows - 3;
    for (let i = 0; i < availRows; i++) {
        process.stdout.write(CUP(2 + i, 1));
        process.stdout.write(CLEAR_LINE);
    }
    const start = Math.max(0, renderedLines.length - availRows);
    const toShow = renderedLines.slice(start);
    for (let i = 0; i < toShow.length; i++) {
        process.stdout.write(CUP(2 + i, 1));
        process.stdout.write(toShow[i]);
    }
    drawInputLine();
}

function appendMessage(text, colorFn = null) {
    const lines = wrapText(text, termCols - 2, 10);
    for (let line of lines) {
        if (colorFn) {
            renderedLines.push(colorFn(line));
        } else {
            renderedLines.push(line);
        }
    }
    renderMessages();
}

function appendSystemMessage(text) {
    const gray = chalk.gray;
    const wrapped = wrapText(text, termCols - 2, 0);
    for (let line of wrapped) {
        renderedLines.push(gray(line));
    }
    renderMessages();
}

// 显示用户执行的命令（青色）
function appendCommandMessage(text) {
    const cyan = chalk.cyan;
    const wrapped = wrapText(`[命令] ${text}`, termCols - 2, 0);
    for (let line of wrapped) {
        renderedLines.push(cyan(line));
    }
    renderMessages();
}

function wrapText(text, maxWidth, indent) {
    if (text.length <= maxWidth) return [text];
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    for (let word of words) {
        if (currentLine.length + word.length + 1 <= maxWidth) {
            currentLine += (currentLine ? ' ' : '') + word;
        } else {
            if (currentLine) lines.push(currentLine);
            if (word.length > maxWidth) {
                let i = 0;
                while (i < word.length) {
                    lines.push(word.slice(i, i + maxWidth));
                    i += maxWidth;
                }
            } else {
                currentLine = word;
            }
        }
    }
    if (currentLine) lines.push(currentLine);
    const indentStr = ' '.repeat(indent);
    for (let i = 1; i < lines.length; i++) {
        lines[i] = indentStr + lines[i];
    }
    return lines;
}

function drawInputLine() {
    process.stdout.write(CUP(termRows, 1));
    process.stdout.write(CLEAR_LINE);
    process.stdout.write('> ' + inputBuffer);
    const cursorPos = 2 + inputCursor;
    process.stdout.write(CUP(termRows, cursorPos + 1));
}

// ---------- 输入处理 ----------
function setupInput() {
    process.stdin.removeAllListeners('data');
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', onKeyPress);
}

function onKeyPress(chunk) {
    const key = chunk.toString();
    if (key === '\x03') {
        process.exit(0);
    } else if (key === '\r' || key === '\n') {
        const text = inputBuffer.trim();
        if (text) {
            if (text.startsWith('/')) {
                // 显示用户执行的命令
                appendCommandMessage(text);
                handleCommand(text).catch(e => {
                    appendSystemMessage(`命令执行错误：${e.message}`);
                });
            } else {
                sendMessage(text);
            }
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
        // ignore
    } else {
        const before = inputBuffer.slice(0, inputCursor);
        const after = inputBuffer.slice(inputCursor);
        inputBuffer = before + key + after;
        inputCursor += key.length;
        drawInputLine();
    }
}

// ---------- 辅助函数 ----------
function shortPub(pubkey) { return pubkey ? pubkey.slice(0, 8) : '????'; }
function getGroupName(groupId) {
  const g = getGroup(groupId);
  return g ? g.name : 'null';
}
function getTopicName(topicId) {
  const t = getTopic(topicId);
  return t ? t.name : 'null';
}
function getTimeStr() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}
// 消息格式：只显示时间和用户名（昵称#公钥前8位），颜色固定：自己绿色，他人蓝色
function formatMessage(displayName, text, time, isSelf) {
  const colorFn = isSelf ? chalk.green : chalk.blue;
  return `{${time}} (${colorFn(displayName)}) ${text}`;
}
function randomColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return `${r},${g},${b}`;
}

// ---------- Tailscale ----------
async function getTailscaleIPs() {
  try {
    const { stdout } = await execAsync('tailscale ip -4');
    return stdout.trim().split('\n').filter(ip => ip);
  } catch (err) {
    if (err.message && (err.message.includes('tailscale: command not found') || err.message.includes('not found'))) {
      throw new Error('NOT_INSTALLED');
    }
    return [];
  }
}

// ---------- 广播自身资料（不含颜色） ----------
function broadcastMyProfile() {
  const profileMsg = {
    type: 'IDENTITY',
    pubkey: myPubkey,
    nickname: myNickname
  };
  transport.broadcast(profileMsg, myPubkey);
  info('MAIN', 'Broadcasted profile', { nickname: myNickname });
}

// ---------- 广播当前状态（群组/话题） ----------
function broadcastStatus() {
  if (!currentGroupId || !currentTopicId) return;
  const statusMsg = {
    type: 'STATUS',
    pubkey: myPubkey,
    groupId: currentGroupId,
    topicId: currentTopicId
  };
  transport.broadcast(statusMsg, myPubkey);
  // 更新自己的状态
  peerStatus.set(myPubkey, { groupId: currentGroupId, topicId: currentTopicId });
  updateStatus(getGroupName(currentGroupId), getTopicName(currentTopicId));
}

// ---------- 处理应用层消息 ----------
function handleAppMessage(msg, session) {
  const { type } = msg;
  try {
    switch (type) {
      case 'IDENTITY': {
        if (msg.pubkey && msg.nickname) {
          saveProfileRemote(msg.pubkey, msg.nickname, null); // 不再保存颜色
          debug('APP', 'Profile updated from IDENTITY', { pubkey: shortPub(msg.pubkey) });
        }
        break;
      }
      case 'STATUS': {
        if (msg.pubkey && msg.groupId && msg.topicId) {
          peerStatus.set(msg.pubkey, { groupId: msg.groupId, topicId: msg.topicId });
          // 更新状态栏（在线人数可能变化）
          const g = currentGroupId ? getGroup(currentGroupId) : null;
          const t = currentTopicId ? getTopic(currentTopicId) : null;
          updateStatus(g ? g.name : '无', t ? t.name : '无');
        }
        break;
      }
      case 'TEST':
        debug('APP', 'Test message received', { from: session.pubkey });
        break;
      case 'GROUP_LIST':
        break;
      case 'MSG_IDS': {
        const { groupId, ids } = msg;
        const ourIds = getLatestMessageIds(groupId, 100);
        const missing = ids.filter(id => !getMessage(id));
        if (missing.length) {
          transport.sendJSON(session.pubkey, { type: 'REQUEST_MSGS', groupId, ids: missing });
        }
        const theirSet = new Set(ids);
        const ourMissing = ourIds.filter(id => !theirSet.has(id));
        if (ourMissing.length) {
          const msgs = ourMissing.map(id => getMessage(id)).filter(Boolean);
          transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
        }
        break;
      }
      case 'REQUEST_MSGS': {
        const { groupId, ids } = msg;
        const msgs = ids.map(id => getMessage(id)).filter(Boolean);
        transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
        break;
      }
      case 'SEND_MSGS': {
        const { messages } = msg;
        for (const m of messages) {
          try { storeValidMessage(m); } catch(e) { warn('APP', 'Failed to store received message', { id: m.id, error: e.message }); }
        }
        break;
      }
      case 'NEW_MSG': {
        const { message } = msg;
        try {
          if (getMessage(message.id)) break;
          try {
            storeValidMessage(message);
          } catch(e) {
            if (e.message.includes('Missing prev messages')) {
              warn('APP', 'Missing prev messages, still storing', { id: message.id });
              saveMessage(message);
            } else {
              throw e;
            }
          }
          if (currentGroupId === message.group_id && currentTopicId === message.topic_id) {
            const symKey = groupKeys.get(message.group_id);
            if (symKey) {
              const plain = decryptMessageBody(message, symKey);
              const displayName = getDisplayNameWithSelf(message.author, myPubkey);
              const time = getTimeStr();
              const isSelf = message.author === myPubkey;
              const formatted = formatMessage(displayName, plain, time, isSelf);
              appendMessage(formatted);
            } else {
              error('APP', 'No group key for message', { groupId: message.group_id });
            }
          }
          const exclude = session.pubkey || message.author;
          transport.broadcast({ type: 'NEW_MSG', message }, exclude);
        } catch(e) {
          appendSystemMessage(`消息处理失败: ${e.message}`);
          error('APP', 'NEW_MSG processing error', { error: e.message, id: message.id });
        }
        break;
      }
      case 'JOIN_REQUEST': {
        const { groupId, requester } = msg;
        if (isAdmin(groupId, myPubkey)) {
          appendSystemMessage(`[加入请求] ${shortPub(requester)} 想加入群组 ${groupId}`);
          appendSystemMessage('使用 /approve <申请人公钥> <群组ID> 批准');
          addJoinRequest(groupId, requester);
          info('APP', 'Join request received', { groupId, requester });
        }
        break;
      }
      case 'JOIN_APPROVAL': {
        const { groupId, groupName, creator, groupKeyEncrypted } = msg;
        const sharedKey = session.sharedKey;
        if (!sharedKey) { warn('APP', 'No shared key for JOIN_APPROVAL', { groupId }); break; }
        try {
          const symKey = aesDecrypt(groupKeyEncrypted, sharedKey);
          const encrypted = aesEncrypt(symKey, masterKey);
          saveGroup(groupId, groupName || '未知群组', creator || '未知', encrypted);
          groupKeys.set(groupId, symKey);
          addMember(groupId, myPubkey, 'member');
          appendSystemMessage(`已批准加入群组 ${groupId}`);
          info('APP', 'Joined group via approval', { groupId });
          const g = getGroup(groupId);
          updateStatus(g ? g.name : '未知', currentTopicId ? getTopicName(currentTopicId) : '无');
        } catch(e) {
          appendSystemMessage('解密群组密钥失败');
          error('APP', 'JOIN_APPROVAL decryption error', { groupId, error: e.message });
        }
        break;
      }
      case 'NICK_UPDATE': {
        const { pubkey, nickname } = msg;
        if (pubkey && nickname) {
          saveProfileRemote(pubkey, nickname, null);
          debug('APP', 'Nickname updated', { pubkey: shortPub(pubkey) });
        }
        break;
      }
      default:
        debug('APP', 'Unhandled message type', { type });
    }
  } catch (err) {
    error('APP', 'handleAppMessage error', { error: err.message, type });
  }
}

// ---------- 消息发送 ----------
function sendMessage(text) {
  if (!currentGroupId) {
    appendSystemMessage('错误：未选择群组，请先 /use');
    return;
  }
  const symKey = groupKeys.get(currentGroupId);
  if (!symKey) {
    appendSystemMessage('错误：无群组密钥');
    return;
  }
  const bodyEncrypted = aesEncrypt(Buffer.from(text), symKey);
  const prev = getMessages(currentGroupId, currentTopicId, 1).map(m => m.id);
  const msgObj = {
    id: '',
    prev_ids: prev,
    author: myPubkey,
    group_id: currentGroupId,
    topic_id: currentTopicId,
    type: 'text',
    body_encrypted: JSON.stringify(bodyEncrypted),
    timestamp: Date.now(),
    sig: ''
  };
  const canonicalData = {
    prev_ids: msgObj.prev_ids,
    author: msgObj.author,
    group_id: msgObj.group_id,
    topic_id: msgObj.topic_id,
    timestamp: msgObj.timestamp,
    type: msgObj.type,
    body_encrypted: msgObj.body_encrypted
  };
  const sig = sign(Buffer.from(JSON.stringify(canonicalData)), keyPair.secretKey);
  msgObj.sig = toHex(sig);
  msgObj.id = computeMessageId(msgObj);
  storeValidMessage(msgObj);
  transport.broadcast({ type: 'NEW_MSG', message: msgObj }, myPubkey);
  
  const displayName = getDisplayNameWithSelf(myPubkey, myPubkey);
  const time = getTimeStr();
  const formatted = formatMessage(displayName, text, time, true);
  appendMessage(formatted);
  debug('MAIN', 'Message sent', { topic: currentTopicId, text });
}

// ---------- /online 命令处理 ----------
function handleOnline(subcmd) {
  let peers = [];
  if (subcmd === 'all') {
    // 所有已连接节点
    for (const [key, sess] of transport.sessions) {
      if (sess.established && sess.pubkey) {
        peers.push(sess.pubkey);
      }
    }
  } else if (subcmd === 'group') {
    if (!currentGroupId) { appendSystemMessage('未选择群组'); return; }
    for (const [pubkey, status] of peerStatus) {
      if (status.groupId === currentGroupId && pubkey !== myPubkey) {
        if (isMember(currentGroupId, pubkey)) {
          peers.push(pubkey);
        }
      }
    }
    // 加上自己
    if (isMember(currentGroupId, myPubkey)) peers.push(myPubkey);
  } else { // 默认话题
    if (!currentGroupId || !currentTopicId) { appendSystemMessage('未选择群组或话题'); return; }
    for (const [pubkey, status] of peerStatus) {
      if (status.groupId === currentGroupId && status.topicId === currentTopicId && pubkey !== myPubkey) {
        if (isMember(currentGroupId, pubkey)) {
          peers.push(pubkey);
        }
      }
    }
    // 加上自己
    if (isMember(currentGroupId, myPubkey)) peers.push(myPubkey);
  }

  if (peers.length === 0) {
    appendSystemMessage('当前没有在线用户');
    return;
  }

  let title = '';
  if (subcmd === 'all') title = '所有连接节点';
  else if (subcmd === 'group') title = `群组 ${getGroupName(currentGroupId)} 在线用户`;
  else title = `话题 ${getTopicName(currentTopicId)} 在线用户`;

  appendSystemMessage(`--- ${title} (${peers.length}) ---`);
  for (const pubkey of peers) {
    const display = getDisplayNameWithSelf(pubkey, myPubkey);
    const role = isAdmin(currentGroupId, pubkey) ? 'admin' : (isMember(currentGroupId, pubkey) ? 'member' : 'unknown');
    const hash = pubkey.slice(0, 16); // 显示前16位哈希
    appendSystemMessage(`  ${display} (${hash}) [${role}]`);
  }
}

// ---------- 命令处理 ----------
async function handleCommand(line) {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) return;
    const cmd = parts[0];
    try {
      switch (cmd) {
        case '/create': {
          const name = parts.slice(1).join(' ');
          if (!name) throw new Error('需要群组名称');
          const { id, symKey } = createGroup(name, myPubkey, masterKey);
          groupKeys.set(id, symKey);
          currentGroupId = id;
          const defaultTopic = getDefaultTopic(id);
          currentTopicId = defaultTopic.id;
          appendSystemMessage(`群组已创建：${id}（默认话题：${defaultTopic.name}）`);
          info('MAIN', 'Group created', { id, name });
          try {
            await dht.announce(fromHex(id));
          } catch (e) {
            appendSystemMessage('DHT 公告失败（可能因网络原因，但手动连接不受影响）');
            warn('MAIN', 'DHT announce failed', { group: id, error: e.message });
          }
          updateStatus(name, defaultTopic.name);
          // 广播状态
          broadcastStatus();
          break;
        }
        case '/join': {
          const groupId = parts[1];
          if (!groupId) throw new Error('需要群组 ID');
          if (isMember(groupId, myPubkey)) {
            appendSystemMessage('已是该群组成员');
          } else {
            requestJoin(groupId, myPubkey, transport);
            appendSystemMessage(`已向群组 ${groupId} 发送加入请求`);
            info('MAIN', 'Join request sent', { groupId });
          }
          break;
        }
        case '/use': {
          const groupId = parts[1];
          if (!groupId) throw new Error('需要群组 ID');
          const g = getGroup(groupId);
          if (!g) throw new Error('群组不存在');
          if (!isMember(groupId, myPubkey) && groupId !== g.creator_pubkey) {
            appendSystemMessage('您不是该群组的成员');
          } else {
            currentGroupId = groupId;
            const defaultTopic = getDefaultTopic(groupId);
            currentTopicId = defaultTopic.id;
            appendSystemMessage(`已切换到群组 ${g.name}（${groupId}），话题：${defaultTopic.name}`);
            info('MAIN', 'Switched group', { groupId, topic: defaultTopic.name });
            updateStatus(g.name, defaultTopic.name);
            broadcastStatus();
          }
          break;
        }
        case '/topic': {
          if (!currentGroupId) throw new Error('未选择群组');
          const topicName = parts.slice(1).join(' ');
          if (!topicName) {
            const topics = getTopicsByGroup(currentGroupId);
            appendSystemMessage('话题列表：' + topics.map(t=>t.name).join(', '));
            break;
          }
          const topicId = toHex(sha256(Buffer.from(`topic:${currentGroupId}:${topicName}`)));
          const existing = getTopic(topicId);
          if (!existing) {
            saveTopic(topicId, currentGroupId, topicName);
            appendSystemMessage(`话题已创建：${topicName}`);
          }
          currentTopicId = topicId;
          appendSystemMessage(`已切换到话题：${topicName}`);
          const g = getGroup(currentGroupId);
          updateStatus(g ? g.name : '未知', topicName);
          broadcastStatus();
          break;
        }
        case '/approve': {
          const requester = parts[1];
          const groupId = parts[2];
          if (!requester || !groupId) throw new Error('用法：/approve <申请人公钥> <群组ID>');
          if (!isAdmin(groupId, myPubkey)) throw new Error('您不是该群组的管理员');
          let sharedKey = null;
          for (const [key, sess] of transport.sessions) {
            if (sess.pubkey === requester) {
              sharedKey = sess.sharedKey;
              break;
            }
          }
          if (!sharedKey) throw new Error('请求者未连接或没有共享密钥');
          const symKey = groupKeys.get(groupId);
          if (!symKey) throw new Error('未找到群组密钥');
          const encryptedKey = aesEncrypt(symKey, sharedKey);
          const g = getGroup(groupId);
          const approval = {
            type: 'JOIN_APPROVAL',
            groupId,
            groupName: g.name,
            creator: g.creator_pubkey,
            groupKeyEncrypted: encryptedKey
          };
          transport.sendJSON(requester, approval);
          addMember(groupId, requester, 'member');
          updateRequestStatus(groupId, requester, 'approved');
          appendSystemMessage(`已批准 ${shortPub(requester)} 加入群组 ${groupId}`);
          info('MAIN', 'Join approved', { requester, groupId });
          break;
        }
        case '/list': {
          const groups = getAllGroups();
          if (groups.length === 0) {
            appendSystemMessage('暂无群组');
          } else {
            groups.forEach(g => appendSystemMessage(`${g.id}  ${g.name}（创建者：${shortPub(g.creator_pubkey)}）`));
          }
          break;
        }
        case '/members': {
          const groupId = parts[1] || currentGroupId;
          if (!groupId) throw new Error('需要群组 ID');
          const members = getMembers(groupId);
          if (members.length === 0) {
            appendSystemMessage('暂无成员');
          } else {
            members.forEach(m => {
              const display = getDisplayNameWithSelf(m.pubkey, myPubkey);
              appendSystemMessage(`  ${display}  （${m.role}）`);
            });
          }
          break;
        }
        case '/msgs': {
          const groupId = parts[1] || currentGroupId;
          if (!groupId) throw new Error('需要群组 ID');
          const topicId = parts[2] || currentTopicId;
          const msgs = getMessages(groupId, topicId, 20);
          const symKey = groupKeys.get(groupId);
          if (!symKey) { appendSystemMessage('无群组密钥'); break; }
          if (msgs.length === 0) {
            appendSystemMessage('暂无消息');
          } else {
            for (const m of msgs.reverse()) {
              try {
                const plain = decryptMessageBody(m, symKey);
                const displayName = getDisplayNameWithSelf(m.author_pubkey, myPubkey);
                const time = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 19);
                const isSelf = m.author_pubkey === myPubkey;
                const formatted = formatMessage(displayName, plain, time, isSelf);
                appendMessage(formatted);
              } catch (e) {
                appendSystemMessage('[无法解密]');
              }
            }
          }
          break;
        }
        case '/connect': {
          const arg = parts[1];
          if (!arg) throw new Error('用法：/connect <IP> [端口]');
          let ip, port;
          if (arg.includes(':')) {
            [ip, port] = arg.split(':');
            port = parseInt(port);
            transport._startHandshake(ip, port);
            appendSystemMessage(`正在连接 ${ip}:${port}...`);
            const timeout = setTimeout(() => {
              const key = `${ip}:${port}`;
              if (!transport.sessions.has(key) || !transport.sessions.get(key).established) {
                appendSystemMessage(`连接 ${ip}:${port} 超时`);
              }
            }, 10000);
            const handler = ({ ip: ip2, port: port2 }) => {
              if (ip2 === ip && port2 === port) {
                clearTimeout(timeout);
                transport.removeListener('handshake-complete', handler);
              }
            };
            transport.on('handshake-complete', handler);
          } else {
            ip = arg;
            const ports = UDP_PORTS;
            for (const p of ports) {
              transport._startHandshake(ip, p);
            }
            appendSystemMessage(`尝试连接 ${ip} 的端口 ${ports.join(', ')}...`);
          }
          break;
        }
        case '/tailscale': {
          try {
            const ips = await getTailscaleIPs();
            if (ips.length) {
              appendSystemMessage(`Tailscale IP: ${ips.join(', ')}`);
            } else {
              appendSystemMessage('未检测到 Tailscale 网络（请确保已安装并登录 Tailscale）');
            }
          } catch (e) {
            if (e.message === 'NOT_INSTALLED') {
              appendSystemMessage('Tailscale 未安装，请访问 https://tailscale.com/download 下载安装。');
            } else {
              appendSystemMessage('获取 Tailscale IP 失败: ' + e.message);
            }
          }
          break;
        }
        case '/nick': {
          if (parts.length === 1) {
            appendSystemMessage(`当前昵称：${myNickname}`);
            break;
          }
          if (parts.length === 2) {
            const newNick = parts[1];
            myNickname = newNick;
            updateUserNickname(myPubkey, newNick);
            const updateMsg = { type: 'NICK_UPDATE', pubkey: myPubkey, nickname: newNick };
            transport.broadcast(updateMsg, myPubkey);
            appendSystemMessage(`昵称已设置为：${newNick}`);
            info('MAIN', 'Nickname updated', { nickname: newNick });
          } else if (parts.length === 3) {
            const target = parts[1];
            const nick = parts[2];
            setLocalNickname(target, nick);
            appendSystemMessage(`已为 ${shortPub(target)} 设置本地昵称：${nick}`);
            info('MAIN', 'Local nickname set', { target, nickname: nick });
          } else {
            throw new Error('用法：/nick [<pubkey>] <昵称>');
          }
          break;
        }
        case '/online': {
          const subcmd = parts[1] || 'topic';
          handleOnline(subcmd);
          break;
        }
        case '/exit': {
          appendSystemMessage('退出程序...');
          process.exit(0);
        }
        default: {
          appendSystemMessage(`未知命令: ${cmd}`);
        }
      }
    } catch(e) {
      appendSystemMessage(`错误：${e.message}`);
      error('MAIN', 'Command error', { command: cmd, error: e.message, stack: e.stack });
    }
}

// ---------- 全局变量 ----------
let keyPair, x25519KeyPair, masterKey, myPubkey;
let transport, dht;
let currentGroupId = null;
let currentTopicId = null;
let groupKeys = new Map();
let myNickname = '';

// ---------- 一次性密码输入 ----------
function question(q) {
  return new Promise((resolve) => {
    process.stdin.setRawMode(false);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(q, (ans) => {
      rl.close();
      process.stdin.setRawMode(true);
      process.stdin.resume();
      resolve(ans);
    });
  });
}

// ---------- 主函数 ----------
async function main() {
  info('MAIN', '=== Application started ===');
  const RESET_DB = false;
  if (RESET_DB) {
    const dbPath = path.join(process.cwd(), 'data', 'chat.db');
    if (fs.existsSync(dbPath)) { fs.unlinkSync(dbPath); info('MAIN', 'Deleted old database'); }
  }

  try {
    await initDB();
    info('MAIN', 'Database initialized', { path: getDBPath() });
  } catch (err) {
    error('MAIN', 'Failed to initialize database', err);
    process.exit(1);
  }

  let user = null;
  try {
    user = getLocalUser();
    if (user && user.pubkey && user.encrypted_private_key) {
      JSON.parse(user.encrypted_private_key);
    } else {
      user = null;
    }
  } catch (e) {
    user = null;
    warn('MAIN', 'User data parse error, will create new', { error: e.message });
  }

  // 初始化终端
  initTerminal();

  // 身份处理
  if (!user) {
    appendSystemMessage('首次运行：创建身份');
    const password = await question('设置密码：');
    info('MAIN', 'Creating new identity');
    keyPair = generateKeyPair();
    x25519KeyPair = ed25519SecretToX25519(keyPair.secretKey);
    myPubkey = toHex(keyPair.publicKey);
    const encrypted = await encryptPrivateKey(keyPair.secretKey, password);
    // 不再存储颜色，传 null
    saveLocalUser(myPubkey, encrypted, toHex(x25519KeyPair.publicKey), 'User', null);
    masterKey = await scryptAsync(password, 'salt', 32);
    myNickname = 'User';
    appendSystemMessage(`身份已创建，你的公钥：${myPubkey}`);
    info('MAIN', 'New identity created', { pubkey: myPubkey });
  } else {
    appendSystemMessage(`欢迎回来，用户 ${shortPub(user.pubkey)}...`);
    const password = await question('输入密码：');
    let encryptedObj;
    try {
      encryptedObj = JSON.parse(user.encrypted_private_key);
    } catch (e) {
      appendSystemMessage('存储的私钥已损坏，请重置 data/chat.db 并重新启动。');
      error('MAIN', 'Encrypted private key corrupted', { error: e.message });
      process.exit(1);
    }
    try {
      const privKey = await decryptPrivateKey(encryptedObj, password);
      keyPair = { publicKey: fromHex(user.pubkey), secretKey: privKey };
      x25519KeyPair = ed25519SecretToX25519(privKey);
      myPubkey = user.pubkey;
      masterKey = await scryptAsync(password, 'salt', 32);
      myNickname = user.nickname || 'User';
      appendSystemMessage(`登录成功，你的公钥：${myPubkey}`);
      info('MAIN', 'User logged in', { pubkey: myPubkey });
    } catch (e) {
      appendSystemMessage('❌ 密码错误或数据损坏，请确认密码或删除 data/chat.db 重新创建。');
      process.exit(1);
    }
  }

  // 启动输入监听
  setupInput();

  // DHT
  try {
    dht = new DHTNode();
    await dht.listen();
    await dht.waitReady();
    info('MAIN', 'DHT ready', { port: dht.port });
    appendSystemMessage(`DHT 正在 UDP 端口 ${dht.port} 监听`);
  } catch (err) {
    error('MAIN', 'DHT initialization failed', err);
    appendSystemMessage('DHT 初始化失败，请检查网络或端口');
  }

  // UDP Transport
  transport = new UDPTransport(keyPair, x25519KeyPair);
  transport.on('error', (err) => {
    error('MAIN', 'UDP transport runtime error', err);
    appendSystemMessage(`UDP 运行时错误，但程序将继续运行: ${err.message}`);
  });
  transport.on('profile-update', ({ pubkey, nickname }) => {
    if (pubkey && nickname) {
      saveProfileRemote(pubkey, nickname, null);
      debug('MAIN', 'Profile updated via transport event', { pubkey: shortPub(pubkey) });
    }
  });
  try {
    await transport.listen();
    info('MAIN', 'UDP transport ready', { port: transport.port });
    appendSystemMessage(`UDP 传输正在监听端口 ${transport.port}`);
  } catch (err) {
    error('MAIN', 'UDP transport initialization failed', err);
    appendSystemMessage('UDP 传输初始化失败，请检查端口是否被占用');
    process.exit(1);
  }

  // Tailscale
  try {
    const tailscaleIPs = await getTailscaleIPs();
    if (tailscaleIPs.length > 0) {
      appendSystemMessage(`Tailscale IP: ${tailscaleIPs.join(', ')} （可用于 /connect 连接）`);
      info('MAIN', 'Tailscale IPs found', { ips: tailscaleIPs });
    } else {
      appendSystemMessage('未检测到 Tailscale 网络，您仍可使用公网 IP 或手动连接。');
    }
  } catch (e) {
    if (e.message === 'NOT_INSTALLED') {
      appendSystemMessage('❌ 未检测到 Tailscale。请访问 https://tailscale.com/download 下载并安装 Tailscale，然后登录您的账号（tailscale login），即可获得安全的内网 IP 用于连接。');
      info('MAIN', 'Tailscale not installed');
    } else {
      appendSystemMessage(`检测 Tailscale 出错: ${e.message}`);
      error('MAIN', 'Tailscale detection error', { error: e.message });
    }
  }

  // 加载已有连接
  try {
    const conns = getAllConnections();
    for (const c of conns) {
      const [ip, port] = c.address.split(':');
      if (ip && port) {
        transport._startHandshake(ip, parseInt(port));
        debug('MAIN', 'Auto-connecting to known node', { ip, port });
      }
    }
    if (conns.length > 0) {
      appendSystemMessage(`已尝试连接 ${conns.length} 个已知节点...`);
    }
  } catch (err) {
    error('MAIN', 'Error loading connections', err);
  }

  // 加载群组密钥
  try {
    for (const g of getAllGroups()) {
      const key = getGroupSymKey(g.id, masterKey);
      if (key) groupKeys.set(g.id, key);
    }
    info('MAIN', 'Group keys loaded', { count: groupKeys.size });
  } catch (err) {
    error('MAIN', 'Error loading group keys', err);
  }

  // ---- 事件绑定 ----
  transport.on('handshake-complete', ({ ip, port, session }) => {
    info('MAIN', 'Handshake complete', { ip, port });
    appendSystemMessage(`[连接] 与 ${ip}:${port} 握手成功`);
    // 更新状态栏
    const g = currentGroupId ? getGroup(currentGroupId) : null;
    const t = currentTopicId ? getTopic(currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
    const identity = { type: 'IDENTITY', pubkey: myPubkey, nickname: myNickname };
    transport.sendTo(ip, port, Buffer.from(JSON.stringify(identity)));
    // 如果当前有群组/话题，立即发送 STATUS
    if (currentGroupId && currentTopicId) {
      const statusMsg = { type: 'STATUS', pubkey: myPubkey, groupId: currentGroupId, topicId: currentTopicId };
      transport.sendTo(ip, port, Buffer.from(JSON.stringify(statusMsg)));
    }
    const groups = getAllGroups();
    transport.sendTo(ip, port, Buffer.from(JSON.stringify({
      type: 'GROUP_LIST',
      groups: groups.map(g => ({ id: g.id, name: g.name, creator: g.creator_pubkey }))
    })));
  });

  transport.on('message', ({ ip, port, msg, session }) => {
    try {
      if (msg.type === 'IDENTITY' && msg.pubkey) {
        session.pubkey = msg.pubkey;
        saveConnection(msg.pubkey, `${ip}:${port}`);
        if (msg.nickname) {
          saveProfileRemote(msg.pubkey, msg.nickname, null);
        }
        debug('MAIN', 'Saved connection', { pubkey: shortPub(msg.pubkey), address: `${ip}:${port}` });
        // 更新状态栏（连接数变化）
        const g = currentGroupId ? getGroup(currentGroupId) : null;
        const t = currentTopicId ? getTopic(currentTopicId) : null;
        updateStatus(g ? g.name : '无', t ? t.name : '无');
      }
      handleAppMessage(msg, session);
    } catch (err) {
      error('MAIN', 'Error handling message', { error: err.message, msg });
    }
  });

  // DHT 定期公告与发现
  setInterval(async () => {
    try {
      for (const g of getAllGroups()) {
        try {
          const infoHash = fromHex(g.id);
          await dht.announce(infoHash);
          const peers = await dht.lookup(infoHash);
          for (const p of peers) {
            const key = `${p.host}:${p.port}`;
            if (!transport.sessions.has(key)) {
              transport._startHandshake(p.host, p.port);
            }
          }
        } catch (err) {
          debug('MAIN', 'DHT group operation error', { group: g.id, error: err.message });
        }
      }
    } catch (err) {
      error('MAIN', 'DHT periodic error', err);
    }
  }, 30000);

  // 定期同步消息 ID
  setInterval(() => {
    try {
      for (const g of getAllGroups()) {
        const members = getMembers(g.id);
        for (const m of members) {
          const ids = getLatestMessageIds(g.id, 100);
          transport.sendJSON(m.pubkey, { type: 'MSG_IDS', groupId: g.id, ids });
        }
      }
    } catch (err) {
      error('MAIN', 'Sync interval error', err);
    }
  }, 60000);

  // 延迟广播自己的身份
  setTimeout(() => {
    broadcastMyProfile();
    // 也广播一次状态
    if (currentGroupId && currentTopicId) {
      broadcastStatus();
    }
  }, 3000);

  // 显示欢迎信息
  appendSystemMessage('===== P2P 聊天系统 (UDP) =====');
  appendSystemMessage('命令列表：');
  appendSystemMessage('  /create <群组名称>            - 创建新群组');
  appendSystemMessage('  /join <群组ID>                - 申请加入群组');
  appendSystemMessage('  /use <群组ID>                 - 切换到指定群组');
  appendSystemMessage('  /topic <话题名称>             - 在当前群组创建/切换话题');
  appendSystemMessage('  /approve <申请人公钥> <群组ID> - 批准加入请求（仅管理员）');
  appendSystemMessage('  /list                        - 列出所有群组');
  appendSystemMessage('  /members <群组ID>            - 查看群组成员');
  appendSystemMessage('  /msgs [群组ID] [话题ID]      - 显示最近消息');
  appendSystemMessage('  /connect <IP> [端口]         - 手动连接对等节点');
  appendSystemMessage('  /tailscale                   - 显示本机 Tailscale IP');
  appendSystemMessage('  /nick [<pubkey>] <昵称>      - 设置自己的昵称或为他人设置本地昵称');
  appendSystemMessage('  /online [all|group]          - 显示在线用户（默认当前话题）');
  appendSystemMessage('  /exit                        - 退出程序');
  appendSystemMessage('直接输入文本即可发送到当前群组/话题\n');

  // 窗口大小变化处理
  process.stdout.on('resize', () => {
    termRows = process.stdout.rows;
    termCols = process.stdout.columns;
    process.stdout.write(`${CSI}2;${termRows - 1}r`);
    const g = currentGroupId ? getGroup(currentGroupId) : null;
    const t = currentTopicId ? getTopic(currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
    renderMessages();
    drawInputLine();
  });

  process.on('exit', restoreTerminal);
  process.on('SIGINT', () => process.exit(0));
}

main().catch((err) => {
  error('MAIN', 'Fatal error in main', { error: err.message, stack: err.stack });
  process.stdout.write(`${CSI}?1049l`);
  console.error(chalk.red('程序发生致命错误，请查看日志 logs/ 目录下的文件'));
  process.exit(1);
});