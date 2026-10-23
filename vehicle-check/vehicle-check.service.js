
const { google } = require("googleapis");

// ======================================================
// CONFIGURATION
// ======================================================

const MAIN_SHEET_ID =
  process.env.GOOGLE_SHEET_ID ||
  "1rkHsnQbsuPlJacOi3Vi271vooze3TnMhrKpZGV4A8ZY";

const REPORT_SHEET_ID =
  process.env.GOOGLE_DAILY_REPORT_SHEET_ID ||
  "1g5cemsjZGTt7NxrA0mXMhGJ2imc0F5WoHHVl3OSxCtI";

const VEHICLE_TAB =
  process.env.GOOGLE_SHEET_TAB || "Vehicle_data";

const CONSIGNEE_TAB =
  process.env.GOOGLE_SHEET_CONSIGNEE_TAB || "Consignee Name";

const VEHICLE_INFO_TAB =
  process.env.GOOGLE_SHEET_VEHICLE_INFO_TAB || "Vehicle_Info";

const REPORT_TABS = (
  process.env.GOOGLE_DAILY_REPORT_TABS ||
  [
    "Jan 2026", "Feb 2026", "Mar 2026",
    "Apr 2026", "May 2026", "Jun 2026",
    "July 2026", "Aug 2026", "Sep 2026",
    "Oct 2026", "Nov 2026", "Dec 2026"
  ].join(",")
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const REPORT_COLUMNS = 44;
const TIME_ZONE = "Asia/Kolkata";
const CACHE_TTL_MS = Number(
  process.env.INSPECTION_CACHE_TTL_MS || 10000
);

const INSPECTION_DEFAULTS = [
  "NO", "NO", "NO", "NO", "NO",
  "YES", "YES", "YES", "Valid", "YES",
  "Valid", "Valid", "OK", "OK", "OK", "Fit"
];

const cache = new Map();
let sheetsClientPromise;

// ======================================================
// GOOGLE SHEETS CLIENT
// ======================================================

async function getSheets() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        keyFile:
          process.env.GOOGLE_APPLICATION_CREDENTIALS ||
          "./service-account.json",
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets"
        ]
      });

      return google.sheets({
        version: "v4",
        auth: await auth.getClient()
      });
    })().catch(error => {
      sheetsClientPromise = null;
      throw error;
    });
  }

  return sheetsClientPromise;
}

// ======================================================
// HELPERS
// ======================================================

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeTruck(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function toProperCase(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, char => char.toUpperCase());
}

function quoteTab(tab) {
  return `'${tab.replace(/'/g, "''")}'`;
}

function dateKey(year, month, day) {
  return [
    year,
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function parseDate(value) {
  if (value == null || value === "") return "";

  if (typeof value === "number" && value > 0) {
    const date = new Date(
      Date.UTC(1899, 11, 30) +
      Math.floor(value) * 86400000
    );

    return dateKey(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    );
  }

  const text = clean(value);

  let match = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})/
  );

  if (match) {
    return dateKey(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
  }

  match = text.match(
    /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/
  );

  if (match) {
    return dateKey(
      Number(match[3]),
      Number(match[2]),
      Number(match[1])
    );
  }

  return "";
}

function indiaTodayKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return dateKey(
    Number(values.year),
    Number(values.month),
    Number(values.day)
  );
}

// Today + previous two calendar days.
function lastThreeDateKeys() {
  const [year, month, day] =
    indiaTodayKey().split("-").map(Number);

  const today = new Date(
    Date.UTC(year, month - 1, day)
  );

  return Array.from({ length: 3 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - index);

    return dateKey(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    );
  });
}

function monthTabFor(date) {
  const [year, month] = date.split("-").map(Number);

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "July", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];

  return `${months[month - 1]} ${year}`;
}

function timeSortValue(value) {
  if (typeof value === "number") {
    return Math.round((value % 1) * 86400);
  }

  const match = clean(value).match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i
  );

  if (!match) return 0;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const ampm = (match[4] || "").toUpperCase();

  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  return hour * 3600 + minute * 60 + second;
}

