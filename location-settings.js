/*
 * location-settings.js — stateless save-interceptor for iOS Location Spoofer.
 *
 * Runs as an http-REQUEST script on gs-loc.apple.com/ils-settings/… and answers the
 * request itself (never hits Apple). It writes the picked point into THIS device's own
 * $persistentStore, using the exact keys location-spoofer.js already reads via
 * enrichArgsFromPluginStore: `latitude`, `longitude`, `altitude`, `enabled`.
 *
 * Nothing is stored server-side, so one public picker page can be shared by any number of
 * people — each person writes only their own device. `enabled` gates spoofing: cleared /
 * never-picked → enabled=false → location-spoofer.js passes through the real location
 * (this pairs with DEFAULT_CONFIG.enabled=false in location-spoofer.js).
 *
 *   GET …/ils-settings/save?lat=&lon=&alt=   → store coords (+altitude) and enable
 *   GET …/ils-settings/save?action=query      → return the device's current stored point
 *   GET …/ils-settings/save?action=clear      → enabled=false (restore real location)
 *
 * Supported clients: Surge / Shadowrocket / Loon / Stash / Egern ($persistentStore) and
 * Quantumult X ($prefs).
 *
 * CSRF guard: when an allowed origin is configured (module argument `origin=https://…`, or
 * injected by the Worker when it serves this file), a request whose Origin / Referer does
 * not match is refused and CORS is limited to that origin. Requests with neither header
 * (iOS Shortcuts "Get Contents of URL") are still allowed unless a browser marks them as
 * cross-site via Sec-Fetch-Site. With no origin configured the old open behaviour is kept.
 */
