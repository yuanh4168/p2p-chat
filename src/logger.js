import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const LOG_FILE = path.join(LOG_DIR, `app_${today}.log`);

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
// 控制台只输出 ERROR 级别（其他级别仅写入文件）
const CONSOLE_MIN_LEVEL = LEVELS.ERROR;
const FILE_MIN_LEVEL = LEVELS.DEBUG;

const LEVEL_COLORS = {
  DEBUG: chalk.gray,
  INFO: chalk.cyan,
  WARN: chalk.yellow,
  ERROR: chalk.red
};

function writeLog(level, module, message, data) {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${level}] [${module}] ${message}`;
  if (data !== undefined && data !== null) {
    try {
      logLine += ' ' + JSON.stringify(data);
    } catch {
      logLine += ' [unserializable data]';
    }
  }
  const levelNum = LEVELS[level];
  // 始终写入文件
  if (levelNum >= FILE_MIN_LEVEL) {
    fs.appendFileSync(LOG_FILE, logLine + '\n');
  }
  // 控制台仅当级别 >= ERROR 时输出
  if (levelNum >= CONSOLE_MIN_LEVEL) {
    const colorFn = LEVEL_COLORS[level] || chalk.white;
    console.log(colorFn(logLine));
  }
}

export function info(module, message, data) { writeLog('INFO', module, message, data); }
export function error(module, message, data) { writeLog('ERROR', module, message, data); }
export function warn(module, message, data) { writeLog('WARN', module, message, data); }
export function debug(module, message, data) { writeLog('DEBUG', module, message, data); }

export function setupGlobalErrorHandler() {
  process.on('uncaughtException', (err) => {
    error('GLOBAL', 'Uncaught Exception', { error: err.message, stack: err.stack });
    console.error(chalk.red('发生未捕获异常，请查看日志文件'), err);
  });
  process.on('unhandledRejection', (reason, promise) => {
    error('GLOBAL', 'Unhandled Rejection', { reason: reason?.message || reason, stack: reason?.stack });
    console.error(chalk.red('未处理的 Promise 拒绝，请查看日志文件'), reason);
  });
}