// ======================================================
// READS AND CACHE
// ======================================================

async function readRange(spreadsheetId, range) {
  const sheets = await getSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER"
  });

  return response.data.values || [];
}

async function getMonthlyRows(tab, forceRefresh = false) {
  const key = `monthly:${tab}`;
  const cached = cache.get(key);

  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.time < CACHE_TTL_MS
  ) {
    return cached.rows;
  }

  const rows = await readRange(
    REPORT_SHEET_ID,
    `${quoteTab(tab)}!A:AR`
  );

  cache.set(key, {
    time: Date.now(),
    rows
  });

  return rows;
}

function clearCache(tab) {
  if (tab) cache.delete(`monthly:${tab}`);
  else cache.clear();
}

function rowDateKeys(rows) {
  let currentDate = "";

  return rows.map(row => {
    const parsed = parseDate(row[0]);

    if (parsed) currentDate = parsed;

    return currentDate;
  });
}

// ======================================================
// VEHICLE DETAILS
// ======================================================

async function getTruckDetails(truckNumber) {
  const target = normalizeTruck(truckNumber);

  if (!target) {
    throw new Error("Truck number is required");
  }

  const [vehicleRows, infoRows, consigneeRows] =
    await Promise.all([
      readRange(
        MAIN_SHEET_ID,
        `${quoteTab(VEHICLE_TAB)}!A:J`
      ),
      readRange(
        MAIN_SHEET_ID,
        `${quoteTab(VEHICLE_INFO_TAB)}!A:Z`
      ),
      readRange(
        MAIN_SHEET_ID,
        `${quoteTab(CONSIGNEE_TAB)}!A:B`
      )
    ]);

  const vehicle = vehicleRows.slice(1).find(
    row => normalizeTruck(row[1]) === target
  );

  const info = infoRows.slice(1).find(
    row => normalizeTruck(row[1]) === target
  );

  const consignee = vehicle ? clean(vehicle[6]) : "";

  const productRow = consigneeRows.slice(1).find(
    row =>
      clean(row[0]).toLowerCase() ===
      consignee.toLowerCase()
  );

  return {
    truckNumber: vehicle
      ? clean(vehicle[1])
      : info
        ? clean(info[1])
        : truckNumber,

    foundInVehicleData: Boolean(vehicle),
    foundInVehicleInfo: Boolean(info),

    driverName: vehicle ? clean(vehicle[2]) : "",
    driverMobile: vehicle ? clean(vehicle[3]) : "",
    startingPoint: vehicle ? clean(vehicle[4]) : "",
    destination: vehicle ? clean(vehicle[5]) : "",

    consignee: toProperCase(consignee),
    product: productRow ? clean(productRow[1]) : "",

    type: info ? clean(info[2]) : "",
    make: info ? clean(info[3]) : "",
    length: info ? clean(info[4]) : "",
    tyres: info ? clean(info[5]) : "",
    overallStatus: info ? clean(info[6]) : "",
    fuelTankStatus: info ? clean(info[7]) : "",
    lockType: info ? clean(info[8]) : "",
    sealStatus: info ? clean(info[9]) : "",

    inspectionDefaults: INSPECTION_DEFAULTS.slice()
  };
}

// ======================================================
// QRT LOCATIONS
// ======================================================

async function getQrtLocations() {
  const locations = new Set();

  for (const tab of REPORT_TABS) {
    const rows = await getMonthlyRows(tab);

    for (const row of rows.slice(1)) {
      const location = clean(row[3]);
      if (location) locations.add(location);
    }
  }

  return [...locations].sort(
    (a, b) => a.localeCompare(b)
  );
}

// ======================================================
// INSPECTION LOOKUP
// Selected date searches that exact date.
// Without a date, searches today and previous two days.
// ======================================================

