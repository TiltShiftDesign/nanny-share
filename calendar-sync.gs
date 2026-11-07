/**
 * Nanny Share Hours → Google Calendar, one-way, once a day.
 *
 * Setup (once):
 *  1. script.google.com → New project → paste this file over Code.gs.
 *  2. Project Settings (gear) → Script properties → add
 *       SYNC_EMAIL     = the timesheet login email to sync with
 *       SYNC_PASSWORD  = its password
 *  3. Pick the function `install` at the top and click Run. Approve the
 *     calendar permission when asked. That runs one sync and schedules
 *     a daily one between 8 and 9 pm.
 *
 * Pick `syncNow` and Run any time you want to push changes right away.
 */

var FIREBASE_API_KEY = "AIzaSyA8kPit0yUP_8emv3Jtmuak-9-kew5rhTg";
var PROJECT_ID = "nanny-share-42170";
var CALENDAR_ID = "32c8bbf70fa7d12b1dd20160e0c00dc686fee503283ee8c6c15d04be8cc4f178@group.calendar.google.com";
var TZ = "America/Los_Angeles";
var DAYS_AHEAD = 90;
var TAG = "Synced from Nanny Share Hours";
var HOUSES = ["MacArthur", "Crandall"];
var DEFAULT_ROT = { days: [2, 3, 4], anchor: "2026-11-08", house: "MacArthur" };

function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncNow") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncNow").timeBased().everyDays(1).atHour(20).inTimezone(TZ).create();
  syncNow();
}

function syncNow() {
  var token = signIn_();
  var cfg = readDoc_(token, "config/main") || {};
  var rot = cfg.rot ? {
    days: cfg.rot.days || DEFAULT_ROT.days,
    anchor: cfg.rot.anchor || DEFAULT_ROT.anchor,
    house: HOUSES.indexOf(cfg.rot.house) >= 0 ? cfg.rot.house : DEFAULT_ROT.house
  } : DEFAULT_ROT;
  var sched = readCollection_(token, "schedule");

  var today = noon_(new Date());
  var end = addDays_(today, DAYS_AHEAD);
  var wantHouse = {};   // dateKey -> house name
  var offs = [];        // {start, end(exclusive), title, desc}
  var run = null;
  for (var d = new Date(today); d < end; d = addDays_(d, 1)) {
    var k = key_(d), s = sched[k] || {};
    var h = houseFor_(d, s, rot);
    if (h) wantHouse[k] = h;
    if (s.title) {
      var title = s.kind === "off" && !/no care/i.test(s.title) ? s.title + " - No Care" : s.title;
      var desc = (s.detail ? s.detail + "\n" : "") + TAG;
      if (run && run.title === title && run.desc === desc && key_(run.end) === k) run.end = addDays_(d, 1);
      else { run = { start: new Date(d), end: addDays_(d, 1), title: title, desc: desc }; offs.push(run); }
    } else run = null;
  }

  var cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error("Calendar not found. Is this Google account allowed to edit it?");
  var events = cal.getEvents(today, end);
  var created = 0, updated = 0, deleted = 0;

  // --- house events: one per date, correct house ---
  var seenHouse = {};
  events.forEach(function (ev) {
    var t = ev.getTitle(), which = /MacArthur House/i.test(t) ? "MacArthur" : /Crandall House/i.test(t) ? "Crandall" : null;
    if (!which) return;
    var k = key_(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime());
    if (!wantHouse[k] || seenHouse[k]) { ev.deleteEvent(); deleted++; return; }
    seenHouse[k] = true;
    if (which !== wantHouse[k]) { ev.setTitle("🏠" + wantHouse[k] + " House"); updated++; }
  });
  Object.keys(wantHouse).forEach(function (k) {
    if (seenHouse[k]) return;
    var ev = cal.createAllDayEvent("🏠" + wantHouse[k] + " House", fromKey_(k));
    ev.setTransparency(CalendarApp.EventTransparency.TRANSPARENT);
    created++;
  });

  // --- time-off events: tagged ones are ours; adopt an untagged one on the same start date ---
  var others = events.filter(function (ev) { return !/MacArthur House|Crandall House/i.test(ev.getTitle()); });
  var tagged = others.filter(function (ev) { return (ev.getDescription() || "").indexOf(TAG) >= 0; });
  var untagged = others.filter(function (ev) { return (ev.getDescription() || "").indexOf(TAG) < 0; });
  var used = [];
  offs.forEach(function (o) {
    var sk = key_(o.start);
    var ev = pick_(tagged, used, function (e) { return key_(e.isAllDayEvent() ? e.getAllDayStartDate() : e.getStartTime()) === sk; })
          || pick_(untagged, used, function (e) { return key_(e.isAllDayEvent() ? e.getAllDayStartDate() : e.getStartTime()) === sk; });
    if (!ev) { cal.createAllDayEvent(o.title, o.start, o.end).setDescription(o.desc); created++; return; }
    var same = ev.isAllDayEvent() && key_(ev.getAllDayStartDate()) === sk && key_(ev.getAllDayEndDate()) === key_(o.end)
            && ev.getTitle() === o.title && (ev.getDescription() || "") === o.desc;
    if (!same) { ev.setAllDayDates(o.start, o.end); ev.setTitle(o.title); ev.setDescription(o.desc); updated++; }
  });
  tagged.forEach(function (ev) { if (used.indexOf(ev) < 0) { ev.deleteEvent(); deleted++; } });

  var msg = "Nanny calendar sync: " + created + " created, " + updated + " updated, " + deleted + " deleted (" + Object.keys(wantHouse).length + " house days, " + offs.length + " time-off entries in the next " + DAYS_AHEAD + " days).";
  Logger.log(msg);
  return msg;
}

