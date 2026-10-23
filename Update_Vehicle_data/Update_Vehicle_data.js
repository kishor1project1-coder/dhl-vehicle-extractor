const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

require('dotenv').config({
  path: path.join(PROJECT_ROOT, '.env')
});

const { google } = require('googleapis');
const { getDhlToken } = require(
  path.join(PROJECT_ROOT, 'config', 'dhl-token')
);

const DHL_API_URL = process.env.DHL_API_URL;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const VEHICLE_TAB =
  process.env.GOOGLE_SHEET_TAB || 'Vehicle_data';

const CONSIGNEE_TAB =
  process.env.GOOGLE_SHEET_CONSIGNEE_TAB || 'Consignee Name';

const SERVICE_ACCOUNT_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    'service-account.json'
);

const VEHICLE_HEADERS = [
  'Serial No',
  'Vehicle Number',
  'Driver Name',
  'Driver Number',
  'Starting Point',
  'Destination',
  'Consignee Name',
  'Latitude',
  'Longitude',
  'Last Updated'
];

const CONSIGNEE_HEADERS = ['Consignee Name'];

// =====================================================
// HELPERS
// =====================================================

function valueOrNA(value) {
  if (value === null || value === undefined) {
    return 'N/A';
  }

  const text = String(value).trim();

  if (!text || text === '0') {
    return 'N/A';
  }

  return text;
}

function normalizeVehicleNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeConsignee(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text || 'N/A';
}

function getIstTimestamp() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
}

function normalizeHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers, aliases) {
  const normalizedHeaders = headers.map(normalizeHeader);

  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(
      normalizeHeader(alias)
    );

    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

// =====================================================
// GOOGLE SHEETS CLIENT
// =====================================================

async function createGoogleClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });

  return google.sheets({
    version: 'v4',
    auth
  });
}

// =====================================================
// WORKSHEET MANAGEMENT
// =====================================================

async function ensureTab(sheets, title) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID
  });

  const exists = (response.data.sheets || []).some(
    sheet => sheet.properties.title === title
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title }
            }
          }
        ]
      }
    });

    console.log(`Created worksheet: ${title}`);
  }
}

// =====================================================
// MIGRATE EXISTING VEHICLE SHEET
// =====================================================

// Reads the existing header names before changing them.
// This supports the earlier layout containing Route,
// GPS Location, Device Date and Vehicle Status.
// Existing vehicle serial numbers are retained.

async function migrateVehicleSheet(sheets) {
  const range = `'${VEHICLE_TAB}'!A:N`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `'${VEHICLE_TAB}'!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [VEHICLE_HEADERS]
      }
    });

    return;
  }

  const oldHeaders = rows[0];

  const vehicleIndex = findHeaderIndex(oldHeaders, [
    'Vehicle Number',
    'Vehicle No',
    'Vehicle Number/No',
    'asset'
  ]);

  const serialIndex = findHeaderIndex(oldHeaders, [
    'Serial No',
    'Serial Number',
    'S.No',
    'Sr No'
  ]);

  // If this is already the desired layout, don't migrate it.
  const isCurrentLayout = VEHICLE_HEADERS.every(
    (header, index) =>
      normalizeHeader(oldHeaders[index]) ===
      normalizeHeader(header)
  );

  if (isCurrentLayout) {
    return;
  }

  // If existing data has no recognizable vehicle number
  // column, stop instead of accidentally corrupting it.
  if (vehicleIndex === -1) {
    throw new Error(
      `Cannot identify the Vehicle Number column in ${VEHICLE_TAB}. ` +
      'Please check the first-row headers before migrating.'
    );
  }

  const driverIndex = findHeaderIndex(oldHeaders, [
    'Driver Name',
    'drivername'
  ]);

  const mobileIndex = findHeaderIndex(oldHeaders, [
    'Driver Number',
    'Driver Mobile No',
    'Driver Mobile Number',
    'drivermob'
  ]);

  const originIndex = findHeaderIndex(oldHeaders, [
    'Starting Point',
    'Origin Hub',
    'Starting Node',
    'orghub'
  ]);

  const destinationIndex = findHeaderIndex(oldHeaders, [
    'Destination',
    'Destination Hub',
    'desthub'
  ]);

  const consigneeIndex = findHeaderIndex(oldHeaders, [
    'Consignee Name',
    'cnename'
  ]);

  const latitudeIndex = findHeaderIndex(oldHeaders, [
    'Latitude',
    'lat'
  ]);

  const longitudeIndex = findHeaderIndex(oldHeaders, [
    'Longitude',
    'lng',
    'long'
  ]);

  const lastUpdatedIndex = findHeaderIndex(oldHeaders, [
    'Last Updated',
    'Last Updated (IST)',
    'Updated Time',
    'Last Update'
  ]);

  const migratedRows = [VEHICLE_HEADERS];

  for (let i = 1; i < rows.length; i++) {
    const oldRow = rows[i];

    const vehicleNumber = normalizeVehicleNumber(
      oldRow[vehicleIndex]
    );

    if (!vehicleNumber) {
      continue;
    }

    const serial = serialIndex === -1
      ? ''
      : valueOrNA(oldRow[serialIndex]);

    migratedRows.push([
      serial === 'N/A' ? '' : serial,
      vehicleNumber,
      valueOrNA(
        driverIndex === -1 ? '' : oldRow[driverIndex]
      ),
      valueOrNA(
        mobileIndex === -1 ? '' : oldRow[mobileIndex]
      ),
      valueOrNA(
        originIndex === -1 ? '' : oldRow[originIndex]
      ),
      valueOrNA(
        destinationIndex === -1 ? '' : oldRow[destinationIndex]
      ),
      normalizeConsignee(
        consigneeIndex === -1 ? '' : oldRow[consigneeIndex]
      ),
      valueOrNA(
        latitudeIndex === -1 ? '' : oldRow[latitudeIndex]
      ),
      valueOrNA(
        longitudeIndex === -1 ? '' : oldRow[longitudeIndex]
      ),
      valueOrNA(
        lastUpdatedIndex === -1 ? '' : oldRow[lastUpdatedIndex]
      )
    ]);
  }

  console.log(
    `Migrating ${migratedRows.length - 1} existing vehicle rows...`
  );

  // Clear old columns and rewrite the new layout.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${VEHICLE_TAB}'!A:N`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${VEHICLE_TAB}'!A1:J${Math.max(1, migratedRows.length)}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: migratedRows
    }
  });

  console.log('Vehicle sheet migrated to the new layout.');
}

