#!/usr/bin/env node
import { initDB, getLocalUser, saveLocalUser, getAllGroups, getGroup, getTopicsByGroup, getDefaultTopic,
         getMessages, saveMessage, getMessage, getLatestMessageIds, getMembers, isMember, addMember,
         isAdmin, getPendingRequests, addJoinRequest, updateRequestStatus, getGroupKey, saveGroup,
         getTopic, saveTopic, getAllConnections, saveConnection, getDBPath,
         getProfile, saveProfileRemote, setLocalNickname, setLocalColor, getDisplayColor,
         getDisplayNameWithSelf, updateUserNickname, updateLocalColor } from './db.js';
import { generateKeyPair, encryptPrivateKey, decryptPrivateKey, ed25519SecretToX25519, toHex, fromHex,
         sign, verify, sha256, aesEncrypt, aesDecrypt } from './crypto.js';
import { DHTNode } from './dht.js';
import { UDPTransport } from './udp-transport.js';
import { verifyMessage, computeMessageId, storeValidMessage, decryptMessageBody } from './message.js';
import { createGroup, getGroupSymKey, requestJoin } from './group.js';
import { UDP_PORTS } from './config.js';
import { info, error, debug, warn, setupGlobalErrorHandler } from './logger.js';
import chalk from 'chalk';
import readline from 'readline';
import { promisify } from 'util';
import { scrypt } from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

setupGlobalErrorHandler();

const execAsync = promisify(exec);
const scryptAsync = promisify(scrypt);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function question(q) { return new Promise(res => rl.question(q, res)); }

let keyPair, x25519KeyPair, masterKey, myPubkey;
let transport, dht;
let currentGroupId = null;
let currentTopicId = null;
let groupKeys = new Map();
let myNickname = '';
let myColor = '';

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
function formatMessage(displayName, color, groupName, topicName, text, time) {
  const colorFn = chalk.rgb(...color.split(',').map(Number));
  return `{${time}} ${chalk.bold(`[${groupName}]`)} ${chalk.cyan(`<${topicName}>`)} (${colorFn(displayName)}) ${text}`;
}
function randomColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return `${r},${g},${b}`;
}

