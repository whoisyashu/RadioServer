const path = require('path');

const { env } = require('./config/env');
const { createLogger } = require('./utils/logger');
const { ensureDirectory } = require('./utils/fs');
const { ensurePromoTrack } = require('./utils/media');
const { Downloader } = require('./downloader/downloader');
const { QueueManager } = require('./queue/queueManager');
const { RadioStreamer } = require('./streamer/streamer');
const { createApp } = require('./api/createApp');
const { bus } = require('./events/events');
const { getSystemPressure } = require('./utils/resources');

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

  await ensurePromoTrack({
    filePath: env.promotionTrackFile,
    logger,
    durationSeconds: env.promoTrackDurationSeconds,
    ffmpegBinary: env.ffmpegBinary,
  });

  const downloader = new Downloader({ env, logger });
  await downloader.loadCache();

  const queueManager = new QueueManager({ logger, maxQueueSize: env.queue.maxQueueSize });
  const streamer = new RadioStreamer({
    env,
    logger,
    queueManager,
    downloader,
  });

  const cleanupTimer = setInterval(() => {
    void downloader.pruneCache({
      keepIds: [queueManager.getNowPlaying()?.id, queueManager.peekNext()?.id].filter(Boolean),
      activeFilePaths: [queueManager.getNowPlaying()?.filePath, queueManager.peekNext()?.filePath].filter(Boolean),
    }).catch((error) => {
      logger.warn('Periodic cache cleanup failed', error && error.message ? error.message : error);
    });
  }, 30 * 60 * 1000);
  cleanupTimer.unref();

  const metricsTimer = setInterval(() => {
    const pressure = getSystemPressure();
    logger.debug('Resource snapshot', {
      cpuLoadPercent: Number(pressure.cpuLoadPercent.toFixed(1)),
      memoryPercent: Number(pressure.memoryPercent.toFixed(1)),
      processMemoryRssMb: pressure.processMemoryRssMb,
      queueLength: queueManager.size(),
      streamerState: streamer.status().state,
    });
  }, 60 * 1000);
  metricsTimer.unref();

  bus.on('error', (payload) => {
    logger.warn('Internal bus error event', payload);
  });

  bus.on('cleanup', (payload) => {
    logger.debug('Cleanup event', payload);
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
    clearInterval(cleanupTimer);
    clearInterval(metricsTimer);
    await streamer.stop();
    await downloader.saveCache();
    await new Promise((resolve) => {
      server.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });
    // best-effort: kill lingering ffmpeg/yt-dlp on Linux to avoid orphans
    try {
      if (process.platform === 'linux') {
        const { spawnSync } = require('child_process');
        try { spawnSync('pkill', ['-f', 'yt-dlp']); } catch (e) {}
        try { spawnSync('pkill', ['-f', 'ffmpeg']); } catch (e) {}
      }
    } catch (e) {
      logger.warn('Failed to pkill lingering processes', e && e.message ? e.message : e);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});