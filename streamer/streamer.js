const { pathExists } = require('../utils/fs');
const { StreamEngine } = require('./streamEngine');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RadioStreamer {
  constructor({ env, logger, queueManager, downloader }) {
    this.env = env;
    this.logger = logger;
    this.queueManager = queueManager;
    this.downloader = downloader;
    this.state = 'idle';
    this.running = false;
    this.sessionPromise = null;
    this.currentAbortController = null;
    this.currentTrack = null;
    this.preparedNextTrack = null;
    this.lastError = null;
    this.engine = new StreamEngine({ env, logger });

    this.queueManager.on('track-added', () => {
      this.refreshPreparedNextTrack();
      if (!this.running) {
        void this.ensureSessionRunning().catch((error) => {
          this.logger.error('Playback session failed to start', error);
        });
      }
    });

    this.queueManager.on('queue-changed', () => {
      this.refreshPreparedNextTrack();
    });
  }

  async ensureSessionRunning() {
    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    this.running = true;
    this.sessionPromise = this.runSession();
    return this.sessionPromise;
  }

  async stop() {
    this.running = false;

    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    try {
      await this.engine.stop();
    } catch (error) {
      this.logger.warn('Error stopping stream engine', error && error.message ? error.message : error);
    }

    this.sessionPromise = null;
    this.currentAbortController = null;
    this.currentTrack = null;
    this.preparedNextTrack = null;
    this.state = 'idle';
  }

  requestSkip() {
    this.state = 'switching';
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

  refreshPreparedNextTrack() {
    const queuedNext = this.queueManager.peekNext();
    this.preparedNextTrack = queuedNext || null;
  }

  status() {
    const engineStatus = this.engine.status ? this.engine.status() : {};
    return {
      state: this.state,
      running: this.running,
      ffmpegPid: engineStatus.ffmpegPid || null,
      currentTrack: this.currentTrack ? { ...this.currentTrack } : null,
      preparedNextTrack: this.preparedNextTrack ? { ...this.preparedNextTrack } : null,
      queueLength: this.queueManager.size(),
      lastError: this.lastError,
    };
  }

  getListenerUrl() {
    return this.env.publicStreamUrl || `http://${this.env.icecast.host}:${this.env.icecast.port}${this.env.icecast.mount}`;
  }

  async runSession() {
    try {
      this.engine.start();

      while (this.running) {
        try {
          const track = await this.pickNextTrack();
          this.refreshPreparedNextTrack();

          if (!track) {
            this.state = 'idle';
            await delay(250);
            continue;
          }

          this.currentTrack = this.queueManager.setNowPlaying(track);
          this.currentAbortController = new AbortController();
          this.state = 'preparing';

          const outcome = await this.pipeTrackToFfmpeg(track, this.currentAbortController.signal);

          if (outcome === 'error') {
            this.state = 'error';
            this.queueManager.finishNowPlaying('error');
            await this.handleTrackFailure(track);
            this.currentAbortController = null;
            this.currentTrack = null;
            continue;
          }

          this.state = 'cleanup';
          this.queueManager.finishNowPlaying(outcome === 'aborted' ? 'skipped' : 'completed');

          await this.cleanupPlayedTrack(track);

          await this.downloader.pruneCache({
            keepIds: [this.currentTrack?.id, this.preparedNextTrack?.id].filter(Boolean),
            activeFilePaths: [track.filePath, this.preparedNextTrack?.filePath].filter(Boolean),
          });

          this.currentAbortController = null;
          this.currentTrack = null;
          this.state = this.queueManager.size() > 0 ? 'switching' : 'idle';
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.logger.error('Playback session error', error);
          this.state = 'error';
          await this.restartProcess();
          await delay(1000);
        }
      }
    } finally {
      try {
        await this.engine.stop();
      } catch (error) {
        this.logger.warn('Error during engine shutdown', error && error.message ? error.message : error);
      }

      this.sessionPromise = null;
      this.currentAbortController = null;
      this.currentTrack = null;
      this.preparedNextTrack = null;
      this.state = 'idle';
    }
  }

  async pipeTrackToFfmpeg(track, signal) {
    try {
      await this.engine.feedTrack(track, { signal });
      return signal?.aborted ? 'aborted' : 'completed';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error('Engine feed failed', error);
      return 'error';
    }
  }

  async restartProcess() {
    try {
      await this.engine.stop();
    } catch (error) {
      this.logger.warn('Error stopping stream engine during restart', error && error.message ? error.message : error);
    }

    this.engine.start();
  }

  async pickNextTrack() {
    const queuedTrack = this.queueManager.dequeueNext();

    if (queuedTrack) {
      if (!pathExists(queuedTrack.filePath)) {
        this.logger.warn('Queued track missing on disk and will be skipped', {
          id: queuedTrack.id,
          filePath: queuedTrack.filePath,
        });
        return null;
      }

      return queuedTrack;
    }

    return null;
  }

  async handleTrackFailure(track) {
    this.logger.warn('Removing corrupt or unusable track from cache', { id: track.id, filePath: track.filePath });
    this.downloader.deleteCachedTrack(track.id, track.filePath);
    await this.downloader.saveCache();
    await this.downloader.pruneCache({
      keepIds: [this.preparedNextTrack?.id].filter(Boolean),
      activeFilePaths: [this.preparedNextTrack?.filePath].filter(Boolean),
    });
  }

  async cleanupPlayedTrack(track) {
    if (!track) {
      return;
    }

    if (String(track.id || '').toLowerCase() === 'promotion' || track.isPromotion) {
      return;
    }

    const promotionFilePath = String(this.env.promotionTrackFile || '').trim();
    if (promotionFilePath && track.filePath && pathExists(promotionFilePath) && track.filePath === promotionFilePath) {
      return;
    }

    this.logger.info('Deleting played track file', { id: track.id, filePath: track.filePath });
    this.downloader.deleteCachedTrack(track.id, track.filePath);
    await this.downloader.saveCache();
  }
}

module.exports = { RadioStreamer };
