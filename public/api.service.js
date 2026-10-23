/* =========================================================
   API SERVICE
   Every call to the backend lives here. app.js imports the
   functions it needs, so URLs, headers and error handling
   are defined in exactly one place.
========================================================= */

const ENDPOINTS = {
  health: "/api/health",
  qrtOptions: "/api/vehicle-check/options",
  truckLookup: "/api/vehicle-check/lookup",
  saveInspection: "/api/vehicle-check/save",
  dhlToken: "/api/dhl-token",
  vehicleDataRefresh: "/api/vehicle-data/refresh",
  vehicleDataStatus: "/api/vehicle-data/refresh/status"
};

/** Error thrown by every API call. */
export class ApiError extends Error {
  constructor(message, { status = 0, authError = false, data = {} } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.authError = authError; // true when DHL rejected the token
    this.data = data;
  }
}

/**
 * Shared request helper.
 * Returns the parsed JSON body, or throws ApiError.
 * Reads the error text from `message` or `error`.
 */
async function request(url, { method = "GET", body, timeoutMs } = {}) {
  let response;

  try {
    response = await fetch(url, {
      method,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (error) {
    throw new ApiError(
      error.name === "TimeoutError"
        ? "The request took too long. Please try again."
        : "Could not reach the server. Check your connection."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    throw new ApiError(
      data.message || data.error || `Request failed (${response.status})`,
      {
        status: response.status,
        authError: Boolean(data.authError),
        data
      }
    );
  }

  return data;
}

/* ---------------- Health ---------------- */

export function getHealth() {
  return request(ENDPOINTS.health);
}

/* ---------------- Vehicle inspection ---------------- */

export function getQrtLocations() {
  return request(ENDPOINTS.qrtOptions);
}

export function lookupTruckDetails(truckNumber, date) {
  const params = new URLSearchParams({ truckNumber });

  if (date) params.set("date", date);

  return request(`${ENDPOINTS.truckLookup}?${params.toString()}`);
}

export function saveInspection(payload) {
  return request(ENDPOINTS.saveInspection, {
    method: "POST",
    body: payload
  });
}

/* ---------------- DHL token management ---------------- */

export function getDhlTokenStatus() {
  return request(ENDPOINTS.dhlToken);
}

export function addDhlToken(token) {
  return request(ENDPOINTS.dhlToken, {
    method: "POST",
    body: { token }
  });
}

export function updateDhlToken(token) {
  return request(ENDPOINTS.dhlToken, {
    method: "PUT",
    body: { token }
  });
}

export function deleteDhlToken() {
  return request(ENDPOINTS.dhlToken, { method: "DELETE" });
}

/* ---------------- Vehicle data sync ---------------- */

export function refreshVehicleData() {
  // The sync reads the DHL API and writes Google Sheets, so allow
  // up to 3 minutes before giving up.
  return request(ENDPOINTS.vehicleDataRefresh, {
    method: "POST",
    timeoutMs: 180000
  });
}

export function getVehicleDataStatus() {
  return request(ENDPOINTS.vehicleDataStatus);
}