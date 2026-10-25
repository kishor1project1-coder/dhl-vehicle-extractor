import {
  getHealth,
  getQrtLocations,
  lookupTruckDetails,
  saveInspection,
  getDhlTokenStatus,
  updateDhlToken,
  deleteDhlToken,
  refreshVehicleData
} from "/api.service.js";

const $ = id => document.getElementById(id);

let lookupTimer;
let requestNumber = 0;
let isSaving = false;
let isTokenBusy = false;
let isSyncing = false;

function showMessage(message, type = "success") {
  const element = $("formMessage");
  element.textContent = message;
  element.className = `message ${type}`;
}

function hideMessage() {
  $("formMessage").className = "message hidden";
  $("formMessage").textContent = "";
}

function showTokenMessage(message, type = "success") {
  const element = $("tokenMessage");
  element.textContent = message;
  element.className = `message ${type}`;
}

function hideTokenMessage() {
  $("tokenMessage").className = "message hidden";
  $("tokenMessage").textContent = "";
}

function showSyncMessage(message, type = "success") {
  const element = $("syncMessage");
  element.textContent = message;
  element.className = `message ${type}`;
}

function hideSyncMessage() {
  $("syncMessage").className = "message hidden";
  $("syncMessage").textContent = "";
}

function localDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function localTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function setText(id, value) {
  $(id).textContent = value || "—";
}

function showTruck(truck) {
  $("truckEmpty").classList.add("hidden");
  $("truckDetails").classList.remove("hidden");

  setText("driverName", truck.driverName);
  setText("driverMobile", truck.driverMobile);
  setText("truckType", truck.type);
  setText("truckMake", truck.make);
  setText("startingPoint", truck.startingPoint);
  setText("destination", truck.destination);
  setText("consignee", truck.consignee);
  setText("product", truck.product);
}

function clearTruck() {
  $("truckEmpty").classList.remove("hidden");
  $("truckDetails").classList.add("hidden");

  [
    "driverName", "driverMobile", "truckType", "truckMake",
    "startingPoint", "destination", "consignee", "product"
  ].forEach(id => setText(id, ""));
}

async function loadHealth() {
  try {
    await getHealth();
    $("apiStatus").textContent = "API connected";
    $("apiStatus").style.background = "#e7f7ed";
  } catch {
    $("apiStatus").textContent = "API unavailable";
    $("apiStatus").style.background = "#fdecec";
  }
}

async function loadQrtLocations() {
  const select = $("qrtLocation");

  select.replaceChildren(new Option("Loading locations…", ""));
  select.disabled = true;

  try {
    const result = await getQrtLocations();

    select.replaceChildren(new Option("Select QRT location", ""));

    (result.qrtLocations || []).forEach(location => {
      select.add(new Option(location, location));
    });

    if (!result.qrtLocations?.length) {
      select.replaceChildren(new Option("No QRT locations found", ""));
    }
  } catch (error) {
    select.replaceChildren(
      new Option("Unable to load locations — refresh to retry", "")
    );
    showMessage(`Could not load QRT locations: ${error.message}`, "error");
  } finally {
    select.disabled = false;
  }
}

async function lookupTruck() {
  if (isSaving) return;

  const truckNumber = $("truckNumber").value.trim();
  const selectedDate = $("date").value;
  const currentRequest = ++requestNumber;

  hideMessage();
  $("inspectionNotice").classList.add("hidden");
  $("inspectionNotice").textContent = "";
  clearTruck();

  if (truckNumber.length < 3) {
    $("lookupStatus").textContent = "Enter a truck number to look up details.";
    return;
  }

  $("lookupStatus").textContent = "Searching inspections…";

  try {
    const result = await lookupTruckDetails(truckNumber, selectedDate);

    if (currentRequest !== requestNumber) return;

    const truck = result.truck;
    const inspection = result.inspection;

    if (truck.foundInVehicleData || truck.foundInVehicleInfo) {
      showTruck(truck);
    }

    if (inspection.found && inspection.latestInspection) {
      const latest = inspection.latestInspection;
      $("sealNumber").value = latest.sealNumber || "";

      $("lookupStatus").textContent =
        `Inspection found: ${latest.date} · ${latest.qrtLocation || latest.tab}`;

      $("inspectionNotice").textContent = latest.sealNumber
        ? `Previous seal: ${latest.sealNumber}. Confirm before saving.`
        : `Inspection found on ${latest.date}, but its seal number is blank.`;

      $("inspectionNotice").classList.remove("hidden");
    } else {
      $("lookupStatus").textContent =
        `No inspection found for ${selectedDate || "the recent date window"}.`;
    }

    if (!truck.foundInVehicleData && !truck.foundInVehicleInfo) {
      $("lookupStatus").textContent =
        "Truck not found in Vehicle_data or Vehicle_Info.";
    }
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    $("lookupStatus").textContent = `Lookup failed: ${error.message}`;
  }
}

