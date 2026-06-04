const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

function requiredEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }

  throw new Error(`Missing required environment variable. Set one of: ${names.join(', ')}`);
}

function toNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }
  return parsed;
}

function normalizeMount(mount) {
  const raw = String(mount || '/stream').trim();
  if (!raw.startsWith('/')) {
    return `/${raw}`;
  }
  return raw;
}

const rootDir = path.resolve(__dirname, '..');

const env = {
  rootDir,
  configDir: path.join(rootDir, 'config'),
  songsDir: path.resolve(rootDir, process.env.SONGS_DIR || 'songs'),
  logsDir: path.resolve(rootDir, process.env.LOG_DIR || 'logs'),
  promotionTrackFile: path.resolve(rootDir, process.env.PROMOTION_TRACK_FILE || 'songs/promotion.mp3'),
  apiPort: toNumber(process.env.PORT || process.env.API_PORT, 3000),
  apiHost: String(process.env.HOST || process.env.API_HOST || '0.0.0.0').trim() || '0.0.0.0',
  apiToken: requiredEnv(['API_TOKEN']),
  logLevel: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
  ffmpegBinary: process.env.FFMPEG_BIN || 'ffmpeg',
  ffmpegLocation: String(process.env.FFMPEG_LOCATION || '').trim(),
  promoTrackDurationSeconds: toNumber(process.env.PROMOTION_TRACK_DURATION_SECONDS, 3),
  streamBitrate: String(process.env.STREAM_BITRATE || '96k'),
  streamSampleRate: toNumber(process.env.STREAM_SAMPLE_RATE, 44100),
  streamChannels: toNumber(process.env.STREAM_CHANNELS, 2),
  publicStreamUrl: String(process.env.PUBLIC_STREAM_URL || '').trim() || null,
  icecast: {
    host: String(process.env.ICECAST_HOST || '127.0.0.1'),
    port: toNumber(process.env.ICECAST_PORT, 8000),
    mount: normalizeMount(process.env.ICECAST_MOUNT || '/stream'),
    sourceUser: String(process.env.ICECAST_SOURCE_USER || 'source'),
    sourcePassword: requiredEnv(['ICECAST_PASSWORD', 'ICECAST_SOURCE_PASSWORD']),
    streamName: String(process.env.ICECAST_STREAM_NAME || 'Radio Server Service'),
    streamDescription: String(process.env.ICECAST_STREAM_DESCRIPTION || 'Standalone radio backend service'),
    genre: String(process.env.ICECAST_GENRE || 'Varied'),
  },
  ytdlp: {
    bin: process.env.YTDLP_BIN || 'yt-dlp',
    // Prefer explicit env var, otherwise auto-detect a cookies.txt at project root
    cookiesFile: (function () {
      if (process.env.YTDLP_COOKIES_FILE) {
        return path.resolve(rootDir, process.env.YTDLP_COOKIES_FILE);
      }
      const defaultCookies = path.resolve(rootDir, 'cookies.txt');
      try {
        if (fs.existsSync(defaultCookies)) {
          return defaultCookies;
        }
      } catch (err) {
        // ignore
      }
      return null;
    })(),
    cookiesFromBrowser: String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim(),
    extractorArgs: process.env.YTDLP_EXTRACTOR_ARGS || '',
    extraArgs: process.env.YTDLP_EXTRA_ARGS || '',
    jsRuntime: process.env.YTDLP_JS_RUNTIME || process.env.YTDLP_JS_RUNTIMES || '',
    remoteComponents: String(process.env.YTDLP_REMOTE_COMPONENTS || '').trim() || (process.platform === 'linux' ? 'ejs:github' : ''),
    searchResults: toNumber(process.env.YTDLP_SEARCH_RESULTS, 3),
    maxDurationSeconds: toNumber(process.env.YTDLP_MAX_DURATION_SECONDS, 900),
  },
  cache: {
    maxTracks: toNumber(process.env.CACHE_MAX_TRACKS, 60),
    maxAgeDays: toNumber(process.env.CACHE_MAX_AGE_DAYS, 30),
  },
  download: {
    // Limit concurrent yt-dlp downloads to avoid CPU/memory spikes
    maxConcurrentDownloads: toNumber(process.env.DOWNLOAD_MAX_CONCURRENT, 1),
  },
  ffmpegThreads: toNumber(process.env.FFMPEG_THREADS, 1),
};

module.exports = { env };