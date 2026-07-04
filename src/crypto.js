import nacl from 'tweetnacl';
import { createHash, scrypt, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { promisify } from 'util';
const scryptAsync = promisify(scrypt);

export function generateKeyPair() { return nacl.sign.keyPair(); }
export function sha256(data) { return createHash('sha256').update(data).digest(); }
export function toHex(buf) { return Buffer.from(buf).toString('hex'); }
export function fromHex(str) { return Buffer.from(str, 'hex'); }
export function sign(msg, secretKey) { return nacl.sign.detached(msg, secretKey); }
export function verify(msg, sig, publicKey) { return nacl.sign.detached.verify(msg, sig, publicKey); }

export function ed25519SecretToX25519(ed25519Secret) {
  const seed = ed25519Secret.slice(0, 32);
  return nacl.box.keyPair.fromSecretKey(seed);
}
export function deriveSharedSecret(myX25519Secret, theirX25519Public) {
  return nacl.scalarMult(myX25519Secret, theirX25519Public);
}

export async function encryptPrivateKey(privateKey, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scryptAsync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: authTag.toString('base64'), encrypted: encrypted.toString('base64') };
}

export async function decryptPrivateKey(obj, password) {
  const { salt, iv, authTag, encrypted } = obj;
  // 修复：参数顺序应为 (password, salt, keylen)
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
}

// AES-GCM 加密 / 解密
export function aesEncrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') };
}
export function aesDecrypt(obj, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(obj.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(obj.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(obj.encrypted, 'base64')), decipher.final()]);
}