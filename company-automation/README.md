# Company Chromium local automation

This AGPL-3.0 workspace package is an independent, local-only acceptance module. It does not call, remove, or bypass Donut/Wayfern paid automation routes.

## Boundary

- Binds only to `127.0.0.1:45110`.
- Validates the Company Chromium executable by SHA-256 before startup.
- Persists environments and Chromium profiles under `%LOCALAPPDATA%\DonutBrowserCompanyAutomation`.
- Uses Playwright `connectOverCDP` over a random loopback port.
- Uses the custom Chromium native persona for CPU, memory, time zone, locale,
  and language. Playwright does not inject fingerprint overrides into pages.
- Captures a protected first-run baseline for native UA/Client Hints, display,
  WebGL/GPU, Canvas, audio capabilities, and a bounded Windows font set. A
  later launch with a different baseline fails closed instead of silently
  changing the environment identity.
- Starts Chromium with
  `disable_non_proxied_udp` WebRTC handling to prevent direct non-proxy UDP.
- Has no company account, Gateway, transfer, cloud sync, or remote-control dependency.
- Closing the Chromium window releases the in-memory running state immediately. Profile data remains local for the next launch.

## Run

```powershell
pnpm install
pnpm company:automation:build
pnpm company:automation
```

Open <http://127.0.0.1:45110>.

The default runtime is the locally admitted Company Chromium build. To use another build, set both `COMPANY_CHROMIUM_EXE` and `COMPANY_CHROMIUM_SHA256`.

## Local acceptance

1. Create an environment with `https://example.com/`.
2. Open it and confirm Company Chromium starts.
3. Navigate or take a screenshot from the local dashboard.
4. Close the Chromium window and verify the dashboard changes to `closed` within two seconds.
5. Reopen it and confirm the same profile directory is reused.
6. Confirm the fingerprint column reports `原生指纹一致` while running.

The baseline records the real capability of the accepted Windows computer. It
does not invent a GPU, font, media device, Canvas result, or WebGL extension.
Moving an environment to a computer with different native capabilities needs a
separate reviewed migration policy; this local milestone rejects that drift.

This milestone intentionally does not claim cross-machine Profile portability.
