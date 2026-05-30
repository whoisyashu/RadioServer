const express = require('express');
const helmet = require('helmet');
const { authMiddleware } = require('../middleware/auth');

function createApp({ env, logger, downloader, queueManager, streamer }) {
  const app = express();

  function extractRequester(body = {}) {
    const requesterId = body.requesterId || body.userId || body.user?.id || null;
    const requesterName = body.requesterName || body.userName || body.user?.name || body.user?.displayName || null;
    const requesterDisplayName = body.requesterDisplayName || body.userDisplayName || body.user?.displayName || requesterName || null;

    return {
      requesterId,
      requesterName,
      requesterDisplayName,
      requestedBy: requesterDisplayName || requesterName || requesterId || 'system',
    };
  }

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.http('API request', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      status: 'up',
      apiPort: env.apiPort,
      queueLength: queueManager.size(),
      radio: streamer.status(),
      streamer: streamer.status(),
      icecast: {
        host: env.icecast.host,
        port: env.icecast.port,
        mount: env.icecast.mount,
        streamUrl: streamer.getListenerUrl(),
      },
    });
  });

  app.use('/play', authMiddleware(env));
  app.use('/promote', authMiddleware(env));
  app.use('/skip', authMiddleware(env));
  app.use('/queue', authMiddleware(env));
  app.use('/now-playing', authMiddleware(env));

  app.post('/play', async (req, res, next) => {
    try {
      const body = req.body || {};
      const input = body.url || body.query || body.input;

      if (!input) {
        return res.status(400).json({ ok: false, error: 'Provide a query or url' });
      }

      const track = await downloader.resolveAndDownload(input);
      const requester = extractRequester(body);
      const queued = queueManager.enqueue({
        ...track,
        ...requester,
      });
      void streamer.ensureSessionRunning().catch((error) => {
        logger.error('Failed to start playback session', error);
      });

      return res.status(201).json({
        ok: true,
        track: queued,
        queueLength: queueManager.size(),
        radio: streamer.status(),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/promote', async (_req, res, next) => {
    try {
      const promoTrack = {
        id: 'promotion',
        title: 'Room Promotion',
        filePath: env.promotionTrackFile,
        source: 'local-promotion',
        duration: null,
        isPromotion: true,
        requesterId: 'system',
        requesterName: 'system',
        requesterDisplayName: 'system',
        requestedBy: 'system',
      };

      const queued = queueManager.enqueueFront(promoTrack);
      void streamer.ensureSessionRunning().catch((error) => {
        logger.error('Failed to start playback session', error);
      });
      streamer.requestSkip();

      return res.status(201).json({
        ok: true,
        track: queued,
        queueLength: queueManager.size(),
        radio: streamer.status(),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/skip', async (req, res, next) => {
    try {
      const count = Math.max(1, Number(req.body?.count || 1));
      const removedUpcoming = queueManager.discardUpcoming(Math.max(0, count - 1));
      streamer.requestSkip();

      return res.json({
        ok: true,
        skippedCurrent: true,
        removedUpcoming,
        queueLength: queueManager.size(),
        radio: streamer.status(),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/queue', (_req, res) => {
    res.json({
      ok: true,
      nowPlaying: queueManager.getNowPlaying(),
      radio: streamer.status(),
      preparedNext: streamer.status().preparedNextTrack,
      queue: queueManager.getQueue(),
      queueLength: queueManager.size(),
      lastFinished: queueManager.getLastFinished(),
    });
  });

  app.get('/now-playing', (_req, res) => {
    const radio = streamer.status();

    res.json({
      ok: true,
      nowPlaying: queueManager.getNowPlaying(),
      preparedNext: radio.preparedNextTrack,
      radio,
      lastFinished: queueManager.getLastFinished(),
    });
  });

  app.use((error, _req, res, _next) => {
    logger.error('Unhandled API error', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error',
    });
  });

  return app;
}

module.exports = { createApp };