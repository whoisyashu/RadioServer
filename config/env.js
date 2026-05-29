const path = require('path');
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
  fallbackTrackFile: path.resolve(rootDir, process.env.FALLBACK_TRACK_FILE || 'songs/fallback.mp3'),
  promotionTrackFile: path.resolve(rootDir, process.env.PROMOTION_TRACK_FILE || 'songs/promotion.mp3'),
  apiPort: toNumber(process.env.PORT || process.env.API_PORT, 3000),
  apiToken: requiredEnv(['API_TOKEN']),
  logLevel: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
  ffmpegBinary: process.env.FFMPEG_BIN || 'ffmpeg',
  fallbackTrackDurationSeconds: toNumber(process.env.FALLBACK_TRACK_DURATION_SECONDS, 3),
  streamBitrate: String(process.env.STREAM_BITRATE || '128k'),
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
    cookiesFile: process.env.YTDLP_COOKIES_FILE ? path.resolve(rootDir, process.env.YTDLP_COOKIES_FILE) : null,
    extractorArgs: process.env.YTDLP_EXTRACTOR_ARGS || '',
    extraArgs: process.env.YTDLP_EXTRA_ARGS || '',
    jsRuntime: process.env.YTDLP_JS_RUNTIME || '',
    searchResults: toNumber(process.env.YTDLP_SEARCH_RESULTS, 5),
    maxDurationSeconds: toNumber(process.env.YTDLP_MAX_DURATION_SECONDS, 900),
  },
  cache: {
    maxTracks: toNumber(process.env.CACHE_MAX_TRACKS, 250),
    maxAgeDays: toNumber(process.env.CACHE_MAX_AGE_DAYS, 30),
  },
};

module.exports = { env };