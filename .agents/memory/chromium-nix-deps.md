---
name: Chromium Nix dependencies
description: Full list of Nix packages required to run Playwright Chromium headless in Replit, and how to verify
---

# Chromium Nix Dependencies

## Required Nix packages

Install all of these via `installSystemDependencies`:

```
glib, nss, nspr, atk, cups, dbus, expat, libdrm,
xorg.libX11, xorg.libXcomposite, xorg.libXdamage, xorg.libXext,
xorg.libXfixes, xorg.libXrandr, libxkbcommon, mesa, pango, cairo,
alsa-lib, at-spi2-atk, at-spi2-core, libgbm, systemd
```

Note: `mesa.drivers` is NOT a valid package name — use `mesa`. `libgbm` and `systemd` (for libudev.so.1) must be added separately.

## Verification

```bash
ldd /home/runner/workspace/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"
```

If the grep returns nothing (exit 1), all libraries are found.

## After install

Always restart the API server workflow after installing new Nix packages so the dynamic linker cache is updated.

**Why:** Playwright's Chromium binary links against many system libraries not present in the base Replit NixOS environment. Installing them via Nix is the only supported approach (no Docker/apt/yum).
