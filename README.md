# SUN SPY Signaling Server

This server provides:
- Random matching queue
- WebSocket signaling
- WebRTC offer/answer relay
- ICE candidate relay
- Partner disconnect notification
- `/health` endpoint

## Deploy on Render

1. Create a new **Web Service**.
2. Upload/push this folder to GitHub.
3. Build Command:
   `npm install`
4. Start Command:
   `npm start`
5. Use the generated Render HTTPS domain.

If Render gives:
`https://sun-spy-signaling-xxxx.onrender.com`

then the SUN SPY WebSocket URL is:

`wss://sun-spy-signaling-xxxx.onrender.com/ws`

## Connect the SUN SPY frontend

The current SUN SPY frontend supports:

`localStorage.setItem("SUN_SPY_SIGNALING_URL", "wss://YOUR-SERVER.onrender.com/ws");`

Then reload the website.

You can also configure:

`window.SUNSPY_CONFIG = { signalingUrl: "wss://YOUR-SERVER.onrender.com/ws" };`

before `script.js` loads.

## Health test

Open:

`https://YOUR-SERVER.onrender.com/health`

You should see JSON with `"ok": true`.

## Important

This is a signaling server, not a TURN server. The frontend currently uses public STUN servers. For reliable connections across restrictive NAT/mobile networks, add a TURN server later.
