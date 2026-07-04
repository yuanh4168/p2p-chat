#!/usr/bin/env node
import { initDB, getLocalUser, saveLocalUser, getAllGroups, getGroup, getTopicsByGroup, getDefaultTopic, getMessages, saveMessage, getMessage, getLatestMessageIds, getMembers, isMember, addMember, isAdmin, getPendingRequests, addJoinRequest, updateRequestStatus, getGroupKey, saveGroup, getTopic, saveTopic, getAllConnections, saveConnection, getDBPath } from './db.js';
import { generateKeyPair, encryptPrivateKey, decryptPrivateKey, ed25519SecretToX25519, toHex, fromHex, sign, verify, sha256, aesEncrypt, aesDecrypt } from './crypto.js';
import { DHTNode } from './dht.js';
import { UDPTransport } from './udp-transport.js';
import { verifyMessage, computeMessageId, storeValidMessage, decryptMessageBody } from './message.js';
import { createGroup, getGroupSymKey, requestJoin } from './group.js';
import { UDP_PORTS } from './config.js';
import { info, error, debug, warn, setupGlobalErrorHandler } from './logger.js';
import readline from 'readline';
import { promisify } from 'util';
import { scrypt } from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

// 设置全局异常捕获
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

/**
 * 获取本机 Tailscale IPv4 地址
 * 若未安装则抛出 'NOT_INSTALLED' 错误
 */
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

