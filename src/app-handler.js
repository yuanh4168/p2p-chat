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
import { strings } from './strings.js';
import { formatString } from './format.js';

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
    appendSystemMessage(strings.ERROR_NO_GROUP);
    return;
  }
  const symKey = state.groupKeys.get(state.currentGroupId);
  if (!symKey) {
    appendSystemMessage(strings.ERROR_NO_GROUP_KEY);
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
      case 'FILE_ACK': {
        const { msgId } = msg;
        const pending = state.pendingFileAcks.get(msgId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve();
          state.pendingFileAcks.delete(msgId);
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
          const symKey = state.groupKeys.get(message.group_id);
          if (symKey) {
            try {
              const plain = decryptMessageBody(message, symKey);
              if (message.type === 'file') {
                const fileInfo = JSON.parse(plain);
                state.pendingFiles.set(message.id, {
                  filename: fileInfo.filename,
                  filesize: fileInfo.filesize,
                  filedata: fileInfo.filedata,
                  from: message.author,
                  groupId: message.group_id,
                  topicId: message.topic_id,
                  timestamp: message.timestamp
                });
                if (message.author !== state.myPubkey) {
                  state.transport.sendJSON(message.author, { type: 'FILE_ACK', msgId: message.id });
                }
                const displayName = getDisplayNameWithSelf(message.author, state.myPubkey, state.myNickname);
                const groupName = getGroupName(message.group_id);
                const topicName = getTopicName(message.topic_id);
                appendSystemMessage(formatString(strings.FILE_RECEIVED, {
                  filename: fileInfo.filename,
                  size: fileInfo.filesize,
                  from: displayName,
                  group: groupName,
                  topic: topicName
                }));
                appendSystemMessage(formatString(strings.FILE_DOWNLOAD_HINT, { id: message.id }));
                if (state.currentGroupId === message.group_id && state.currentTopicId === message.topic_id) {
                  const time = getTimeStr();
                  const msgText = `{${time}} (${displayName}) 发送了文件：${fileInfo.filename} (${fileInfo.filesize} 字节)`;
                  appendMessage(msgText, message.author === state.myPubkey);
                }
              } else {
                if (state.currentGroupId === message.group_id && state.currentTopicId === message.topic_id) {
                  const displayName = getDisplayNameWithSelf(message.author, state.myPubkey, state.myNickname);
                  const time = getTimeStr();
                  const msgText = formatMessage(displayName, plain, time);
                  appendMessage(msgText, message.author === state.myPubkey);
                }
              }
            } catch(e) {
              appendSystemMessage(formatString(strings.ERROR_MSG_DECRYPT, { msg: e.message }));
            }
          } else {
            appendSystemMessage(formatString(strings.ERROR_MSG_ENCRYPTED_NO_KEY, { groupId: message.group_id }));
          }
          const exclude = session.pubkey || message.author;
          state.transport.broadcast({ type: 'NEW_MSG', message }, exclude);
        } catch(e) {
          appendSystemMessage(formatString(strings.MSG_PROCESS_FAIL, { msg: e.message }));
        }
        break;
      }
      case 'JOIN_REQUEST': {
        const { groupId, requester } = msg;
        if (isAdmin(groupId, state.myPubkey)) {
          appendSystemMessage(formatString(strings.JOIN_REQUEST_RECEIVED, { pubkey: shortPub(requester), id: groupId }));
          appendSystemMessage(strings.JOIN_APPROVE_HINT);
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
          appendSystemMessage(formatString(strings.JOIN_APPROVAL_RECEIVED, { id: groupId }));
          const g = getGroup(groupId);
          updateStatus(g ? g.name : '未知', state.currentTopicId ? getTopicName(state.currentTopicId) : '无');
        } catch(e) {
          appendSystemMessage(strings.DECRYPT_FAIL);
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
      case 'GROUP_RENAME': {
        const { groupId, newName } = msg;
        if (groupId && newName) {
          updateGroupName(groupId, newName);
          appendSystemMessage(formatString(strings.GROUP_RENAMED, { name: newName }));
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
          deleteGroup(groupId);
          state.groupKeys.delete(groupId);
          if (state.currentGroupId === groupId) {
            state.currentGroupId = null;
            state.currentTopicId = null;
            updateStatus('无', '无');
          }
          appendSystemMessage(formatString(strings.GROUP_DELETED, { id: groupId }));
        }
        break;
      }
      case 'GROUP_LEAVE': {
        const { groupId, leaver } = msg;
        if (groupId && leaver) {
          if (getGroup(groupId)) {
            removeMember(groupId, leaver);
            if (leaver === state.myPubkey) {
              if (state.currentGroupId === groupId) {
                state.currentGroupId = null;
                state.currentTopicId = null;
                updateStatus('无', '无');
              }
            }
            appendSystemMessage(formatString(strings.GROUP_LEAVE_NOTIFICATION, { pubkey: shortPub(leaver), id: groupId }));
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