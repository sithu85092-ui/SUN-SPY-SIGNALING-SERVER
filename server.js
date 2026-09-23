const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const clients = new Map(); // id -> ws
const waiting = [];
const partners = new Map(); // id -> peerId

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function send(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (_) {}
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

    send(wa, {
      type: "match:found",
      peerId: b,
      initiator: true
    });

    send(wb, {
      type: "match:found",
      peerId: a,
      initiator: false
    });
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "SUN SPY Signaling Server",
      waiting: waiting.length,
      connected: clients.size
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", ws => {
  const id = makeId();
  clients.set(id, ws);

  send(ws, {
    type: "server:ready",
    userId: id
  });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      send(ws, { type: "error", message: "Invalid JSON." });
      return;
    }

    const type = String(message.type || "").toLowerCase();

    if (type === "match:join") {
      removeFromWaiting(id);
      if (!partners.has(id)) {
        waiting.push(id);
        send(ws, { type: "match:waiting" });
        tryMatch();
      }
      return;
    }

    if (type === "match:cancel") {
      removeFromWaiting(id);
      disconnectPeer(id, true);
      return;
    }

    if (type === "match:end") {
      removeFromWaiting(id);
      disconnectPeer(id, true);
      return;
    }

    if (type === "report") {
      // Basic relay/report acknowledgement. Add persistent moderation storage later.
      send(ws, { type: "report:received" });
      return;
    }

    if (
      type === "signal:offer" ||
      type === "signal:answer" ||
      type === "signal:ice"
    ) {
      const peerId = partners.get(id) || message.peerId;
      const peer = clients.get(peerId);

      if (!peer || peer.readyState !== peer.OPEN) {
        send(ws, {
          type: "error",
          message: "Partner is no longer connected."
        });
        return;
      }

      const forwarded = {
        ...message,
        peerId: id
      };

      send(peer, forwarded);
      return;
    }
  });

  ws.on("close", () => {
    removeFromWaiting(id);
    disconnectPeer(id, true);
    clients.delete(id);
  });

  ws.on("error", () => {
    removeFromWaiting(id);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`SUN SPY Signaling Server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: /ws`);
});
