const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function validateAudioFile({ ffmpegBinary, filePath }) {
  await execFileAsync(
    ffmpegBinary,
    ['-hide_banner', '-loglevel', 'error', '-v', 'error', '-i', filePath, '-f', 'null', '-'],
    { maxBuffer: 5 * 1024 * 1024 }
  );
}

module.exports = { validateAudioFile };