const EventEmitter = require('events');

// Single shared event bus for internal components
const bus = new EventEmitter();

module.exports = { bus };