async function lookupLatestInspection(
  truckNumber,
  selectedDate = ""
) {
  const target = normalizeTruck(truckNumber);

  if (!target) {
    throw new Error("Truck number is required");
  }

  const selectedDateKey = parseDate(selectedDate);

  const searchedDates = selectedDateKey
    ? [selectedDateKey]
    : lastThreeDateKeys();

  const allowedDates = new Set(searchedDates);

  const relevantTabs = [
    ...new Set(searchedDates.map(monthTabFor))
  ].filter(tab => REPORT_TABS.includes(tab));

  const matches = [];

  for (const tab of relevantTabs) {
    const rows = await getMonthlyRows(tab);
    const dates = rowDateKeys(rows);

    rows.forEach((row, index) => {
      if (index === 0) return;
      if (!allowedDates.has(dates[index])) return;
      if (normalizeTruck(row[7]) !== target) return;

      matches.push({
        date: dates[index],
        time: row[8] || "",
        sealNumber: clean(row[27]),
        qrtLocation: clean(row[3]),
        qrtName: clean(row[1]),
        tab,
        rowNumber: index + 1
      });
    });
  }

  matches.sort((a, b) => {
    const dateDifference = b.date.localeCompare(a.date);
    if (dateDifference !== 0) return dateDifference;

    return (
      timeSortValue(b.time) - timeSortValue(a.time) ||
      b.rowNumber - a.rowNumber
    );
  });

  return {
    truckNumber,
    found: matches.length > 0,
    latestInspection: matches[0] || null,
    searchedDates
  };
}

// ======================================================
// REPORT SHEET METADATA
// ======================================================

async function getReportSheetMetadata(tab) {
  const sheets = await getSheets();

  const response = await sheets.spreadsheets.get({
    spreadsheetId: REPORT_SHEET_ID,
    fields:
      "sheets(properties(sheetId,title,gridProperties),merges)"
  });

  const item = (response.data.sheets || []).find(
    sheet => sheet.properties.title === tab
  );

  if (!item) {
    throw new Error(
      `Monthly report tab "${tab}" was not found`
    );
  }

  return {
    sheetId: item.properties.sheetId,
    rowCount: item.properties.gridProperties?.rowCount || 0,
    columnCount:
      item.properties.gridProperties?.columnCount || REPORT_COLUMNS,
    merges: item.merges || []
  };
}

function isColumnAMerge(merge) {
  return (
    merge.startColumnIndex === 0 &&
    merge.endColumnIndex === 1 &&
    merge.startRowIndex != null &&
    merge.endRowIndex != null
  );
}

// ======================================================
// FIND DATE SECTION
// ======================================================

async function findDateSection(tab, requestedDate) {
  const rows = await getMonthlyRows(tab, true);
  const metadata = await getReportSheetMetadata(tab);
  const dates = rowDateKeys(rows);
  const wanted = parseDate(requestedDate);

  if (!wanted) throw new Error("Invalid inspection date");

  const matchingIndex = dates.findIndex(
    (date, index) => index > 0 && date === wanted
  );

  if (matchingIndex < 0) return null;

  const targetRow = matchingIndex + 1;

  const dateMerge = metadata.merges.find(
    merge =>
      isColumnAMerge(merge) &&
      targetRow >= merge.startRowIndex + 1 &&
      targetRow <= merge.endRowIndex
  );

  let startRow;
  let endRow;

  if (dateMerge) {
    startRow = dateMerge.startRowIndex + 1;
    endRow = dateMerge.endRowIndex;
  } else {
    startRow = targetRow;
    endRow = targetRow;

    for (
      let rowNumber = targetRow + 1;
      rowNumber <= rows.length;
      rowNumber++
    ) {
      const nextDate = dates[rowNumber - 1];
      if (nextDate && nextDate !== wanted) break;

      const nextMerge = metadata.merges.find(
        merge =>
          isColumnAMerge(merge) &&
          rowNumber >= merge.startRowIndex + 1 &&
          rowNumber <= merge.endRowIndex
      );

      if (nextMerge) break;

      endRow = rowNumber;
    }
  }

  return {
    startRow,
    endRow,
    dateMerge: dateMerge || null,
    rows,
    metadata
  };
}

