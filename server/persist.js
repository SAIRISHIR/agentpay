const fs = require('fs');
const path = require('path');
const { DATA_DIR, PERSIST } = require('./config');

const FILE = path.join(DATA_DIR, 'state.json');
let timer = null;

function load() {
  if (!PERSIST) return null;
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

// Debounced atomic write: write to a temp file, then rename over the snapshot.
function schedule(snapshot) {
  if (!PERSIST) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...snapshot() }));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error(`[persist] ${e.message}`);
    }
  }, 500);
}

module.exports = { load, schedule, FILE };