// 更新提示符（包含时间、群组、话题、用户）
function updatePrompt() {
  const time = getTimeStr();
  const groupPart = currentGroupId ? `[${getGroupName(currentGroupId)}]` : '[null]';
  const topicPart = currentTopicId ? `<${getTopicName(currentTopicId)}>` : '<null>';
  const userPart = `User-${myPubkey.slice(0,6)}`;
  rl.setPrompt(`{${time}} ${groupPart} ${topicPart} (${userPart}) > `);
  rl.prompt();
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

// ---------- 广播自身资料 ----------
function broadcastMyProfile() {
  const profileMsg = {
    type: 'IDENTITY',
    pubkey: myPubkey,
    nickname: myNickname,
    color: myColor
  };
  transport.broadcast(profileMsg, myPubkey);
  info('MAIN', 'Broadcasted profile', { nickname: myNickname, color: myColor });
}

// ---------- 处理应用层消息 ----------
function handleAppMessage(msg, session) {
  const { type } = msg;
  try {
    switch (type) {
      case 'IDENTITY': {
        if (msg.pubkey && (msg.nickname || msg.color)) {
          saveProfileRemote(msg.pubkey, msg.nickname, msg.color);
          debug('APP', 'Profile updated from IDENTITY', { pubkey: shortPub(msg.pubkey) });
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
              const color = getDisplayColor(message.author);
              const groupName = getGroupName(message.group_id);
              const topicName = getTopicName(message.topic_id);
              const time = getTimeStr();
              const formatted = formatMessage(displayName, color, groupName, topicName, plain, time);
              console.log('\n' + formatted);
              rl.prompt();
            } else {
              error('APP', 'No group key for message', { groupId: message.group_id });
            }
          }
          const exclude = session.pubkey || message.author;
          transport.broadcast({ type: 'NEW_MSG', message }, exclude);
        } catch(e) {
          console.error(chalk.red('消息处理失败:'), e.message);
          error('APP', 'NEW_MSG processing error', { error: e.message, id: message.id });
          rl.prompt();
        }
        break;
      }
      case 'JOIN_REQUEST': {
        const { groupId, requester } = msg;
        if (isAdmin(groupId, myPubkey)) {
          console.log(chalk.yellow(`\n[加入请求] ${shortPub(requester)} 想加入群组 ${groupId}`));
          console.log(chalk.yellow('使用 /approve <申请人公钥> <群组ID> 批准'));
          rl.prompt();
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
          console.log(chalk.green(`已批准加入群组 ${groupId}`));
          info('APP', 'Joined group via approval', { groupId });
          updatePrompt();
        } catch(e) {
          console.error(chalk.red('解密群组密钥失败'));
          error('APP', 'JOIN_APPROVAL decryption error', { groupId, error: e.message });
        }
        break;
      }
      case 'COLOR_UPDATE': {
        const { pubkey, color } = msg;
        if (pubkey) {
          saveProfileRemote(pubkey, null, color);
          debug('APP', 'Color updated', { pubkey: shortPub(pubkey) });
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
    rl.prompt();
  }
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

  if (!user) {
    console.log(chalk.blue('首次运行：创建身份'));
    const password = await question('设置密码：');
    info('MAIN', 'Creating new identity');
    keyPair = generateKeyPair();
    x25519KeyPair = ed25519SecretToX25519(keyPair.secretKey);
    myPubkey = toHex(keyPair.publicKey);
    const encrypted = await encryptPrivateKey(keyPair.secretKey, password);
    const color = randomColor();
    saveLocalUser(myPubkey, encrypted, toHex(x25519KeyPair.publicKey), 'User', color);
    masterKey = await scryptAsync(password, 'salt', 32);
    myColor = color;
    myNickname = 'User';
    console.log(chalk.green(`身份已创建，你的公钥：${myPubkey}`));
    info('MAIN', 'New identity created', { pubkey: myPubkey });
  } else {
    console.log(chalk.blue(`欢迎回来，用户 ${shortPub(user.pubkey)}...`));
    const password = await question('输入密码：');
    let encryptedObj;
    try {
      encryptedObj = JSON.parse(user.encrypted_private_key);
    } catch (e) {
      console.error(chalk.red('存储的私钥已损坏，请重置 data/chat.db 并重新启动。'));
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
      myColor = user.color || randomColor();
      console.log(chalk.green(`登录成功，你的公钥：${myPubkey}`));
      info('MAIN', 'User logged in', { pubkey: myPubkey });
    } catch (e) {
      console.error(chalk.red('❌ 密码错误或数据损坏，请确认密码或删除 data/chat.db 重新创建。'));
      error('MAIN', 'Login failed', { error: e.message });
      process.exit(1);
    }
  }

  // DHT
  try {
    dht = new DHTNode();
    await dht.listen();
    await dht.waitReady();
    info('MAIN', 'DHT ready', { port: dht.port });
    console.log(chalk.gray(`DHT 正在 UDP 端口 ${dht.port} 监听`));
  } catch (err) {
    error('MAIN', 'DHT initialization failed', err);
    console.error(chalk.red('DHT 初始化失败，请检查网络或端口'));
  }

  // UDP Transport
  transport = new UDPTransport(keyPair, x25519KeyPair);
  transport.on('error', (err) => {
    error('MAIN', 'UDP transport runtime error', err);
    console.warn(chalk.yellow('UDP 运行时错误，但程序将继续运行'), err.message);
  });
  transport.on('profile-update', ({ pubkey, nickname, color }) => {
    if (pubkey) {
      saveProfileRemote(pubkey, nickname, color);
      debug('MAIN', 'Profile updated via transport event', { pubkey: shortPub(pubkey) });
    }
  });
  try {
    await transport.listen();
    info('MAIN', 'UDP transport ready', { port: transport.port });
    console.log(chalk.gray(`UDP 传输正在监听端口 ${transport.port}`));
  } catch (err) {
    error('MAIN', 'UDP transport initialization failed', err);
    console.error(chalk.red('UDP 传输初始化失败，请检查端口是否被占用'));
    process.exit(1);
  }

  // Tailscale
  try {
    const tailscaleIPs = await getTailscaleIPs();
    if (tailscaleIPs.length > 0) {
      console.log(chalk.gray(`Tailscale IP: ${tailscaleIPs.join(', ')} （可用于 /connect 连接）`));
      info('MAIN', 'Tailscale IPs found', { ips: tailscaleIPs });
    } else {
      console.log(chalk.yellow('未检测到 Tailscale 网络，您仍可使用公网 IP 或手动连接。'));
    }
  } catch (e) {
    if (e.message === 'NOT_INSTALLED') {
      console.log(chalk.yellow('❌ 未检测到 Tailscale。'));
      console.log(chalk.yellow('请访问 https://tailscale.com/download 下载并安装 Tailscale，'));
      console.log(chalk.yellow('然后登录您的账号（tailscale login），即可获得安全的内网 IP 用于连接。'));
      info('MAIN', 'Tailscale not installed');
    } else {
      console.log(chalk.red('检测 Tailscale 出错:'), e.message);
      error('MAIN', 'Tailscale detection error', { error: e.message });
    }
  }

  // 加载已有连接并自动连接
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
      console.log(chalk.gray(`已尝试连接 ${conns.length} 个已知节点...`));
    }
  } catch (err) {
    error('MAIN', 'Error loading connections', err);
  }

  // 群组密钥加载
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
    console.log(chalk.green(`[连接] 与 ${ip}:${port} 握手成功`));
    const identity = { type: 'IDENTITY', pubkey: myPubkey, nickname: myNickname, color: myColor };
    transport.sendTo(ip, port, Buffer.from(JSON.stringify(identity)));
    const groups = getAllGroups();
    transport.sendTo(ip, port, Buffer.from(JSON.stringify({
      type: 'GROUP_LIST',
      groups: groups.map(g => ({ id: g.id, name: g.name, creator: g.creator_pubkey }))
    })));
    rl.prompt();
  });

  transport.on('message', ({ ip, port, msg, session }) => {
    try {
      if (msg.type === 'IDENTITY' && msg.pubkey) {
        session.pubkey = msg.pubkey;
        saveConnection(msg.pubkey, `${ip}:${port}`);
        if (msg.nickname || msg.color) {
          saveProfileRemote(msg.pubkey, msg.nickname, msg.color);
        }
        debug('MAIN', 'Saved connection', { pubkey: shortPub(msg.pubkey), address: `${ip}:${port}` });
      }
      handleAppMessage(msg, session);
    } catch (err) {
      error('MAIN', 'Error handling message', { error: err.message, msg });
      rl.prompt();
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
  }, 3000);

  // 初始化提示符
  updatePrompt();

  // CLI 交互界面
  console.log(chalk.bold('\n===== P2P 聊天系统 (UDP) ====='));
  console.log(chalk.gray('命令列表：'));
  console.log(chalk.gray('  /create <群组名称>            - 创建新群组'));
  console.log(chalk.gray('  /join <群组ID>                - 申请加入群组'));
  console.log(chalk.gray('  /use <群组ID>                 - 切换到指定群组'));
  console.log(chalk.gray('  /topic <话题名称>             - 在当前群组创建/切换话题'));
  console.log(chalk.gray('  /approve <申请人公钥> <群组ID> - 批准加入请求（仅管理员）'));
  console.log(chalk.gray('  /list                        - 列出所有群组'));
  console.log(chalk.gray('  /members <群组ID>            - 查看群组成员'));
  console.log(chalk.gray('  /msgs [群组ID] [话题ID]      - 显示最近消息'));
  console.log(chalk.gray('  /connect <IP> [端口]         - 手动连接对等节点'));
  console.log(chalk.gray('  /tailscale                   - 显示本机 Tailscale IP'));
  console.log(chalk.gray('  /nick [<pubkey>] <昵称>      - 设置自己的昵称或为他人设置本地昵称'));
  console.log(chalk.gray('  /color <R> <G> <B>          - 设置自己的颜色（RGB 0-255）'));
  console.log(chalk.gray('  /exit                        - 退出程序'));
  console.log(chalk.gray('直接输入文本即可发送到当前群组/话题\n'));

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) { rl.prompt(); return; }
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
          console.log(chalk.green(`群组已创建：${id}（默认话题：${defaultTopic.name}）`));
          info('MAIN', 'Group created', { id, name });
          try {
            await dht.announce(fromHex(id));
          } catch (e) {
            console.log(chalk.yellow('DHT 公告失败（可能因网络原因，但手动连接不受影响）'));
            warn('MAIN', 'DHT announce failed', { group: id, error: e.message });
          }
          updatePrompt();
          break;
        }
        case '/join': {
          const groupId = parts[1];
          if (!groupId) throw new Error('需要群组 ID');
          if (isMember(groupId, myPubkey)) {
            console.log(chalk.yellow('已是该群组成员'));
          } else {
            requestJoin(groupId, myPubkey, transport);
            console.log(chalk.green(`已向群组 ${groupId} 发送加入请求`));
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
            console.log(chalk.yellow('您不是该群组的成员'));
          } else {
            currentGroupId = groupId;
            const defaultTopic = getDefaultTopic(groupId);
            currentTopicId = defaultTopic.id;
            console.log(chalk.green(`已切换到群组 ${g.name}（${groupId}），话题：${defaultTopic.name}`));
            info('MAIN', 'Switched group', { groupId, topic: defaultTopic.name });
            updatePrompt();
          }
          break;
        }
        case '/topic': {
          if (!currentGroupId) throw new Error('未选择群组');
          const topicName = parts.slice(1).join(' ');
          if (!topicName) {
            const topics = getTopicsByGroup(currentGroupId);
            console.log(chalk.gray('话题列表：'), topics.map(t=>t.name).join(', '));
            break;
          }
          const topicId = toHex(sha256(Buffer.from(`topic:${currentGroupId}:${topicName}`)));
          const existing = getTopic(topicId);
          if (!existing) {
            saveTopic(topicId, currentGroupId, topicName);
            console.log(chalk.green(`话题已创建：${topicName}`));
          }
          currentTopicId = topicId;
          console.log(chalk.green(`已切换到话题：${topicName}`));
          updatePrompt();
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
          console.log(chalk.green(`已批准 ${shortPub(requester)} 加入群组 ${groupId}`));
          info('MAIN', 'Join approved', { requester, groupId });
          break;
        }
        case '/list': {
          const groups = getAllGroups();
          if (groups.length === 0) {
            console.log(chalk.gray('暂无群组'));
          } else {
            groups.forEach(g => console.log(`${g.id}  ${g.name}（创建者：${shortPub(g.creator_pubkey)}）`));
          }
          break;
        }
        case '/members': {
          const groupId = parts[1] || currentGroupId;
          if (!groupId) throw new Error('需要群组 ID');
          const members = getMembers(groupId);
          if (members.length === 0) {
            console.log(chalk.gray('暂无成员'));
          } else {
            members.forEach(m => {
              const display = getDisplayNameWithSelf(m.pubkey, myPubkey);
              const color = getDisplayColor(m.pubkey);
              const colorFn = chalk.rgb(...color.split(',').map(Number));
              console.log(`${colorFn(display)}  （${m.role}）`);
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
          if (!symKey) { console.log(chalk.yellow('无群组密钥')); break; }
          if (msgs.length === 0) {
            console.log(chalk.gray('暂无消息'));
          } else {
            for (const m of msgs.reverse()) {
              try {
                const plain = decryptMessageBody(m, symKey);
                const displayName = getDisplayNameWithSelf(m.author_pubkey, myPubkey);
                const color = getDisplayColor(m.author_pubkey);
                const groupName = getGroupName(m.group_id);
                const topicName = getTopicName(m.topic_id);
                const time = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 19);
                const formatted = formatMessage(displayName, color, groupName, topicName, plain, time);
                console.log(formatted);
              } catch (e) {
                console.log(chalk.red('[无法解密]'));
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
            console.log(chalk.gray(`正在连接 ${ip}:${port}...`));
            const timeout = setTimeout(() => {
              const key = `${ip}:${port}`;
              if (!transport.sessions.has(key) || !transport.sessions.get(key).established) {
                console.log(chalk.red(`连接 ${ip}:${port} 超时`));
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
            console.log(chalk.gray(`尝试连接 ${ip} 的端口 ${ports.join(', ')}...`));
          }
          break;
        }
        case '/tailscale': {
          try {
            const ips = await getTailscaleIPs();
            if (ips.length) {
              console.log(chalk.green(`Tailscale IP: ${ips.join(', ')}`));
            } else {
              console.log(chalk.yellow('未检测到 Tailscale 网络（请确保已安装并登录 Tailscale）'));
            }
          } catch (e) {
            if (e.message === 'NOT_INSTALLED') {
              console.log(chalk.yellow('Tailscale 未安装，请访问 https://tailscale.com/download 下载安装。'));
            } else {
              console.log(chalk.red('获取 Tailscale IP 失败:'), e.message);
            }
          }
          break;
        }
        case '/nick': {
          if (parts.length === 1) {
            console.log(chalk.gray(`当前昵称：${myNickname}`));
            break;
          }
          if (parts.length === 2) {
            const newNick = parts[1];
            myNickname = newNick;
            updateUserNickname(myPubkey, newNick);
            const updateMsg = { type: 'NICK_UPDATE', pubkey: myPubkey, nickname: newNick };
            transport.broadcast(updateMsg, myPubkey);
            console.log(chalk.green(`昵称已设置为：${newNick}`));
            info('MAIN', 'Nickname updated', { nickname: newNick });
            updatePrompt();
          } else if (parts.length === 3) {
            const target = parts[1];
            const nick = parts[2];
            setLocalNickname(target, nick);
            console.log(chalk.green(`已为 ${shortPub(target)} 设置本地昵称：${nick}`));
            info('MAIN', 'Local nickname set', { target, nickname: nick });
          } else {
            throw new Error('用法：/nick [<pubkey>] <昵称>');
          }
          break;
        }
        case '/color': {
          if (parts.length !== 4) throw new Error('用法：/color <R> <G> <B>  (0-255)');
          const r = parseInt(parts[1]), g = parseInt(parts[2]), b = parseInt(parts[3]);
          if (isNaN(r) || isNaN(g) || isNaN(b) || r<0 || r>255 || g<0 || g>255 || b<0 || b>255) {
            throw new Error('RGB 值须在 0-255 之间');
          }
          myColor = `${r},${g},${b}`;
          updateLocalColor(myColor);
          const colorMsg = { type: 'COLOR_UPDATE', pubkey: myPubkey, color: myColor };
          transport.broadcast(colorMsg, myPubkey);
          console.log(chalk.green(`颜色已设置为：${chalk.rgb(r,g,b)('█')} (${myColor})`));
          info('MAIN', 'Color updated', { color: myColor });
          break;
        }
        case '/exit': {
          console.log(chalk.gray('退出程序...'));
          process.exit(0);
        }
        default: {
          if (!currentGroupId) throw new Error('未选择群组，请先使用 /use');
          const text = line.trim();
          if (!text) { rl.prompt(); return; }
          const symKey = groupKeys.get(currentGroupId);
          if (!symKey) throw new Error('无群组密钥');
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
          const color = getDisplayColor(myPubkey);
          const groupName = getGroupName(currentGroupId);
          const topicName = getTopicName(currentTopicId);
          const time = getTimeStr();
          const formatted = formatMessage(displayName, color, groupName, topicName, text, time);
          console.log('\n' + formatted);
          rl.prompt();
          debug('MAIN', 'Message sent', { topic: currentTopicId, text });
        }
      }
    } catch(e) {
      console.error(chalk.red('错误：'), e.message);
      error('MAIN', 'Command error', { command: cmd, error: e.message, stack: e.stack });
    }
    rl.prompt();
  });
}

main().catch((err) => {
  error('MAIN', 'Fatal error in main', { error: err.message, stack: err.stack });
  console.error(chalk.red('程序发生致命错误，请查看日志 logs/ 目录下的文件'));
  process.exit(1);
});