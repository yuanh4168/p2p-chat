import { state } from './state.js';
import {
  getGroup, getAllGroups, isMember, getMembers, getMessages,
  getTopic, saveTopic, getTopicsByGroup, getDefaultTopic,
  updateUserNickname, setLocalNickname, isAdmin, addMember,
  updateRequestStatus, getDisplayNameWithSelf
} from './db.js';
import { createGroup, requestJoin } from './group.js';
import { toHex, sha256, fromHex, aesEncrypt } from './crypto.js';
import { decryptMessageBody } from './message.js';
import { appendSystemMessage, appendMessage, updateStatus, formatMessage } from './ui.js';
import { shortPub, getGroupName, getTopicName, getTimeStr, getTailscaleIPs } from './utils.js';
import { broadcastStatus } from './app-handler.js';

export function handleOnline(subcmd) {
  let peers = [];
  if (subcmd === 'all') {
    for (const [key, sess] of state.transport.sessions) {
      if (sess.established && sess.pubkey) {
        peers.push(sess.pubkey);
      }
    }
  } else if (subcmd === 'group') {
    if (!state.currentGroupId) { appendSystemMessage('未选择群组'); return; }
    for (const [pubkey, status] of state.peerStatus) {
      if (status.groupId === state.currentGroupId && pubkey !== state.myPubkey) {
        if (isMember(state.currentGroupId, pubkey)) {
          peers.push(pubkey);
        }
      }
    }
    if (isMember(state.currentGroupId, state.myPubkey)) peers.push(state.myPubkey);
  } else {
    if (!state.currentGroupId || !state.currentTopicId) { appendSystemMessage('未选择群组或话题'); return; }
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
    appendSystemMessage('当前没有在线用户');
    return;
  }

  let title = '';
  if (subcmd === 'all') title = '所有连接节点';
  else if (subcmd === 'group') title = `群组 ${getGroupName(state.currentGroupId)} 在线用户`;
  else title = `话题 ${getTopicName(state.currentTopicId)} 在线用户`;

  appendSystemMessage(`--- ${title} (${peers.length}) ---`);
  for (const pubkey of peers) {
    const display = getDisplayNameWithSelf(pubkey, state.myPubkey);
    const role = isAdmin(state.currentGroupId, pubkey) ? 'admin' : (isMember(state.currentGroupId, pubkey) ? 'member' : 'unknown');
    const hash = pubkey.slice(0, 16);
    appendSystemMessage(`  ${display} (${hash}) [${role}]`);
  }
}

