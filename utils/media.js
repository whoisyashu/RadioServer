const path = require('path');
const { spawn } = require('child_process');
const { ensureDirectory, pathExists } = require('./fs');

function ensureFallbackTrack({ filePath, logger, durationSeconds = 3, ffmpegBinary = 'ffmpeg' }) {
  if (pathExists(filePath)) {
    return Promise.resolve();
  }

  ensureDirectory(path.dirname(filePath));

  logger.info('Generating idle silence track', { filePath, durationSeconds });

  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBinary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        String(durationSeconds),
        '-q:a',
        '9',
        '-acodec',
        'libmp3lame',
        filePath,
      ],
      { stdio: 'ignore' }
    );

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Failed to generate silence track. ffmpeg exited with code ${code}`));
    });
  });
}

module.exports = { ensureFallbackTrack };