# Update: Dark mode / Normal mode switch

What is new
1. A sun/moon button in the top bar (every page, including Admin). Tap it to switch between Normal (light) and Dark mode.
2. On a phone the menu also has an Appearance section: Light, Dark, Auto. Auto follows your phone's own setting.
3. Your choice is remembered in that browser (each device remembers its own). If you never press it, the site follows your device as before.

How to update (about 3 minutes; no SQL, no function deploy)
1. GitHub: your repository > Add file > Upload files. Drag in the contents of the update folder (keep the folder names `web`, `docs`, `tests`). Do NOT upload `web/config.js`. Commit. Cloudflare publishes by itself.
2. Open the site and refresh once (on a phone, close and reopen the tab if it still looks old).
