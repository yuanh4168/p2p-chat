import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const LOG_FILE = path.join(LOG_DIR, `app_${today}.log`); // 修正：使用反引号

// 日志级别定义
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// 控制台日志级别（默认 INFO，可通过环境变量 CONSOLE_LOG_LEVEL 调整）
const consoleLevel = (process.env.CONSOLE_LOG_LEVEL || 'info').toUpperCase();
const CONSOLE_MIN_LEVEL = LEVELS[consoleLevel] !== undefined ? LEVELS[consoleLevel] : LEVELS.INFO;

// 文件日志级别固定为 DEBUG（记录所有）
const FILE_MIN_LEVEL = LEVELS.DEBUG;

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
    // 写入文件（只要 level >= DEBUG）
    if (levelNum >= FILE_MIN_LEVEL) {
        fs.appendFileSync(LOG_FILE, logLine + '\n');
    }
    // 控制台输出（只输出 level >= CONSOLE_MIN_LEVEL）
    if (levelNum >= CONSOLE_MIN_LEVEL) {
        console.log(logLine);
    }
}

export function info(module, message, data) {
    writeLog('INFO', module, message, data);
}

export function error(module, message, data) {
    writeLog('ERROR', module, message, data);
}

export function warn(module, message, data) {
    writeLog('WARN', module, message, data);
}

export function debug(module, message, data) {
    writeLog('DEBUG', module, message, data);
}

// 全局异常捕获
export function setupGlobalErrorHandler() {
    process.on('uncaughtException', (err) => {
        error('GLOBAL', 'Uncaught Exception', { error: err.message, stack: err.stack });
        console.error('发生未捕获异常，请查看日志文件', err);
        // 不退出，让程序继续
    });
    process.on('unhandledRejection', (reason, promise) => {
        error('GLOBAL', 'Unhandled Rejection', { reason: reason?.message || reason, stack: reason?.stack });
        console.error('未处理的 Promise 拒绝，请查看日志文件', reason);
    });
}