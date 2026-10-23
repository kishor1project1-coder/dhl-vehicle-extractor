const express = require('express');
const { runVehicleSync } = require('./Update_Vehicle_data');

const router = express.Router();

// Only one sync at a time, so repeated clicks cannot overlap
// and double-write the sheet.
let running = false;
let lastRun = null;

// POST /api/vehicle-data/refresh  -> run the sync now
router.post('/', async (req, res) => {
  if (running) {
    return res.status(409).json({
      success: false,
      error: 'A vehicle data refresh is already running. Please wait.'
    });
  }

  running = true;
  const startedAt = new Date().toISOString();

  try {
    const result = await runVehicleSync();

    lastRun = { success: true, startedAt, ...result };

    return res.json({ success: true, ...lastRun });
  } catch (error) {
    // Never include tokens or headers; error messages from the
    // extractor are already safe.
    console.error('Vehicle data refresh failed:', error.message);

    lastRun = {
      success: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message
    };

    const status = error.code === 'DHL_AUTH' ? 502 : 500;

    return res.status(status).json({
      success: false,
      authError: error.code === 'DHL_AUTH',
      error: error.message
    });
  } finally {
    running = false;
  }
});

// GET /api/vehicle-data/refresh/status  -> last result + running flag
router.get('/status', (req, res) => {
  res.json({ running, lastRun });
});

module.exports = router;