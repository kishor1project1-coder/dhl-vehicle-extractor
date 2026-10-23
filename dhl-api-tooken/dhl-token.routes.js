
const express = require("express");
const {
  getDhlToken,
  updateDhlToken,
  clearDhlTokenCache,
} = require("../config/dhl-token");

const router = express.Router();

// GET /api/dhl-token
// Returns status only; never exposes the token.
router.get("/", async (req, res) => {
  try {
    const token = await getDhlToken(true);

    res.json({
      success: true,
      configured: Boolean(token),
      masked: token
        ? `${"*".repeat(Math.min(8, token.length))}${token.slice(-4)}`
        : null,
    });
  } catch (error) {
    console.error("DHL token status error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to read DHL token from Google Sheets",
    });
  }
});

// POST /api/dhl-token
// Add a token only when the sheet cell is empty.
router.post("/", async (req, res) => {
  try {
    let currentToken = "";

    try {
      currentToken = await getDhlToken(true);
    } catch (error) {
      if (!error.message.includes("missing from the token sheet")) {
        throw error;
      }
    }

    if (currentToken) {
      return res.status(409).json({
        success: false,
        message: "A DHL token already exists. Use PUT to update it.",
      });
    }

    await updateDhlToken(req.body?.token);

    res.status(201).json({
      success: true,
      message: "DHL token added successfully",
    });
  } catch (error) {
    console.error("DHL token add error:", error.message);

    res.status(400).json({
      success: false,
      message: "Unable to add DHL token",
    });
  }
});

// PUT /api/dhl-token
// Replace the existing token.
router.put("/", async (req, res) => {
  try {
    await updateDhlToken(req.body?.token);

    res.json({
      success: true,
      message: "DHL token updated successfully",
    });
  } catch (error) {
    console.error("DHL token update error:", error.message);

    res.status(400).json({
      success: false,
      message: "Unable to update DHL token",
    });
  }
});

// DELETE /api/dhl-token
// Clears the stored token cell without deleting the tab.
router.delete("/", async (req, res) => {
  try {
    const { google } = require("googleapis");

    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const tabName =
      process.env.GOOGLE_SHEET_DHL_API_TOKEN_TAB || "DHL_API_Token";

    const cell = `'${tabName.replace(/'/g, "''")}'!A2`;

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: cell,
      requestBody: {},
    });

    clearDhlTokenCache();

    res.json({
      success: true,
      message: "DHL token deleted successfully",
    });
  } catch (error) {
    console.error("DHL token delete error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to delete DHL token",
    });
  }
});

module.exports = router;
