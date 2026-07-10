export const BOOTSTRAP_NODES = [
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
  'dht.aelitis.com:6881'
];
// 增大到 65000，支持更大文件（理论最大 65507，留一些余量）
export const UDP_MTU = 65000;
export const HANDSHAKE_TIMEOUT = 5000;
export const SYNC_INTERVAL = 60000;
export const UDP_PORTS = [6881, 6882, 6883, 6884];