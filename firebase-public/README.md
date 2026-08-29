This directory is deliberately empty of anything the app needs.

Firebase Hosting serves a matching static file *before* it ever checks a
rewrite rule. If this folder contained `index.html`, requests for `/` —
including the game's own WebSocket handshake, which always connects to `/` —
would be answered with the static file and would never reach Cloud Run,
silently breaking every WebSocket connection while the page itself still
loaded and looked fine.

So `firebase.json` points Hosting's `public` at this near-empty folder, its
`**` rewrite sends every request (the WebSocket upgrade included) to Cloud
Run, and the Cloud Run container serves the real static files itself — from
`public/`, via `server/static.js` — exactly as it does when run locally with
`npm start`.
