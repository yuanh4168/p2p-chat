import { exec } from 'child_process';
import { promisify } from 'util';
import { getGroup, getTopic } from './db.js';

const execAsync = promisify(exec);

export function shortPub(pubkey) {
  return pubkey ? pubkey.slice(0, 8) : '????';
}

export function getGroupName(groupId) {
  const g = getGroup(groupId);
  return g ? g.name : 'null';
}

export function getTopicName(topicId) {
  const t = getTopic(topicId);
  return t ? t.name : 'null';
}

export function getTimeStr() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

export function randomColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return `${r},${g},${b}`;
}

export async function getTailscaleIPs() {
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