(function () {
  "use strict";

  var isQuanX = typeof $task !== "undefined";

  function readKey(k) {
    try {
      return isQuanX ? $prefs.valueForKey(k) : $persistentStore.read(k);
    } catch (e) {
      return null;
    }
  }
  function writeKey(k, v) {
    try {
      return isQuanX ? $prefs.setValueForKey(String(v), k) : $persistentStore.write(String(v), k);
    } catch (e) {
      return false;
    }
  }

  function parseQuery(url) {
    var out = {};
    var qi = url.indexOf("?");
    if (qi < 0) return out;
    var parts = url.slice(qi + 1).split("&");
    for (var i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf("=");
      var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
      var v = eq < 0 ? "" : parts[i].slice(eq + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) {}
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  function finiteNum(s) {
    if (s == null || s === "") return NaN;
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  // Replaced by the Worker with JSON of its own origin when serving /location-settings.js.
  var INJECTED_ORIGIN = /*__ILS_ALLOWED_ORIGIN__*/"";

  function originOf(u) {
    var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(u || "").trim());
    return m ? m[1].toLowerCase().replace(/\/+$/, "") : "";
  }

  function getHeader(headers, name) {
    if (!headers) return "";
    var lname = name.toLowerCase();
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === lname) {
        return headers[k] == null ? "" : String(headers[k]);
      }
    }
    return "";
  }

  // Module argument (Surge/Loon/Stash/Shadowrocket) wins over the Worker-injected origin.
  function configuredOrigin() {
    var arg = typeof $argument !== "undefined" && $argument ? $argument : "";
    if (arg && typeof arg === "object") arg = arg.origin || "";
    var fromArg = typeof arg === "string" ? originOf(parseQuery("?" + arg).origin || "") : "";
    return fromArg || originOf(INJECTED_ORIGIN);
  }

  // true = request may proceed.
  function originAllowed(allowed, headers) {
    if (!allowed) return true; // nothing configured: backward compatible (open)
    var origin = getHeader(headers, "Origin");
    if (origin && origin !== "null") return originOf(origin) === allowed;
    var referer = getHeader(headers, "Referer");
    if (referer) return originOf(referer) === allowed;
    if (origin === "null") return false;
    // No Origin and no Referer: non-browser clients (iOS Shortcuts) land here. A browser
    // that stripped the Referer still sends Sec-Fetch-Site, so refuse anything but "none".
    var sfs = getHeader(headers, "Sec-Fetch-Site").toLowerCase();
    return !sfs || sfs === "none" || sfs === "same-origin";
  }

  var req = typeof $request !== "undefined" && $request ? $request : {};
  var url = req.url || "";
  var q = parseQuery(url);
  var action = q.action || "save";
  var result;
  var status = 200;
  var allowedOrigin = configuredOrigin();

  if (!originAllowed(allowedOrigin, req.headers)) {
    status = 403;
    result = { success: false, error: "來源網域不允許" };
  } else if (action === "query") {
    var qlat = readKey("latitude");
    var qlon = readKey("longitude");
    var qalt = readKey("altitude");
    var qen = readKey("enabled");
    var qhacc = readKey("horizontalAccuracy");
    var qvacc = readKey("verticalAccuracy");
    var qrr = readKey("randomRadius");
    if (qlat != null && qlat !== "" && qlon != null && qlon !== "") {
      result = {
        success: true,
        latitude: Number(qlat),
        longitude: Number(qlon),
        altitude: qalt != null && qalt !== "" ? Number(qalt) : null,
        horizontalAccuracy: qhacc != null && qhacc !== "" ? Number(qhacc) : null,
        verticalAccuracy: qvacc != null && qvacc !== "" ? Number(qvacc) : null,
        randomRadius: qrr != null && qrr !== "" ? Number(qrr) : null,
        enabled: String(qen) === "true"
      };
    } else {
      result = { success: false, error: "尚未儲存座標" };
    }
  } else if (action === "clear") {
    writeKey("enabled", "false");
    result = { success: true };
  } else {
    var lon = finiteNum(q.lon != null ? q.lon : q.longitude);
    var lat = finiteNum(q.lat != null ? q.lat : q.latitude);
    var alt = finiteNum(q.alt != null ? q.alt : q.altitude);
    var hacc = finiteNum(q.hacc != null ? q.hacc : q.horizontalAccuracy);
    var vacc = finiteNum(q.vacc != null ? q.vacc : q.verticalAccuracy);
    var rr = finiteNum(q.rr != null ? q.rr : q.randomRadius);
    if (isFinite(lon) && isFinite(lat) && (Math.abs(lat) > 90 || Math.abs(lon) > 180)) {
      result = { success: false, error: "經緯度超出範圍" };
    } else if (isFinite(lon) && isFinite(lat)) {
      writeKey("latitude", String(lat));
      writeKey("longitude", String(lon));
      if (isFinite(alt)) writeKey("altitude", String(Math.round(alt)));
      if (isFinite(hacc)) writeKey("horizontalAccuracy", String(Math.round(hacc)));
      if (isFinite(vacc)) writeKey("verticalAccuracy", String(Math.round(vacc)));
      // randomRadius: 0 is a valid value (off), so write whenever the picker sends it.
      if (isFinite(rr)) writeKey("randomRadius", String(Math.max(0, Math.round(rr))));
      writeKey("enabled", "true");
      result = { success: true, latitude: lat, longitude: lon };
      if (isFinite(alt)) result.altitude = Math.round(alt);
      if (isFinite(hacc)) result.horizontalAccuracy = Math.round(hacc);
      if (isFinite(vacc)) result.verticalAccuracy = Math.round(vacc);
      if (isFinite(rr)) result.randomRadius = Math.max(0, Math.round(rr));
    } else {
      result = { success: false, error: "缺少 lat/lon 參數" };
    }
  }

  var headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
  if (allowedOrigin) headers["Vary"] = "Origin";
  var body = JSON.stringify(result);

  if (isQuanX) {
    $done({ status: status === 200 ? "HTTP/1.1 200 OK" : "HTTP/1.1 403 Forbidden", headers: headers, body: body });
  } else {
    $done({ response: { status: status, headers: headers, body: body } });
  }
})();
