# Release Signing And Notarization

Brows3 supports three macOS release modes:

1. Ad-hoc signing only
   This is the fallback when no Apple credentials are configured.
   Builds may still trigger Gatekeeper quarantine warnings after browser download.

2. Apple code signing
   This signs the `.app` and `.dmg` with your Apple Developer certificate.

3. Apple code signing plus notarization
   This is the preferred release path for normal end-user installs on macOS.

## Required GitHub Secrets

Core updater signing:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The updater private key must match the public key committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. If you generate a new private key and do not replace the public key in the repo, update installation will fail even though CI still builds artifacts.

macOS code signing:

- `APPLE_CERTIFICATE`
  The exported `.p12` certificate contents, usually base64 encoded.
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
  Example: `Developer ID Application: Your Name (TEAMID)`

macOS notarization using App Store Connect API:

- `APPLE_API_KEY`
  The App Store Connect key ID.
- `APPLE_API_ISSUER`
  The issuer ID.
- `APPLE_API_PRIVATE_KEY`
  The contents of the `.p8` private key file.

Alternative notarization using Apple ID:

- `APPLE_ID`
- `APPLE_PASSWORD`
  Use an app-specific password.
- `APPLE_TEAM_ID`

## Recommended Setup

Use the App Store Connect API method for notarization. It is more stable for CI than Apple ID login.

Set:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_KEY`
- `APPLE_API_ISSUER`
- `APPLE_API_PRIVATE_KEY`

## Where To Add The GitHub Keys

In GitHub, open:

1. Repository `Settings`
2. `Secrets and variables`
3. `Actions`
4. `New repository secret`

Add the Tauri updater secrets there. If you already added them previously, verify the secret names match exactly:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

If you rotated the updater key, also update `src-tauri/tauri.conf.json` with the matching new public key before shipping another release.

## Generate Or Rotate The Tauri Updater Key

Generate a minisign-compatible updater key pair:

```bash
pnpm dlx @tauri-apps/cli signer generate -w ~/.tauri/brows3.key
```

Then:

1. copy the private key contents into the GitHub `TAURI_SIGNING_PRIVATE_KEY` secret
2. copy the password into `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. copy the generated public key into `src-tauri/tauri.conf.json` at `plugins.updater.pubkey`

## Workflow Behavior

The release workflow now:

- writes the App Store Connect private key to a temporary file when configured
- exports Apple signing variables only when the matching secret exists
- falls back to ad-hoc signing when Apple certificate secrets are absent
- warns when notarization is not configured

## Expected Result

If signing and notarization are configured correctly, macOS users should be able to:

1. open the `.dmg`
2. drag `Brows3.app` into `/Applications`
3. launch the app from `/Applications`

without the "app is damaged" Gatekeeper error.
