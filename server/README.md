# CampusFallback server

Express app that serves:

- `POST /api/timestamp`: seals a SHA-256 with FreeTSA and stores the receipt in MongoDB Atlas.
- `GET /api/receipt/:sha256`: returns the receipt and checks it again with `openssl ts -verify`.
- `POST /api/draft-email` and `POST /api/digest`: Gemini drafts, with built-in templates as a fallback.
- `/` (landing page) and `/verify` (professor drops a file; it is hashed in the browser and never uploaded).

It only ever receives hashes and short metadata.

## Run locally

```bash
cd server
cp .env.example .env     # fill in GEMINI_API_KEY and MONGODB_URI
npm install
npm run dev              # http://localhost:3000, verify page at /verify
```

## Deploy to Vultr (Ubuntu 24.04, Caddy, pm2)

In the commands below, replace `your-domain.example` with the GoDaddy domain and `203.0.113.10` with the Vultr IP.

### 1. Create the server

Vultr → Deploy → Cloud Compute → Ubuntu 24.04 → the smallest plan is enough. Copy its IPv4 address.

### 2. Point the GoDaddy domain at it

GoDaddy → My Products → the domain → **DNS** → DNS Records:

- Edit the existing **A** record named `@` (GoDaddy's "Parked" record): Value `203.0.113.10`, TTL 600 seconds.
- Make sure **CNAME** `www` points to `@`, or add an **A** `www` → `203.0.113.10`.
- Delete any other `A` / `AAAA` records for `@`, or Caddy's HTTPS check can hit the wrong server.

Check from your laptop (it can take a few minutes):

```bash
dig +short your-domain.example        # must print 203.0.113.10
```

### 3. Allow the server in MongoDB Atlas

Atlas → Security → **Network Access** → Add IP Address → `203.0.113.10/32` → Confirm.

### 4. Install Node 20, openssl, pm2 and Caddy on the server

```bash
ssh root@203.0.113.10

apt-get update && apt-get install -y curl ca-certificates gnupg openssl rsync ufw

# Node 20 (the code also runs on Node 22 if the 20.x repo is unavailable: use setup_22.x)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v                                # v20.12 or newer

npm install -g pm2

# Caddy (official apt repository)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Firewall: SSH and HTTPS only. Port 3000 stays private behind Caddy.
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw --force enable
```

If the Vultr dashboard has a firewall group attached, allow 22, 80 and 443 there too.

### 5. Copy the app to the server

From your laptop, in the `campusfallback` folder (`.env` and `node_modules` stay behind):

```bash
rsync -av --exclude node_modules --exclude .env server/ root@203.0.113.10:/opt/campusfallback/server/
```

Then on the server:

```bash
cd /opt/campusfallback/server
npm ci --omit=dev
cp .env.example .env && nano .env
```

Set these in `.env`:

| Variable | Production value |
| --- | --- |
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | `https://your-domain.example` (goes into every verify link and professor email) |
| `GEMINI_API_KEY` | your key from https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | same as local, e.g. `gemini-3.5-flash-lite,gemini-3.6-flash` |
| `MONGODB_URI` | the Atlas `mongodb+srv://…/campusfallback` string |
| `ALLOWED_ORIGINS` | `chrome-extension://leojplfopmmgfldnbdalehcokjldbdcp,https://your-domain.example` |

The extension ID is fixed by the `key` in `extension/manifest.json`, so this origin stays the same on every laptop it is loaded on.

```bash
chmod 600 .env
```

### 6. Start the app with pm2 and put Caddy in front

```bash
cd /opt/campusfallback/server
pm2 start src/index.js --name campusfallback
pm2 save
pm2 startup systemd -u root --hp /root      # starts pm2 again after a reboot
curl -s localhost:3000/api/health           # {"ok":true,"store":"mongodb","storeReachable":true,...}

sed 's/your-domain\.example/YOUR-REAL-DOMAIN/g' Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 30 --no-pager        # look for "certificate obtained successfully"
```

### 7. Check it from your laptop

```bash
curl -s https://your-domain.example/api/health
curl -s -X POST https://your-domain.example/api/timestamp -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$(echo hello | shasum -a 256 | cut -d' ' -f1)\"}"
open https://your-domain.example/verify
```

### 8. Point the extension at the domain

- `extension/lib/config.js`: set `PROD_API_BASE = 'https://your-domain.example'` and `API_TARGET = 'prod'`.
- `extension/manifest.json`: add `"https://your-domain.example/*"` to `host_permissions`.
- In `chrome://extensions`, click reload on CampusFallback.

If the server is unreachable during judging, set `API_TARGET = 'local'`, run `npm run dev` here and reload the extension.

### Updating after a code change

```bash
rsync -av --exclude node_modules --exclude .env server/ root@203.0.113.10:/opt/campusfallback/server/
ssh root@203.0.113.10 'cd /opt/campusfallback/server && npm ci --omit=dev && pm2 restart campusfallback'
```

Logs: `pm2 logs campusfallback` (method, path and status only; request bodies are never logged).