/* ---------- rotation ---------- */
function houseFor_(d, s, rot) {
  if (s.house === "none") return null;
  if (s.house && HOUSES.indexOf(s.house) >= 0) return s.house;
  if (s.kind === "off") return null;
  var dow = d.getDay();
  if (rot.days.indexOf(dow) < 0) return null;
  var weekStart = addDays_(d, -dow), a = fromKey_(rot.anchor), anchorWeek = addDays_(a, -a.getDay());
  var n = Math.round((weekStart - anchorWeek) / (7 * 864e5));
  var first = rot.house, other = HOUSES[1 - HOUSES.indexOf(first)];
  return ((n % 2) + 2) % 2 === 0 ? first : other;
}

/* ---------- Firebase (REST) ---------- */
function signIn_() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty("SYNC_EMAIL"), pass = props.getProperty("SYNC_PASSWORD");
  if (!email || !pass) throw new Error("Add SYNC_EMAIL and SYNC_PASSWORD under Project Settings → Script properties.");
  var r = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIREBASE_API_KEY, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({ email: email, password: pass, returnSecureToken: true })
  });
  var j = JSON.parse(r.getContentText());
  if (!j.idToken) throw new Error("Firebase sign-in failed: " + (j.error && j.error.message));
  return j.idToken;
}
function fsGet_(token, path) {
  var r = UrlFetchApp.fetch("https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/" + path,
    { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() >= 300) throw new Error("Firestore read failed (" + r.getResponseCode() + "): " + r.getContentText());
  return JSON.parse(r.getContentText());
}
function readDoc_(token, path) { var d = fsGet_(token, path); return d && d.fields ? fromFields_(d.fields) : null; }
function readCollection_(token, coll) {
  var out = {}, pageToken = "";
  do {
    var j = fsGet_(token, coll + "?pageSize=300" + (pageToken ? "&pageToken=" + pageToken : "")) || {};
    (j.documents || []).forEach(function (d) { out[d.name.split("/").pop()] = fromFields_(d.fields || {}); });
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}
function fromFields_(f) { var o = {}; Object.keys(f).forEach(function (k) { o[k] = fromValue_(f[k]); }); return o; }
function fromValue_(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return fromFields_(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue_);
  return null;
}

/* ---------- dates (all in Pacific, anchored at noon so DST can't shift a day) ---------- */
function key_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd"); }
function fromKey_(k) { var p = k.split("-"); return new Date(p[0], p[1] - 1, p[2], 12); }
function noon_(d) { return fromKey_(key_(d)); }
function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function pick_(list, used, test) {
  for (var i = 0; i < list.length; i++) if (used.indexOf(list[i]) < 0 && test(list[i])) { used.push(list[i]); return list[i]; }
  return null;
}
