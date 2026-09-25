const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const admin = require("firebase-admin");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "sithu85092@gmail.com").trim().toLowerCase();
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "https://sithu85092-ui.github.io").replace(/\/$/, "");

function initFirebase() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const firebaseApp = initFirebase();
const auth = admin.auth(firebaseApp);
const db = admin.firestore(firebaseApp);

const clients = new Map();
const waiting = [];
const partners = new Map();

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function send(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(message)); } catch (_) {}
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  });
  res.end(JSON.stringify(data));
}

function removeFromWaiting(id) {
  const i = waiting.indexOf(id);
  if (i !== -1) waiting.splice(i, 1);
}

function disconnectPeer(id, notify = true) {
  const peerId = partners.get(id);
  partners.delete(id);
  if (peerId) {
    partners.delete(peerId);
    const peer = clients.get(peerId);
    if (notify) send(peer, { type: "match:left" });
  }
}

function tryMatch() {
  while (waiting.length >= 2) {
    const a = waiting.shift();
    const b = waiting.shift();
    const wa = clients.get(a);
    const wb = clients.get(b);

    if (!wa || wa.readyState !== wa.OPEN) {
      if (wb && wb.readyState === wb.OPEN) waiting.unshift(b);
      continue;
    }
    if (!wb || wb.readyState !== wb.OPEN) {
      waiting.unshift(a);
      continue;
    }

    partners.set(a, b);
    partners.set(b, a);
    send(wa, { type: "match:found", peerId: b, initiator: true });
    send(wb, { type: "match:found", peerId: a, initiator: false });
  }
}

async function verifyRequest(req, requireAdmin = false) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) throw new Error("Missing Firebase ID token.");
  const token = header.slice(7).trim();
  const decoded = await auth.verifyIdToken(token, true);
  if (requireAdmin && decoded.admin !== true) throw new Error("Admin access denied.");
  return decoded;
}

async function bootstrapAdminClaim() {
  if (!ADMIN_EMAIL) return;
  try {
    const user = await auth.getUserByEmail(ADMIN_EMAIL);
    const current = user.customClaims || {};
    if (current.admin !== true) {
      await auth.setCustomUserClaims(user.uid, { ...current, admin: true });
      console.log(`Admin claim granted to ${ADMIN_EMAIL}. User must refresh/login again.`);
    } else {
      console.log(`Admin claim already active for ${ADMIN_EMAIL}.`);
    }
  } catch (err) {
    console.warn(`Admin bootstrap skipped: ${err.message}`);
  }
}

async function upsertUser(decoded, body = {}) {
  const ref = db.collection("users").doc(decoded.uid);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : {};
  const data = {
    uid: decoded.uid,
    email: decoded.email || existing.email || "",
    username: String(body.username || existing.username || (decoded.email || "user").split("@")[0]),
    photoURL: String(body.photoURL || existing.photoURL || ""),
    disabled: existing.disabled === true,
    coins: Number(existing.coins || 0),
    plan: existing.plan || "Free",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp()
  };
  await ref.set(data, { merge: true });
  return { ...data, createdAt: undefined, updatedAt: undefined };
}

