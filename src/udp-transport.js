import dgram from 'dgram';
import { EventEmitter } from 'events';
import { createCipheriv, createDecipheriv } from 'crypto';
import { deriveSharedSecret } from './crypto.js';
import { UDP_MTU, HANDSHAKE_TIMEOUT, UDP_PORTS } from './config.js';
import { debug, error, info, warn } from './logger.js';

export class UDPTransport extends EventEmitter {
  constructor(localEd25519KeyPair, localX25519KeyPair) {
    super();
    this.localEd25519 = localEd25519KeyPair;
    this.localX25519 = localX25519KeyPair;
    this.socket = dgram.createSocket('udp4');
    this.port = 0;
    this.sessions = new Map();          // key: "ip:port" -> session
    this.peerAddresses = new Map();     // pubkey -> {ip, port}
    this.pendingHandshakes = new Map(); // key: "ip:port" -> { timeout, startTime }
    this._bind();
    this._startCleanupTimer();
    // 心跳定时器：每 30 秒发送 PING 保持活跃
    this._heartbeatInterval = setInterval(() => {
      for (const [key, session] of this.sessions) {
        if (session.established) {
          const [ip, port] = key.split(':');
          this.sendTo(ip, parseInt(port), Buffer.from(JSON.stringify({ type: 'PING' })));
        }
      }
    }, 30000);
    debug('UDPTransport', 'Transport created');
  }

  _bind() {
    this.socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    this.socket.on('listening', () => {
      this.port = this.socket.address().port;
      info('UDPTransport', 'Socket listening', { port: this.port });
      this.emit('listening', this.port);
    });
  }

