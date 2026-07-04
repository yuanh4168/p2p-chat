import DHT from 'bittorrent-dht';
import { BOOTSTRAP_NODES } from './config.js';

export class DHTNode {
  constructor() {
    this.dht = new DHT({ bootstrap: BOOTSTRAP_NODES, concurrency: 16 });
    this.port = 0;
    this.ready = false;
  }

  // 监听并等待 ready
  listen(port = 0) {
    return new Promise((res, rej) => {
      this.dht.listen(port, () => {
        this.port = this.dht.address().port;
        // 若已经 ready，直接返回；否则等待 ready 事件
        if (this.dht.ready) {
          this.ready = true;
          res(this.port);
        } else {
          this.dht.once('ready', () => {
            this.ready = true;
            res(this.port);
          });
        }
      });
      this.dht.on('error', rej);
    });
  }

  // 显式等待 ready（用于确保后续操作）
  waitReady() {
    if (this.ready) return Promise.resolve();
    return new Promise((res) => {
      if (this.dht.ready) {
        this.ready = true;
        res();
      } else {
        this.dht.once('ready', () => {
          this.ready = true;
          res();
        });
      }
    });
  }

  announce(infoHash, port = this.port) {
    return new Promise((res, rej) => {
      this.dht.announce(infoHash, port, (err) => {
        err ? rej(err) : res();
      });
    });
  }

  lookup(infoHash) {
    return new Promise((resolve) => {
      const peers = [];
      const onPeer = (p, ih) => {
        if (ih.equals(infoHash)) peers.push(p);
      };
      this.dht.on('peer', onPeer);
      this.dht.lookup(infoHash);
      setTimeout(() => {
        this.dht.removeListener('peer', onPeer);
        resolve(peers);
      }, 5000);
    });
  }

  destroy() {
    this.dht.destroy();
  }
}