// ======================================================
// INSERT ROW
// Copy formatting and validation, not QRT cell values.
// ======================================================

async function insertQrtRow({
  section,
  insertAfterRow,
  templateRow
}) {
  const sheets = await getSheets();
  const sheetId = section.metadata.sheetId;
  const requests = [];

  if (section.dateMerge) {
    requests.push({
      unmergeCells: {
        range: {
          sheetId,
          startRowIndex: section.dateMerge.startRowIndex,
          endRowIndex: section.dateMerge.endRowIndex,
          startColumnIndex: 0,
          endColumnIndex: 1
        }
      }
    });
  }

  requests.push({
    insertDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: insertAfterRow,
        endIndex: insertAfterRow + 1
      },
      inheritFromBefore: true
    }
  });

  const newRowIndex = insertAfterRow;

  requests.push({
    copyPaste: {
      source: {
        sheetId,
        startRowIndex: templateRow - 1,
        endRowIndex: templateRow,
        startColumnIndex: 0,
        endColumnIndex: REPORT_COLUMNS
      },
      destination: {
        sheetId,
        startRowIndex: newRowIndex,
        endRowIndex: newRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: REPORT_COLUMNS
      },
      pasteType: "PASTE_FORMAT",
      pasteOrientation: "NORMAL"
    }
  });

  requests.push({
    copyPaste: {
      source: {
        sheetId,
        startRowIndex: templateRow - 1,
        endRowIndex: templateRow,
        startColumnIndex: 0,
        endColumnIndex: REPORT_COLUMNS
      },
      destination: {
        sheetId,
        startRowIndex: newRowIndex,
        endRowIndex: newRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: REPORT_COLUMNS
      },
      pasteType: "PASTE_DATA_VALIDATION",
      pasteOrientation: "NORMAL"
    }
  });

  // Vertical borders in B:F for the QRT section.
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: section.startRow - 1,
        endRowIndex: section.endRow + 1,
        startColumnIndex: 1,
        endColumnIndex: 6
      },
      cell: {
        userEnteredFormat: {
          borders: {
            left: {
              style: "SOLID",
              color: { red: 0, green: 0, blue: 0 }
            },
            right: {
              style: "SOLID",
              color: { red: 0, green: 0, blue: 0 }
            }
          }
        }
      },
      fields:
        "userEnteredFormat.borders.left," +
        "userEnteredFormat.borders.right"
    }
  });

  if (section.dateMerge) {
    requests.push({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: section.dateMerge.startRowIndex,
          endRowIndex: section.dateMerge.endRowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: 1
        },
        mergeType: "MERGE_ALL"
      }
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: REPORT_SHEET_ID,
    requestBody: { requests }
  });

  clearCache();
  return insertAfterRow + 1;
}

// ======================================================
// UPDATE QRT TRUCK COUNT IN COLUMN C
//
// For the selected date and QRT location:
// - Count rows with a truck number in column H.
// - Put the total in column C of the first QRT row.
// - Leave column C blank on subsequent QRT rows.
// - If there are zero trucks, keep the first row blank.
// ======================================================

