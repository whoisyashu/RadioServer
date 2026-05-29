const fs = require('fs');
const path = require('path');

function serializeMeta(meta) {
  if (!meta) {
    return '';
  }

  if (meta instanceof Error) {
    return JSON.stringify({ message: meta.message, stack: meta.stack });
  }

  return JSON.stringify(meta);
}

function createLogger({ logFilePath, level = 'info' }) {
  const stream = fs.createWriteStream(logFilePath, { flags: 'a' });
  const levels = new Map([
    ['error', 0],
    ['warn', 1],
    ['info', 2],
    ['debug', 3],
  ]);
  const threshold = levels.get(level) ?? 2;

  const write = (severity, message, meta) => {
    if ((levels.get(severity) ?? 2) > threshold) {
      return;
    }

    const line = `${new Date().toISOString()} [${severity.toUpperCase()}] ${message}${meta ? ` ${serializeMeta(meta)}` : ''}`;
    console.log(line);
    stream.write(`${line}\n`);
  };

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    http: (message, meta) => write('info', message, meta),
    child: () => createLogger({ logFilePath, level }),
    close: () => stream.end(),
    logFilePath: path.resolve(logFilePath),
  };
}

module.exports = { createLogger };