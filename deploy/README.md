# Sanhe Donut deployment

Production host: `124.221.228.102`; public URL: `https://browser.sanheqiyun.xyz`.

Before starting, create the DNS A record, a private Tencent COS bucket, and a
least-privilege CAM sub-user. Copy `.env.production.example` to
`.env.production`, fill secrets, and keep it mode `0600`.

On a new host, run `init-secrets.sh` to generate PostgreSQL/JWT/internal
secrets and the one-time initial administrator credential. It deliberately
leaves the three COS values as explicit placeholders.

Replace the placeholders in `cos-cam-policy.json` before attaching it to the
CAM sub-user. Run `configure-cos.sh` once to enforce private access, bucket
versioning, server-side encryption and the 30-day lifecycle policy.

The Nginx config deliberately uses a separate virtual host. It does not modify
the existing `sanheqiyun.xyz` routes or the finance service on port 3000.

Run `docker compose --env-file .env.production build`, then `up -d`. Verify
`http://127.0.0.1:3930/readyz` and `http://127.0.0.1:3929/readyz` before enabling
the Nginx site. Obtain the subdomain certificate with the existing webroot
`/var/www/letsencrypt`, then run `nginx -t` before reload.

## Windows releases

Build on a Windows machine with `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set in the process environment. Tauri
produces the updater artifact and its `.sig` file because
`createUpdaterArtifacts` is enabled. Publish both with:

```powershell
.\deploy\publish-windows-release.ps1 -Version 0.28.3-company.1 `
  -Artifact .\src-tauri\target\release\bundle\nsis\Donut_0.28.3-company.1_x64-setup.exe `
  -Signature .\src-tauri\target\release\bundle\nsis\Donut_0.28.3-company.1_x64-setup.exe.sig
```

The script generates `latest.json`, embeds the Tauri signature, writes a
SHA-256 sidecar, and uploads all three files to the internal HTTPS download
directory.
