const path = require('path');

const { env } = require('./config/env');
const { createLogger } = require('./utils/logger');
const { ensureDirectory } = require('./utils/fs');
const { ensureFallbackTrack } = require('./utils/media');
const { Downloader } = require('./downloader/downloader');
const { QueueManager } = require('./queue/queueManager');
const { RadioStreamer } = require('./streamer/streamer');
const { createApp } = require('./api/createApp');

async function main() {
  ensureDirectory(env.songsDir);
  ensureDirectory(env.logsDir);
  ensureDirectory(env.configDir);

  const logger = createLogger({
    logFilePath: path.join(env.logsDir, 'radio-server.log'),
    level: env.logLevel,
  });

  logger.info('Starting radio server', {
    apiPort: env.apiPort,
    icecast: `${env.icecast.host}:${env.icecast.port}${env.icecast.mount}`,
  });

  await ensureFallbackTrack({
    filePath: env.fallbackTrackFile,
    logger,
    durationSeconds: env.fallbackTrackDurationSeconds,
    ffmpegBinary: env.ffmpegBinary,
  });

  const downloader = new Downloader({ env, logger });
  await downloader.loadCache();

  const queueManager = new QueueManager({ logger });
  const streamer = new RadioStreamer({
    env,
    logger,
    queueManager,
    downloader,
    fallbackTrackFile: env.fallbackTrackFile,
  });

  queueManager.on('queue-changed', () => {
    logger.debug('Queue changed', { queueLength: queueManager.size() });
  });

  const app = createApp({
    env,
    logger,
    downloader,
    queueManager,
    streamer,
  });

  const server = app.listen(env.apiPort, env.apiHost, () => {
    logger.info('HTTP API listening', { host: env.apiHost, port: env.apiPort });
  });

  const shutdown = async (signal) => {
    logger.info('Shutting down', { signal });
    await streamer.stop();
    await downloader.saveCache();
    server.close(() => logger.info('HTTP server closed'));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});