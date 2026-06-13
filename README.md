# CommConsole

**A secure, self-contained SSH, serial, and SFTP terminal client for Windows.**

CommConsole is a desktop terminal emulator built for sysadmins, network/MSSP
engineers, and anyone who manages a fleet of servers and devices. It combines an
encrypted credential vault, a grouped session manager, SSH tunneling, serial/COM
console access, and an SFTP file browser in a single portable application — no
installer and no cloud account required.

Credentials are encrypted at rest with Windows DPAPI, with an optional master
password adding a second AES-256-GCM layer on top. The app can be locked behind a
password and TOTP 2FA, and every trusted host key is verified on first use.

> Built with Electron + React + xterm.js. Ships as a single portable `.exe`.

---

## Highlights

- 🔐 **Encrypted credential vault** — passwords and keys protected by Windows DPAPI, with an optional master password (AES-256-GCM) and TOTP-gated app lock.
- 🖥️ **SSH, Serial, and SFTP in one app** — full xterm.js terminal, COM-port console, and a built-in file browser.
- 🔀 **Tunnels** — local (`-L`), remote (`-R`), and dynamic SOCKS5 (`-D`) port forwarding, plus jump-host / ProxyJump chaining.
- ⚡ **Productivity** — split/tiled multi-terminal view, broadcast input, snippets library, session logging, and scrollback search.
- 🎨 **Themeable** — Olive Drab, Desert, Navy, and Light themes; configurable terminal font and size.
- 📦 **Portable** — one signed-free `.exe`, no installation, settings stored per-user.

---

## Features

### Connectivity
- SSH shell terminal (copy/paste, clickable links, resize, 256-color)
- Serial / COM connections (port picker, baud, data/parity/stop bits)
- SFTP file browser (list, upload, download, mkdir, rename, delete)
- SSH port forwarding — local (`-L`), remote (`-R`), and dynamic SOCKS5 (`-D`)
- SSH jump host / ProxyJump chaining (connect through one or more bastions)
- Quick-connect bar — type `user@host:port` to connect fast

### Authentication & security
- Encrypted credential vault (Windows DPAPI / safeStorage)
- Master password — adds a second AES-256-GCM encryption layer over the vault
- App lock with idle auto-lock and TOTP (RFC 6238) two-factor unlock
- Trust-on-first-use host-key verification with man-in-the-middle warnings
- Known-hosts manager (view / revoke trusted fingerprints)
- Private-key auth (OpenSSH keys) and keyboard-interactive login
- Encrypted, passphrase-protected backup export/import (`.ccbak`) — portable across machines

### Sessions & UI
- Session sidebar with groups (create / rename / delete, drag-to-move)
- Colored session tags (e.g. prod / staging / dev)
- Drag-to-reorder open tabs
- MobaXterm session import
- Resource monitor (CPU / mem / disk / net / uptime)
- Connection status bar — latency, negotiated cipher, uptime
- Themes (Olive Drab, Desert, Navy, Light), configurable terminal font + size

### Productivity
- **Split / tiled view** — see every open terminal at once in a grid
- **Broadcast input** — type once, send keystrokes to all open terminals
- **Snippets / command library** — save reusable commands and fire them into the active terminal (or all terminals when broadcasting)
- **Session logging** — record terminal output to timestamped log files (opt-in)
- **Scrollback search** — `Ctrl+F` in-terminal find with next/previous
- **Reconnect on drop** — dropped sessions stay open with a one-click reconnect
- **Drag-drop upload** — drop a file onto an SSH terminal to SFTP-upload it to the remote working directory

---

## Installation

CommConsole ships as a **portable Windows executable** — no install required.

1. Download the latest `CommConsole-<version>-portable.exe` from the [Releases](https://github.com/Squirt11798/CommConsole/releases) page.
2. Run it. Settings and the encrypted vault are stored per-user under `%APPDATA%\CommConsole`.

---

## Building from source

Requires Node.js 18+ and the Windows build toolchain (for the native `serialport` module).

```bash
git clone https://github.com/Squirt11798/CommConsole.git
cd CommConsole
npm install

npm run dev        # run in development
npm run typecheck  # type-check (tsc --noEmit)
npm run dist       # build the portable EXE → dist/CommConsole-<version>-portable.exe
```

### Tech stack
| Layer | Technology |
|-------|-----------|
| Shell | Electron 31 + electron-vite |
| UI | React 18 + TypeScript |
| Terminal | xterm.js (`@xterm/xterm`) + fit / web-links / search addons |
| SSH | `ssh2` |
| Serial | `serialport` (native; rebuilt for Electron on `npm run dist`) |
| Crypto | Electron `safeStorage` (DPAPI), AES-256-GCM + scrypt, RFC 6238 TOTP |

---

## Roadmap

The core terminal, security, connectivity, and productivity feature sets are
complete. Remaining and future work, roughly in priority order:

### Serial-specific tools (next up)
- [ ] Send-file over serial (XMODEM/raw)
- [ ] Break signal + DTR/RTS line toggles
- [ ] Line-ending selector (CR / LF / CRLF) and local-echo toggle
- [ ] Hex / raw view mode for binary streams

### Under consideration
- [ ] Optional automatic reconnect with backoff (currently one-click manual)
- [ ] Per-session environment / startup command
- [ ] macOS and Linux builds

See [`FEATURES.md`](FEATURES.md) for the detailed, versioned checklist of what's
shipped and what's planned.

---

## License

MIT © Derrick Frey
