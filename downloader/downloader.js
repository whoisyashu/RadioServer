const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { parseArgString } = require('../utils/args');
const { validateAudioFile } = require('../utils/audio');
const { ensureDirectory, pathExists, readJson, removeFile, writeJson } = require('../utils/fs');

const execFileAsync = promisify(execFile);

class Downloader {
  constructor({ env, logger }) {
    this.env = env;
    this.logger = logger;
    this.cacheFile = path.join(env.songsDir, 'index.json');
    this.cache = { tracksById: {} };
    this.inFlight = new Map();
  }

  async loadCache() {
    ensureDirectory(this.env.songsDir);
    ensureDirectory(path.dirname(this.cacheFile));

    this.cache = readJson(this.cacheFile, { tracksById: {} });
    if (!this.cache.tracksById) {
      this.cache.tracksById = {};
    }

    this.logger.info('Loaded downloader cache', { cachedTracks: Object.keys(this.cache.tracksById).length });
  }

  async saveCache() {
    writeJson(this.cacheFile, this.cache);
  }

  async resolveAndDownload(input) {
    const normalizedInput = String(input || '').trim();
    if (!normalizedInput) {
      throw new Error('A search query or URL is required');
    }

    const candidate = await this.selectPlayableCandidate(normalizedInput);
    if (!candidate?.id) {
      throw new Error('No usable playable result was found');
    }

    const existing = this.cache.tracksById[candidate.id];
    if (existing && (await this.isCachedTrackPlayable(existing))) {
      this.logger.info('Reusing cached track', { id: candidate.id, filePath: existing.filePath });
      const refreshed = this.touchTrack(existing);
      await this.saveCache();
      return refreshed;
    }

    if (existing) {
      this.logger.warn('Cached track was invalid and will be re-downloaded', { id: candidate.id, filePath: existing.filePath });
      this.deleteCachedTrack(existing.id, existing.filePath);
      await this.saveCache();
    }

    if (this.inFlight.has(candidate.id)) {
      return this.inFlight.get(candidate.id);
    }

    const downloadPromise = this.downloadTrack(candidate, normalizedInput);
    this.inFlight.set(candidate.id, downloadPromise);

    try {
      const track = await downloadPromise;
      this.cache.tracksById[track.id] = track;
      await this.saveCache();
      return track;
    } finally {
      this.inFlight.delete(candidate.id);
    }
  }

  async selectPlayableCandidate(input) {
    const resolved = await this.resolveCandidates(input);
    const candidates = Array.isArray(resolved) ? resolved : [resolved];
    const playable = candidates.filter((candidate) => this.isPlayableCandidate(candidate));

    if (playable.length === 0) {
      this.logger.warn('No playable yt-dlp candidate matched the duration limit', {
        input,
        candidateCount: candidates.length,
        maxDurationSeconds: this.env.ytdlp.maxDurationSeconds,
      });
      return null;
    }

    const selected = playable[0];
    this.logger.info('Selected playable track', {
      id: selected.id,
      title: selected.title || selected.fulltitle || selected.id,
      duration: selected.duration || null,
    });

    return selected;
  }

  async resolveCandidates(input) {
    const target = this.isUrl(input) ? input : `ytsearch${this.env.ytdlp.searchResults}:${input}`;
    const args = ['--dump-single-json', '--no-playlist', '--skip-download'];

    if (this.env.ytdlp.cookiesFile) {
      args.push('--cookies', this.env.ytdlp.cookiesFile);
    }

    if (this.env.ytdlp.extractorArgs) {
      args.push('--extractor-args', this.env.ytdlp.extractorArgs);
    }

    args.push(...parseArgString(this.env.ytdlp.extraArgs));
    // Append configured JS runtime when running on Linux (WSL) to support yt-dlp signature extraction.
    // Only add if user configured a runtime and the args don't already include --js-runtimes.
    try {
      if (this.env.ytdlp.jsRuntime && process.platform === 'linux') {
        const hasRuntime = args.some((a) => String(a).startsWith('--js-runtimes'));
        if (!hasRuntime) {
          args.push('--js-runtimes', this.env.ytdlp.jsRuntime);
        }
      }
    } catch (e) {
      // defensive: do nothing if platform check fails
    }
    args.push(target);

    this.logger.info('Searching YouTube candidates', { target, candidateCount: this.env.ytdlp.searchResults });
    const { stdout } = await execFileAsync(this.env.ytdlp.bin, args, { maxBuffer: 10 * 1024 * 1024 });
    const payload = JSON.parse(stdout);

    if (Array.isArray(payload.entries)) {
      return payload.entries;
    }

    return payload;
  }

  isPlayableCandidate(candidate) {
    if (!candidate || !candidate.id) {
      return false;
    }

    if (candidate.is_live || candidate.live_status === 'is_live' || candidate.live_status === 'is_upcoming') {
      return false;
    }

    return this.isDurationAcceptable(candidate.duration);
  }

  isDurationAcceptable(durationSeconds) {
    if (durationSeconds === undefined || durationSeconds === null || durationSeconds === '') {
      return true;
    }

    const parsedDuration = Number(durationSeconds);
    if (Number.isNaN(parsedDuration)) {
      return true;
    }

    return parsedDuration <= this.env.ytdlp.maxDurationSeconds;
  }

