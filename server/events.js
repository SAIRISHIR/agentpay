const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(500);

// walletId scopes an event to one visitor's wallet; null means marketplace-wide.
function publish(type, data, walletId = null) {
  bus.emit('evt', { type, data, walletId, at: new Date().toISOString() });
}

module.exports = { bus, publish };
