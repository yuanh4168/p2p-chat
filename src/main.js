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
import readline from 'readline';

import { state } from './state.js';
import { initTerminal, restoreTerminal, updateStatus, appendSystemMessage, appendMessage, setupInput, onResize } from './ui.js';
import { handleCommand } from './commands.js';
import { broadcastMyProfile, broadcastStatus, sendMessage, handleAppMessage } from './app-handler.js';
import { shortPub, getTailscaleIPs, getGroupName, getTopicName, getTimeStr } from './utils.js';
import { strings } from './strings.js';
import { formatString } from './format.js';

setupGlobalErrorHandler();

const scryptAsync = promisify(scrypt);

// ---------- 密码输入 ----------
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

  initTerminal();

  // 身份处理
  if (!user) {
    appendSystemMessage(strings.FIRST_RUN_CREATE);
    const password = await question(strings.SET_PASSWORD);
    info('MAIN', 'Creating new identity');
    const keyPair = generateKeyPair();
    const x25519KeyPair = ed25519SecretToX25519(keyPair.secretKey);
    const myPubkey = toHex(keyPair.publicKey);
    const encrypted = await encryptPrivateKey(keyPair.secretKey, password);
    saveLocalUser(myPubkey, encrypted, toHex(x25519KeyPair.publicKey), 'User', null);
    const masterKey = await scryptAsync(password, 'salt', 32);
    const myNickname = 'User';
    state.keyPair = keyPair;
    state.x25519KeyPair = x25519KeyPair;
    state.masterKey = masterKey;
    state.myPubkey = myPubkey;
    state.myNickname = myNickname;
    appendSystemMessage(formatString(strings.IDENTITY_CREATED, { pubkey: myPubkey }));
    info('MAIN', 'New identity created', { pubkey: myPubkey });
  } else {
    appendSystemMessage(formatString(strings.WELCOME_BACK, { shortPub: shortPub(user.pubkey) }));
    const password = await question(strings.ENTER_PASSWORD);
    let encryptedObj;
    try {
      encryptedObj = JSON.parse(user.encrypted_private_key);
    } catch (e) {
      appendSystemMessage(strings.PRIVATE_KEY_CORRUPTED);
      error('MAIN', 'Encrypted private key corrupted', { error: e.message });
      process.exit(1);
    }
    try {
      const privKey = await decryptPrivateKey(encryptedObj, password);
      const keyPair = { publicKey: fromHex(user.pubkey), secretKey: privKey };
      const x25519KeyPair = ed25519SecretToX25519(privKey);
      const myPubkey = user.pubkey;
      const masterKey = await scryptAsync(password, 'salt', 32);
      const myNickname = user.nickname || 'User';
      state.keyPair = keyPair;
      state.x25519KeyPair = x25519KeyPair;
      state.masterKey = masterKey;
      state.myPubkey = myPubkey;
      state.myNickname = myNickname;
      appendSystemMessage(formatString(strings.LOGIN_SUCCESS, { pubkey: myPubkey }));
      info('MAIN', 'User logged in', { pubkey: myPubkey });
    } catch (e) {
      appendSystemMessage(strings.PASSWORD_WRONG);
      process.exit(1);
    }
  }

  // 输入监听
  setupInput((line) => {
    if (line.startsWith('/')) {
      handleCommand(line).catch(e => {
        appendSystemMessage(formatString(strings.ERROR_PREFIX, { msg: e.message }));
      });
    } else {
      sendMessage(line);
    }
  });

  // DHT
  let dht;
  try {
    dht = new DHTNode();
    await dht.listen();
    await dht.waitReady();
    state.dht = dht;
    info('MAIN', 'DHT ready', { port: dht.port });
    appendSystemMessage(formatString(strings.DHT_LISTENING, { port: dht.port }));
  } catch (err) {
    error('MAIN', 'DHT initialization failed', err);
    appendSystemMessage(strings.DHT_INIT_FAIL);
  }

  // UDP Transport
  const transport = new UDPTransport(state.keyPair, state.x25519KeyPair);
  state.transport = transport;
  transport.on('error', (err) => {
    error('MAIN', 'UDP transport runtime error', err);
    appendSystemMessage(formatString(strings.ERROR_PREFIX, { msg: err.message }));
  });
  transport.on('profile-update', ({ pubkey, nickname }) => {
    if (pubkey && nickname) {
      saveProfileRemote(pubkey, nickname, null);
      debug('MAIN', 'Profile updated via transport event', { pubkey: shortPub(pubkey) });
    }
  });

  // 监听握手超时事件
  transport.on('handshake-timeout', ({ ip, port }) => {
    appendSystemMessage(formatString(strings.CONNECTION_TIMEOUT, { ip, port }));
  });

  // 监听握手完成，显示延迟
  transport.on('handshake-complete', ({ ip, port, session, delay }) => {
    if (delay !== undefined) {
      appendSystemMessage(formatString(strings.HANDSHAKE_SUCCESS, { ip, port, delay }));
    }
    // 其他处理（身份等）在 main 原有逻辑中已经包含，此处只做延迟显示
  });

  // 监听会话移除事件
  transport.on('session-removed', ({ pubkey, ip, port }) => {
    if (pubkey) {
      state.peerStatus.delete(pubkey);
      debug('MAIN', 'Removed peer from status', { pubkey: shortPub(pubkey) });
    }
    const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
    const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
  });

  try {
    await transport.listen();
    info('MAIN', 'UDP transport ready', { port: transport.port });
    appendSystemMessage(formatString(strings.UDP_LISTENING, { port: transport.port }));
  } catch (err) {
    error('MAIN', 'UDP transport initialization failed', err);
    appendSystemMessage(strings.UDP_INIT_FAIL);
    process.exit(1);
  }

  // Tailscale
  try {
    const tailscaleIPs = await getTailscaleIPs();
    if (tailscaleIPs.length > 0) {
      appendSystemMessage(formatString(strings.TAILSCALE_IP, { ips: tailscaleIPs.join(', ') }));
      info('MAIN', 'Tailscale IPs found', { ips: tailscaleIPs });
    } else {
      appendSystemMessage(strings.TAILSCALE_NOT_FOUND);
    }
  } catch (e) {
    if (e.message === 'NOT_INSTALLED') {
      appendSystemMessage(strings.TAILSCALE_NOT_INSTALLED);
      info('MAIN', 'Tailscale not installed');
    } else {
      appendSystemMessage(formatString(strings.TAILSCALE_ERROR, { msg: e.message }));
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
      appendSystemMessage(formatString(strings.KNOWN_NODES_CONNECT, { count: conns.length }));
    }
  } catch (err) {
    error('MAIN', 'Error loading connections', err);
  }

  // 加载群组密钥
  try {
    for (const g of getAllGroups()) {
      const key = getGroupSymKey(g.id, state.masterKey);
      if (key) state.groupKeys.set(g.id, key);
    }
    info('MAIN', 'Group keys loaded', { count: state.groupKeys.size });
  } catch (err) {
    error('MAIN', 'Error loading group keys', err);
  }

  // ---- 事件绑定 ----
  transport.on('handshake-complete', ({ ip, port, session }) => {
    info('MAIN', 'Handshake complete', { ip, port });
    // 原有握手成功逻辑（不重复显示延迟，延迟由上面的监听显示）
    const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
    const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
    const identity = { type: 'IDENTITY', pubkey: state.myPubkey, nickname: state.myNickname };
    transport.sendTo(ip, port, Buffer.from(JSON.stringify(identity)));
    setTimeout(() => {
      if (state.currentGroupId && state.currentTopicId) {
        const statusMsg = { type: 'STATUS', pubkey: state.myPubkey, groupId: state.currentGroupId, topicId: state.currentTopicId };
        transport.sendTo(ip, port, Buffer.from(JSON.stringify(statusMsg)));
      }
      const groups = getAllGroups();
      transport.sendTo(ip, port, Buffer.from(JSON.stringify({
        type: 'GROUP_LIST',
        groups: groups.map(g => ({ id: g.id, name: g.name, creator: g.creator_pubkey }))
      })));
    }, 100);
  });

  transport.on('message', ({ ip, port, msg, session }) => {
    try {
      if (msg.type === 'IDENTITY' && msg.pubkey) {
        session.pubkey = msg.pubkey;
        saveConnection(msg.pubkey, `${ip}:${port}`);
        if (msg.nickname) {
          saveProfileRemote(msg.pubkey, msg.nickname, null);
        }
        const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
        const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
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
            if (p.host === '0.0.0.0' || p.host === '::' || !p.host) continue;
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
    if (state.currentGroupId && state.currentTopicId) {
      broadcastStatus();
    }
  }, 3000);

  // 显示欢迎信息
  appendSystemMessage(strings.WELCOME);
  appendSystemMessage(strings.HELP_PROMPT);
  appendSystemMessage(strings.DIRECT_INPUT + '\n');

  // 窗口大小变化处理
  process.stdout.on('resize', () => {
    onResize();
    const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
    const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
  });

  process.on('exit', restoreTerminal);
  process.on('SIGINT', () => process.exit(0));
}

main().catch((err) => {
  error('MAIN', 'Fatal error in main', { error: err.message, stack: err.stack });
  restoreTerminal();
  console.error(chalk.red('程序发生致命错误，请查看日志 logs/ 目录下的文件'));
  process.exit(1);
});