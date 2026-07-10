import { state } from './state.js';
import {
  getGroup, getAllGroups, isMember, getMembers, getMessages,
  getTopic, saveTopic, getTopicsByGroup, getDefaultTopic,
  updateUserNickname, setLocalNickname, isAdmin, addMember,
  updateRequestStatus, getDisplayNameWithSelf,
  deleteGroup, deleteTopic, updateMemberRole, removeMember,
  updateGroupName, getProfile, saveProfileRemote, getGroupKey
} from './db.js';
import { createGroup, requestJoin } from './group.js';
import { toHex, sha256, fromHex, aesEncrypt, sign } from './crypto.js';
import { verifyMessage, computeMessageId, storeValidMessage, decryptMessageBody } from './message.js';
import { appendSystemMessage, appendMessage, updateStatus, formatMessage, appendCommandMessage, appendRaw } from './ui.js';
import { shortPub, getGroupName, getTopicName, getTimeStr, getTailscaleIPs } from './utils.js';
import { broadcastStatus } from './app-handler.js';
import { UDP_MTU } from './config.js';
import fs from 'fs';
import path from 'path';
import { strings } from './strings.js';
import { formatString } from './format.js';

// ---------- 辅助函数：根据公钥前缀解析唯一公钥 ----------
function resolvePubkey(prefix, groupId = null) {
  if (!prefix) return null;
  if (prefix.length >= 40) return prefix;

  const candidates = new Set();
  if (groupId) {
    const members = getMembers(groupId);
    for (const m of members) {
      if (m.pubkey.startsWith(prefix)) candidates.add(m.pubkey);
    }
  }
  for (const [, sess] of state.transport.sessions) {
    if (sess.pubkey && sess.pubkey.startsWith(prefix)) candidates.add(sess.pubkey);
  }
  if (state.myPubkey.startsWith(prefix)) candidates.add(state.myPubkey);

  const arr = Array.from(candidates);
  if (arr.length === 1) return arr[0];
  if (arr.length > 1) throw new Error(formatString(strings.ERR_REQUESTER_NOT_FOUND, { input: prefix }));
  return null;
}

// ---------- 在线处理 ----------
export function handleOnline(subcmd) {
  let peers = [];
  if (subcmd === 'all') {
    for (const [, sess] of state.transport.sessions) {
      if (sess.established && sess.pubkey) {
        peers.push(sess.pubkey);
      }
    }
    if (!peers.includes(state.myPubkey)) peers.push(state.myPubkey);
    peers = [...new Set(peers)];
  } else if (subcmd === 'group') {
    if (!state.currentGroupId) { appendSystemMessage(strings.ERR_NEED_TOPIC); return; }
    const groupId = state.currentGroupId;
    const statusPeers = [];
    for (const [pubkey, status] of state.peerStatus) {
      if (status.groupId === groupId && pubkey !== state.myPubkey) {
        if (isMember(groupId, pubkey)) statusPeers.push(pubkey);
      }
    }
    const sessionPeers = [];
    for (const [, sess] of state.transport.sessions) {
      if (sess.established && sess.pubkey && sess.pubkey !== state.myPubkey) {
        if (isMember(groupId, sess.pubkey)) sessionPeers.push(sess.pubkey);
      }
    }
    peers = [...new Set([...statusPeers, ...sessionPeers])];
    if (isMember(groupId, state.myPubkey)) peers.push(state.myPubkey);
  } else {
    if (!state.currentGroupId || !state.currentTopicId) { appendSystemMessage(strings.ERR_NEED_TOPIC); return; }
    for (const [pubkey, status] of state.peerStatus) {
      if (status.groupId === state.currentGroupId && status.topicId === state.currentTopicId && pubkey !== state.myPubkey) {
        if (isMember(state.currentGroupId, pubkey)) {
          peers.push(pubkey);
        }
      }
    }
    if (isMember(state.currentGroupId, state.myPubkey)) peers.push(state.myPubkey);
  }

  if (peers.length === 0) {
    appendSystemMessage(strings.ONLINE_NO_USERS);
    return;
  }

  let title = '';
  if (subcmd === 'all') title = formatString(strings.ONLINE_TITLE_ALL, { count: peers.length });
  else if (subcmd === 'group') title = formatString(strings.ONLINE_TITLE_GROUP, { group: getGroupName(state.currentGroupId), count: peers.length });
  else title = formatString(strings.ONLINE_TITLE_TOPIC, { topic: getTopicName(state.currentTopicId), count: peers.length });

  appendSystemMessage(`--- ${title} ---`);
  for (const pubkey of peers) {
    const display = getDisplayNameWithSelf(pubkey, state.myPubkey, state.myNickname);
    const hash = pubkey.slice(0, 16);
    let roleInfo = '';
    if (subcmd !== 'all') {
      const role = isAdmin(state.currentGroupId, pubkey) ? 'admin' : (isMember(state.currentGroupId, pubkey) ? 'member' : 'unknown');
      roleInfo = ` [${role}]`;
    }
    appendSystemMessage(`  ${display} (${hash})${roleInfo}`);
  }
}

