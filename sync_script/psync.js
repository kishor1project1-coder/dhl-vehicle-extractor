
require('dotenv').config();

const { google } = require('googleapis');
const path = require('path');

// =====================================================
// CONFIGURATION
// =====================================================

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const SERVICE_ACCOUNT_PATH = path.resolve(
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    './service-account.json'
);

const VEHICLE_TAB =
  process.env.GOOGLE_SHEET_TAB || 'Vehicle_data';

const CONSIGNEE_TAB =
  process.env.GOOGLE_SHEET_CONSIGNEE_TAB ||
  'Consignee Name';

const DAILY_REPORT_SHEET_ID =
  process.env.GOOGLE_DAILY_REPORT_SHEET_ID;

const DAILY_REPORT_TABS = (
  process.env.GOOGLE_DAILY_REPORT_TABS || ''
)
  .split(',')
  .map(tab => tab.trim())
  .filter(Boolean);

// Report columns N and O.
const REPORT_RANGE = 'N:O';

// =====================================================
// HELPERS
// =====================================================

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function normalizeProduct(value) {
  return String(value ?? '').trim();
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
// ENSURE CONSIGNEE TAB EXISTS
// =====================================================

async function ensureConsigneeTab(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID
  });

  const exists = (spreadsheet.data.sheets || []).some(
    sheet => sheet.properties.title === CONSIGNEE_TAB
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: CONSIGNEE_TAB
              }
            }
          }
        ]
      }
    });

    console.log(`Created tab: ${CONSIGNEE_TAB}`);
  }
}

// =====================================================
// READ UNIQUE CONSIGNEES FROM VEHICLE DATA
// =====================================================

async function getUniqueConsignees(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${VEHICLE_TAB}'!B:G`
  });

  const rows = response.data.values || [];
  const names = new Map();

  // B:G means:
  // B = Vehicle Number
  // G = Consignee Name (index 5)
  for (let i = 1; i < rows.length; i++) {
    const originalName = String(rows[i][5] ?? '')
      .trim()
      .replace(/\s+/g, ' ');

    const key = normalizeName(originalName);

    if (!key || key === 'N/A' || key === '0') {
      continue;
    }

    if (!names.has(key)) {
      names.set(key, originalName);
    }
  }

  return names;
}

// =====================================================
// READ CLIENT NAME + PRODUCT FROM MONTHLY REPORTS
// =====================================================

async function getProductsByClient(sheets) {
  const productsByClient = new Map();

  for (const tab of DAILY_REPORT_TABS) {
    console.log(`Reading report tab: ${tab}`);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DAILY_REPORT_SHEET_ID,
      range: `'${tab}'!${REPORT_RANGE}`
    });

    const rows = response.data.values || [];

    if (rows.length === 0) {
      console.log(`No data found in ${tab}`);
      continue;
    }

    // Find the header row, rather than assuming row 1.
    const headerRowIndex = rows.findIndex(row =>
      normalizeName(row[0]) === 'CLIENT NAME' &&
      normalizeName(row[1]) === 'PRODUCT'
    );

    if (headerRowIndex === -1) {
      console.warn(
        `Skipping ${tab}: Client Name and Product headers were not found in columns N:O.`
      );
      continue;
    }

    for (let i = headerRowIndex + 1; i < rows.length; i++) {
      const clientKey = normalizeName(rows[i][0]);
      const product = normalizeProduct(rows[i][1]);

      if (
        !clientKey ||
        clientKey === 'N/A' ||
        clientKey === '0' ||
        !product ||
        product === '0' ||
        normalizeName(product) === 'N/A'
      ) {
        continue;
      }

      if (!productsByClient.has(clientKey)) {
        productsByClient.set(clientKey, new Set());
      }

      productsByClient.get(clientKey).add(product);
    }
  }

  return productsByClient;
}

// =====================================================
// UPDATE CONSIGNEE NAME SHEET
// =====================================================

async function updateConsigneeSheet(
  sheets,
  consignees,
  productsByClient
) {
  const output = [
    ['Consignee Name', 'Product']
  ];

  let matchedCount = 0;
  let unmatchedCount = 0;

  const sortedConsignees = [...consignees.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  for (const [key, displayName] of sortedConsignees) {
    const products = productsByClient.get(key);

    let productText = 'N/A';

    if (products && products.size > 0) {
      productText = [...products]
        .sort((a, b) => a.localeCompare(b))
        .join(', ');

      matchedCount++;
    } else {
      unmatchedCount++;
    }

    output.push([
      displayName,
      productText
    ]);
  }

  // Replace the lookup table only after all reports
  // have been read successfully.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${CONSIGNEE_TAB}'!A:B`
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${CONSIGNEE_TAB}'!A1:B${output.length}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: output
    }
  });

  console.log('\n================================');
  console.log('CONSIGNEE PRODUCT SYNC COMPLETED');
  console.log('================================');
  console.log(`Unique consignees: ${consignees.size}`);
  console.log(`Matched products: ${matchedCount}`);
  console.log(`No matching product: ${unmatchedCount}`);
  console.log(`Updated tab: ${CONSIGNEE_TAB}`);
  console.log('================================\n');
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error(
      'GOOGLE_SHEET_ID is missing from .env'
    );
  }

  if (!DAILY_REPORT_SHEET_ID) {
    throw new Error(
      'GOOGLE_DAILY_REPORT_SHEET_ID is missing from .env'
    );
  }

  if (DAILY_REPORT_TABS.length === 0) {
    throw new Error(
      'GOOGLE_DAILY_REPORT_TABS is missing from .env'
    );
  }

  const sheets = await createGoogleClient();

  console.log('Starting consignee/product matching...');

  // Read every configured report first.
  // A permission or tab error stops the script before
  // the existing lookup sheet is cleared.
  const productsByClient =
    await getProductsByClient(sheets);

  const consignees =
    await getUniqueConsignees(sheets);

  await ensureConsigneeTab(sheets);

  await updateConsigneeSheet(
    sheets,
    consignees,
    productsByClient
  );
}

main().catch(error => {
  console.error('\nCONSIGNEE SYNC FAILED');
  console.error(error.message);

  if (error.response?.data) {
    console.error(
      JSON.stringify(error.response.data, null, 2)
    );
  }

  process.exitCode = 1;
});