// =====================================================
// FETCH DHL VEHICLES
// =====================================================

async function fetchDhlVehicles() {
  if (!DHL_API_URL) {
    throw new Error('DHL_API_URL is missing in .env');
  }

  // Read fresh on every request (the token service caches for 30s).
  // Any failure here (sheet unreadable, token missing) stops the run
  // before the vehicle sheet is touched.
  let token;

  try {
    token = await getDhlToken();
  } catch (error) {
    throw new Error(
      `Could not read the DHL API token from Google Sheets: ${error.message}`
    );
  }

  token = typeof token === 'string' ? token.trim() : '';

  if (!token) {
    throw new Error(
      'DHL API token is missing. Add it to DHL_API_Token!A2 ' +
      'or via POST/PUT /api/dhl-token.'
    );
  }

  console.log('Fetching vehicle data from DHL API...');

  const response = await fetch(DHL_API_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(60000)
  });

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    // No retry. A 403 is not necessarily an expired token: it can also
    // mean missing permission or an IP restriction on the DHL side.
    const authError = new Error(
      `DHL API authentication failed (HTTP ${response.status}). ` +
      'The token may be expired, revoked or invalid, or the account may ' +
      'lack permission or be IP-restricted. Check the token in ' +
      'DHL_API_Token!A2 and with DHL. Vehicle sheet was not updated.'
    );
    authError.code = 'DHL_AUTH';
    throw authError;
  }

  if (!response.ok) {
    throw new Error(
      `DHL API returned HTTP ${response.status}: ` +
      text.slice(0, 500)
    );
  }

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error('DHL API returned invalid JSON.');
  }

  const vehicles = Array.isArray(result)
    ? result
    : result.data ?? result.vehicles ?? result.result;

  if (!Array.isArray(vehicles)) {
    throw new Error(
      'Unexpected DHL API response: expected an array of vehicles.'
    );
  }

  console.log(`Fetched ${vehicles.length} vehicle records.`);

  return vehicles;
}

// =====================================================
// NORMALIZE DHL VEHICLE
// =====================================================

function normalizeVehicle(vehicle) {
  const vehicleNumber = normalizeVehicleNumber(vehicle.asset);

  if (!vehicleNumber) {
    return null;
  }

  return {
    vehicleNumber,
    driverName: valueOrNA(vehicle.drivername),
    driverNumber: valueOrNA(vehicle.drivermob),
    startingPoint: valueOrNA(vehicle.orghub),
    destination: valueOrNA(vehicle.desthub),
    consigneeName: normalizeConsignee(vehicle.cnename),
    latitude: valueOrNA(vehicle.latitude),
    longitude: valueOrNA(vehicle.longitude),
    lastUpdated: getIstTimestamp()
  };
}

function toSheetRow(vehicle, serialNumber) {
  return [
    serialNumber,
    vehicle.vehicleNumber,
    vehicle.driverName,
    vehicle.driverNumber,
    vehicle.startingPoint,
    vehicle.destination,
    vehicle.consigneeName,
    vehicle.latitude,
    vehicle.longitude,
    vehicle.lastUpdated
  ];
}

// =====================================================
// SYNC VEHICLES
// =====================================================

