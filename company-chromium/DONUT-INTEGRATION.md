# Donut Browser integration handoff

## Goal

Add Company Chromium as a new Donut browser implementation without deleting or
changing the existing Wayfern path, sync server API, account system, proxy
storage, or team permissions.

## Required implementation

1. Add a distinct internal browser identifier such as `company-chromium`.
2. Add a runtime downloader/registry entry whose archive and member hashes are
   verified before publication beneath Donut's browser binary directory.
3. Add a `company_chromium_manager.rs` launch adapter. Reuse Donut's existing
   profile path, local proxy, process monitoring, close handling, and standard
   CDP connection, but do not invoke any `Wayfern.*` CDP command.
4. Before every launch, create the exact profile-owned startup cohort below.
5. Pass both `--user-data-dir=<profile>` and
   `--company-persona-config=<profile>/.company-browser-native-hardware.json`.
6. Keep profile sync deferred while Chromium is running. On close, wait for the
   Chromium process tree to exit before allowing the existing sync scheduler to
   snapshot the profile.

## Canonical persona file

The persona file must be UTF-8 without BOM, have exactly one trailing LF, and
use this exact key order and no whitespace:

```json
{"schemaVersion":3,"environmentId":"<uuid-v4>","portableKeyId":"<uuid-v4>","hardwareConcurrency":8,"deviceMemoryGiB":8,"timezone":"Asia/Shanghai","locale":"zh-CN","languages":["zh-CN","zh"]}
```

Supported `hardwareConcurrency` is 1 through 256. Supported
`deviceMemoryGiB` values are 2, 4, 8, 16, and 32. The current runtime locks the
time zone and language identity shown above.

## Canonical device-local OSCrypt envelope

The adjacent `.company-browser-portable-os-crypt.json` file must be UTF-8
without BOM, have exactly one trailing LF, and use this exact key order:

```json
{"schemaVersion":1,"environmentId":"<same-environment-uuid>","keyId":"<same-portable-key-uuid>","algorithm":"AES-256-GCM","wrapping":"windows-dpapi-current-user","encryptedKeyBase64":"<dpapi-ciphertext>"}
```

The plaintext is exactly 32 random bytes. Windows DPAPI optional entropy is the
UTF-8 byte sequence `CompanyBrowser.PortableOSCrypt.v1`, NUL, environment UUID,
NUL, key UUID. Use CurrentUser scope and prohibit UI.

The DPAPI envelope is local device material. Add it to Donut profile-sync
exclusions. Never upload it. For encrypted cross-device profiles, obtain the
same 32-byte environment key through Donut's existing end-to-end encrypted key
lifecycle and wrap it independently with DPAPI on each Windows account.

## Fingerprint behavior

This runtime does not accept arbitrary Wayfern fingerprints. The native persona
locks CPU, memory, time zone, locale, and languages before the renderer starts.
UA, Client Hints, display, GPU/WebGL, Canvas, audio, and fonts remain native and
must be measured against a protected local baseline. Hide or disable Donut UI
controls that imply unsupported arbitrary spoofing for this browser type.

Do not add JavaScript page-init overrides. Do not attempt to reimplement or
bypass paid Wayfern automation. Standard CDP/Playwright automation may be
integrated as a separately reviewed Donut capability.

## Existing systems that should remain unchanged

- `donut-sync` HTTP routes and storage object layout.
- Account login, teams, profile grants, and subscription enforcement.
- Proxy and VPN entities.
- Profile metadata conflict policy.
- Existing Wayfern profiles and runtime downloads.

Only the local sync exclusion list and encrypted key preparation need a
Company Chromium-specific branch.

## Migration policy

First enable Company Chromium only for newly created Windows profiles. Do not
rewrite the browser type of existing Wayfern profiles. A later migration must
be explicit, preserve a backup, verify Chromium major-version compatibility,
and prove Cookie decryption before deleting the old local profile.

## Minimum acceptance matrix

- New profile launches and closes; running state clears within two seconds.
- Reopen preserves Cookies, Local Storage, and IndexedDB.
- Proxy traffic uses the selected Donut proxy and WebRTC does not use direct
  non-proxied UDP.
- A second Windows account can reconstruct its own DPAPI envelope from the same
  end-to-end encrypted environment key and decrypt the same Cookie database.
- A wrong environment key, wrong key ID, aliased path, reparse point, hard link,
  noncanonical JSON, or changed native baseline fails closed.
- Existing Wayfern launch, server sync, team/account, proxy, and paid automation
  tests remain unchanged and passing.

