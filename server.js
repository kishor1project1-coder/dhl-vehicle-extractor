const path = require("path");

// Load .env from the project root, not from the current working directory.
require("dotenv").config({
  path: path.join(__dirname, ".env")
});

const express = require("express");

const vehicleCheckRoutes = require("./vehicle-check/vehicle-check.routes");
const dhlTokenRoutes = require("./dhl-api-tooken/dhl-token.routes");
const updateVehicleDataRoutes = require("./Update_Vehicle_data/update-vehicle-data.routes");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));

// Serve the static HTML, CSS and JavaScript.
app.use(express.static(path.join(__dirname, "public")));

// Health check.
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "DHL Vehicle Check API is running",
    timestamp: new Date().toISOString()
  });
});

// Existing vehicle-check API.
app.use("/api/vehicle-check", vehicleCheckRoutes);

// DHL token management API.
// GET, POST, PUT and DELETE: /api/dhl-token
app.use("/api/dhl-token", dhlTokenRoutes);

// Fetch latest vehicle data from DHL into Google Sheets.
// POST /api/vehicle-data/refresh        -> run the sync
// GET  /api/vehicle-data/refresh/status -> running flag + last result
app.use("/api/vehicle-data/refresh", updateVehicleDataRoutes);

// Frontend fallback.
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Central error handler.
app.use((err, req, res, next) => {
  console.error("API error:", err.message);

  res.status(err.status || 500).json({
    success: false,
    message:
      err.status && err.status < 500
        ? err.message
        : "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`DHL Vehicle Check running on port ${PORT}`);
});