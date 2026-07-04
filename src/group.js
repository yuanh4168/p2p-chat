import { randomBytes } from 'crypto';
import { sha256, toHex, fromHex, aesEncrypt, aesDecrypt, sign, verify, deriveSharedSecret } from './crypto.js';
import { 
  getGroup, getGroupKey, saveGroup, updateGroupKey, 
  addMember, isMember, isAdmin, addJoinRequest, getPendingRequests, updateRequestStatus, getMembers 
} from './db.js';

export function createGroup(name, creatorPubkey, masterKey) {
  const id = toHex(sha256(Buffer.from(`group:${name}:${creatorPubkey}:${Date.now()}`)));
  const symKey = randomBytes(32);
  const encrypted = aesEncrypt(symKey, masterKey);
  saveGroup(id, name, creatorPubkey, encrypted);
  addMember(id, creatorPubkey, 'admin');
  return { id, symKey };
}

export function getGroupSymKey(groupId, masterKey) {
  return getGroupKey(groupId, masterKey);
}

export function requestJoin(groupId, requesterPubkey, transport) {
  const msg = { type: 'JOIN_REQUEST', groupId, requester: requesterPubkey };
  transport.broadcast(msg);
  addJoinRequest(groupId, requesterPubkey);
}

export function approveJoin(groupId, requesterPubkey, adminPubkey, sharedKeyWithRequester, masterKey, transport) {
  if (!isAdmin(groupId, adminPubkey)) throw new Error('Not admin');
  const symKey = getGroupKey(groupId, masterKey);
  if (!symKey) throw new Error('Group key not found');
  const encryptedKey = aesEncrypt(symKey, sharedKeyWithRequester);
  const approval = { type: 'JOIN_APPROVAL', groupId, groupKeyEncrypted: encryptedKey };
  transport.sendJSON(requesterPubkey, approval);
  addMember(groupId, requesterPubkey, 'member');
  updateRequestStatus(groupId, requesterPubkey, 'approved');
}

export function handleJoinRequest(msg, senderPubkey, transport, myPubkey) {
  const { groupId, requester } = msg;
  if (isAdmin(groupId, myPubkey)) {
    addJoinRequest(groupId, requester);
    // 触发事件，由 CLI 显示
  }
}