  listen(portList = UDP_PORTS) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(portList)) portList = [portList];
      let index = 0;
      const tryBind = () => {
        if (index >= portList.length) {
          reject(new Error('All ports failed to bind'));
          return;
        }
        const port = portList[index++];
        info('UDPTransport', 'Attempting to bind', { port });
        const onError = (err) => {
          if (err.code === 'EADDRINUSE') {
            warn('UDPTransport', 'Port busy, trying next', { port });
            tryBind();
          } else {
            reject(err);
          }
        };
        this.socket.once('error', onError);
        this.socket.bind(port, () => {
          this.socket.removeListener('error', onError);
          this.port = this.socket.address().port;
          info('UDPTransport', 'Bound successfully', { port: this.port });
          resolve(this.port);
        });
      };
      tryBind();
    });
  }

  sendTo(ip, port, plaintext) {
    const key = `${ip}:${port}`;
    const session = this.sessions.get(key);
    if (!session || !session.established) {
      debug('UDPTransport', 'No established session, starting handshake', { ip, port });
      this._startHandshake(ip, port);
      return false;
    }
    try {
      const nonce = Buffer.alloc(12);
      nonce.writeUInt32BE(session.outNonce++, 0);
      const cipher = createCipheriv('aes-256-gcm', session.sharedKey, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const packet = Buffer.concat([nonce, encrypted, authTag]);
      if (packet.length > UDP_MTU) {
        warn('UDPTransport', 'Packet too large, not sending', { length: packet.length, mtu: UDP_MTU });
        return false;
      }
      this.socket.send(packet, port, ip);
      session.lastSeen = Date.now();
      debug('UDPTransport', 'Sent encrypted data', { ip, port, size: packet.length });
      return true;
    } catch (e) {
      error('UDPTransport', 'Encryption/send error', { error: e.message, ip, port });
      return false;
    }
  }

  _startHandshake(ip, port) {
    const key = `${ip}:${port}`;
    if (this.sessions.has(key) && this.sessions.get(key).established) return;
    if (this.pendingHandshakes.has(key)) return;
    info('UDPTransport', 'Starting handshake', { ip, port });
    const startTime = Date.now();
    const timeout = setTimeout(() => {
      this.pendingHandshakes.delete(key);
      this.emit('handshake-timeout', { ip, port });
    }, HANDSHAKE_TIMEOUT);
    this.pendingHandshakes.set(key, { timeout, startTime });
    const handshakeMsg = Buffer.concat([Buffer.from([0x01]), this.localX25519.publicKey]);
    this.socket.send(handshakeMsg, port, ip);
    debug('UDPTransport', 'Sent handshake packet', { ip, port });
  }

  _onMessage(buf, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    debug('UDPTransport', 'Received packet', { from: key, size: buf.length });

    // 握手包
    if (buf.length === 33 && buf[0] === 0x01) {
      const peerPublicKey = buf.slice(1);
      const existing = this.sessions.get(key);
      if (existing && existing.established) return;

      try {
        const shared = deriveSharedSecret(this.localX25519.secretKey, peerPublicKey);
        const session = {
          pubkey: null,
          x25519Public: peerPublicKey,
          sharedKey: shared,
          outNonce: 0,
          inNonce: 0,
          lastSeen: Date.now(),
          established: true
        };
        this.sessions.set(key, session);
        // 计算延迟（若为主动发起方）
        let delay = undefined;
        const pending = this.pendingHandshakes.get(key);
        if (pending) {
          delay = Date.now() - pending.startTime;
          clearTimeout(pending.timeout);
          this.pendingHandshakes.delete(key);
        }
        const reply = Buffer.concat([Buffer.from([0x01]), this.localX25519.publicKey]);
        this.socket.send(reply, rinfo.port, rinfo.address);
        info('UDPTransport', 'Handshake complete (incoming)', { ip: rinfo.address, port: rinfo.port, delay });
        this.emit('handshake-complete', { ip: rinfo.address, port: rinfo.port, session, delay });
      } catch (e) {
        error('UDPTransport', 'Handshake processing error', { error: e.message, from: key });
      }
      return;
    }

    // 数据包
    const session = this.sessions.get(key);
    if (!session || !session.established) {
      debug('UDPTransport', 'No session, starting handshake', { key });
      this._startHandshake(rinfo.address, rinfo.port);
      return;
    }

    try {
      if (buf.length < 28) {
        warn('UDPTransport', 'Packet too short', { key, len: buf.length });
        return;
      }
      const nonce = buf.slice(0, 12);
      const ciphertext = buf.slice(12, buf.length - 16);
      const authTag = buf.slice(buf.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', session.sharedKey, nonce);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const nonceNum = nonce.readUInt32BE(0);
      if (nonceNum < session.inNonce) {
        debug('UDPTransport', 'Replayed packet ignored', { key, nonce: nonceNum, expected: session.inNonce });
        return;
      }
      session.inNonce = nonceNum + 1;
      session.lastSeen = Date.now();

      let msg;
      try { msg = JSON.parse(plaintext.toString()); } catch (e) {
        warn('UDPTransport', 'Invalid JSON in plaintext', { from: key, text: plaintext.toString() });
        return;
      }
      if (msg.type === 'PING') {
        debug('UDPTransport', 'Received PING, keepalive', { from: key });
        return;
      }
      if (msg.pubkey) {
        session.pubkey = msg.pubkey;
        this.peerAddresses.set(msg.pubkey, { ip: rinfo.address, port: rinfo.port });
        debug('UDPTransport', 'Set peer pubkey', { pubkey: msg.pubkey.slice(0,8), from: key });
        if (msg.nickname || msg.color) {
          this.emit('profile-update', { pubkey: msg.pubkey, nickname: msg.nickname, color: msg.color });
        }
      }
      debug('UDPTransport', 'Received app message', { from: key, type: msg.type });
      this.emit('message', { ip: rinfo.address, port: rinfo.port, msg, session });
    } catch (e) {
      error('UDPTransport', 'Decryption/processing error', { error: e.message, from: key });
    }
  }

  sendJSON(peerId, json) {
    const data = JSON.stringify(json);
    if (Buffer.byteLength(data) > UDP_MTU - 32) {
      warn('UDPTransport', 'JSON message too large', { size: Buffer.byteLength(data) });
      return false;
    }
    let address;
    if (peerId.includes(':')) {
      const [ip, port] = peerId.split(':');
      address = { ip, port: parseInt(port) };
    } else {
      const addr = this.peerAddresses.get(peerId);
      if (!addr) {
        debug('UDPTransport', 'No address known for peer', { peerId });
        return false;
      }
      address = addr;
    }
    return this.sendTo(address.ip, address.port, Buffer.from(data));
  }

  broadcast(json, excludePubkey = null) {
    for (const [key, session] of this.sessions) {
      if (!session.established) continue;
      if (session.pubkey === excludePubkey) continue;
      const [ip, port] = key.split(':');
      this.sendTo(ip, parseInt(port), Buffer.from(JSON.stringify(json)));
    }
  }

  // ---------- 会话清理 ----------
  _startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      const timeout = 120000;
      for (const [key, session] of this.sessions) {
        if (now - session.lastSeen > timeout) {
          info('UDPTransport', 'Removing inactive session', { key });
          const pubkey = session.pubkey;
          this.sessions.delete(key);
          if (pubkey) {
            this.peerAddresses.delete(pubkey);
            this.emit('session-removed', { pubkey, ip: key.split(':')[0], port: parseInt(key.split(':')[1]) });
          }
        }
      }
    }, 30000);
  }

  destroy() {
    clearInterval(this._heartbeatInterval);
    this.socket.close();
  }
}