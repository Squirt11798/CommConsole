# CommConsole — Feature Checklist

Tracking what's built and what's planned. Current version: **v1.14.0**.

## ✅ Implemented

### Core
- [x] SSH shell terminal (xterm.js: copy/paste, web links, resize)
- [x] SFTP file browser (list, upload, download, mkdir, rename, delete)
- [x] Serial / COM connections (port picker, baud, data/parity/stop bits)
- [x] Encrypted credential vault (Windows DPAPI / safeStorage)
- [x] TOFU host-key verification (trust-on-first-use, MITM warning)
- [x] PPK key auth + keyboard-interactive login *(v1.3.0)*

### Sessions & UI
- [x] Session sidebar with groups (create/rename/delete, drag-to-move)
- [x] Collapsible groups
- [x] MobaXterm session import wizard
- [x] Resource monitor (CPU / mem / disk / net / uptime)
- [x] Colored session tags (prod/staging/dev distinction) *(v1.6.0)*
- [x] Connection status bar — ping, cipher, uptime *(v1.11.0)*

### Connectivity
- [x] SSH port forwarding — local (-L) and remote (-R) tunnels *(v1.7.0)*
- [x] Dynamic / SOCKS5 proxy tunnel (-D) *(v1.12.0)*
- [x] SSH jump host / ProxyJump chaining (connect through a bastion) *(v1.12.0)*

### Productivity
- [x] Split / tiled view — all open terminals in a grid *(v1.12.0)*
- [x] Broadcast input — type once, send to every open terminal *(v1.12.0)*
- [x] Session logging — record terminal output to timestamped files *(v1.12.0)*
- [x] Quick-connect bar (`user@host:port` one-liner) *(v1.13.0)*
- [x] Drag-to-reorder tabs *(v1.13.0)*
- [x] Drag-drop file onto terminal → SFTP upload to remote cwd *(v1.13.0)*
- [x] Search in terminal scrollback (Ctrl+F) *(v1.14.0)*
- [x] Reconnect on dropped sessions (overlay + one-click reconnect) *(v1.14.0)*
- [x] Snippets / command library (send to active terminal, broadcastable) *(v1.14.0)*

### Appearance
- [x] Settings page *(v1.8.0)*
- [x] Theme variants — Olive Drab, Desert, Navy, Light *(v1.8.0)*
- [x] Configurable terminal font + size *(v1.8.0)*
- [x] Default group for new connections *(v1.8.0)*

### Security
- [x] Known-hosts manager UI (view / revoke trusted fingerprints) *(v1.9.0)*
- [x] Encrypted credential export / import (passphrase `.ccbak`, portable across machines) *(v1.9.0)*
- [x] Master password / app-lock — real 2nd encryption layer over DPAPI *(v1.10.0)*
- [x] Idle auto-lock (app-activity based) *(v1.10.0, fixed v1.11.1)*
- [x] TOTP 2FA-gated unlock *(v1.10.0)*

## ⬜ Planned / Not Yet Implemented

### Quality of life
*(all shipped — see Productivity above)*

### Serial-specific
- [ ] Send-file over serial
- [ ] Break signal + DTR/RTS toggles
- [ ] Line-ending selector (CR / LF / CRLF) and local-echo toggle
- [ ] Hex / raw view mode for binary streams

---
*Update this list as features land. Versions noted in parentheses; see git log for details.*
