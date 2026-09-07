import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const fixturePort = Number(process.env.HITCH_B2_FIXTURE_PORT);
if (!Number.isInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535) {
  throw new Error("B2 network fixture port is invalid");
}
const fixtureAddress = "8.8.8.8";
const originalDnsLookup = dns.lookup;
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

function hostnameOf(options) {
  if (typeof options === "string" || options instanceof URL) {
    return new URL(options).hostname;
  }
  return options?.hostname ?? options?.host ?? "";
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function fixtureLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (hostname !== "api.tavily.com") {
    const error = new Error(`network fixture DNS denied: ${hostname}`);
    process.nextTick(() => callback(error));
    return;
  }
  process.nextTick(() => {
    if (options?.all) callback(null, [{ address: fixtureAddress, family: 4 }]);
    else callback(null, fixtureAddress, 4);
  });
}

dns.lookup = fixtureLookup;
function deniedHttpRequest(options, callback) {
  const hostname = hostnameOf(options);
  if (!isLoopback(hostname)) {
    throw new Error(`network fixture HTTP denied: ${hostname}`);
  }
  return originalHttpRequest(options, callback);
}

http.request = deniedHttpRequest;
function routedHttpsRequest(options, callback) {
  const hostname = hostnameOf(options);
  if (hostname !== "api.tavily.com") {
    throw new Error(`network fixture HTTPS denied: ${hostname}`);
  }
  const routed =
    typeof options === "object" && !(options instanceof URL)
      ? { ...options }
      : new URL(options);
  routed.hostname = "127.0.0.1";
  routed.host = "127.0.0.1";
  routed.port = fixturePort;
  delete routed.protocol;
  delete routed.agent;
  delete routed.lookup;
  delete routed.rejectUnauthorized;
  delete routed.servername;
  delete routed.ca;
  delete routed.cert;
  delete routed.key;
  delete routed.pfx;
  delete routed.passphrase;
  delete routed.ciphers;
  delete routed.minVersion;
  delete routed.maxVersion;
  delete routed.secureProtocol;
  delete routed.ALPNProtocols;
  return originalHttpRequest(routed, callback);
}

https.request = routedHttpsRequest;
syncBuiltinESMExports();
