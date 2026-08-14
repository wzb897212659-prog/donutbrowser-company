# Company Chromium source kit

This directory carries the reproducible source delta for the Company Chromium
runtime used by Donut Browser. It intentionally does not vendor the Chromium
checkout, build output, profile data, credentials, or browser runtime archive.

## Frozen upstream

- Chromium version: `151.0.7922.76`
- Upstream repository: `https://chromium.googlesource.com/chromium/src.git`
- Base commit: `031bfd60f544af71d8dd7246970d1af3e1acf3ad`
- Supported production target in this source kit: Windows x64

`SOURCE-LOCK.json` binds every changed path to its base and patched SHA-256,
the patch bytes, build arguments, Chromium license, and the locally accepted
runtime executable.

## What the patch contains

- A native, startup-locked company persona for hardware concurrency, device
  memory, time zone, locale, and languages.
- Protection against changing the locked persona through DevTools emulation.
- A Windows portable OSCrypt provider for environment-bound Cookie encryption.
- Strict canonical, profile-owned startup configuration with reparse-point,
  hard-link, path-alias, and mixed-cohort rejection.
- Tests for parsing, startup locking, DevTools rejection, renderer behavior,
  and portable OSCrypt key handling.

The patch does not contain Wayfern paid code, does not emulate its proprietary
CDP domain, and does not bypass Donut Browser feature gates.

## Rebuild on another Windows computer

Install the Chromium build prerequisites and `depot_tools`, then run these from
PowerShell:

```powershell
.\company-chromium\scripts\fetch-source.ps1 -DestinationRoot D:\chromium-company
.\company-chromium\scripts\apply-patches.ps1 -ChromiumSource D:\chromium-company\src
.\company-chromium\scripts\build-windows.ps1 -ChromiumSource D:\chromium-company\src
```

The build is written to `out/Company`. Fetching Chromium is large and slow; a
developer who only needs to integrate Donut Browser should use the separately
published, hash-verified runtime release instead.

## Donut integration boundary

The runtime is launched with a standard Chromium user data directory and
standard CDP. Donut must create the two canonical profile-owned files required
by the runtime and pass `--company-persona-config` for the persona file. Donut
must not call `Wayfern.getFingerprint`, `Wayfern.refreshFingerprint`, or
`Wayfern.setFingerprint` for this runtime.

The DPAPI-wrapped portable OSCrypt envelope is device-local and must never be
uploaded as part of profile sync. The underlying environment key may only move
between devices inside Donut's existing end-to-end encrypted key lifecycle.

## Verification

Run:

```powershell
node .\company-chromium\scripts\verify-source-kit.mjs
```

This verifies the exact file set, hashes, patch path coverage, source lock,
forbidden local paths, and exclusion of build/toolchain directories.

