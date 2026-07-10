import { state } from './state.js';
import {
  saveProfileRemote, getMessage, saveMessage, getLatestMessageIds,
  getGroup, addMember, isAdmin, addJoinRequest, saveGroup,
  getTopic, getDefaultTopic, getMessages, getDisplayNameWithSelf,
  deleteGroup, removeMember, updateGroupName
} from './db.js';
import { aesDecrypt, aesEncrypt, toHex, sign, fromHex } from './crypto.js';
import { verifyMessage, computeMessageId, storeValidMessage, decryptMessageBody } from './message.js';
import { appendSystemMessage, appendMessage, updateStatus, formatMessage } from './ui.js';
import { shortPub, getGroupName, getTopicName, getTimeStr } from './utils.js';

export function broadcastMyProfile() {
  const profileMsg = {
    type: 'IDENTITY',
    pubkey: state.myPubkey,
    nickname: state.myNickname
  };
  state.transport.broadcast(profileMsg, state.myPubkey);
}

export function broadcastStatus() {
  if (!state.currentGroupId || !state.currentTopicId) return;
  const statusMsg = {
    type: 'STATUS',
    pubkey: state.myPubkey,
    groupId: state.currentGroupId,
    topicId: state.currentTopicId
  };
  state.transport.broadcast(statusMsg, state.myPubkey);
  state.peerStatus.set(state.myPubkey, { groupId: state.currentGroupId, topicId: state.currentTopicId });
  const g = getGroup(state.currentGroupId);
  const t = getTopic(state.currentTopicId);
  updateStatus(g ? g.name : '无', t ? t.name : '无');
}

