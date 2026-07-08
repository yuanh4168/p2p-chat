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

// 导入拆分后的模块
import { state } from './state.js';
import { initTerminal, restoreTerminal, updateStatus, appendSystemMessage, appendMessage, setupInput, onResize } from './ui.js';
import { handleCommand } from './commands.js';
import { broadcastMyProfile, broadcastStatus, sendMessage, handleAppMessage } from './app-handler.js';
import { shortPub, getTailscaleIPs, getGroupName, getTopicName, getTimeStr } from './utils.js';

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
    appendSystemMessage('首次运行：创建身份');
    const password = await question('设置密码：');
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
      appendSystemMessage(`登录成功，你的公钥：${myPubkey}`);
      info('MAIN', 'User logged in', { pubkey: myPubkey });
    } catch (e) {
      appendSystemMessage('❌ 密码错误或数据损坏，请确认密码或删除 data/chat.db 重新创建。');
      process.exit(1);
    }
  }

  // 输入监听
  setupInput((line) => {
    if (line.startsWith('/')) {
      handleCommand(line).catch(e => {
        appendSystemMessage(`命令执行错误：${e.message}`);
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
    appendSystemMessage(`DHT 正在 UDP 端口 ${dht.port} 监听`);
  } catch (err) {
    error('MAIN', 'DHT initialization failed', err);
    appendSystemMessage('DHT 初始化失败，请检查网络或端口');
  }

  // UDP Transport
  const transport = new UDPTransport(state.keyPair, state.x25519KeyPair);
  state.transport = transport;
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
    appendSystemMessage(`[连接] 与 ${ip}:${port} 握手成功`);
    const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
    const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
    updateStatus(g ? g.name : '无', t ? t.name : '无');
    // 仅发送 IDENTITY，其他消息延迟发送，避免对方处理顺序问题
    const identity = { type: 'IDENTITY', pubkey: state.myPubkey, nickname: state.myNickname };
    transport.sendTo(ip, port, Buffer.from(JSON.stringify(identity)));
    // 延迟发送 STATUS 和 GROUP_LIST
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
            // 过滤无效 IP
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