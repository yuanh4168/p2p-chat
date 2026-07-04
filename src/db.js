import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { toHex, sha256, aesDecrypt, aesEncrypt } from './crypto.js';
import { info, error, debug } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 固定数据库路径，不再使用 PID
const DB_PATH = path.join(process.cwd(), 'data', 'chat.db');

let db = null;
let isInitialized = false;

export async function initDB() {
    if (isInitialized) {
        debug('DB', 'Database already initialized');
        return db;
    }
    info('DB', 'Initializing database', { path: DB_PATH });
    const SQL = await initSqlJs({
        locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
    });
    let data = null;
    if (fs.existsSync(DB_PATH)) {
        info('DB', 'Found existing database file');
        data = new Uint8Array(fs.readFileSync(DB_PATH));
    } else {
        info('DB', 'No existing database, will create new');
    }
    try {
        db = new SQL.Database(data);
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                pubkey TEXT PRIMARY KEY,
                nickname TEXT,
                encrypted_private_key TEXT,
                x25519_public TEXT,
                created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT,
                creator_pubkey TEXT,
                symmetric_key_encrypted TEXT,
                created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                group_id TEXT,
                name TEXT,
                created_at INTEGER,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS members (
                group_id TEXT,
                pubkey TEXT,
                role TEXT DEFAULT 'member',
                joined_at INTEGER,
                PRIMARY KEY (group_id, pubkey),
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS join_requests (
                group_id TEXT,
                requester_pubkey TEXT,
                status TEXT DEFAULT 'pending',
                requested_at INTEGER,
                PRIMARY KEY (group_id, requester_pubkey)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                group_id TEXT,
                topic_id TEXT,
                author_pubkey TEXT,
                prev_ids TEXT,
                type TEXT,
                body_encrypted TEXT,
                timestamp INTEGER,
                sig TEXT,
                received_at INTEGER,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS connections (
                pubkey TEXT PRIMARY KEY,
                address TEXT,
                last_seen INTEGER
            );
        `);
        isInitialized = true;
        saveDB();
        info('DB', 'Database initialized successfully');
        return db;
    } catch (err) {
        error('DB', 'Failed to initialize database', { error: err.message, stack: err.stack });
        throw err;
    }
}

function saveDB() {
    if (!db) return;
    try {
        const data = db.export();
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(DB_PATH, Buffer.from(data));
        debug('DB', 'Database saved');
    } catch (err) {
        error('DB', 'Failed to save database', { error: err.message });
    }
}

function exec(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    try {
        const stmt = db.prepare(sql);
        const result = stmt.run(params);
        stmt.free();
        saveDB();
        return result;
    } catch (err) {
        error('DB', 'SQL exec error', { sql, params, error: err.message });
        throw err;
    }
}

function get(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const hasRow = stmt.step();
        const result = hasRow ? stmt.getAsObject() : null;
        stmt.free();
        return result;
    } catch (err) {
        error('DB', 'SQL get error', { sql, params, error: err.message });
        throw err;
    }
}

function all(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (err) {
        error('DB', 'SQL all error', { sql, params, error: err.message });
        throw err;
    }
}

// ---------- 导出操作（保持不变） ----------
export function getLocalUser() {
    return get('SELECT * FROM users LIMIT 1') || null;
}
export function saveLocalUser(pubkey, encryptedObj, x25519Public, nickname) {
    exec(
        'INSERT OR REPLACE INTO users (pubkey, nickname, encrypted_private_key, x25519_public, created_at) VALUES (?,?,?,?,?)',
        [pubkey, nickname || '', JSON.stringify(encryptedObj), x25519Public, Date.now()]
    );
}

export function getGroup(id) {
    return get('SELECT * FROM groups WHERE id = ?', [id]);
}
export function getAllGroups() {
    return all('SELECT * FROM groups ORDER BY created_at DESC');
}
export function saveGroup(id, name, creator, encryptedKey) {
    exec(
        'INSERT OR REPLACE INTO groups (id, name, creator_pubkey, symmetric_key_encrypted, created_at) VALUES (?,?,?,?,?)',
        [id, name, creator, JSON.stringify(encryptedKey), Date.now()]
    );
}
export function updateGroupKey(id, encryptedObj) {
    exec('UPDATE groups SET symmetric_key_encrypted = ? WHERE id = ?', [JSON.stringify(encryptedObj), id]);
}
export function getGroupKey(groupId, masterKey) {
    const row = get('SELECT symmetric_key_encrypted FROM groups WHERE id = ?', [groupId]);
    if (!row) return null;
    const obj = JSON.parse(row.symmetric_key_encrypted);
    return aesDecrypt(obj, masterKey);
}

export function getTopic(id) {
    return get('SELECT * FROM topics WHERE id = ?', [id]);
}
export function getTopicsByGroup(groupId) {
    return all('SELECT * FROM topics WHERE group_id = ? ORDER BY created_at', [groupId]);
}
export function saveTopic(id, groupId, name) {
    exec(
        'INSERT OR REPLACE INTO topics (id, group_id, name, created_at) VALUES (?,?,?,?)',
        [id, groupId, name, Date.now()]
    );
}
export function getDefaultTopic(groupId) {
    const topics = getTopicsByGroup(groupId);
    if (topics.length) return topics[0];
    const defaultId = toHex(sha256(Buffer.from(`default:${groupId}`)));
    saveTopic(defaultId, groupId, 'general');
    return getTopic(defaultId);
}

export function addMember(groupId, pubkey, role = 'member') {
    exec(
        'INSERT OR REPLACE INTO members (group_id, pubkey, role, joined_at) VALUES (?,?,?,?)',
        [groupId, pubkey, role, Date.now()]
    );
}
export function isMember(groupId, pubkey) {
    return !!get('SELECT 1 FROM members WHERE group_id = ? AND pubkey = ?', [groupId, pubkey]);
}
export function getMembers(groupId) {
    return all('SELECT pubkey, role FROM members WHERE group_id = ?', [groupId]);
}
export function isAdmin(groupId, pubkey) {
    const row = get('SELECT role FROM members WHERE group_id = ? AND pubkey = ?', [groupId, pubkey]);
    return row && row.role === 'admin';
}

export function addJoinRequest(groupId, requester) {
    exec(
        'INSERT OR REPLACE INTO join_requests (group_id, requester_pubkey, status, requested_at) VALUES (?,?,?,?)',
        [groupId, requester, 'pending', Date.now()]
    );
}
export function getPendingRequests(groupId) {
    return all('SELECT * FROM join_requests WHERE group_id = ? AND status = "pending"', [groupId]);
}
export function updateRequestStatus(groupId, requester, status) {
    exec('UPDATE join_requests SET status = ? WHERE group_id = ? AND requester_pubkey = ?', [status, groupId, requester]);
}

export function saveMessage(msg) {
    exec(
        `INSERT OR REPLACE INTO messages 
         (id, group_id, topic_id, author_pubkey, prev_ids, type, body_encrypted, timestamp, sig, received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
            msg.id, msg.group_id, msg.topic_id, msg.author,
            JSON.stringify(msg.prev_ids || []),
            msg.type, msg.body_encrypted, msg.timestamp, msg.sig, Date.now()
        ]
    );
}
export function getMessages(groupId, topicId = null, limit = 100) {
    let sql = 'SELECT * FROM messages WHERE group_id = ?';
    const params = [groupId];
    if (topicId) {
        sql += ' AND topic_id = ?';
        params.push(topicId);
    }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    return all(sql, params);
}
export function getMessage(id) {
    return get('SELECT * FROM messages WHERE id = ?', [id]);
}
export function getLatestMessageIds(groupId, count = 100) {
    const rows = all('SELECT id FROM messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?', [groupId, count]);
    return rows.map(r => r.id);
}

// ---------- 连接管理 ----------
export function getAllConnections() {
    return all('SELECT * FROM connections ORDER BY last_seen DESC');
}

export function saveConnection(pubkey, address) {
    exec(
        'INSERT OR REPLACE INTO connections (pubkey, address, last_seen) VALUES (?,?,?)',
        [pubkey, address, Date.now()]
    );
}

export function removeConnection(pubkey) {
    exec('DELETE FROM connections WHERE pubkey = ?', [pubkey]);
}

// 导出数据库路径（用于显示）
export function getDBPath() {
    return DB_PATH;
}