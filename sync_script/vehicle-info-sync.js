
require('dotenv').config();

const { google } = require('googleapis');
const path = require('path');

// =====================================================
// CONFIGURATION
// =====================================================

const MAIN_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const REPORT_SHEET_ID =
  process.env.GOOGLE_DAILY_REPORT_SHEET_ID;

const VEHICLE_INFO_TAB =
  process.env.GOOGLE_SHEET_VEHICLE_INFO_TAB ||
  'Vehicle_Info';

const SERVICE_ACCOUNT_PATH = path.resolve(
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    './service-account.json'
);

const REPORT_TABS = (
  process.env.GOOGLE_DAILY_REPORT_TABS || ''
)
  .split(',')
  .map(tab => tab.trim())
  .filter(Boolean);

const HEADERS = [
  'Serial No',
  'Truck No.',
  'Type Of Truck',
  'Make of Truck',
  'Truck Length',
  'No. of Tyres in Truck',
  'Overall Truck Status',
  'Fuel Tank Status',
  'Type of Lock',
  'Seal Status'
];

// =====================================================
// HELPERS
// =====================================================

function clean(value) {
  return String(value ?? '').trim();
}

function truckKey(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function valueOrNA(value) {
  const result = clean(value);

  return !result || result === '0'
    ? 'N/A'
    : result;
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
// ENSURE DESTINATION TAB EXISTS
// =====================================================

async function ensureVehicleInfoTab(sheets) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: MAIN_SHEET_ID
  });

  const exists = (response.data.sheets || []).some(
    sheet =>
      sheet.properties.title === VEHICLE_INFO_TAB
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: MAIN_SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: VEHICLE_INFO_TAB
              }
            }
          }
        ]
      }
    });

    console.log(`Created tab: ${VEHICLE_INFO_TAB}`);
  }
}

// =====================================================
// COLLECT UNIQUE VEHICLES FROM MONTHLY REPORTS
// =====================================================

async function collectUniqueVehicles(sheets) {
  const vehicles = new Map();

  for (const tab of REPORT_TABS) {
    console.log(`Reading report tab: ${tab}`);

    // H = Truck No.
    // I = Time Checked (not used for output)
    // J = Type Of Truck
    // K = Make of Truck
    // L = Truck Length
    // M = No. of Tyres in Truck
    // X = Overall Truck Status
    // Y = Fuel Tank Status
    // Z = Type of Lock
    // AA = Seal Status
    //
    // Read H:M and X:AA separately to avoid reading
    // all the unrelated columns between M and X.

    const [vehicleResponse, statusResponse] =
      await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: REPORT_SHEET_ID,
          range: `'${tab}'!H2:M`
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId: REPORT_SHEET_ID,
          range: `'${tab}'!X2:AA`
        })
      ]);

    const vehicleRows = vehicleResponse.data.values || [];
    const statusRows = statusResponse.data.values || [];

    const rowCount = Math.max(
      vehicleRows.length,
      statusRows.length
    );

    for (let i = 0; i < rowCount; i++) {
      const row = vehicleRows[i] || [];
      const status = statusRows[i] || [];

      const truckNumber = clean(row[0]);
      const key = truckKey(truckNumber);

      // Ignore blank truck numbers and header/invalid rows.
      if (!key || key === '0') {
        continue;
      }

      const vehicle = {
        truckNumber,
        type: valueOrNA(row[2]),
        make: valueOrNA(row[3]),
        length: valueOrNA(row[4]),
        tyres: valueOrNA(row[5]),

        overallStatus: valueOrNA(status[0]),
        fuelTankStatus: valueOrNA(status[1]),
        typeOfLock: valueOrNA(status[2]),
        sealStatus: valueOrNA(status[3])
      };

      const existing = vehicles.get(key);

      if (!existing) {
        vehicles.set(key, vehicle);
        continue;
      }

      // Preserve useful details when duplicate trucks
      // appear in more than one month.
      //
      // Later tabs are processed later. Their non-N/A
      // values replace earlier values. This is based on
      // configured tab order, not the actual check date.

      for (const field of [
        'truckNumber',
        'type',
        'make',
        'length',
        'tyres',
        'overallStatus',
        'fuelTankStatus',
        'typeOfLock',
        'sealStatus'
      ]) {
        if (
          vehicle[field] &&
          vehicle[field] !== 'N/A'
        ) {
          existing[field] = vehicle[field];
        }
      }
    }

    console.log(
      `Read ${rowCount} rows from ${tab}.`
    );
  }

  return vehicles;
}

// =====================================================
// WRITE VEHICLE INFO
// =====================================================

async function updateVehicleInfoSheet(sheets, vehicles) {
  const output = [HEADERS];

  const sortedVehicles = [...vehicles.entries()].sort(
    (a, b) =>
      a[1].truckNumber.localeCompare(
        b[1].truckNumber
      )
  );

  let serialNumber = 1;

  for (const [, vehicle] of sortedVehicles) {
    output.push([
      serialNumber++,
      vehicle.truckNumber,
      vehicle.type,
      vehicle.make,
      vehicle.length,
      vehicle.tyres,
      vehicle.overallStatus,
      vehicle.fuelTankStatus,
      vehicle.typeOfLock,
      vehicle.sealStatus
    ]);
  }

  // Refresh only columns A:J of Vehicle_Info.
  // Other columns, if any, remain untouched.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: MAIN_SHEET_ID,
    range: `'${VEHICLE_INFO_TAB}'!A:J`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: MAIN_SHEET_ID,
    range:
      `'${VEHICLE_INFO_TAB}'!A1:J${output.length}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: output
    }
  });

  console.log('\n===================================');
  console.log('VEHICLE INFO SYNC COMPLETED');
  console.log('===================================');
  console.log(`Monthly tabs processed: ${REPORT_TABS.length}`);
  console.log(`Unique truck numbers: ${vehicles.size}`);
  console.log(`Destination tab: ${VEHICLE_INFO_TAB}`);
  console.log('Output columns: A:J');
  console.log('===================================\n');
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  if (!MAIN_SHEET_ID) {
    throw new Error(
      'GOOGLE_SHEET_ID is missing from .env'
    );
  }

  if (!REPORT_SHEET_ID) {
    throw new Error(
      'GOOGLE_DAILY_REPORT_SHEET_ID is missing from .env'
    );
  }

  if (REPORT_TABS.length === 0) {
    throw new Error(
      'GOOGLE_DAILY_REPORT_TABS is missing from .env'
    );
  }

  const sheets = await createGoogleClient();

  console.log('Starting Vehicle_Info synchronization...');

  // Read source data before changing the destination.
  const vehicles = await collectUniqueVehicles(sheets);

  await ensureVehicleInfoTab(sheets);

  await updateVehicleInfoSheet(sheets, vehicles);
}

main().catch(error => {
  console.error('\nVEHICLE INFO SYNC FAILED');
  console.error(error.message);

  if (error.response?.data) {
    console.error(
      JSON.stringify(error.response.data, null, 2)
    );
  }

  process.exitCode = 1;
});
