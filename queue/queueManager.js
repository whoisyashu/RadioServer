const { EventEmitter } = require('events');
const { bus } = require('../events/events');

class QueueManager extends EventEmitter {
  constructor({ logger, maxQueueSize = 20 }) {
    super();
    this.logger = logger;
    this.maxQueueSize = maxQueueSize;
    this.queue = [];
    this.nowPlaying = null;
    this.lastFinished = null;
  }

  canAcceptMore() {
    return this.queue.length < this.maxQueueSize;
  }

  _assertCapacity(track) {
    const isPromotion = track?.isPromotion || String(track?.id || '').toLowerCase() === 'promotion';
    if (!isPromotion && !this.canAcceptMore()) {
      const error = new Error('Queue is full');
      error.code = 'QUEUE_FULL';
      throw error;
    }
  }

  enqueue(track) {
    this._assertCapacity(track);
    const queuedTrack = {
      ...track,
      queuedAt: new Date().toISOString(),
      status: 'queued',
    };

    this.queue.push(queuedTrack);
    this.emit('track-added', queuedTrack);
    this.emit('queue-changed');
    bus.emit('queue-update', { size: this.size(), action: 'enqueue', trackId: queuedTrack.id });
    this.logger.info('Queued track', { id: queuedTrack.id, title: queuedTrack.title });

    return queuedTrack;
  }

  enqueueFront(track) {
    this._assertCapacity(track);
    const queuedTrack = {
      ...track,
      queuedAt: new Date().toISOString(),
      status: 'queued',
      isPriority: true,
    };

    this.queue.unshift(queuedTrack);
    this.emit('track-added', queuedTrack);
    this.emit('queue-changed');
    bus.emit('queue-update', { size: this.size(), action: 'enqueueFront', trackId: queuedTrack.id });
    this.logger.info('Queued priority track', { id: queuedTrack.id, title: queuedTrack.title });

    return queuedTrack;
  }

  dequeueNext() {
    const next = this.queue.shift() || null;

    if (next) {
      this.emit('queue-changed');
      bus.emit('queue-update', { size: this.size(), action: 'dequeue', trackId: next.id });
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
      bus.emit('queue-update', { size: this.size(), action: 'discard', count: removed.length });
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
    bus.emit('track-start', { id: track.id, title: track.title });
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
    bus.emit('track-end', { id: this.lastFinished.id, title: this.lastFinished.title, status });
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