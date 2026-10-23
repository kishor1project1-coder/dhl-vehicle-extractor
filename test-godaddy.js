
const LOGIN_URL =
  "https://sso.godaddy.com/v1/api/pass/login";

async function testGoDaddyEndpoint() {
  const url = new URL(LOGIN_URL);

  // Use the non-sensitive parameters from your captured request.
  url.searchParams.set("domain", "d4g.co.in");
  url.searchParams.set("realm", "pass");
  url.searchParams.set("app", "o365");
  url.searchParams.set("wa", "wsignin1.0");
  url.searchParams.set(
    "wtrealm",
    "urn:federation:MicrosoftOnline"
  );

  console.log("Testing GoDaddy login endpoint...");
  console.log("Host:", url.host);
  console.log("Path:", url.pathname);
  console.log("\nSending a diagnostic request...");

  try {
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        "Origin": "https://sso.godaddy.com",
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(15000),
      redirect: "manual"
    });

    console.log("\nHTTP status:", response.status);
    console.log("Status text:", response.statusText);
    console.log(
      "Content-Type:",
      response.headers.get("content-type") || "(none)"
    );
    console.log(
      "Allow:",
      response.headers.get("allow") || "(not provided)"
    );
    console.log(
      "Access-Control-Allow-Origin:",
      response.headers.get("access-control-allow-origin") ||
        "(not provided)"
    );

    console.log(
      "\nThis is only a connectivity/CORS diagnostic."
    );
    console.log(
      "It does not authenticate your account or obtain a token."
    );
  } catch (error) {
    console.error("\nRequest failed:", error.message);
  }
}

testGoDaddyEndpoint();
