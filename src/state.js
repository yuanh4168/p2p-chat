export const state = {
  keyPair: null,
  x25519KeyPair: null,
  masterKey: null,
  myPubkey: '',
  transport: null,
  dht: null,
  currentGroupId: null,
  currentTopicId: null,
  groupKeys: new Map(),
  myNickname: '',
  peerStatus: new Map() // pubkey -> { groupId, topicId }
};