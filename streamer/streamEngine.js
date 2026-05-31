const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { bus } = require('../events/events');

class StreamEngine {
  constructor({ env, logger }) {
    this.env = env;
    this.logger = logger;
    this.icecastUrl = null;
    this.main = null; // main ffmpeg process
    this.mainStdin = null;
    this.running = false;
    this.pending = false;
    this.transientProcs = new Set();
  }

  buildIcecastUrl() {
    const { host, port, mount, sourceUser, sourcePassword } = this.env.icecast;
    const encodedPassword = encodeURIComponent(sourcePassword);
    return `icecast://${sourceUser}:${encodedPassword}@${host}:${port}${mount}`;
  }

  start() {
    if (this.running) return;
    this.icecastUrl = this.buildIcecastUrl();
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-re',
      '-f', 'mp3',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'copy',
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      this.icecastUrl,
    ];

    try {
      this.main = spawn(this.env.ffmpegBinary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      this.mainStdin = this.main.stdin;
      this.running = true;

      this.main.stderr.on('data', (d) => this.logger.debug('StreamEngine ffmpeg', { stderr: d.toString('utf8').trim() }));

      this.main.once('close', (code) => {
        this.logger.warn('Persistent ffmpeg exited', { code });
        this.running = false;
        this.main = null;
        this.mainStdin = null;
        // notify listeners so streamer can restart if needed
        bus.emit('engine-stopped', { code });
      });
    } catch (err) {
      this.logger.error('Failed to spawn persistent ffmpeg', err);
      this.running = false;
    }
  }

  async stop() {
    // stop transient procs first
    for (const p of Array.from(this.transientProcs)) {
      try { p.kill('SIGTERM'); } catch (e) {}
    }
    this.transientProcs.clear();

    if (this.main) {
      try { this.main.kill('SIGTERM'); } catch (e) {}
    }
    this.main = null;
    this.mainStdin = null;
    this.running = false;
  }

  // Feed a track into the persistent engine. Returns when the track finishes streaming.
  async feedTrack(track, { signal } = {}) {
    if (!track || !track.filePath) throw new Error('Invalid track');
    if (!this.running) this.start();
    if (!this.mainStdin) throw new Error('Engine not ready');

    bus.emit('track-start', { id: track.id, title: track.title });

    const ext = path.extname(track.filePath || '').toLowerCase();
    if (ext === '.mp3') {
      await this._pipeFileToMain(track.filePath, signal);
    } else {
      // spawn transient ffmpeg to transcode to mp3 and pipe its stdout
      await this._transcodeAndPipe(track.filePath, signal);
    }

    bus.emit('track-end', { id: track.id, title: track.title });
  }

  _pipeFileToMain(filePath, signal) {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      const onError = (err) => {
        rs.destroy();
        reject(err);
      };

      if (signal) {
        signal.addEventListener('abort', () => {
          try { rs.destroy(); } catch (e) {}
          resolve('aborted');
        }, { once: true });
      }

      rs.on('error', onError);
      rs.on('end', () => resolve());

      // Pipe into main stdin. Do not close stdin after each track; ffmpeg expects continuous stream.
      rs.pipe(this.mainStdin, { end: false });
    });
  }

  _transcodeAndPipe(filePath, signal) {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-i', filePath,
        '-f', 'mp3',
        '-vn',
        '-ar', String(this.env.streamSampleRate),
        '-ac', String(this.env.streamChannels),
        '-b:a', this.env.streamBitrate,
        '-'
      ];

      const p = spawn(this.env.ffmpegBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.transientProcs.add(p);

      p.stderr.on('data', (d) => this.logger.debug('transcode ffmpeg', { stderr: d.toString('utf8').trim() }));

      p.stdout.on('error', (err) => {
        this.transientProcs.delete(p);
        reject(err);
      });

      p.stdout.on('end', () => {
        this.transientProcs.delete(p);
        resolve();
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          try { p.kill('SIGTERM'); } catch (e) {}
          this.transientProcs.delete(p);
          resolve('aborted');
        }, { once: true });
      }

      // pipe into main stdin
      p.stdout.pipe(this.mainStdin, { end: false });
    });
  }
}

module.exports = { StreamEngine };
