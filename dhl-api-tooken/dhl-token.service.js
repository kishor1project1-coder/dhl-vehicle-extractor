
const { google } = require("googleapis");

const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const tabName =
  process.env.GOOGLE_SHEET_DHL_API_TOKEN_TAB || "DHL_API_Token";

const cellRange = `'${tabName.replace(/'/g, "''")}'!A2`;

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let sheetsPromise;
let cachedToken = "";
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

async function getSheets() {
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEET_ID is missing");
  }

  if (!sheetsPromise) {
    sheetsPromise = auth.getClient().then((client) =>
      google.sheets({ version: "v4", auth: client })
    );
  }

  return sheetsPromise;
}

async function readStoredToken() {
  const sheets = await getSheets();

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: cellRange,
  });

  return String(result.data.values?.[0]?.[0] || "").trim();
}

async function getToken({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() < cacheExpiresAt
  ) {
    return cachedToken;
  }

  const token = await readStoredToken();

  cachedToken = token;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return token;
}

async function getStatus() {
  const token = await getToken({ forceRefresh: true });

  return {
    configured: Boolean(token),
    masked: token
      ? `${"*".repeat(Math.min(8, token.length))}${token.slice(-4)}`
      : null,
  };
}

async function saveToken(token, { onlyIfMissing = false } = {}) {
  if (typeof token !== "string") {
    throw new Error("Token must be a string");
  }

  const value = token.trim();

  if (!value || value.length > 10000) {
    throw new Error("Provide a valid token");
  }

  const sheets = await getSheets();

  // Use a Google Sheets batch update to prevent accidental overwrite
  // when adding a token that already exists.
  if (onlyIfMissing) {
    const current = await readStoredToken();

    if (current) {
      const error = new Error("A token already exists; use PUT to update it");
      error.statusCode = 409;
      throw error;
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: cellRange,
    valueInputOption: "RAW",
    requestBody: {
      values: [[value]],
    },
  });

  cachedToken = value;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return { success: true };
}

async function deleteToken() {
  const sheets = await getSheets();

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: cellRange,
    requestBody: {},
  });

  cachedToken = "";
  cacheExpiresAt = 0;

  return { success: true };
}

module.exports = {
  getToken,
  getStatus,
  saveToken,
  deleteToken,
};