function scheduleLookup() {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(lookupTruck, 300);
}

$("truckNumber").addEventListener("input", scheduleLookup);
$("truckNumber").addEventListener("change", lookupTruck);
$("date").addEventListener("change", lookupTruck);

// Check time is a plain 24-hour text field: digits only, colon added
// automatically (1430 -> 14:30).
$("checkTime").addEventListener("input", () => {
  const digits = $("checkTime").value.replace(/\D/g, "").slice(0, 4);

  $("checkTime").value =
    digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
});

$("inspectionForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (isSaving) return;

  hideMessage();

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test($("checkTime").value.trim())) {
    showMessage(
      "Enter the check time in 24-hour format, for example 09:30 or 14:30.",
      "error"
    );
    $("checkTime").focus();
    return;
  }

  const button = $("saveButton");
  const payload = {
    date: $("date").value,
    qrtLocation: $("qrtLocation").value,
    truckNumber: $("truckNumber").value.trim(),
    checkTime: $("checkTime").value,
    sealNumber: $("sealNumber").value.trim()
  };

  isSaving = true;
  button.disabled = true;
  button.textContent = "Saving…";

  try {
    const result = await saveInspection(payload);

    const savedTab = result.data?.tab || "";
    const savedRow = result.data?.rowNumber || "";

    $("inspectionForm").reset();
    $("date").value = localDateValue();
    $("checkTime").value = localTimeValue();
    $("qrtLocation").value = "";
    $("truckNumber").value = "";
    $("sealNumber").value = "";
    $("lookupStatus").textContent = "Lookup starts automatically.";

    $("inspectionNotice").classList.add("hidden");
    $("inspectionNotice").textContent = "";
    clearTruck();
    hideMessage();

    showMessage(
      `Inspection saved successfully to ${savedTab}, row ${savedRow}. Form cleared.`,
      "success"
    );
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    isSaving = false;
    button.disabled = false;
    button.textContent = "Save inspection";
  }
});

$("inspectionForm").addEventListener("reset", () => {
  requestNumber++;
  clearTimeout(lookupTimer);

  setTimeout(() => {
    $("date").value = localDateValue();
    $("checkTime").value = localTimeValue();
    $("truckNumber").value = "";
    $("sealNumber").value = "";
    $("qrtLocation").value = "";
    $("lookupStatus").textContent = "Lookup starts automatically.";
    $("inspectionNotice").classList.add("hidden");
    $("inspectionNotice").textContent = "";
    clearTruck();
    hideMessage();
  }, 0);
});

/* =========================================
   VEHICLE DATA SYNC (Fetch latest data)
========================================= */

async function fetchLatestVehicleData() {
  if (isSyncing) return;

  isSyncing = true;

  const button = $("fetchLatestBtn");
  button.disabled = true;
  button.classList.add("loading");
  button.textContent = "Fetching…";
  $("syncStatus").textContent = "Running… this can take a minute";
  hideSyncMessage();
  $("goToTokenBtn").classList.add("hidden");

  try {
    const data = await refreshVehicleData();

    $("syncStatus").textContent = `Last sync: ${data.finishedAt}`;

    $("statUpdated").textContent = data.updated;
    $("statAdded").textContent = data.added;
    $("statUnique").textContent = data.uniqueVehicles;
    $("statConsignees").textContent = data.consigneeCount;
    $("syncStats").classList.remove("hidden");

    showSyncMessage(
      `Vehicle data updated. ${data.updated} updated, ${data.added} added ` +
      `(${data.uniqueVehicles} unique vehicles, ${data.consigneeCount} consignees).`,
      "success"
    );

    // Refresh the truck details on screen if a truck is already entered.
    if ($("truckNumber").value.trim().length >= 3) {
      lookupTruck();
    }
  } catch (error) {
    $("syncStatus").textContent = "Last run failed";
    $("syncStats").classList.add("hidden");
    $("goToTokenBtn").classList.toggle("hidden", !error.authError);

    showSyncMessage(
      error.authError
        ? "DHL rejected the API token. Update it in the DHL API Token Management section below, then try again."
        : `Sync failed: ${error.message}`,
      "error"
    );
  } finally {
    isSyncing = false;
    button.disabled = false;
    button.classList.remove("loading");
    button.textContent = "Fetch latest data";
  }
}

