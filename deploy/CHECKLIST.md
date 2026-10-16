# Ask C4S — sandbox deployment checklist

Target: EC2 `i-01358be98e20d4e01` (`ec2-54-83-232-127.compute-1.amazonaws.com`, Elastic IP `54.83.232.127`), us-east-1.
Path: image published to GHCR by CI, pulled onto the box; HTTPS via Caddy **self-signed** (`TLS_MODE=internal`).

## 0. Publish the image (GitHub)
- [ ] Push this repo to a **private** GitHub repo
- [ ] Confirm the **GHCR package is private** (Packages → the package → Package settings)
- [ ] CI (`.github/workflows/ci.yml`) builds + publishes `ghcr.io/<owner>/ask-c4s:main` on push to `main`
- [ ] Create a **fine-grained PAT**: that one repo only, **read-only** (Contents: Read, Packages: Read), short expiry

## 1. Get the image on the box (EC2 Instance Connect terminal)
- [ ] `echo <PAT> | docker login ghcr.io -u <github-username> --password-stdin`
- [ ] `cd /opt/ask-c4s` and place `deploy/` here (the `docker-compose.yml`, `Caddyfile`), or clone the repo

## 2. Configure
- [ ] `cp deploy/.env.example deploy/.env`
- [ ] Set in `.env`: `ASKC4S_IMAGE=ghcr.io/<owner>/ask-c4s:main`, `SITE_ADDRESS=ec2-54-83-232-127.compute-1.amazonaws.com`, `TLS_MODE=internal`, bootstrap owner email + a strong temp password

## 3. Start
- [ ] `cd deploy && docker compose pull && docker compose up -d`
- [ ] `docker compose ps` → both services **healthy**
- [ ] `curl -k https://localhost/api/health` → `{"ok":true}`

## 4. Certificate (for testers)
- [ ] `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./askc4s-root-ca.crt`
- [ ] Each test machine imports `askc4s-root-ca.crt` into **Windows → Trusted Root Certification Authorities**

## 5. App config (browser → admin page)
- [ ] Open `https://ec2-54-83-232-127.compute-1.amazonaws.com` (after importing the CA)
- [ ] First **owner sign-in** (bootstrap creds) → set a real password → **remove the bootstrap lines from `.env`** and `docker compose up -d`
- [ ] **Re-enter the Anthropic API key** (Settings)
- [ ] **Configure the SAP tenant** (Tenants tab)
- [ ] Create **demouser** + **manager** accounts (strong passwords)

## 6. Extension + end-to-end
- [ ] Extension endpoint → `https://ec2-54-83-232-127.compute-1.amazonaws.com`; add the host permission; reload
- [ ] Sign in → run `/triage` or a KB query → confirm SAP data loads and the AI responds

## 7. Before sharing wider
- [ ] Narrow SG inbound **443** from `0.0.0.0/0` to the corporate CIDR; close **80**
- [ ] Confirm SAP C4C allows API calls from `54.83.232.127`
- [ ] Confirm managed-browser policy allows the extension (IT allowlist/force-install)
- [ ] Revoke the sandbox PAT when done; move to corporate GitHub if this graduates past sandbox

> Switch self-signed → real domain later = set `SITE_ADDRESS=<domain>` and `TLS_MODE=<email>` in `.env`, point DNS at `54.83.232.127`, reopen 80/443, `docker compose up -d`. No image rebuild.