async function updateQrtTruckCount(tab, date, qrtLocation) {
  const sheets = await getSheets();
  const section = await findDateSection(tab, date);

  if (!section) {
    throw new Error(
      `Date ${date} not found in "${tab}" while updating QRT count`
    );
  }

  const targetLocation = normalizeTruck(qrtLocation);
  const matchingRows = [];

  for (
    let rowNumber = section.startRow;
    rowNumber <= section.endRow;
    rowNumber++
  ) {
    const row = section.rows[rowNumber - 1] || [];

    if (normalizeTruck(row[3]) === targetLocation) {
      matchingRows.push({
        rowNumber,
        truckNumber: clean(row[7])
      });
    }
  }

  if (!matchingRows.length) {
    throw new Error(
      `QRT location "${qrtLocation}" not found for ${date} in "${tab}"`
    );
  }

  const totalTrucks = matchingRows.filter(
    item => item.truckNumber
  ).length;

  const firstRow = matchingRows[0].rowNumber;

  const data = [
    {
      range: `${quoteTab(tab)}!C${firstRow}`,
      values: [[totalTrucks > 0 ? totalTrucks : ""]]
    }
  ];

  // Keep the count only on the first row of this QRT.
  for (const item of matchingRows.slice(1)) {
    data.push({
      range: `${quoteTab(tab)}!C${item.rowNumber}`,
      values: [[""]]
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: REPORT_SHEET_ID,
    valueInputOption: "RAW",
    requestBody: { data }
  });

  clearCache(tab);

  return {
    qrtLocation,
    date,
    totalTrucks,
    firstRow
  };
}

// ======================================================
// WRITE INSPECTION FIELDS G:AR ONLY
// Never overwrite QRT master values in B:F.
// ======================================================

async function writeInspectionFields(tab, rowNumber, values) {
  const sheets = await getSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId: REPORT_SHEET_ID,
    range: `${quoteTab(tab)}!G${rowNumber}:AR${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values]
    }
  });

  clearCache(tab);
}

// ======================================================
// SAVE INSPECTION
// ======================================================

async function saveInspection(payload) {
  if (!payload || typeof payload !== "object") {
    const error = new Error("Inspection data is required");
    error.status = 400;
    throw error;
  }

  const date = parseDate(payload.date);
  const truckNumber = clean(payload.truckNumber);
  const qrtLocation = clean(payload.qrtLocation);
  const checkTime = clean(payload.checkTime);
  const sealNumber = clean(payload.sealNumber);

  if (!date || !truckNumber || !qrtLocation || !checkTime) {
    const error = new Error(
      "Date, truck number, QRT location and check time are required"
    );
    error.status = 400;
    throw error;
  }

  const tab = monthTabFor(date);

  if (!REPORT_TABS.includes(tab)) {
    const error = new Error(
      `Monthly report tab "${tab}" is not configured`
    );
    error.status = 400;
    throw error;
  }

  const targetTruck = normalizeTruck(truckNumber);
  const targetLocation = normalizeTruck(qrtLocation);

  const truck = await getTruckDetails(truckNumber);

  if (!truck.foundInVehicleData) {
    const error = new Error(
      `Truck "${truckNumber}" was not found in ${VEHICLE_TAB}`
    );
    error.status = 404;
    throw error;
  }

  if (!truck.foundInVehicleInfo) {
    const error = new Error(
      `Truck "${truckNumber}" was not found in ${VEHICLE_INFO_TAB}`
    );
    error.status = 404;
    throw error;
  }

  let section = await findDateSection(tab, date);

  if (!section) {
    const error = new Error(
      `Date ${date} was not found in "${tab}". ` +
      "Create the date section and QRT rows first."
    );
    error.status = 400;
    throw error;
  }

  let rows = section.rows;
  let qrtRows = [];

  for (
    let rowNumber = section.startRow;
    rowNumber <= section.endRow;
    rowNumber++
  ) {
    const row = rows[rowNumber - 1] || [];

    if (normalizeTruck(row[3]) === targetLocation) {
      qrtRows.push(rowNumber);
    }
  }

  if (!qrtRows.length) {
    const error = new Error(
      `QRT location "${qrtLocation}" was not found for ${date} in "${tab}".`
    );
    error.status = 400;
    throw error;
  }

  // Prevent duplicate truck + date + QRT entries.
  const duplicateRow = qrtRows.find(rowNumber => {
    const row = rows[rowNumber - 1] || [];
    return normalizeTruck(row[7]) === targetTruck;
  });

  if (duplicateRow) {
    const error = new Error(
      `Truck "${truckNumber}" is already recorded at ` +
      `"${qrtLocation}" on ${date} (row ${duplicateRow}).`
    );
    error.status = 409;
    throw error;
  }

  // Capture B:F from the first QRT row.
  // These values are used only when a new row is needed.
  const firstQrtRow = Math.min(...qrtRows);
  const qrtMasterRow = rows[firstQrtRow - 1] || [];

  const qrtMasterValues = [
    clean(qrtMasterRow[1]), // B: QRT Name
    clean(qrtMasterRow[2]), // C: No. of Trucks (recalculated later)
    clean(qrtMasterRow[3]), // D: QRT Location
    clean(qrtMasterRow[4]), // E: Zone
    clean(qrtMasterRow[5])  // F: QRT Region
  ];

  // Prefer a blank row belonging to this QRT.
  const emptyRow = qrtRows.find(rowNumber => {
    const row = rows[rowNumber - 1] || [];
    return !clean(row[7]); // H: Truck No.
  });

  let targetRow = emptyRow;

  if (!targetRow) {
    // All rows for this QRT already contain a truck.
    const insertAfterRow = Math.max(...qrtRows);

    targetRow = await insertQrtRow({
      section,
      insertAfterRow,
      templateRow: insertAfterRow
    });

    // Explicitly copy B:F into the new row only.
    const sheets = await getSheets();

    await sheets.spreadsheets.values.update({
      spreadsheetId: REPORT_SHEET_ID,
      range: `${quoteTab(tab)}!B${targetRow}:F${targetRow}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [qrtMasterValues]
      }
    });
  }

  // G:AR contains 38 columns.
  // G=0, H=1, ..., T=13, U=14, V=15, W=16,
  // X=17, AB=21, AC=22, AR=37.
  const output = new Array(38).fill("");

  output[0] = "Activated";                  // G
  output[1] = truck.truckNumber;             // H
  output[2] = checkTime;                    // I
  output[3] = truck.type;                    // J
  output[4] = truck.make;                    // K
  output[5] = truck.length;                  // L
  output[6] = truck.tyres;                   // M
  output[7] = toProperCase(truck.consignee); // N
  output[8] = truck.product;                 // O
  output[9] = truck.startingPoint;           // P
  output[10] = truck.destination;            // Q
  output[11] = truck.driverName;             // R
  output[12] = truck.driverMobile;            // S

  output[13] = "Healthy"; // T
  output[14] = "N/A";     // U
  output[15] = "N/A";     // V
  output[16] = "N/A";     // W

  output[17] = truck.overallStatus;   // X
  output[18] = truck.fuelTankStatus;  // Y
  output[19] = truck.lockType;        // Z
  output[20] = truck.sealStatus;      // AA
  output[21] = sealNumber;            // AB

  INSPECTION_DEFAULTS.forEach((value, index) => {
    output[22 + index] = value;       // AC:AR
  });

  // IMPORTANT: B:F are not part of this write.
  await writeInspectionFields(tab, targetRow, output);

  // Recalculate the total trucks for this QRT and date.
  await updateQrtTruckCount(tab, date, qrtLocation);

  // Keep truck and seal numbers formatted as text.
  const metadata = await getReportSheetMetadata(tab);
  const sheets = await getSheets();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: REPORT_SHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: metadata.sheetId,
              startRowIndex: targetRow - 1,
              endRowIndex: targetRow,
              startColumnIndex: 7,
              endColumnIndex: 8
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "TEXT" }
              }
            },
            fields: "userEnteredFormat.numberFormat"
          }
        },
        {
          repeatCell: {
            range: {
              sheetId: metadata.sheetId,
              startRowIndex: targetRow - 1,
              endRowIndex: targetRow,
              startColumnIndex: 27,
              endColumnIndex: 28
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "TEXT" }
              }
            },
            fields: "userEnteredFormat.numberFormat"
          }
        }
      ]
    }
  });

  clearCache(tab);

  return {
    success: true,
    message: emptyRow
      ? "Inspection saved in the existing QRT row."
      : "Inspection saved in a new QRT row.",
    tab,
    rowNumber: targetRow,
    truckNumber: truck.truckNumber,
    date,
    qrtLocation
  };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getQrtLocations,
  getTruckDetails,
  lookupLatestInspection,
  saveInspection
};
