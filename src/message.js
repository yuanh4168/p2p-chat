import { getMessage, getMessages, saveMessage } from './db.js';
import { sha256, toHex, fromHex, verify, aesDecrypt } from './crypto.js';

export function getCanonicalData(msg) {
  return {
    prev_ids: msg.prev_ids || [],
    author: msg.author,
    group_id: msg.group_id,
    topic_id: msg.topic_id,
    timestamp: msg.timestamp,
    type: msg.type,
    body_encrypted: msg.body_encrypted
  };
}

export function verifyMessage(msg, publicKey) {
  const data = getCanonicalData(msg);
  return verify(Buffer.from(JSON.stringify(data)), fromHex(msg.sig), publicKey);
}

export function computeMessageId(msg) {
  const data = getCanonicalData(msg);
  return toHex(sha256(Buffer.from(JSON.stringify(data))));
}

export function arePrevIdsValid(prevIds) {
  for (const id of prevIds) if (!getMessage(id)) return false;
  return true;
}

export function storeValidMessage(msg) {
  if (!verifyMessage(msg, fromHex(msg.author))) throw new Error('Invalid signature');
  if (!arePrevIdsValid(msg.prev_ids || [])) throw new Error('Missing prev messages');
  if (computeMessageId(msg) !== msg.id) throw new Error('ID mismatch');
  saveMessage(msg);
  return true;
}

export function decryptMessageBody(msg, groupKey) {
  const obj = JSON.parse(msg.body_encrypted);
  return aesDecrypt(obj, groupKey).toString();
}