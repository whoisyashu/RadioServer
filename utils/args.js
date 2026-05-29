function parseArgString(input) {
  if (!input || !String(input).trim()) {
    return [];
  }

  const values = [];
  const regex = /"([^\"]*(?:\\.[^\"]*)*)"|'([^']*(?:\\.[^']*)*)'|([^\s]+)/g;
  let match;

  while ((match = regex.exec(input)) !== null) {
    const value = match[1] || match[2] || match[3];
    if (value) {
      values.push(value.replace(/\\([\"'])/g, '$1'));
    }
  }

  return values;
}

module.exports = { parseArgString };