async function main() {
    info('MAIN', '=== Application started ===');
    const RESET_DB = false;
    if (RESET_DB) {
        const dbPath = path.join(process.cwd(), 'data', 'chat.db');
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            info('MAIN', 'Deleted old database file', { path: dbPath });
        }
        const dataDir = path.dirname(dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
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
        console.log('首次运行：创建身份');
        const password = await question('设置密码：');
        info('MAIN', 'Creating new identity');
        keyPair = generateKeyPair();
        x25519KeyPair = ed25519SecretToX25519(keyPair.secretKey);
        myPubkey = toHex(keyPair.publicKey);
        const encrypted = await encryptPrivateKey(keyPair.secretKey, password);
        saveLocalUser(myPubkey, encrypted, toHex(x25519KeyPair.publicKey), 'User');
        masterKey = await scryptAsync(password, 'salt', 32);
        console.log(`身份已创建：${myPubkey}`);
        info('MAIN', 'New identity created', { pubkey: myPubkey.slice(0,8) });
    } else {
        console.log(`欢迎回来，用户 ${user.pubkey.slice(0,8)}...`);
        const password = await question('输入密码：');
        let encryptedObj;
        try {
            encryptedObj = JSON.parse(user.encrypted_private_key);
        } catch (e) {
            console.error('存储的私钥已损坏，请重置 data/chat.db 并重新启动。');
            error('MAIN', 'Encrypted private key corrupted', { error: e.message });
            process.exit(1);
        }
        try {
            const privKey = await decryptPrivateKey(encryptedObj, password);
            keyPair = { publicKey: fromHex(user.pubkey), secretKey: privKey };
            x25519KeyPair = ed25519SecretToX25519(privKey);
            myPubkey = user.pubkey;
            masterKey = await scryptAsync(password, 'salt', 32);
            console.log(`已登录为 ${myPubkey.slice(0,8)}...`);
            info('MAIN', 'User logged in', { pubkey: myPubkey.slice(0,8) });
        } catch (e) {
            console.error('❌ 密码错误或数据损坏，请确认密码或删除 data/chat.db 重新创建。');
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
        console.log(`DHT 正在 UDP 端口 ${dht.port} 监听`);
    } catch (err) {
        error('MAIN', 'DHT initialization failed', err);
        console.error('DHT 初始化失败，请检查网络或端口');
        // 继续运行
    }

    // UDP Transport
    transport = new UDPTransport(keyPair, x25519KeyPair);
    transport.on('error', (err) => {
        error('MAIN', 'UDP transport runtime error', err);
        console.warn('UDP 运行时错误，但程序将继续运行', err.message);
    });
    try {
        await transport.listen();
        info('MAIN', 'UDP transport ready', { port: transport.port });
        console.log(`UDP 传输正在监听端口 ${transport.port}`);
    } catch (err) {
        error('MAIN', 'UDP transport initialization failed', err);
        console.error('UDP 传输初始化失败，请检查端口是否被占用');
        process.exit(1);
    }

    // Tailscale
    let tailscaleIPs = [];
    try {
        tailscaleIPs = await getTailscaleIPs();
        if (tailscaleIPs.length > 0) {
            console.log(`Tailscale IP: ${tailscaleIPs.join(', ')} （可用于 /connect 连接）`);
            info('MAIN', 'Tailscale IPs found', { ips: tailscaleIPs });
        } else {
            console.log('未检测到 Tailscale 网络，您仍可使用公网 IP 或手动连接。');
            info('MAIN', 'No Tailscale IPs');
        }
    } catch (e) {
        if (e.message === 'NOT_INSTALLED') {
            console.log('❌ 未检测到 Tailscale。');
            console.log('请访问 https://tailscale.com/download 下载并安装 Tailscale，');
            console.log('然后登录您的账号（tailscale login），即可获得安全的内网 IP 用于连接。');
            console.log('若不使用 Tailscale，也可直接用公网 IP + 端口连接。');
            info('MAIN', 'Tailscale not installed');
        } else {
            console.log('检测 Tailscale 出错:', e.message);
            error('MAIN', 'Tailscale detection error', { error: e.message });
        }
    }

    // 加载已有连接并自动连接
    try {
        const conns = getAllConnections();
        info('MAIN', 'Loading connections', { count: conns.length });
        for (const c of conns) {
            const [ip, port] = c.address.split(':');
            if (ip && port) {
                transport._startHandshake(ip, parseInt(port));
                debug('MAIN', 'Auto-connecting to', { ip, port });
            }
        }
        if (conns.length > 0) {
            console.log(`已加载 ${conns.length} 个已知节点，正在尝试连接...`);
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
        console.log(`[UDP] 与 ${ip}:${port} 握手完成`);
        transport.sendTo(ip, port, Buffer.from(JSON.stringify({ type: 'IDENTITY', pubkey: myPubkey })));
        transport.sendTo(ip, port, Buffer.from(JSON.stringify({ type: 'TEST', from: myPubkey })));
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
                console.log(`[APP] 已保存连接 ${msg.pubkey.slice(0,8)}... -> ${ip}:${port}`);
                info('MAIN', 'Saved connection', { pubkey: msg.pubkey.slice(0,8), address: `${ip}:${port}` });
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

    // CLI 交互界面
    console.log('\n===== P2P 聊天系统 (UDP) =====');
    console.log('命令列表：');
    console.log('  /create <群组名称>            - 创建新群组');
    console.log('  /join <群组ID>                - 申请加入群组');
    console.log('  /use <群组ID>                 - 切换到指定群组');
    console.log('  /topic <话题名称>             - 在当前群组创建/切换话题');
    console.log('  /approve <申请人公钥> <群组ID> - 批准加入请求（仅管理员）');
    console.log('  /list                        - 列出所有群组');
    console.log('  /members <群组ID>            - 查看群组成员');
    console.log('  /msgs [群组ID] [话题ID]      - 显示最近消息');
    console.log('  /connect <IP> [端口]         - 手动连接对等节点（支持 Tailscale IP，若不指定端口则自动尝试四个固定端口）');
    console.log('  /tailscale                   - 显示本机 Tailscale IP');
    console.log('  /exit                        - 退出程序');
    console.log('直接输入文本即可发送到当前群组/话题\n');

    rl.setPrompt('> ');
    rl.prompt();

    rl.on('line', async (line) => {
        const parts = line.trim().split(/\s+/);
        if (!parts.length) { rl.prompt(); return; }
        const cmd = parts[0];
        try {
            if (cmd === '/create') {
                const name = parts.slice(1).join(' ');
                if (!name) throw new Error('需要群组名称');
                const { id, symKey } = createGroup(name, myPubkey, masterKey);
                groupKeys.set(id, symKey);
                currentGroupId = id;
                const defaultTopic = getDefaultTopic(id);
                currentTopicId = defaultTopic.id;
                console.log(`群组已创建：${id}（默认话题：${defaultTopic.name}）`);
                info('MAIN', 'Group created', { id, name });
                try {
                    await dht.announce(fromHex(id));
                } catch (e) {
                    console.log('DHT 公告失败（网络可能不通，但可以继续使用手动连接）');
                    warn('MAIN', 'DHT announce failed', { group: id, error: e.message });
                }
            } else if (cmd === '/join') {
                const groupId = parts[1];
                if (!groupId) throw new Error('需要群组 ID');
                if (isMember(groupId, myPubkey)) {
                    console.log('已是该群组成员');
                } else {
                    requestJoin(groupId, myPubkey, transport);
                    console.log(`已向群组 ${groupId} 发送加入请求`);
                    info('MAIN', 'Join request sent', { groupId });
                }
            } else if (cmd === '/use') {
                const groupId = parts[1];
                if (!groupId) throw new Error('需要群组 ID');
                const g = getGroup(groupId);
                if (!g) throw new Error('群组不存在');
                if (!isMember(groupId, myPubkey) && groupId !== g.creator_pubkey) {
                    console.log('您不是该群组的成员');
                } else {
                    currentGroupId = groupId;
                    const defaultTopic = getDefaultTopic(groupId);
                    currentTopicId = defaultTopic.id;
                    console.log(`已切换到群组 ${g.name}（${groupId}），话题：${defaultTopic.name}`);
                    info('MAIN', 'Switched group', { groupId, topic: defaultTopic.name });
                }
            } else if (cmd === '/topic') {
                if (!currentGroupId) throw new Error('未选择群组');
                const topicName = parts.slice(1).join(' ');
                if (!topicName) {
                    const topics = getTopicsByGroup(currentGroupId);
                    console.log('话题列表：', topics.map(t=>t.name).join(', '));
                    return;
                }
                const topicId = toHex(sha256(Buffer.from(`topic:${currentGroupId}:${topicName}`)));
                const existing = getTopic(topicId);
                if (!existing) {
                    saveTopic(topicId, currentGroupId, topicName);
                    console.log(`话题已创建：${topicName}`);
                }
                currentTopicId = topicId;
                console.log(`已切换到话题：${topicName}`);
            } else if (cmd === '/approve') {
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
                console.log(`已批准 ${requester} 加入群组 ${groupId}`);
                info('MAIN', 'Join approved', { requester, groupId });
            } else if (cmd === '/list') {
                const groups = getAllGroups();
                groups.forEach(g => console.log(`${g.id}  ${g.name}（创建者：${g.creator_pubkey.slice(0,8)}...）`));
            } else if (cmd === '/members') {
                const groupId = parts[1] || currentGroupId;
                if (!groupId) throw new Error('需要群组 ID');
                const members = getMembers(groupId);
                members.forEach(m => console.log(`${m.pubkey}  （${m.role}）`));
            } else if (cmd === '/msgs') {
                const groupId = parts[1] || currentGroupId;
                if (!groupId) throw new Error('需要群组 ID');
                const topicId = parts[2] || currentTopicId;
                const msgs = getMessages(groupId, topicId, 20);
                const symKey = groupKeys.get(groupId);
                if (!symKey) { console.log('无群组密钥'); return; }
                for (const m of msgs.reverse()) {
                    const plain = decryptMessageBody(m, symKey);
                    console.log(`${new Date(m.timestamp).toLocaleTimeString()} [${m.author.slice(0,8)}] ${plain}`);
                }
            } else if (cmd === '/connect') {
                const arg = parts[1];
                if (!arg) throw new Error('用法：/connect <IP> [端口]');
                let ip, port;
                if (arg.includes(':')) {
                    [ip, port] = arg.split(':');
                    port = parseInt(port);
                    transport._startHandshake(ip, port);
                    console.log(`尝试连接 ${ip}:${port}`);
                } else {
                    ip = arg;
                    const ports = UDP_PORTS;
                    for (const p of ports) {
                        transport._startHandshake(ip, p);
                    }
                    console.log(`尝试连接 ${ip} 的端口 ${ports.join(', ')}`);
                }
            } else if (cmd === '/tailscale') {
                try {
                    const ips = await getTailscaleIPs();
                    if (ips.length) {
                        console.log(`Tailscale IP: ${ips.join(', ')}`);
                    } else {
                        console.log('未检测到 Tailscale 网络（请确保已安装并登录 Tailscale）');
                    }
                } catch (e) {
                    if (e.message === 'NOT_INSTALLED') {
                        console.log('Tailscale 未安装，请访问 https://tailscale.com/download 下载安装。');
                    } else {
                        console.log('获取 Tailscale IP 失败:', e.message);
                    }
                }
            } else if (cmd === '/exit') {
                process.exit(0);
            } else {
                // 发送文本消息
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
                // 广播时排除自己，避免循环
                transport.broadcast({ type: 'NEW_MSG', message: msgObj }, myPubkey);
                console.log('消息已发送');
                debug('MAIN', 'Message sent', { topic: currentTopicId, text });
            }
        } catch(e) {
            console.error('错误：', e.message);
            error('MAIN', 'Command error', { command: cmd, error: e.message, stack: e.stack });
        }
        rl.prompt();
    });
}

// 应用层消息处理
function handleAppMessage(msg, session) {
    const { type } = msg;
    try {
        switch(type) {
            case 'IDENTITY': {
                // 已在外部事件中处理
                break;
            }
            case 'TEST':
                console.log(`[APP] 收到测试消息，来自 ${session.pubkey ? session.pubkey.slice(0,8)+'...' : '未知'}`);
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
                    debug('APP', 'Requesting missing messages', { groupId, count: missing.length });
                }
                const theirSet = new Set(ids);
                const ourMissing = ourIds.filter(id => !theirSet.has(id));
                if (ourMissing.length) {
                    const msgs = ourMissing.map(id => getMessage(id)).filter(Boolean);
                    transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
                    debug('APP', 'Sending our missing messages', { groupId, count: msgs.length });
                }
                break;
            }
            case 'REQUEST_MSGS': {
                const { groupId, ids } = msg;
                const msgs = ids.map(id => getMessage(id)).filter(Boolean);
                transport.sendJSON(session.pubkey, { type: 'SEND_MSGS', groupId, messages: msgs });
                debug('APP', 'Replying to REQUEST_MSGS', { groupId, count: msgs.length });
                break;
            }
            case 'SEND_MSGS': {
                const { messages } = msg;
                for (const m of messages) {
                    try { storeValidMessage(m); } catch(e) { 
                        warn('APP', 'Failed to store received message', { id: m.id, error: e.message });
                    }
                }
                debug('APP', 'Stored received messages', { count: messages.length });
                break;
            }
            case 'NEW_MSG': {
                const { message } = msg;
                try {
                    // 检查是否已存在，避免重复存储
                    if (getMessage(message.id)) {
                        debug('APP', 'Message already exists, skipping', { id: message.id });
                        break;
                    }
                    storeValidMessage(message);
                    if (currentGroupId === message.group_id) {
                        const symKey = groupKeys.get(message.group_id);
                        if (symKey) {
                            const plain = decryptMessageBody(message, symKey);
                            const author = message.author || '未知';
                            console.log(`\n[${author.slice(0,8)}] ${plain}`);
                            rl.prompt();
                        } else {
                            console.error('错误：无群组密钥用于消息');
                            error('APP', 'No group key for message', { groupId: message.group_id });
                        }
                    }
                    // 转发给其他人，排除原始发送者（使用消息中的 author 或 session.pubkey）
                    const exclude = session.pubkey || message.author;
                    if (exclude) {
                        transport.broadcast({ type: 'NEW_MSG', message }, exclude);
                    } else {
                        transport.broadcast({ type: 'NEW_MSG', message }, myPubkey);
                    }
                } catch(e) {
                    console.error('消息处理失败:', e.message);
                    error('APP', 'NEW_MSG processing error', { error: e.message, id: message.id });
                }
                break;
            }
            case 'JOIN_REQUEST': {
                const { groupId, requester } = msg;
                if (isAdmin(groupId, myPubkey)) {
                    console.log(`\n[加入请求] ${requester} 想加入群组 ${groupId}`);
                    console.log('使用 /approve <申请人公钥> <群组ID> 批准');
                    rl.prompt();
                    addJoinRequest(groupId, requester);
                    info('APP', 'Join request received and added', { groupId, requester });
                }
                break;
            }
            case 'JOIN_APPROVAL': {
                const { groupId, groupName, creator, groupKeyEncrypted } = msg;
                const sharedKey = session.sharedKey;
                if (!sharedKey) {
                    warn('APP', 'No shared key for JOIN_APPROVAL', { groupId });
                    break;
                }
                try {
                    const symKey = aesDecrypt(groupKeyEncrypted, sharedKey);
                    const encrypted = aesEncrypt(symKey, masterKey);
                    saveGroup(groupId, groupName || '未知群组', creator || '未知', encrypted);
                    groupKeys.set(groupId, symKey);
                    addMember(groupId, myPubkey, 'member');
                    console.log(`已批准加入群组 ${groupId}`);
                    info('APP', 'Joined group via approval', { groupId });
                } catch(e) {
                    console.error('解密群组密钥失败');
                    error('APP', 'JOIN_APPROVAL decryption error', { groupId, error: e.message });
                }
                break;
            }
            default: {
                debug('APP', 'Unhandled message type', { type });
            }
        }
    } catch (err) {
        error('APP', 'handleAppMessage error', { error: err.message, type });
    }
}

main().catch((err) => {
    error('MAIN', 'Fatal error in main', { error: err.message, stack: err.stack });
    console.error('程序发生致命错误，请查看日志 logs/ 目录下的文件');
    process.exit(1);
});