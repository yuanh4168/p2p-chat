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
import { toHex, sha256, fromHex, aesEncrypt } from './crypto.js';
import { decryptMessageBody } from './message.js';
import { appendSystemMessage, appendMessage, updateStatus, formatMessage, appendCommandMessage } from './ui.js';
import { shortPub, getGroupName, getTopicName, getTimeStr, getTailscaleIPs } from './utils.js';
import { broadcastStatus } from './app-handler.js';

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
  if (arr.length > 1) throw new Error(`公钥前缀 "${prefix}" 不唯一，请提供更多位`);
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
    if (!state.currentGroupId) { appendSystemMessage('未选择群组'); return; }
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
  // 记录命令及时间
  const timeStr = getTimeStr();
  appendCommandMessage(`[${timeStr}] > ${line}`);

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
          // 先尝试通过 DHT 发现该群组的节点并连接
          const infoHash = fromHex(groupId);
          try {
            appendSystemMessage(`正在通过 DHT 查找群组 ${groupId} 的节点...`);
            const peers = await state.dht.lookup(infoHash);
            let connected = 0;
            for (const p of peers) {
              if (p.host && p.port && p.host !== '0.0.0.0' && p.host !== '::') {
                state.transport._startHandshake(p.host, p.port);
                connected++;
              }
            }
            if (connected > 0) {
              appendSystemMessage(`已向 ${connected} 个节点发起连接，等待握手...`);
              // 等待 2 秒让握手可能完成
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              appendSystemMessage('DHT 未找到该群组的活跃节点，将广播请求（可能无法送达）');
            }
          } catch (e) {
            appendSystemMessage('DHT 查找失败，将广播请求');
          }
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
          appendSystemMessage('话题列表：' + topics.map(t=>`${t.name} (${t.id})`).join(', '));
          break;
        }
        if (topicName === 'general') {
          const defaultTopic = getDefaultTopic(state.currentGroupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(`已切换到默认话题：general`);
          const g = getGroup(state.currentGroupId);
          updateStatus(g ? g.name : '未知', 'general');
          broadcastStatus();
          break;
        }
        const topicId = toHex(sha256(Buffer.from(`topic:${state.currentGroupId}:${topicName}`)));
        const existing = getTopic(topicId);
        if (!existing) {
          saveTopic(topicId, state.currentGroupId, topicName);
          appendSystemMessage(`话题已创建：${topicName} (ID: ${topicId})`);
        }
        state.currentTopicId = topicId;
        appendSystemMessage(`已切换到话题：${topicName}`);
        const g = getGroup(state.currentGroupId);
        updateStatus(g ? g.name : '未知', topicName);
        broadcastStatus();
        break;
      }
      case '/approve': {
        const requesterInput = parts[1];
        const groupId = parts[2] || state.currentGroupId;
        if (!requesterInput || !groupId) throw new Error('用法：/approve <申请人公钥/前缀> <群组ID>');
        if (!isAdmin(groupId, state.myPubkey)) throw new Error('您不是该群组的管理员');
        const requester = resolvePubkey(requesterInput, groupId);
        if (!requester) throw new Error(`未找到匹配 "${requesterInput}" 的公钥`);
        let sharedKey = null;
        for (const [, sess] of state.transport.sessions) {
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
            const display = getDisplayNameWithSelf(m.pubkey, state.myPubkey, state.myNickname);
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
              const displayName = getDisplayNameWithSelf(m.author_pubkey, state.myPubkey, state.myNickname);
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
      case '/hash': {
        appendSystemMessage(`你的完整公钥：${state.myPubkey}`);
        break;
      }
      case '/renamegroup': {
        const newName = parts.slice(1).join(' ');
        if (!newName) throw new Error('用法：/renamegroup <新名称>');
        if (!state.currentGroupId) throw new Error('未选择群组');
        if (!isAdmin(state.currentGroupId, state.myPubkey)) throw new Error('只有管理员可以重命名群组');
        const g = getGroup(state.currentGroupId);
        if (!g) throw new Error('群组不存在');
        updateGroupName(state.currentGroupId, newName);
        const members = getMembers(state.currentGroupId);
        const renameMsg = { type: 'GROUP_RENAME', groupId: state.currentGroupId, newName };
        for (const m of members) {
          if (m.pubkey !== state.myPubkey) {
            state.transport.sendJSON(m.pubkey, renameMsg);
          }
        }
        appendSystemMessage(`群组名称已更新为：${newName}`);
        const g2 = getGroup(state.currentGroupId);
        updateStatus(g2.name, getTopicName(state.currentTopicId));
        broadcastStatus();
        break;
      }
      case '/deletegroup': {
        const groupId = parts[1] || state.currentGroupId;
        if (!groupId) throw new Error('用法：/deletegroup <群组ID>');
        const g = getGroup(groupId);
        if (!g) throw new Error('群组不存在');
        if (!isAdmin(groupId, state.myPubkey)) throw new Error('只有管理员可以删除群组');
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
        appendSystemMessage(`群组 ${groupId} 已删除（已通知成员）`);
        break;
      }
      case '/leave': {
        if (!state.currentGroupId) throw new Error('未选择群组');
        const groupId = state.currentGroupId;
        if (isAdmin(groupId, state.myPubkey)) throw new Error('管理员不能退出群组，请使用 /deletegroup 解散');
        if (!isMember(groupId, state.myPubkey)) throw new Error('您不是该群组的成员');
        const members = getMembers(groupId);
        const leaveMsg = { type: 'GROUP_LEAVE', groupId, leaver: state.myPubkey };
        for (const m of members) {
          if (m.pubkey !== state.myPubkey) {
            state.transport.sendJSON(m.pubkey, leaveMsg);
          }
        }
        removeMember(groupId, state.myPubkey);
        state.currentGroupId = null;
        state.currentTopicId = null;
        updateStatus('无', '无');
        appendSystemMessage(`您已退出群组 ${groupId}`);
        break;
      }
      case '/deletetopic': {
        const input = parts[1];
        if (!input) throw new Error('用法：/deletetopic <话题ID或名称>');
        if (!state.currentGroupId) throw new Error('未选择群组');
        let topic = getTopic(input);
        let topicId = input;
        if (!topic) {
          const topics = getTopicsByGroup(state.currentGroupId);
          const matches = topics.filter(t => t.name === input);
          if (matches.length === 0) throw new Error(`未找到话题 "${input}"`);
          if (matches.length > 1) throw new Error(`话题名称 "${input}" 不唯一，请使用ID删除`);
          topic = matches[0];
          topicId = topic.id;
        }
        if (!topic) throw new Error('话题不存在');
        const groupId = topic.group_id;
        if (!isAdmin(groupId, state.myPubkey)) throw new Error('只有管理员可以删除话题');
        deleteTopic(topicId);
        if (state.currentTopicId === topicId) {
          const defaultTopic = getDefaultTopic(groupId);
          state.currentTopicId = defaultTopic.id;
          appendSystemMessage(`已删除话题，切换到默认话题：${defaultTopic.name}`);
          const g = getGroup(groupId);
          updateStatus(g ? g.name : '未知', defaultTopic.name);
          broadcastStatus();
        } else {
          appendSystemMessage(`已删除话题 ${topicId}`);
        }
        break;
      }
      case '/help': {
        appendSystemMessage('===== 命令帮助 =====');
        appendSystemMessage('  /create <名称>            - 创建新群组');
        appendSystemMessage('  /join <群组ID>            - 申请加入群组');
        appendSystemMessage('  /use <群组ID>             - 切换到指定群组');
        appendSystemMessage('  /topic <话题名>           - 切换/创建话题（"general" 切回默认）');
        appendSystemMessage('  /approve <公钥/前缀> <群组ID> - 批准加入请求（管理员）');
        appendSystemMessage('  /list                    - 列出所有群组');
        appendSystemMessage('  /members <群组ID>         - 查看群组成员');
        appendSystemMessage('  /msgs [群组ID] [话题ID]   - 显示最近20条消息');
        appendSystemMessage('  /connect <IP> [端口]      - 手动连接对等节点');
        appendSystemMessage('  /tailscale               - 显示本机 Tailscale IP');
        appendSystemMessage('  /nick [<pubkey>] <昵称>  - 设置昵称');
        appendSystemMessage('  /online [all|group]      - 显示在线用户');
        appendSystemMessage('  /hash                    - 显示您的完整公钥');
        appendSystemMessage('  /renamegroup <新名称>    - 重命名当前群组（管理员）');
        appendSystemMessage('  /deletegroup <群组ID>    - 解散群组（管理员，会通知所有成员）');
        appendSystemMessage('  /leave                   - 退出当前群组（非管理员）');
        appendSystemMessage('  /deletetopic <ID或名称>  - 删除话题（管理员）');
        appendSystemMessage('  /help                    - 显示此帮助');
        appendSystemMessage('  /exit                    - 退出程序');
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