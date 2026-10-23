// C:\Users\Admin\Desktop\dhl-vehicle-extractor\config\dhl-token.js
const path = require("path");
const { google } = require("googleapis");

const PROJECT_ROOT = path.resolve(__dirname, "..");

// Safe to call even if the caller already loaded .env (it never overrides).
require("dotenv").config({
  path: path.join(PROJECT_ROOT, ".env"),
  quiet: true,
});

const CACHE_TTL_MS = 30_000;

let sheetsPromise;
let cachedToken = "";
let cacheExpiresAt = 0;

function getSheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("GOOGLE_SHEET_ID is missing");
  return id;
}

function getTokenCell() {
  const tab = process.env.GOOGLE_SHEET_DHL_API_TOKEN_TAB || "DHL_API_Token";
  return `'${tab.replace(/'/g, "''")}'!A2`;
}

function getKeyFile() {
  return path.resolve(
    PROJECT_ROOT,
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "service-account.json"
  );
}

async function getSheets() {
  if (!sheetsPromise) {
    const auth = new google.auth.GoogleAuth({
      keyFile: getKeyFile(),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheetsPromise = auth
      .getClient()
      .then((client) => google.sheets({ version: "v4", auth: client }))
      .catch((error) => {
        sheetsPromise = undefined; // allow a retry on the next call
        throw error;
      });
  }

  return sheetsPromise;
}

async function getDhlToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cacheExpiresAt) {
    return cachedToken;
  }

  const spreadsheetId = getSheetId();
  const sheets = await getSheets();

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: getTokenCell(),
  });

  const token = String(result.data.values?.[0]?.[0] || "").trim();

  if (!token) {
    throw new Error("DHL token is missing from the token sheet");
  }

  cachedToken = token;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return token;
}

async function updateDhlToken(newToken) {
  const token = typeof newToken === "string" ? newToken.trim() : "";

  if (!token || token.length > 10000) {
    throw new Error("A valid DHL token is required");
  }

  const spreadsheetId = getSheetId();
  const sheets = await getSheets();

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: getTokenCell(),
    valueInputOption: "RAW",
    requestBody: {
      values: [[token]],
    },
  });

  cachedToken = token;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return { success: true };
}

function clearDhlTokenCache() {
  cachedToken = "";
  cacheExpiresAt = 0;
}

module.exports = {
  getDhlToken,
  updateDhlToken,
  clearDhlTokenCache,
};