# ADALIGO API · @eco

The API serves the static GitHub Pages frontend and stores data with Prisma. MongoDB is the default provider; PostgreSQL remains supported.

## Local setup

1. Copy `api/.env.example` to `api/.env` and set `DATABASE_URL` to your MongoDB connection string.
2. Set `MUSIC_SYNC_SECRET` to a new random secret. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL` using a GitHub OAuth App. For local development, set the callback URL to `http://localhost:8787/auth/github/callback`.
4. Set `FRONTEND_URL=http://localhost:5173` and `ALLOWED_ORIGINS=http://localhost:5173`.
5. From the repository root, install the API dependencies if needed, then create the MongoDB collections and indexes:

   ```sh
   npm --prefix api install
   npm --prefix api run db:push:mongodb
   npm --prefix api run dev
   ```

6. In the root `.env` file, set `VITE_API_BASE_URL=http://localhost:8787`, then run the frontend with `npm run dev`.

The OAuth callback URL in the GitHub OAuth App must exactly match `GITHUB_CALLBACK_URL`. Use a separate OAuth App for production if its callback URL differs.

## GitHub registration and sign-in

Open the **Protected users** link in the frontend and choose **Continue with GitHub**. The first successful sign-in creates a user record; subsequent sign-ins update that same record. There is no separate password or registration form.

The API stores the GitHub account ID, username, available profile name/email, avatar URL, and profile URL in MongoDB's `protected_users` collection. It does not store GitHub access tokens. Login sessions are stored in `protected_user_sessions`; only a SHA-256 hash of each random session token is persisted. The browser receives the opaque token in an HTTP-only cookie.

To see a registered user in MongoDB Atlas, open the cluster's **Browse Collections** view, select the database named in `DATABASE_URL`, and open `protected_users`. A record appears after that user's first successful sign-in. Session hashes are in the separate `protected_user_sessions` collection.

The protected-users HTML/JavaScript is necessarily public because the frontend is static. User data is protected by the API session check, not by hiding the page or its source files.

## Production setup

- GitHub Pages can host the frontend but cannot run this Node API. Keep the GitHub Pages sites and deploy this API as one long-running Node.js service (for example, Railway or Render). Do not deploy the SSE relay as a Vercel serverless function; the event stream and in-memory playback lease require a persistent single API instance.
- Configure the API host with `PORT` (usually provided by the host), `DATABASE_PROVIDER=mongodb`, `DATABASE_URL`, `MUSIC_SYNC_SECRET`, `ALLOWED_ORIGINS`, `FRONTEND_URL`, and the GitHub OAuth variables if GitHub sign-in is used. Do not put database credentials, `MUSIC_SYNC_SECRET`, or `GITHUB_CLIENT_SECRET` in frontend variables or source control.
- For Railway, create a Node service from the ADALIGO website repository and leave the root directory at the repository root. Set the build command to `npm ci --prefix api && npm run build --prefix api` and the start command to `npm start --prefix api`; the API depends on the repository root package, so deploying only the `api` subdirectory will not work. Keep one running replica for the in-memory SSE relay and leases. Attach a MongoDB Atlas database and set `DATABASE_URL` to its MongoDB connection string.
- Run `npm run db:push:mongodb` from the API directory during setup. The API creates the `music_sync_tracks` collection/index and GridFS bucket collections (`music_sync_audio.files` and `music_sync_audio.chunks`) when needed. MongoDB stores shared track metadata and uploaded audio; `MUSIC_SYNC_SECRET` HMAC-hashes room identifiers before storing them.
- Set the frontend build variable `VITE_API_BASE_URL` to the API's HTTPS origin when using API-backed sign-in, and set `VITE_MUSIC_SYNC_URL` to that same API origin for music sync. Both are public build-time URLs, not secrets.
- Add the same `VITE_MUSIC_SYNC_URL` GitHub Actions **repository variable** to every Pages repository that includes the music player. The existing Pages workflows read `vars.VITE_MUSIC_SYNC_URL`; changing the variable requires rebuilding/redeploying each site. If the repositories share a GitHub organization, use an organization Actions variable instead.
- Set `ALLOWED_ORIGINS` to the exact HTTPS origins of every deployed Pages site, comma-separated (for example, `https://adaligo.github.io,https://noaouahbi.github.io`). Do not use wildcard origins. Include local development origins only where needed.
- Set the GitHub OAuth App callback URL to the API callback endpoint, for example `https://api.example.com/auth/github/callback`.
- PostgreSQL remains supported for the existing API data, but the shared audio library currently requires MongoDB/GridFS. For PostgreSQL, set `DATABASE_URL` to a PostgreSQL connection string and run `npm --prefix api run db:migrate:postgres`; use MongoDB for this music-sync deployment.

### Music sync behavior and privacy

- Pairing codes are private bearer credentials. Anyone with the code can control playback and view, download, or delete tracks in that room. Share the code only with people you trust.
- Connecting a site to a room uploads that browser's saved audio URLs and imported audio files to the shared room. Audio files are limited to 100 MB each. Disconnecting stops future syncing but does not delete tracks already stored in the room; remove them from the library or delete the MongoDB collections to erase them.
- Public playlist entries are not copied. Browser-local imports remain in the browser as well as being uploaded to the room. Shared audio is streamed from MongoDB GridFS.
- The sync server keeps active SSE connections, playback state, and the 10-second playback lease in process memory. Use one persistent API instance; horizontal scaling requires shared pub/sub and distributed leases before adding replicas.
- GitHub Pages does not provide server environment variables. `VITE_MUSIC_SYNC_URL` is compiled into public JavaScript and must only contain the API URL. All credentials stay on the Node API host.

Production sign-in uses secure cross-site cookies when the frontend and API are on different sites. Some browsers restrict third-party cookies, so a custom frontend/API domain arrangement under the same site is more reliable than unrelated domains.

## Endpoints

- `GET /healthz` — API health.
- `GET /auth/github` — starts GitHub OAuth.
- `GET /auth/github/callback` — validates OAuth state, upserts the user, and creates a session.
- `GET /api/auth/me` — returns the signed-in profile or `401`.
- `POST /api/auth/logout` — deletes the current session.
- `GET /api/profile-clicks` — returns the existing profile-click counter.
- `POST /api/profile-clicks` — increments the existing profile-click counter.
- `GET /v1/events` — server-sent events for paired playback state, commands, and library changes.
- `POST /v1/lease` and `POST /v1/command` — paired playback coordination and remote controls.
- `GET`/`PUT /v1/library` — list and sync paired saved links and track metadata.
- `PUT /v1/library/{trackId}/file` — upload a shared audio track (100 MB maximum).
- `GET /v1/library/audio/{trackId}` — stream a shared audio track; `DELETE /v1/library/{trackId}` removes it from the room.

The browser must make `/api/auth/me` and `/api/auth/logout` requests with credentials enabled. Configure `ALLOWED_ORIGINS` with the exact frontend origin so the API can allow credentialed CORS requests.
