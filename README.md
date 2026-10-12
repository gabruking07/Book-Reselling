# Book Reselling

Server-rendered book catalog and order workflow using Node.js, Express, EJS, the MongoDB Node driver, Bootstrap, and jQuery.

## Requirements

- Node.js 20.12+ (or 24.x) and npm
- MongoDB 4.4+ (local or hosted)

## Install and configure

From the project root:

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` and set `MONGODB_URI` and `SESSION_SECRET` (a unique random value of at least 32 characters). Admin login uses the account documents already stored in MongoDB's `admin_detail` collection; administrator email addresses and passwords do not belong in environment variables. Do not commit `.env`.

On macOS/Linux, copy the example with `cp .env.example .env`.

## Run

```powershell
npm start
```

Open `http://localhost:3000`. `PORT` can change the listening port. The server does not start listening until it connects to MongoDB and completes startup checks. `/health` reports service readiness.

## Tests

```powershell
npm test
```

Tests use an in-memory Mongo-like collection fixture and Express's in-memory session store; they do not connect to or modify a real database. The direct `node:test` invocation avoids child-process spawning, which may be restricted in managed Windows environments.

## Existing account password migration

Customer and administrator documents using the old `pwd` field remain intact until that account next signs in. A successful legacy plaintext-password check upgrades that individual record to `password_hash` using bcrypt and removes only its `pwd` field. No bulk migration runs, and account records are not deleted. Back up the database before deployment as usual. New customer and administrator passwords are only stored as bcrypt hashes.

## Sessions and administrator setup

Sessions are persisted in the existing MongoDB database's `sessions` collection. The cookie is HTTP-only, SameSite=Lax, and Secure automatically for HTTPS requests. Set `TRUST_PROXY=1` when hosted behind a trusted single reverse proxy so Express can detect HTTPS. Production startup requires `SESSION_SECRET`.

Public customer registration remains available. Public administrator registration has been removed; provision the first administrator directly in MongoDB's `admin_detail` collection, then an administrator can create additional administrators from the protected `/admin_registration` page. Admin documents can use `email_id` plus `password_hash` (bcrypt) or the legacy `email_id` plus `pwd` fields; successful legacy login upgrades the password to `password_hash`.

## Uploads and hosting

Book images continue to use `express-fileupload` and are stored in `public/book_img` with generated names. The server accepts JPEG, PNG, GIF, and WebP image signatures up to 5 MB. Existing image paths remain valid. Before mounting a new persistent disk over that directory, copy any existing book images into the disk so they remain visible.

`render.yaml` targets Render and starts the Express process normally. Local uploads on Render's default filesystem can be lost when an instance restarts or is redeployed; configure a persistent disk on a plan that supports it and mount it for `public/book_img` before relying on uploads in production. Vercel's serverless filesystem is not durable or generally writable, so the existing `vercel.json` does not make local image uploads production-persistent there. The existing MongoDB-backed session store works across server instances when all instances share the same database.

For Vercel, add `MONGODB_URI`, `MONGODB_DB_NAME`, and a 32+ character `SESSION_SECRET` to the project's Environment Variables for the production deployment (and Preview if testing previews). The checked-in local `.env` is ignored by Git and is not automatically copied into Vercel's runtime environment. Confirm the MongoDB provider permits connections from the deployed function. Startup failures return a generic 503 page; the function log records a sanitized reason.

### Environment variable names

`PORT`, `NODE_ENV`, `MONGODB_URI`, `MONGODB_DB_NAME`, `SESSION_SECRET`, `TRUST_PROXY`, and optional `MONGODB_CONNECT_TIMEOUT_MS`. Admin login credentials are stored in MongoDB, not environment settings.
