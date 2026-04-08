# Security Policy

Brows3 is an open-source Amazon S3 browser, S3 explorer, and S3 desktop client. Security matters because the project handles cloud credentials and object-storage access locally.

## Reporting a Vulnerability

Please do not open a public GitHub issue for sensitive security problems.

Instead, report vulnerabilities privately to the maintainer through GitHub security reporting if enabled, or contact the maintainer directly through the profile linked in the repository.

Include:

- affected Brows3 version
- operating system
- storage provider
- reproduction steps
- impact
- any logs or screenshots that help explain the issue

## Scope

Relevant issues include:

- credential leakage
- unsafe secret storage
- privilege escalation
- remote code execution
- broken authentication assumptions
- insecure updater or release-signing behavior

## Storage Model

Brows3 is designed so that credentials remain on the local machine. Manual and custom S3 secrets should be stored in secure OS keychain facilities instead of plain JSON configuration files.
