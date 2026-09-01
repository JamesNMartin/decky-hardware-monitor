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
./build.sh
```

Installs dependencies, bundles `src/index.tsx` into `dist/index.js`, and packages `plugin.json`, `package.json`, `main.py`, `README.md`, and `dist/` into `decky-hardware-monitor.zip` at the repo root, ready to install.

(To just rebuild the frontend without producing a zip: `pnpm i && pnpm run build`.)

## Installing on a Steam Deck

Copy `decky-hardware-monitor.zip` to the Deck, then in the Quick Access Menu: plug icon → gear → General → enable **Developer Mode**, then the **Developer** tab → **Install from zip** → pick the file.

To update after a code change, just re-run `./build.sh` and reinstall the new zip the same way.
