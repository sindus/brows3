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