export async function handleCommand(line) {
  const parts = line.trim().split(/\s+/);
  if (!parts.length) return;
  const cmd = parts[0];
  try {
    switch (cmd) {
      case '/create': {
        const name = parts.slice(1).join(' ');
        if (!name) throw new Error('需要群组名称');
        const { id, symKey } = createGroup(name, state.myPubkey, state.masterKey);
        state.groupKeys.set(id, symKey);
        state.currentGroupId = id;
        const defaultTopic = getDefaultTopic(id);
        state.currentTopicId = defaultTopic.id;
        appendSystemMessage(`群组已创建：${id}（默认话题：${defaultTopic.name}）`);
        try {
          await state.dht.announce(fromHex(id));
        } catch (e) {
          appendSystemMessage('DHT 公告失败（可能因网络原因，但手动连接不受影响）');
        }
        updateStatus(name, defaultTopic.name);
        broadcastStatus();
        break;
      }
      case '/join': {
        const groupId = parts[1];
        if (!groupId) throw new Error('需要群组 ID');
        if (isMember(groupId, state.myPubkey)) {
          appendSystemMessage('已是该群组成员');
        } else {
          requestJoin(groupId, state.myPubkey, state.transport);
          appendSystemMessage(`已向群组 ${groupId} 发送加入请求`);
        }
        break;
      }
      case '/use': {
        const groupId = parts[1];
        if (!groupId) throw new Error('需要群组 ID');
        const g = getGroup(groupId);
        if (!g) throw new Error('群组不存在');
        if (!isMember(groupId, state.myPubkey) && groupId !== g.creator_pubkey) {
          appendSystemMessage('您不是该群组的成员');
        } else {
          state.currentGroupId = groupId;
          const defaultTopic = getDefaultTopic(groupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(`已切换到群组 ${g.name}（${groupId}），话题：${defaultTopic.name}`);
          updateStatus(g.name, defaultTopic.name);
          broadcastStatus();
        }
        break;
      }
      case '/topic': {
        if (!state.currentGroupId) throw new Error('未选择群组');
        const topicName = parts.slice(1).join(' ');
        if (!topicName) {
          const topics = getTopicsByGroup(state.currentGroupId);
          appendSystemMessage('话题列表：' + topics.map(t=>t.name).join(', '));
          break;
        }
        const topicId = toHex(sha256(Buffer.from(`topic:${state.currentGroupId}:${topicName}`)));
        const existing = getTopic(topicId);
        if (!existing) {
          saveTopic(topicId, state.currentGroupId, topicName);
          appendSystemMessage(`话题已创建：${topicName}`);
        }
        state.currentTopicId = topicId;
        appendSystemMessage(`已切换到话题：${topicName}`);
        const g = getGroup(state.currentGroupId);
        updateStatus(g ? g.name : '未知', topicName);
        broadcastStatus();
        break;
      }
      case '/approve': {
        const requester = parts[1];
        const groupId = parts[2];
        if (!requester || !groupId) throw new Error('用法：/approve <申请人公钥> <群组ID>');
        if (!isAdmin(groupId, state.myPubkey)) throw new Error('您不是该群组的管理员');
        let sharedKey = null;
        for (const [key, sess] of state.transport.sessions) {
          if (sess.pubkey === requester) {
            sharedKey = sess.sharedKey;
            break;
          }
        }
        if (!sharedKey) throw new Error('请求者未连接或没有共享密钥');
        const symKey = state.groupKeys.get(groupId);
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
        state.transport.sendJSON(requester, approval);
        addMember(groupId, requester, 'member');
        updateRequestStatus(groupId, requester, 'approved');
        appendSystemMessage(`已批准 ${shortPub(requester)} 加入群组 ${groupId}`);
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
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error('需要群组 ID');
        const members = getMembers(groupId);
        if (members.length === 0) {
          appendSystemMessage('暂无成员');
        } else {
          members.forEach(m => {
            const display = getDisplayNameWithSelf(m.pubkey, state.myPubkey);
            appendSystemMessage(`  ${display}  （${m.role}）`);
          });
        }
        break;
      }
      case '/msgs': {
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error('需要群组 ID');
        const topicId = parts[2] || state.currentTopicId;
        const msgs = getMessages(groupId, topicId, 20);
        const symKey = state.groupKeys.get(groupId);
        if (!symKey) { appendSystemMessage('无群组密钥'); break; }
        if (msgs.length === 0) {
          appendSystemMessage('暂无消息');
        } else {
          for (const m of msgs.reverse()) {
            try {
              const plain = decryptMessageBody(m, symKey);
              const displayName = getDisplayNameWithSelf(m.author_pubkey, state.myPubkey);
              const time = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 19);
              const isSelf = m.author_pubkey === state.myPubkey;
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
          state.transport._startHandshake(ip, port);
          appendSystemMessage(`正在连接 ${ip}:${port}...`);
          const timeout = setTimeout(() => {
            const key = `${ip}:${port}`;
            if (!state.transport.sessions.has(key) || !state.transport.sessions.get(key).established) {
              appendSystemMessage(`连接 ${ip}:${port} 超时`);
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
          appendSystemMessage(`当前昵称：${state.myNickname}`);
          break;
        }
        if (parts.length === 2) {
          const newNick = parts[1];
          state.myNickname = newNick;
          updateUserNickname(state.myPubkey, newNick);
          const updateMsg = { type: 'NICK_UPDATE', pubkey: state.myPubkey, nickname: newNick };
          state.transport.broadcast(updateMsg, state.myPubkey);
          appendSystemMessage(`昵称已设置为：${newNick}`);
        } else if (parts.length === 3) {
          const target = parts[1];
          const nick = parts[2];
          setLocalNickname(target, nick);
          appendSystemMessage(`已为 ${shortPub(target)} 设置本地昵称：${nick}`);
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
  }
}