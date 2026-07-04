export const BOOTSTRAP_NODES = [
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
  'dht.aelitis.com:6881'
];
export const UDP_MTU = 1400;          // 最大安全 UDP 包
export const HANDSHAKE_TIMEOUT = 5000; // 握手超时(ms)
export const SYNC_INTERVAL = 60000;    // 同步间隔(ms)
export const UDP_PORTS = [6881, 6882, 6883, 6884]; // 新增：尝试绑定的端口列表