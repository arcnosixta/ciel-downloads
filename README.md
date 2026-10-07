# Ciel Connector

Official installers for Windows, macOS and Linux.

[Download the latest release](https://github.com/arcnosixta/ciel-downloads/releases/latest) | [Open Ciel](https://ciel-flax.vercel.app)

Choose the installer matching your operating system and processor. SHA256SUMS accompanies every release.

| Platform | Architectures | Updates starting with 1.0.15 |
| --- | --- | --- |
| Windows | x64, ARM64 | Background download, then **Update and restart** |
| Linux DEB | x64, ARM64 | Background download, then **Update and restart**; system authorization may be required |
| Linux AppImage | x64, ARM64 | Background download, then **Update and restart**; run the AppImage from a writable folder |
| macOS | Intel, Apple Silicon | New-version check and download button; install the DMG manually |

Windows x64 1.0.13 can install 1.0.15 through its built-in updater. Connector 1.0.12 and earlier must be upgraded manually once. Project files and chat history stay in their separate local directories. When installing manually, exit the previous Connector first.

Updates wait until agent tasks and pending questions or permissions have finished. New Windows installations use the current user's account; upgrades preserve an existing installation's location and scope.

This repository distributes installers only. Windows builds are unsigned; macOS builds are ad-hoc signed, without notarization or Developer ID. macOS automatic installation remains disabled.