$("fetchLatestBtn").addEventListener("click", fetchLatestVehicleData);
$("goToTokenBtn").addEventListener("click", () => selectTab("token"));

/* =========================================
   DHL TOKEN MANAGEMENT
========================================= */

function setTokenBusy(busy) {
  isTokenBusy = busy;
  $("updateDhlToken").disabled = busy;
  $("deleteDhlToken").disabled = busy;
  $("refreshTokenStatus").disabled = busy;
}

async function loadDhlTokenStatus() {
  $("dhlTokenStatus").textContent = "Checking…";
  $("dhlTokenStatus").dataset.state = "";

  try {
    const result = await getDhlTokenStatus();

    $("dhlTokenStatus").textContent = result.configured
      ? `Configured${result.masked ? ` (${result.masked})` : ""}`
      : "Not configured";

    const state = result.configured ? "ok" : "missing";
    $("dhlTokenStatus").dataset.state = state;
    $("tokenTabDot").dataset.state = state;
  } catch (error) {
    $("dhlTokenStatus").textContent = "Unable to check status";
    $("dhlTokenStatus").dataset.state = "";
    $("tokenTabDot").dataset.state = "";
    showTokenMessage(`Could not load token status: ${error.message}`, "error");
  }
}

$("dhlTokenForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (isTokenBusy) return;

  const token = $("dhlTokenInput").value.trim();

  if (!token) {
    showTokenMessage("Please enter the new DHL token.", "error");
    return;
  }

  setTokenBusy(true);

  try {
    const result = await updateDhlToken(token);

    $("dhlTokenInput").value = "";
    showTokenMessage(result.message || "DHL token updated successfully.");
    await loadDhlTokenStatus();
  } catch (error) {
    showTokenMessage(`Token update failed: ${error.message}`, "error");
  } finally {
    setTokenBusy(false);
  }
});

$("deleteDhlToken").addEventListener("click", async () => {
  if (isTokenBusy) return;

  const confirmed = window.confirm(
    "Delete the stored DHL API token? Vehicle extraction will fail until a valid token is added."
  );

  if (!confirmed) return;

  setTokenBusy(true);

  try {
    const result = await deleteDhlToken();

    $("dhlTokenInput").value = "";
    showTokenMessage(result.message || "DHL token deleted successfully.");
    await loadDhlTokenStatus();
  } catch (error) {
    showTokenMessage(`Token deletion failed: ${error.message}`, "error");
  } finally {
    setTokenBusy(false);
  }
});

$("refreshTokenStatus").addEventListener("click", loadDhlTokenStatus);

$("toggleTokenVisibility").addEventListener("click", () => {
  const input = $("dhlTokenInput");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggleTokenVisibility").textContent = show ? "Hide" : "Show";
});

/* =========================================
   TABS
========================================= */

const TAB_NAMES = ["inspection", "sync", "token"];

function selectTab(name, updateHash = true) {
  if (!TAB_NAMES.includes(name)) name = "inspection";

  TAB_NAMES.forEach(tabName => {
    const active = tabName === name;
    const button = $(`tabBtn-${tabName}`);

    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $(`tab-${tabName}`).classList.toggle("hidden", !active);
  });

  if (updateHash) {
    history.replaceState(null, "", `#${name}`);
  }
}

TAB_NAMES.forEach(tabName => {
  $(`tabBtn-${tabName}`).addEventListener("click", () => selectTab(tabName));
});

// Left/Right arrow keys move between tabs.
document.querySelector(".tabs").addEventListener("keydown", event => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;

  const current = TAB_NAMES.findIndex(
    tabName => $(`tabBtn-${tabName}`).getAttribute("aria-selected") === "true"
  );
  const step = event.key === "ArrowRight" ? 1 : -1;
  const next = TAB_NAMES[(current + step + TAB_NAMES.length) % TAB_NAMES.length];

  selectTab(next);
  $(`tabBtn-${next}`).focus();
});

selectTab(location.hash.replace("#", ""), false);

$("date").value = localDateValue();
$("checkTime").value = localTimeValue();

loadHealth();
loadQrtLocations();
loadDhlTokenStatus();