// ---------- 主命令处理 ----------
export async function handleCommand(line) {
  const timeStr = getTimeStr();
  appendCommandMessage(`[${timeStr}] > ${line}`);

  const parts = line.trim().split(/\s+/);
  if (!parts.length) return;
  const cmd = parts[0];
  try {
    switch (cmd) {
      case '/create': {
        const name = parts.slice(1).join(' ');
        if (!name) throw new Error(strings.ERR_NEED_GROUP_NAME);
        const { id, symKey } = createGroup(name, state.myPubkey, state.masterKey);
        state.groupKeys.set(id, symKey);
        state.currentGroupId = id;
        const defaultTopic = getDefaultTopic(id);
        state.currentTopicId = defaultTopic.id;
        appendSystemMessage(formatString(strings.GROUP_CREATED, { id, topic: defaultTopic.name }));
        try {
          await state.dht.announce(fromHex(id));
        } catch (e) {
          appendSystemMessage(strings.DHT_INIT_FAIL);
        }
        updateStatus(name, defaultTopic.name);
        broadcastStatus();
        break;
      }
      case '/join': {
        const groupId = parts[1];
        if (!groupId) throw new Error(strings.ERR_NEED_GROUP_ID);
        if (isMember(groupId, state.myPubkey)) {
          appendSystemMessage(strings.ALREADY_MEMBER);
        } else {
          const infoHash = fromHex(groupId);
          try {
            appendSystemMessage(formatString(strings.SYNC_MSGS, { count: 0 })); // 占位
            const peers = await state.dht.lookup(infoHash);
            let connected = 0;
            for (const p of peers) {
              if (p.host && p.port && p.host !== '0.0.0.0' && p.host !== '::') {
                state.transport._startHandshake(p.host, p.port);
                connected++;
              }
            }
            if (connected > 0) {
              appendSystemMessage(formatString(strings.SYNC_MSGS, { count: connected }));
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              appendSystemMessage(strings.DHT_NOT_FOUND);
            }
          } catch (e) {
            appendSystemMessage(strings.DHT_LOOKUP_FAIL);
          }
          requestJoin(groupId, state.myPubkey, state.transport);
          appendSystemMessage(formatString(strings.JOIN_REQUEST_SENT, { id: groupId }));
        }
        break;
      }
      case '/use': {
        const groupId = parts[1];
        if (!groupId) throw new Error(strings.ERR_NEED_GROUP_ID);
        const g = getGroup(groupId);
        if (!g) throw new Error(strings.GROUP_NOT_EXIST);
        if (!isMember(groupId, state.myPubkey) && groupId !== g.creator_pubkey) {
          appendSystemMessage(strings.NOT_MEMBER);
        } else {
          state.currentGroupId = groupId;
          const defaultTopic = getDefaultTopic(groupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(formatString(strings.GROUP_SWITCHED, { name: g.name, id: groupId, topic: defaultTopic.name }));
          updateStatus(g.name, defaultTopic.name);
          broadcastStatus();
        }
        break;
      }
      case '/topic': {
        if (!state.currentGroupId) throw new Error(strings.ERR_NEED_TOPIC);
        const topicName = parts.slice(1).join(' ');
        if (!topicName) {
          const topics = getTopicsByGroup(state.currentGroupId);
          appendSystemMessage(formatString(strings.TOPIC_LIST, { topics: topics.map(t=>`${t.name} (${t.id})`).join(', ') }));
          break;
        }
        if (topicName === 'general') {
          const defaultTopic = getDefaultTopic(state.currentGroupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(strings.TOPIC_SWITCHED_DEFAULT);
          const g = getGroup(state.currentGroupId);
          updateStatus(g ? g.name : '未知', 'general');
          broadcastStatus();
          break;
        }
        const topicId = toHex(sha256(Buffer.from(`topic:${state.currentGroupId}:${topicName}`)));
        const existing = getTopic(topicId);
        if (!existing) {
          saveTopic(topicId, state.currentGroupId, topicName);
          appendSystemMessage(formatString(strings.TOPIC_CREATED, { name: topicName, id: topicId }));
        }
        state.currentTopicId = topicId;
        appendSystemMessage(formatString(strings.TOPIC_SWITCHED, { name: topicName }));
        const g = getGroup(state.currentGroupId);
        updateStatus(g ? g.name : '未知', topicName);
        broadcastStatus();
        break;
      }
      case '/approve': {
        const requesterInput = parts[1];
        const groupId = parts[2] || state.currentGroupId;
        if (!requesterInput || !groupId) throw new Error(strings.ERR_APPROVE_USAGE);
        if (!isAdmin(groupId, state.myPubkey)) throw new Error(strings.ERR_NOT_ADMIN);
        const requester = resolvePubkey(requesterInput, groupId);
        if (!requester) throw new Error(formatString(strings.ERR_REQUESTER_NOT_FOUND, { input: requesterInput }));
        let sharedKey = null;
        for (const [, sess] of state.transport.sessions) {
          if (sess.pubkey === requester) {
            sharedKey = sess.sharedKey;
            break;
          }
        }
        if (!sharedKey) throw new Error(strings.ERR_REQUESTER_NOT_CONNECTED);
        const symKey = state.groupKeys.get(groupId);
        if (!symKey) throw new Error(strings.ERR_GROUP_KEY_NOT_FOUND);
        const encryptedKey = aesEncrypt(symKey, sharedKey);
        const g = getGroup(groupId);
        const approval = {
          type: 'JOIN_APPROVAL',
          groupId,
          groupName: g.name,
          creator: g.creator_pubkey,
          groupKeyEncrypted: encryptedKey
        };
        state.transport.sendJSON(requester, approval);
        addMember(groupId, requester, 'member');
        updateRequestStatus(groupId, requester, 'approved');
        appendSystemMessage(formatString(strings.JOIN_APPROVED, { pubkey: shortPub(requester), id: groupId }));
        break;
      }
      case '/list': {
        const groups = getAllGroups().filter(g => isMember(g.id, state.myPubkey));
        if (groups.length === 0) {
          appendSystemMessage(strings.NO_GROUPS);
        } else {
          groups.forEach(g => appendSystemMessage(`${g.id}  ${g.name}（创建者：${shortPub(g.creator_pubkey)}）`));
        }
        break;
      }
      case '/members': {
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error(strings.ERR_NEED_GROUP_ID);
        const members = getMembers(groupId);
        if (members.length === 0) {
          appendSystemMessage(strings.NO_GROUPS);
        } else {
          appendSystemMessage(strings.MEMBER_LIST_TITLE);
          members.forEach(m => {
            const display = getDisplayNameWithSelf(m.pubkey, state.myPubkey, state.myNickname);
            appendSystemMessage(`  ${display}  （${m.role}）`);
          });
        }
        break;
      }
      case '/msgs': {
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error(strings.ERR_MSGS_USAGE);
        const topicId = parts[2] || state.currentTopicId;
        const msgs = getMessages(groupId, topicId, 20);
        const symKey = state.groupKeys.get(groupId);
        if (!symKey) { appendSystemMessage(strings.ERROR_NO_GROUP_KEY); break; }
        if (msgs.length === 0) {
          appendSystemMessage(strings.NO_MESSAGES);
        } else {
          for (const m of msgs.reverse()) {
            try {
              const plain = decryptMessageBody(m, symKey);
              const displayName = getDisplayNameWithSelf(m.author_pubkey, state.myPubkey, state.myNickname);
              const time = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 19);
              if (m.type === 'file') {
                const fileInfo = JSON.parse(plain);
                const msgText = `{${time}} (${displayName}) 发送了文件：${fileInfo.filename} (${fileInfo.filesize} 字节) [ID: ${m.id}]`;
                appendMessage(msgText);
              } else {
                const isSelf = m.author_pubkey === state.myPubkey;
                const formatted = formatMessage(displayName, plain, time, isSelf);
                appendMessage(formatted);
              }
            } catch (e) {
              appendSystemMessage(strings.DECRYPT_FAIL);
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
          state.transport._startHandshake(ip, port);
          appendSystemMessage(formatString(strings.CONNECTION_ATTEMPT, { ip, port }));
          const timeout = setTimeout(() => {
            const key = `${ip}:${port}`;
            if (!state.transport.sessions.has(key) || !state.transport.sessions.get(key).established) {
              appendSystemMessage(formatString(strings.CONNECTION_TIMEOUT, { ip, port }));
            }
          }, 10000);
          const handler = ({ ip: ip2, port: port2 }) => {
            if (ip2 === ip && port2 === port) {
              clearTimeout(timeout);
              state.transport.removeListener('handshake-complete', handler);
            }
          };
          state.transport.on('handshake-complete', handler);
        } else {
          ip = arg;
          const ports = [6881, 6882, 6883, 6884];
          for (const p of ports) {
            state.transport._startHandshake(ip, p);
          }
          appendSystemMessage(`尝试连接 ${ip} 的端口 ${ports.join(', ')}...`);
        }
        break;
      }
      case '/tailscale': {
        try {
          const ips = await getTailscaleIPs();
          if (ips.length) {
            appendSystemMessage(formatString(strings.TAILSCALE_IP, { ips: ips.join(', ') }));
          } else {
            appendSystemMessage(strings.TAILSCALE_NOT_FOUND);
          }
        } catch (e) {
          if (e.message === 'NOT_INSTALLED') {
            appendSystemMessage(strings.TAILSCALE_NOT_INSTALLED);
          } else {
            appendSystemMessage(formatString(strings.TAILSCALE_ERROR, { msg: e.message }));
          }
        }
        break;
      }
      case '/nick': {
        if (parts.length === 1) {
          appendSystemMessage(formatString(strings.NICK_CURRENT, { nick: state.myNickname }));
          break;
        }
        if (parts.length === 2) {
          const newNick = parts[1];
          state.myNickname = newNick;
          updateUserNickname(state.myPubkey, newNick);
          const updateMsg = { type: 'NICK_UPDATE', pubkey: state.myPubkey, nickname: newNick };
          state.transport.broadcast(updateMsg, state.myPubkey);
          appendSystemMessage(formatString(strings.NICK_SET, { nick: newNick }));
        } else if (parts.length === 3) {
          const target = parts[1];
          const nick = parts[2];
          setLocalNickname(target, nick);
          appendSystemMessage(formatString(strings.LOCAL_NICK_SET, { pubkey: shortPub(target), nick }));
        } else {
          throw new Error(strings.ERR_NICK_USAGE);
        }
        break;
      }
      case '/online': {
        const subcmd = parts[1] || 'topic';
        handleOnline(subcmd);
        break;
      }
      case '/hash': {
        appendSystemMessage(formatString(strings.HASH_DISPLAY, { pubkey: state.myPubkey }));
        break;
      }
      case '/renamegroup': {
        const newName = parts.slice(1).join(' ');
        if (!newName) throw new Error(strings.ERR_RENAME_USAGE);
        if (!state.currentGroupId) throw new Error(strings.ERR_NEED_TOPIC);
        if (!isAdmin(state.currentGroupId, state.myPubkey)) throw new Error(strings.ERR_NOT_ADMIN);
        const g = getGroup(state.currentGroupId);
        if (!g) throw new Error(strings.GROUP_NOT_EXIST);
        updateGroupName(state.currentGroupId, newName);
        const members = getMembers(state.currentGroupId);
        const renameMsg = { type: 'GROUP_RENAME', groupId: state.currentGroupId, newName };
        for (const m of members) {
          if (m.pubkey !== state.myPubkey) {
            state.transport.sendJSON(m.pubkey, renameMsg);
          }
        }
        appendSystemMessage(formatString(strings.GROUP_RENAMED, { name: newName }));
        const g2 = getGroup(state.currentGroupId);
        updateStatus(g2.name, getTopicName(state.currentTopicId));
        broadcastStatus();
        break;
      }
      case '/deletegroup': {
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error(strings.ERR_DELETE_GROUP_USAGE);
        const g = getGroup(groupId);
        if (!g) throw new Error(strings.GROUP_NOT_EXIST);
        if (!isAdmin(groupId, state.myPubkey)) throw new Error(strings.ERR_NOT_ADMIN);
        const members = getMembers(groupId);
        const delMsg = { type: 'GROUP_DELETE', groupId };
        for (const m of members) {
          if (m.pubkey !== state.myPubkey) {
            state.transport.sendJSON(m.pubkey, delMsg);
          }
        }
        deleteGroup(groupId);
        state.groupKeys.delete(groupId);
        if (state.currentGroupId === groupId) {
          state.currentGroupId = null;
          state.currentTopicId = null;
          updateStatus('无', '无');
        }
        appendSystemMessage(formatString(strings.GROUP_DELETED, { id: groupId }));
        break;
      }
      case '/leave': {
        if (!state.currentGroupId) throw new Error(strings.ERR_NEED_TOPIC);
        const groupId = state.currentGroupId;
        if (isAdmin(groupId, state.myPubkey)) throw new Error(strings.ERR_ADMIN_CANT_LEAVE);
        if (!isMember(groupId, state.myPubkey)) throw new Error(strings.NOT_MEMBER);
        
        // 广播退出通知给所有在线节点（而不是仅数据库成员）
        const leaveMsg = { type: 'GROUP_LEAVE', groupId, leaver: state.myPubkey };
        state.transport.broadcast(leaveMsg, state.myPubkey);
        
        // 本地清理
        removeMember(groupId, state.myPubkey);
        state.currentGroupId = null;
        state.currentTopicId = null;
        updateStatus('无', '无');
        appendSystemMessage(formatString(strings.GROUP_LEFT, { id: groupId }));
        break;
      }
      case '/deletetopic': {
        const input = parts[1];
        if (!input) throw new Error(strings.ERR_TOPIC_USAGE);
        if (!state.currentGroupId) throw new Error(strings.ERR_NEED_TOPIC);
        let topic = getTopic(input);
        let topicId = input;
        if (!topic) {
          const topics = getTopicsByGroup(state.currentGroupId);
          const matches = topics.filter(t => t.name === input);
          if (matches.length === 0) throw new Error(formatString(strings.ERR_TOPIC_NOT_FOUND, { input }));
          if (matches.length > 1) throw new Error(formatString(strings.ERR_TOPIC_NOT_UNIQUE, { input }));
          topic = matches[0];
          topicId = topic.id;
        }
        if (!topic) throw new Error(strings.GROUP_NOT_EXIST);
        const groupId = topic.group_id;
        if (!isAdmin(groupId, state.myPubkey)) throw new Error(strings.ERR_NOT_ADMIN);
        deleteTopic(topicId);
        if (state.currentTopicId === topicId) {
          const defaultTopic = getDefaultTopic(groupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(formatString(strings.TOPIC_DELETED_SWITCH_DEFAULT, { name: defaultTopic.name }));
          const g = getGroup(groupId);
          updateStatus(g ? g.name : '未知', defaultTopic.name);
          broadcastStatus();
        } else {
          appendSystemMessage(formatString(strings.TOPIC_DELETED, { id: topicId }));
        }
        break;
      }
      case '/sendfile': {
        if (!state.currentGroupId) throw new Error(strings.ERR_NEED_TOPIC);
        const filePath = parts.slice(1).join(' ');
        if (!filePath) throw new Error(strings.ERR_NEED_FILE_PATH);
        if (!fs.existsSync(filePath)) throw new Error(strings.ERR_FILE_NOT_EXIST);
        const stats = fs.statSync(filePath);
        const filename = path.basename(filePath);
        const filedata = fs.readFileSync(filePath).toString('base64');
        const symKey = state.groupKeys.get(state.currentGroupId);
        if (!symKey) throw new Error(strings.ERROR_NO_GROUP_KEY);
        const bodyObj = { filename, filesize: stats.size, filedata };
        const bodyEncrypted = aesEncrypt(Buffer.from(JSON.stringify(bodyObj)), symKey);
        const prev = getMessages(state.currentGroupId, state.currentTopicId, 1).map(m => m.id);
        const msgObj = {
          id: '',
          prev_ids: prev,
          author: state.myPubkey,
          group_id: state.currentGroupId,
          topic_id: state.currentTopicId,
          type: 'file',
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
        const sig = sign(Buffer.from(JSON.stringify(canonicalData)), state.keyPair.secretKey);
        msgObj.sig = toHex(sig);
        msgObj.id = computeMessageId(msgObj);
        const fullMsg = { type: 'NEW_MSG', message: msgObj };
        const jsonStr = JSON.stringify(fullMsg);
        const byteLen = Buffer.byteLength(jsonStr);
        if (byteLen > UDP_MTU) {
          appendSystemMessage(formatString(strings.FILE_TOO_LARGE, { size: stats.size, byteLen, mtu: UDP_MTU }));
          break;
        }
        storeValidMessage(msgObj);
        state.transport.broadcast({ type: 'NEW_MSG', message: msgObj }, state.myPubkey);
        appendSystemMessage(formatString(strings.FILE_SENT, { filename, size: stats.size }));

        const ackPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            state.pendingFileAcks.delete(msgObj.id);
            reject(new Error('ACK timeout'));
          }, 5000);
          state.pendingFileAcks.set(msgObj.id, {
            timeout,
            resolve,
            reject
          });
        });

        try {
          await ackPromise;
          appendSystemMessage(formatString(strings.FILE_ACK_RECEIVED, { filename }));
        } catch (e) {
          appendSystemMessage(formatString(strings.FILE_SEND_TIMEOUT, { filename }));
        }
        break;
      }
      case '/download': {
        const msgId = parts[1];
        if (!msgId) throw new Error(strings.ERR_NEED_MSG_ID);
        const pending = state.pendingFiles.get(msgId);
        if (!pending) throw new Error(formatString(strings.FILE_DOWNLOAD_ERROR, { id: msgId }));
        const filesDir = path.join(process.cwd(), 'files');
        if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
        let savePath = path.join(filesDir, pending.filename);
        let counter = 1;
        const ext = path.extname(pending.filename);
        const baseName = path.basename(pending.filename, ext);
        while (fs.existsSync(savePath)) {
          savePath = path.join(filesDir, `${baseName}_${counter}${ext}`);
          counter++;
        }
        const fileBuffer = Buffer.from(pending.filedata, 'base64');
        fs.writeFileSync(savePath, fileBuffer);
        appendSystemMessage(formatString(strings.FILE_DOWNLOAD_SUCCESS, { path: savePath }));
        state.pendingFiles.delete(msgId);
        break;
      }
      case '/help': {
        const helpLines = strings.HELP.split('\n');
        for (const line of helpLines) {
          appendRaw(line);
        }
        break;
      }
      case '/exit': {
        appendSystemMessage('退出程序...');
        process.exit(0);
      }
      default: {
        appendSystemMessage(formatString(strings.UNKNOWN_COMMAND, { cmd }));
      }
    }
  } catch(e) {
    appendSystemMessage(formatString(strings.ERROR_PREFIX, { msg: e.message }));
  }
}