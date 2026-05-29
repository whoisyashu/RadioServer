const fs = require('fs');
const { spawn } = require('child_process');

const { pathExists } = require('../utils/fs');
const { ensureFallbackTrack } = require('../utils/media');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RadioStreamer {
  constructor({ env, logger, queueManager, downloader, fallbackTrackFile }) {
    this.env = env;
    this.logger = logger;
    this.queueManager = queueManager;
    this.downloader = downloader;
    this.fallbackTrackFile = fallbackTrackFile;
    this.state = 'idle';
    this.running = false;
    this.sessionPromise = null;
    this.process = null;
    this.currentAbortController = null;
    this.currentTrack = null;
    this.preparedNextTrack = null;
    this.lastError = null;

    this.queueManager.on('track-added', () => {
      this.refreshPreparedNextTrack();

      if (!this.running) {
        void this.ensureSessionRunning().catch((error) => {
          this.logger.error('Playback session failed to start', error);
        });
        return;
      }

      if (this.currentTrack?.isFallback && this.currentAbortController) {
        this.state = 'switching';
        this.currentAbortController.abort();
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

    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }

    if (this.process) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        this.process.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.process = null;
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
    this.preparedNextTrack = queuedNext || this.createFallbackTrack();
  }

  status() {
    return {
      state: this.state,
      running: this.running,
      ffmpegPid: this.process?.pid || null,
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
          this.state = track.isFallback ? 'idle' : 'preparing';

          const outcome = await this.pipeTrackToFfmpeg(track, this.currentAbortController.signal);

          if (outcome === 'error') {
            this.state = 'error';
            this.queueManager.finishNowPlaying('error');
            if (!track.isFallback) {
              await this.handleTrackFailure(track);
            }
            this.currentAbortController = null;
            this.currentTrack = null;
            continue;
          }

          this.state = 'cleanup';
          this.queueManager.finishNowPlaying(outcome === 'aborted' ? 'skipped' : 'completed');

          if (!track.isFallback) {
            await this.downloader.pruneCache({
              keepIds: [this.currentTrack?.id, this.preparedNextTrack?.id].filter(Boolean),
              activeFilePaths: [track.filePath, this.preparedNextTrack?.filePath].filter(Boolean),
            });
          }

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
      // Ensure any lingering process is terminated
      if (this.process && !this.process.killed) {
        try { this.process.kill('SIGTERM'); } catch (e) {}
      }

      this.process = null;
      this.sessionPromise = null;
      this.currentAbortController = null;
      this.currentTrack = null;
      this.preparedNextTrack = null;
      this.state = 'idle';
    }
  }

  async pipeTrackToFfmpeg(track, signal) {
    const icecastUrl = this.buildIcecastUrl();
    this.logger.info('Spawning FFmpeg for track', { id: track.id, file: track.filePath, icecastUrl });

    return new Promise((resolve) => {
      let settled = false;
      const args = [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-re',
        '-i',
        track.filePath,
        '-vn',
        '-ar',
        String(this.env.streamSampleRate),
        '-ac',
        String(this.env.streamChannels),
        '-c:a',
        'libmp3lame',
        '-b:a',
        this.env.streamBitrate,
        '-content_type',
        'audio/mpeg',
        '-f',
        'mp3',
        icecastUrl,
      ];

      const ff = spawn(this.env.ffmpegBinary, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      ff.stderr.on('data', (chunk) => {
        this.logger.debug('FFmpeg', { stderr: chunk.toString('utf8').trim() });
      });

      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      const fail = (err) => {
        if (!settled) {
          settled = true;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.logger.error('FFmpeg track process failed', err);
          resolve('error');
        }
      };

      const onClose = (code, signal) => {
        if (code === 0) {
          finish('completed');
        } else if (!settled) {
          fail(new Error(`FFmpeg exited with code ${code}`));
        }
      };

      ff.once('close', onClose);

      if (signal) {
        signal.addEventListener('abort', () => {
          try { ff.kill('SIGTERM'); } catch (e) {}
          finish('aborted');
        }, { once: true });
      }
    }).catch((error) => {
      this.lastError = error.message;
      this.logger.error('Track spawn failed', error);
      return 'error';
    });
  }

  async restartProcess() {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }

    this.process = null;
  }

  async pickNextTrack() {
    const queuedTrack = this.queueManager.dequeueNext();

    if (queuedTrack) {
      if (!pathExists(queuedTrack.filePath)) {
        this.logger.warn('Queued track missing on disk and will be skipped', {
          id: queuedTrack.id,
          filePath: queuedTrack.filePath,
        });
        return this.createFallbackTrack();
      }

      return queuedTrack;
    }

    if (!pathExists(this.fallbackTrackFile)) {
      await ensureFallbackTrack({
        filePath: this.fallbackTrackFile,
        logger: this.logger,
        durationSeconds: this.env.fallbackTrackDurationSeconds,
        ffmpegBinary: this.env.ffmpegBinary,
      });
    }

    return this.createFallbackTrack();
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

  createFallbackTrack() {
    return {
      id: 'fallback',
      title: 'Fallback Audio',
      filePath: this.fallbackTrackFile,
      duration: this.env.fallbackTrackDurationSeconds,
      isFallback: true,
      source: 'local-fallback',
      status: 'idle',
    };
  }

  buildIcecastUrl() {
    const { host, port, mount, sourceUser, sourcePassword } = this.env.icecast;
    const encodedPassword = encodeURIComponent(sourcePassword);
    return `icecast://${sourceUser}:${encodedPassword}@${host}:${port}${mount}`;
  }
}

module.exports = { RadioStreamer };