async function syncVehicles(sheets, apiVehicles) {
  const range = `'${VEHICLE_TAB}'!A:J`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range
  });

  const rows = response.data.values || [];

  const existingVehicles = new Map();
  let highestSerial = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const vehicleNumber = normalizeVehicleNumber(row[1]);
    const serial = Number(row[0]);

    if (Number.isInteger(serial) && serial > highestSerial) {
      highestSerial = serial;
    }

    if (!vehicleNumber) {
      continue;
    }

    existingVehicles.set(vehicleNumber, {
      rowNumber: i + 1,
      serialNumber:
        Number.isInteger(serial) && serial > 0
          ? serial
          : null
    });
  }

  // Deduplicate incoming API records by vehicle number.
  const latestVehicles = new Map();

  for (const rawVehicle of apiVehicles) {
    const vehicle = normalizeVehicle(rawVehicle);

    if (vehicle) {
      latestVehicles.set(vehicle.vehicleNumber, vehicle);
    }
  }

  const updates = [];
  const additions = [];

  let updatedCount = 0;
  let addedCount = 0;

  for (const [vehicleNumber, vehicle] of latestVehicles) {
    const existing = existingVehicles.get(vehicleNumber);

    if (existing) {
      let serial = existing.serialNumber;

      if (serial === null) {
        serial = ++highestSerial;
      }

      updates.push({
        range: `'${VEHICLE_TAB}'!A${existing.rowNumber}:J${existing.rowNumber}`,
        values: [toSheetRow(vehicle, serial)]
      });

      updatedCount++;
    } else {
      const serial = ++highestSerial;

      additions.push(toSheetRow(vehicle, serial));
      addedCount++;
    }
  }

  // Batch-update existing rows.
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates
      }
    });
  }

  // Append new vehicles.
  if (additions.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: additions
      }
    });
  }

  console.log('\n========== VEHICLE SYNC ==========');
  console.log(`API records: ${apiVehicles.length}`);
  console.log(`Unique valid vehicles: ${latestVehicles.size}`);
  console.log(`Updated: ${updatedCount}`);
  console.log(`Added: ${addedCount}`);
  console.log('==================================\n');

  return {
    apiRecords: apiVehicles.length,
    uniqueVehicles: latestVehicles.size,
    updated: updatedCount,
    added: addedCount
  };
}

// =====================================================
// BUILD UNIQUE CONSIGNEE SHEET
// =====================================================

// Uses all consignee names currently present in Vehicle_data,
// including vehicles absent from the latest API response.

async function syncConsigneeSheet(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${VEHICLE_TAB}'!B:G`
  });

  const rows = response.data.values || [];
  const uniqueNames = new Set();

  // In the B:G range, Consignee Name is column index 5 (G).
  for (let i = 1; i < rows.length; i++) {
    const name = normalizeConsignee(rows[i][5]);

    if (name !== 'N/A') {
      uniqueNames.add(name);
    }
  }

  const sortedNames = [...uniqueNames].sort((a, b) =>
    a.localeCompare(b)
  );

  const output = [
    CONSIGNEE_HEADERS,
    ...sortedNames.map(name => [name])
  ];

  // Clear old entries so removed names do not remain stale.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${CONSIGNEE_TAB}'!A:A`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${CONSIGNEE_TAB}'!A1:A${output.length}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: output
    }
  });

  console.log(
    `Unique consignee names written: ${sortedNames.length}`
  );

  console.log(`Consignee worksheet: ${CONSIGNEE_TAB}`);

  return sortedNames.length;
}

// =====================================================
// RUN SYNC (shared by the command line and the web API)
// =====================================================

async function runVehicleSync() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID is missing in .env');
  }

  const sheets = await createGoogleClient();

  // Ensure both tabs exist before writing.
  await ensureTab(sheets, VEHICLE_TAB);
  await ensureTab(sheets, CONSIGNEE_TAB);

  // Preserve and migrate existing data using its old headers.
  await migrateVehicleSheet(sheets);

  // Fetch DHL data. If this fails, don't overwrite vehicle data.
  const vehicles = await fetchDhlVehicles();

  // Update vehicle tracking sheet.
  const summary = await syncVehicles(sheets, vehicles);

  // Refresh unique consignee names from the resulting sheet.
  const consigneeCount = await syncConsigneeSheet(sheets);

  console.log('All Google Sheets updates completed successfully.');

  return {
    ...summary,
    consigneeCount,
    finishedAt: getIstTimestamp()
  };
}

// =====================================================
// COMMAND-LINE ENTRY (node Update_Vehicle_data.js)
// =====================================================

async function main() {
  try {
    await runVehicleSync();
  } catch (error) {
    console.error('\nDHL VEHICLE SYNC FAILED');
    console.error(error.message);

    if (error.response?.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }

    process.exitCode = 1;
  }
}

// Only run automatically when started directly, NOT when the
// server imports this file.
if (require.main === module) {
  main();
}

module.exports = { runVehicleSync };