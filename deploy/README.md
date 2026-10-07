# Deploying Ask C4S on AWS EC2

One instance, Docker Compose, the published image, Caddy for HTTPS. About 30 minutes.

```
Chrome/Edge extension ─┐
Field app (phone)      ├── https://askc4s.example.com ── Caddy (443) ── ask-c4s-server (3030) ── SAP C4C (OData, 443 out)
Admin page             ┘                                   EC2 instance, one Docker volume
```

## 1. The instance

- **AMI:** Ubuntu 22.04 or 24.04. **Size:** `t3.small` is plenty (Node + SQLite; the work happens in SAP). **Disk:** 20 GB gp3.
- **Elastic IP** attached, and a **DNS A record** (`askc4s.example.com`) pointing at it. Caddy needs the name to resolve before it can get a certificate.
- **Security group inbound:** `443` and `80` from the people who use it (or `0.0.0.0/0`; `80` is only used for the certificate challenge and the redirect), `22` from your admin IP only.
- **Outbound:** HTTPS to the SAP tenant (`*.crm.ondemand.com`), to `ghcr.io` (image pulls), to Let's Encrypt, and — only if the AI features are used — to `api.anthropic.com` / `api.openai.com`. If a corporate proxy sits in between, SAP's hostname must be reachable through it.

## 2. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version
```

## 3. Get the deploy files

Copy this `deploy/` folder to the instance (or clone the repository and `cd deploy`):

```bash
sudo mkdir -p /opt/askc4s && sudo chown $USER /opt/askc4s && cd /opt/askc4s
# docker-compose.yml, Caddyfile, .env.example go here
cp .env.example .env
```

Edit `.env`: `DOMAIN`, `ACME_EMAIL`, `ASKC4S_IMAGE`, and the bootstrap owner email/password (12+ characters; it is temporary). If the GHCR package is private:

```bash
echo <read-only-token> | docker login ghcr.io -u <github-user> --password-stdin
```

## 4. Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f askc4s     # until you see "Ask C4S running at" and "Admin: ENABLED, access by role"
```

Caddy obtains the certificate within a minute of the first request to `https://askc4s.example.com`.

## 5. First sign-in

1. Open `https://askc4s.example.com/settings`, sign in with the bootstrap owner, choose a real password.
2. Remove `ASKC4S_BOOTSTRAP_OWNER_EMAIL` and `ASKC4S_BOOTSTRAP_OWNER_PASSWORD` from `.env`, then `docker compose up -d` (the account already exists; the variables are a no-op from now on, but they shouldn't sit in a file).
3. **Tenants tab** → add the SAP tenant: OData base URL (`https://<tenant>.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi`), integration user, password → **Test connection** → **Add tenant**. It is active immediately. Tag production tenants as `production`: writes then require an explicit confirmation from the client.
4. **Users tab** → add the people: `agent` for everyone who uses the extension or the field app, `admin` for whoever manages settings, tenants and users. Each gets a temporary password shown once.

## 6. Point the clients at it

- **Extension:** Options → Server URL `https://askc4s.example.com` → Save. Chrome asks once to allow the host. Then sign in with the account from step 5.
- **Field app:** `https://askc4s.example.com/` on the phone; "Add to home screen" installs it.

## Day 2

**Backups.** Everything that matters is in the `askc4s-data` volume: users, settings, the encrypted SAP credentials and their key.

```bash
docker run --rm -v askc4s_askc4s-data:/data -v "$PWD":/backup alpine tar czf /backup/askc4s-data-$(date +%F).tgz -C /data .
```

Restore by extracting into the volume the same way (`tar xzf` with the container stopped). The volume name is `<folder>_askc4s-data`; `docker volume ls` shows it.

**Upgrades.** `docker compose pull && docker compose up -d`. The data volume is untouched; the SQLite schema migrates itself at start.

**Logs.** `docker compose logs -f askc4s` (server), `docker compose logs -f caddy` (TLS, requests).

**Lost owner access.** `docker compose exec askc4s node dist/usersCli.js set-owner <email> <temporary-password>`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Browser shows a Caddy certificate error after start | DNS doesn't resolve to this instance yet, or port 80 isn't open. Caddy retries by itself; `docker compose logs caddy`. |
| 502 from Caddy | The server container isn't healthy: `docker compose ps`, then `docker compose logs askc4s`. |
| "Admin disabled" on `/settings` | `ADMIN_ENABLED` was set to something other than `true` in `.env` (the image defaults it on). |
| Sign-in works, lookups fail with "Missing C4C config" | No tenant yet: Tenants tab, step 5.3. |
| Test connection says HTTP 401 | Wrong, expired or locked SAP password — reset it on the SAP side, then Edit the tenant. |
| Extension says it can't reach the server | Options → Server URL must be the `https://` name, and the permission prompt must have been accepted. |

**Terminating TLS elsewhere** (an ALB, an existing nginx): drop the `caddy` service, put `ports: ["3030:3030"]` on `askc4s` and restrict that port to the proxy. The server honours `X-Forwarded-For` for rate limiting.