  async downloadTrack(candidate, originalInput) {
    ensureDirectory(this.env.songsDir);

    const outputTemplate = path.join(this.env.songsDir, '%(id)s.%(ext)s');
    const filePath = path.join(this.env.songsDir, `${candidate.id}.mp3`);
    const target = candidate.webpage_url || candidate.url || originalInput;

    const args = ['--no-playlist', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--output', outputTemplate];

    if (this.env.ytdlp.cookiesFile) {
      args.push('--cookies', this.env.ytdlp.cookiesFile);
    }

    if (this.env.ytdlp.extractorArgs) {
      args.push('--extractor-args', this.env.ytdlp.extractorArgs);
    }

    args.push(...parseArgString(this.env.ytdlp.extraArgs));
    // Append configured JS runtime only on Linux hosts where it's required (WSL with node at /usr/bin/node)
    try {
      if (this.env.ytdlp.jsRuntime && process.platform === 'linux') {
        const hasRuntime = args.some((a) => String(a).startsWith('--js-runtimes'));
        if (!hasRuntime) {
          args.push('--js-runtimes', this.env.ytdlp.jsRuntime);
        }
      }
    } catch (e) {
      // ignore
    }
    args.push(target);

    this.logger.info('Downloading track', {
      id: candidate.id,
      title: candidate.title || candidate.fulltitle || candidate.id,
      target,
    });

    await execFileAsync(this.env.ytdlp.bin, args, { maxBuffer: 10 * 1024 * 1024 });

    if (!pathExists(filePath)) {
      throw new Error(`Expected cached MP3 file not found after download: ${filePath}`);
    }

    await this.assertPlayableFile(filePath);

    const track = this.createTrackRecord(candidate, target, filePath);
    this.logger.info('Track downloaded', { id: track.id, title: track.title, filePath: track.filePath });
    return track;
  }

  async isCachedTrackPlayable(track) {
    if (!track?.filePath || !pathExists(track.filePath)) {
      return false;
    }

    try {
      await this.assertPlayableFile(track.filePath);
      return true;
    } catch (error) {
      this.logger.warn('Cached audio validation failed', { id: track.id, filePath: track.filePath, error: error.message });
      return false;
    }
  }

  async assertPlayableFile(filePath) {
    await validateAudioFile({ ffmpegBinary: this.env.ffmpegBinary, filePath });
  }

  createTrackRecord(candidate, target, filePath) {
    const now = new Date().toISOString();
    return {
      id: candidate.id,
      title: candidate.title || candidate.fulltitle || candidate.id,
      webpageUrl: candidate.webpage_url || target,
      originalUrl: target,
      filePath,
      duration: candidate.duration || null,
      uploader: candidate.uploader || candidate.channel || null,
      source: candidate.extractor || 'youtube',
      downloadedAt: now,
      lastUsedAt: now,
      playCount: 0,
    };
  }

  touchTrack(track) {
    const updated = {
      ...track,
      lastUsedAt: new Date().toISOString(),
      playCount: Number(track.playCount || 0) + 1,
    };

    this.cache.tracksById[updated.id] = updated;
    return updated;
  }

  deleteCachedTrack(trackId, filePath) {
    if (trackId && this.cache.tracksById[trackId]) {
      delete this.cache.tracksById[trackId];
    }

    if (filePath) {
      removeFile(filePath);
    }
  }

  async pruneCache({ keepIds = [], activeFilePaths = [] } = {}) {
    const entries = Object.values(this.cache.tracksById);
    const keepSet = new Set(keepIds);
    const activeSet = new Set(activeFilePaths);
    const now = Date.now();
    const maxAgeMs = this.env.cache.maxAgeDays * 24 * 60 * 60 * 1000;

    const candidates = entries
      .filter((track) => !keepSet.has(track.id) && !activeSet.has(track.filePath))
      .sort((left, right) => {
        const leftTouched = new Date(left.lastUsedAt || left.downloadedAt || 0).getTime();
        const rightTouched = new Date(right.lastUsedAt || right.downloadedAt || 0).getTime();
        return leftTouched - rightTouched;
      });

    const removableByAge = candidates.filter((track) => {
      const touchedAt = new Date(track.lastUsedAt || track.downloadedAt || 0).getTime();
      return Number.isFinite(touchedAt) && now - touchedAt > maxAgeMs;
    });

    const excessCount = Math.max(0, entries.length - this.env.cache.maxTracks);
    const removableByCount = candidates.slice(0, excessCount);
    const removable = new Map([...removableByAge, ...removableByCount].map((track) => [track.id, track]));

    for (const track of removable.values()) {
      this.logger.info('Pruning cached track', { id: track.id, filePath: track.filePath });
      delete this.cache.tracksById[track.id];
      removeFile(track.filePath);
    }

    if (removable.size > 0) {
      await this.saveCache();
    }

    return Array.from(removable.values());
  }

  isUrl(input) {
    try {
      const parsed = new URL(String(input));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
}

module.exports = { Downloader };