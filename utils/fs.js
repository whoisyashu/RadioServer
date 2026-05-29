const fs = require('fs');
const path = require('path');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath, fallback) {
  if (!pathExists(filePath)) {
    return fallback;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return fallback;
  }

  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

module.exports = {
  ensureDirectory,
  pathExists,
  readJson,
  removeFile,
  writeJson,
};