export function sendMessage(text) {
  if (!state.currentGroupId) {
    appendSystemMessage('错误：未选择群组，请先 /use');
    return;
  }
  const symKey = state.groupKeys.get(state.currentGroupId);
  if (!symKey) {
    appendSystemMessage('错误：无群组密钥');
    return;
  }
  const bodyEncrypted = aesEncrypt(Buffer.from(text), symKey);
  const prev = getMessages(state.currentGroupId, state.currentTopicId, 1).map(m => m.id);
  const msgObj = {
    id: '',
    prev_ids: prev,
    author: state.myPubkey,
    group_id: state.currentGroupId,
    topic_id: state.currentTopicId,
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
  const sig = sign(Buffer.from(JSON.stringify(canonicalData)), state.keyPair.secretKey);
  msgObj.sig = toHex(sig);
  msgObj.id = computeMessageId(msgObj);
  storeValidMessage(msgObj);
  state.transport.broadcast({ type: 'NEW_MSG', message: msgObj }, state.myPubkey);

  const displayName = getDisplayNameWithSelf(state.myPubkey, state.myPubkey, state.myNickname);
  const time = getTimeStr();
  const msgText = formatMessage(displayName, text, time);
  appendMessage(msgText, true);
}

export function handleAppMessage(msg, session) {
  const { type } = msg;
  try {
    switch (type) {
      case 'IDENTITY': {
        if (msg.pubkey && msg.nickname) {
          saveProfileRemote(msg.pubkey, msg.nickname, null);
        }
        break;
      }
      case 'STATUS': {
        if (msg.pubkey && msg.groupId && msg.topicId) {
          state.peerStatus.set(msg.pubkey, { groupId: msg.groupId, topicId: msg.topicId });
          const g = state.currentGroupId ? getGroup(state.currentGroupId) : null;
          const t = state.currentTopicId ? getTopic(state.currentTopicId) : null;
          updateStatus(g ? g.name : '无', t ? t.name : '无');
        }
        break;
      }
      case 'TEST':
        break;
      case 'GROUP_LIST':
        break;
      case 'MSG_IDS': {
        const { groupId, ids } = msg;
        const ourIds = getLatestMessageIds(groupId, 100);
        const missing = ids.filter(id => !getMessage(id));
        if (missing.length) {
          state.transport.sendJSON(session.pubkey, { type: 'REQUEST_MSGS', groupId, ids: missing });
        }
        const theirSet = new Set(ids);
        const ourMissing = ourIds.filter(id => !theirSet.has(id));
        if (ourMissing.length) {
          const msgs = ourMissing.map(id => getMessage(id)).filter(Boolean);
          state.transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
        }
        break;
      }
      case 'REQUEST_MSGS': {
        const { groupId, ids } = msg;
        const msgs = ids.map(id => getMessage(id)).filter(Boolean);
        state.transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
        break;
      }
      case 'SEND_MSGS': {
        const { messages } = msg;
        for (const m of messages) {
          try { storeValidMessage(m); } catch(e) { /* warn */ }
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
              saveMessage(message);
            } else {
              throw e;
            }
          }
          if (state.currentGroupId === message.group_id && state.currentTopicId === message.topic_id) {
            const symKey = state.groupKeys.get(message.group_id);
            if (symKey) {
              const plain = decryptMessageBody(message, symKey);
              const displayName = getDisplayNameWithSelf(message.author, state.myPubkey, state.myNickname);
              const time = getTimeStr();
              const msgText = formatMessage(displayName, plain, time);
              appendMessage(msgText, message.author === state.myPubkey);
            }
          }
          const exclude = session.pubkey || message.author;
          state.transport.broadcast({ type: 'NEW_MSG', message }, exclude);
        } catch(e) {
          appendSystemMessage(`消息处理失败: ${e.message}`);
        }
        break;
      }
      case 'JOIN_REQUEST': {
        const { groupId, requester } = msg;
        if (isAdmin(groupId, state.myPubkey)) {
          appendSystemMessage(`[加入请求] ${shortPub(requester)} 想加入群组 ${groupId}`);
          appendSystemMessage('使用 /approve <申请人公钥> <群组ID> 批准');
          addJoinRequest(groupId, requester);
        }
        break;
      }
      case 'JOIN_APPROVAL': {
        const { groupId, groupName, creator, groupKeyEncrypted } = msg;
        const sharedKey = session.sharedKey;
        if (!sharedKey) break;
        try {
          const symKey = aesDecrypt(groupKeyEncrypted, sharedKey);
          const encrypted = aesEncrypt(symKey, state.masterKey);
          saveGroup(groupId, groupName || '未知群组', creator || '未知', encrypted);
          state.groupKeys.set(groupId, symKey);
          addMember(groupId, state.myPubkey, 'member');
          appendSystemMessage(`已批准加入群组 ${groupId}`);
          const g = getGroup(groupId);
          updateStatus(g ? g.name : '未知', state.currentTopicId ? getTopicName(state.currentTopicId) : '无');
        } catch(e) {
          appendSystemMessage('解密群组密钥失败');
        }
        break;
      }
      case 'NICK_UPDATE': {
        const { pubkey, nickname } = msg;
        if (pubkey && nickname) {
          saveProfileRemote(pubkey, nickname, null);
        }
        break;
      }
      // ---------- 新增群组管理消息 ----------
      case 'GROUP_RENAME': {
        const { groupId, newName } = msg;
        if (groupId && newName) {
          updateGroupName(groupId, newName);
          appendSystemMessage(`群组 ${groupId} 已更名为：${newName}`);
          if (state.currentGroupId === groupId) {
            const g = getGroup(groupId);
            updateStatus(g ? g.name : '未知', state.currentTopicId ? getTopicName(state.currentTopicId) : '无');
          }
        }
        break;
      }
      case 'GROUP_DELETE': {
        const { groupId } = msg;
        if (groupId) {
          // 删除本地群组
          deleteGroup(groupId);
          state.groupKeys.delete(groupId);
          if (state.currentGroupId === groupId) {
            state.currentGroupId = null;
            state.currentTopicId = null;
            updateStatus('无', '无');
          }
          appendSystemMessage(`群组 ${groupId} 已被管理员解散`);
        }
        break;
      }
      case 'GROUP_LEAVE': {
        const { groupId, leaver } = msg;
        if (groupId && leaver) {
          // 仅当本地存在该群且该成员在成员列表中
          if (getGroup(groupId)) {
            removeMember(groupId, leaver);
            appendSystemMessage(`${shortPub(leaver)} 已退出群组 ${groupId}`);
            // 如果离开者是自己，但自己不会发送给自己，所以忽略
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // log error
  }
}