async function audit(adminUser, action, targetUid, details = {}) {
  await db.collection("auditLogs").add({
    adminUid: adminUser.uid,
    adminEmail: adminUser.email || "",
    action,
    targetUid: targetUid || null,
    details,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function listUsers(search = "") {
  const result = [];
  let pageToken;
  const q = search.trim().toLowerCase();
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      const username = String(u.displayName || "").toLowerCase();
      const email = String(u.email || "").toLowerCase();
      const uid = String(u.uid || "").toLowerCase();
      if (!q || username.includes(q) || email.includes(q) || uid.includes(q)) {
        const doc = await db.collection("users").doc(u.uid).get();
        const data = doc.exists ? doc.data() : {};
        result.push({
          uid: u.uid,
          email: u.email || "",
          username: u.displayName || data.username || "User",
          photoURL: u.photoURL || data.photoURL || "",
          disabled: !!u.disabled,
          emailVerified: !!u.emailVerified,
          coins: Number(data.coins || 0),
          plan: data.plan || "Free",
          vipLevel: Number(data.vipLevel || 0),
          avatarFrame: data.avatarFrame || "none",
          matchingEffect: data.matchingEffect || "none",
          entranceEffect: data.entranceEffect || "none",
          giftsReceived: Array.isArray(data.giftsReceived) ? data.giftsReceived : []
        });
      }
      if (result.length >= 100) return result;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return result;
}

async function handleApi(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path === "/health" || path === "/") {
    return json(res, 200, {
      ok: true,
      service: "SUN SPY Signaling + Admin API",
      waiting: waiting.length,
      connected: clients.size,
      adminEmail: ADMIN_EMAIL
    });
  }

  if (path === "/api/me" && req.method === "POST") {
    try {
      const user = await verifyRequest(req, false);
      const body = await readJson(req);
      const profile = await upsertUser(user, body);
      return json(res, 200, { ok: true, user: profile });
    } catch (err) {
      return json(res, 401, { error: err.message });
    }
  }

  if (!path.startsWith("/api/admin/")) return json(res, 404, { error: "Not found" });

  let adminUser;
  try {
    adminUser = await verifyRequest(req, true);
  } catch (err) {
    return json(res, 403, { error: err.message });
  }

  try {
    if (path === "/api/admin/me" && req.method === "GET") {
      return json(res, 200, { ok: true, admin: true, uid: adminUser.uid, email: adminUser.email || "" });
    }

    if (path === "/api/admin/stats" && req.method === "GET") {
      const users = await auth.listUsers(1000);
      let totalCoins = 0;
      const userDocs = await db.collection("users").get();
      userDocs.forEach(doc => { totalCoins += Number(doc.data().coins || 0); });
      const reportsSnap = await db.collection("reports").where("status", "==", "open").get().catch(() => ({ size: 0 }));
      return json(res, 200, { ok: true, users: users.users.length, coins: totalCoins, reports: reportsSnap.size || 0, live: partners.size / 2 });
    }

    if (path === "/api/admin/users" && req.method === "GET") {
      const users = await listUsers(url.searchParams.get("q") || "");
      return json(res, 200, { ok: true, users });
    }


    const detailMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (detailMatch && req.method === "GET") {
      const targetUid = decodeURIComponent(detailMatch[1]);
      const u = await auth.getUser(targetUid);
      const doc = await db.collection("users").doc(targetUid).get();
      const data = doc.exists ? doc.data() : {};
      return json(res, 200, { ok: true, user: {
        uid: u.uid, email: u.email || "", username: u.displayName || data.username || "User", photoURL: u.photoURL || data.photoURL || "",
        disabled: !!u.disabled, emailVerified: !!u.emailVerified, coins: Number(data.coins || 0), plan: data.plan || "Free",
        vipLevel: Number(data.vipLevel || 0), avatarFrame: data.avatarFrame || "none", matchingEffect: data.matchingEffect || "none", entranceEffect: data.entranceEffect || "none",
        giftsReceived: Array.isArray(data.giftsReceived) ? data.giftsReceived : []
      }});
    }

    const profileMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/profile$/);
    if (profileMatch && req.method === "POST") {
      const targetUid = decodeURIComponent(profileMatch[1]);
      const body = await readJson(req);
      await auth.getUser(targetUid);
      const allowedPlans = new Set(["Free","VIP","Premium"]);
      const patch = {
        vipLevel: Math.max(0, Math.min(10, Number(body.vipLevel || 0))),
        plan: allowedPlans.has(String(body.plan)) ? String(body.plan) : "Free",
        avatarFrame: String(body.avatarFrame || "none").slice(0, 40),
        matchingEffect: String(body.matchingEffect || "none").slice(0, 40),
        entranceEffect: String(body.entranceEffect || "none").slice(0, 40),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection("users").doc(targetUid).set(patch, { merge: true });
      await audit(adminUser, "user.profile.update", targetUid, patch);
      return json(res, 200, { ok: true, uid: targetUid, profile: patch });
    }

    const giftsMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/gifts$/);
    if (giftsMatch && req.method === "POST") {
      const targetUid = decodeURIComponent(giftsMatch[1]);
      const body = await readJson(req);
      const gift = { id: String(body.id || "gift"), icon: String(body.icon || "🎁"), name: String(body.name || "Gift"), count: Math.max(1, Number(body.count || 1)) };
      const ref = db.collection("users").doc(targetUid); const snap = await ref.get(); const data = snap.exists ? snap.data() : {};
      const gifts = Array.isArray(data.giftsReceived) ? data.giftsReceived.slice() : []; const i = gifts.findIndex(x => x.id === gift.id);
      if (i >= 0) gifts[i] = { ...gifts[i], ...gift, count: Number(gifts[i].count || 0) + gift.count }; else gifts.push(gift);
      await ref.set({ giftsReceived: gifts, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await audit(adminUser, "user.gift.grant", targetUid, gift);
      return json(res, 200, { ok: true, gifts });
    }

    const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/(coins|status)$/);

    if (userMatch && req.method === "POST") {
      const targetUid = decodeURIComponent(userMatch[1]);
      const action = userMatch[2];
      const body = await readJson(req);
      const userRecord = await auth.getUser(targetUid);
      const ref = db.collection("users").doc(targetUid);

      if (action === "coins") {
        const delta = Number(body.delta || 0);
        if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000) {
          return json(res, 400, { error: "Invalid coin delta." });
        }
        let newCoins = 0;
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const current = Number(snap.exists ? snap.data().coins || 0 : 0);
          newCoins = Math.max(0, current + delta);
          tx.set(ref, {
            uid: targetUid,
            email: userRecord.email || "",
            username: userRecord.displayName || "User",
            coins: newCoins,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: snap.exists && snap.data().createdAt ? snap.data().createdAt : admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await db.collection("coinTransactions").add({ targetUid, delta, balanceAfter: newCoins, reason: String(body.reason || "Admin adjustment"), adminUid: adminUser.uid, adminEmail: adminUser.email || "", createdAt: admin.firestore.FieldValue.serverTimestamp() });
        await audit(adminUser, "coins.adjust", targetUid, { delta, balanceAfter: newCoins, reason: body.reason || "" });
        return json(res, 200, { ok: true, uid: targetUid, coins: newCoins });
      }

      const disabled = body.disabled === true;
      await auth.updateUser(targetUid, { disabled });
      await ref.set({ disabled, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await audit(adminUser, disabled ? "user.disable" : "user.enable", targetUid);
      return json(res, 200, { ok: true, uid: targetUid, disabled });
    }

    if (path === "/api/admin/audit" && req.method === "GET") {
      const snap = await db.collection("auditLogs").orderBy("createdAt", "desc").limit(100).get();
      return json(res, 200, { ok: true, logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    }

    if (path === "/api/admin/reports" && req.method === "GET") {
      const snap = await db.collection("reports").orderBy("createdAt", "desc").limit(100).get().catch(() => ({ docs: [] }));
      return json(res, 200, { ok: true, reports: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    }

    return json(res, 404, { error: "Admin endpoint not found" });
  } catch (err) {
    console.error("Admin API error:", err);
    return json(res, 500, { error: err.message || "Server error" });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith("/api/") || req.url === "/" || req.url === "/health") return handleApi(req, res);
  json(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  const id = makeId();
  clients.set(id, ws);
  send(ws, { type: "server:ready", userId: id });

  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch (_) { return send(ws, { type: "error", message: "Invalid JSON." }); }

    const type = String(message.type || "").toLowerCase();
    if (type === "match:join") {
      removeFromWaiting(id);
      if (!partners.has(id)) { waiting.push(id); send(ws, { type: "match:waiting" }); tryMatch(); }
      return;
    }
    if (type === "match:cancel" || type === "match:end") {
      removeFromWaiting(id); disconnectPeer(id, true); return;
    }
    if (type === "report") {
      const peerId = partners.get(id) || message.peerId || null;
      db.collection("reports").add({ reporterConnectionId: id, reportedConnectionId: peerId, reason: String(message.reason || "user_report"), status: "open", createdAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      send(ws, { type: "report:received" });
      return;
    }
    if (type === "signal:offer" || type === "signal:answer" || type === "signal:ice") {
      const peerId = partners.get(id) || message.peerId;
      const peer = clients.get(peerId);
      if (!peer || peer.readyState !== peer.OPEN) return send(ws, { type: "error", message: "Partner is no longer connected." });
      send(peer, { ...message, peerId: id });
    }
  });

  ws.on("close", () => { removeFromWaiting(id); disconnectPeer(id, true); clients.delete(id); });
  ws.on("error", () => removeFromWaiting(id));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`SUN SPY server listening on ${PORT}`);
  console.log(`WebSocket endpoint: /ws`);
  bootstrapAdminClaim();
});
