const os = require('os');

function getSystemPressure() {
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const load1 = Number(os.loadavg()[0] || 0);
  const memoryTotal = os.totalmem() || 1;
  const memoryUsed = memoryTotal - os.freemem();

  return {
    cpuLoadPercent: (load1 / cpuCount) * 100,
    memoryPercent: (memoryUsed / memoryTotal) * 100,
    processMemoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    loadAverage: os.loadavg(),
    cpuCount,
  };
}

function isSystemOverloaded({ cpuLimitPercent = 85, memoryLimitPercent = 85 } = {}) {
  const pressure = getSystemPressure();
  return {
    overloaded: pressure.cpuLoadPercent >= cpuLimitPercent || pressure.memoryPercent >= memoryLimitPercent,
    pressure,
  };
}

module.exports = {
  getSystemPressure,
  isSystemOverloaded,
};
