
const express = require("express");
const router = express.Router();

const {
  getQrtLocations,
  getTruckDetails,
  lookupLatestInspection,
  saveInspection
} = require("./vehicle-check.service");

// ======================================================
// GET QRT LOCATIONS
// GET /api/vehicle-check/options
// ======================================================

router.get("/options", async (req, res, next) => {
  try {
    const qrtLocations = await getQrtLocations();

    return res.status(200).json({
      success: true,
      qrtLocations
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// LOOKUP TRUCK DETAILS + INSPECTION
//
// Default:
// GET /api/vehicle-check/lookup?truckNumber=HR55AD0287
//
// Selected date:
// GET /api/vehicle-check/lookup?truckNumber=HR55AD0287&date=2026-11-01
// ======================================================

router.get("/lookup", async (req, res, next) => {
  try {
    const truckNumber = String(
      req.query.truckNumber || ""
    ).trim();

    const selectedDate = String(
      req.query.date || ""
    ).trim();

    if (!truckNumber) {
      return res.status(400).json({
        success: false,
        message: "Enter a truck number"
      });
    }

    // Validate YYYY-MM-DD and the actual calendar date.
    if (selectedDate) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
      ) {
        return res.status(400).json({
          success: false,
          message: "Date must be in YYYY-MM-DD format"
        });
      }

      const parsedDate = new Date(
        `${selectedDate}T00:00:00.000Z`
      );

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== selectedDate
      ) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid calendar date"
        });
      }
    }

    const [truck, inspection] = await Promise.all([
      getTruckDetails(truckNumber),

      lookupLatestInspection(
        truckNumber,
        selectedDate
      )
    ]);

    return res.status(200).json({
      success: true,
      truck,
      inspection
    });
  } catch (error) {
    next(error);
  }
});

// ======================================================
// SAVE VEHICLE INSPECTION
// POST /api/vehicle-check/save
// ======================================================

router.post("/save", async (req, res, next) => {
  try {
    const result = await saveInspection(
      req.body || {}
    );

    return res.status(201).json({
      success: true,
      message: "Inspection saved successfully",
      data: result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
