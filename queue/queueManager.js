const { EventEmitter } = require('events');

class QueueManager extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.queue = [];
    this.nowPlaying = null;
    this.lastFinished = null;
  }

  enqueue(track) {
    const queuedTrack = {
      ...track,
      queuedAt: new Date().toISOString(),
      status: 'queued',
    };

    this.queue.push(queuedTrack);
    this.emit('track-added', queuedTrack);
    this.emit('queue-changed');
    this.logger.info('Queued track', { id: queuedTrack.id, title: queuedTrack.title });

    return queuedTrack;
  }

  enqueueFront(track) {
    const queuedTrack = {
      ...track,
      queuedAt: new Date().toISOString(),
      status: 'queued',
      isPriority: true,
    };

    this.queue.unshift(queuedTrack);
    this.emit('track-added', queuedTrack);
    this.emit('queue-changed');
    this.logger.info('Queued priority track', { id: queuedTrack.id, title: queuedTrack.title });

    return queuedTrack;
  }

  dequeueNext() {
    const next = this.queue.shift() || null;

    if (next) {
      this.emit('queue-changed');
    }

    return next;
  }

  peekNext() {
    return this.queue.length > 0 ? { ...this.queue[0] } : null;
  }

  getUpcoming(limit = 1) {
    return this.queue.slice(0, limit).map((track) => ({ ...track }));
  }

  discardUpcoming(count) {
    const removed = [];

    for (let index = 0; index < count; index += 1) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      removed.push(next);
    }

    if (removed.length > 0) {
      this.emit('queue-changed');
    }

    return removed;
  }

  setNowPlaying(track) {
    this.nowPlaying = {
      ...track,
      startedAt: new Date().toISOString(),
      status: track.isFallback || track.isSilence ? 'idle' : 'playing',
    };
    this.emit('now-playing', this.nowPlaying);
    return this.nowPlaying;
  }

  finishNowPlaying(status = 'completed') {
    if (!this.nowPlaying) {
      return null;
    }

    this.lastFinished = {
      ...this.nowPlaying,
      finishedAt: new Date().toISOString(),
      status,
    };
    this.nowPlaying = null;
    this.emit('now-playing', this.nowPlaying);
    return this.lastFinished;
  }

  getQueue() {
    return this.queue.map((track) => ({ ...track }));
  }

  getNowPlaying() {
    return this.nowPlaying ? { ...this.nowPlaying } : null;
  }

  getLastFinished() {
    return this.lastFinished ? { ...this.lastFinished } : null;
  }

  size() {
    return this.queue.length;
  }
}

module.exports = { QueueManager };