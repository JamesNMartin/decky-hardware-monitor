# decky-hardware-monitor

A [Decky Loader](https://decky.xyz/) plugin for the Steam Deck that shows a live CPU/GPU/Memory/Disk dashboard in the Quick Access Menu, polled from [Open Hardware Monitor](https://openhardwaremonitor.org/) or [Libre Hardware Monitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) running on a PC on your local network.

## Prerequisites

On the PC you want to monitor:
1. Run Open Hardware Monitor or Libre Hardware Monitor.
2. Enable its built-in remote web server (Options → Remote Web Server), default port `8085`.
3. Allow that port through the PC's firewall so the Steam Deck can reach it over LAN.

## Usage

Open the plugin from the Quick Access Menu, enter the PC's IP address and port under **Settings**, and hit **Save**. The dashboard updates every 2 seconds.

## Building

```sh
pnpm i
pnpm run build
```

This bundles `src/index.tsx` into `dist/index.js`. The Python backend (`main.py`) needs no build step or extra dependencies.

## Deploying to a Steam Deck

Copy `plugin.json`, `main.py`, `package.json`, and the built `dist/` folder into `~/homebrew/plugins/decky-hardware-monitor/` on the Deck, then restart Decky Loader. Backend-only changes (`main.py`) just need the file re-copied and Decky Loader restarted — no rebuild required.
