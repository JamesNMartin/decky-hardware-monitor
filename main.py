import asyncio
import json
import os
import re
import socket
import urllib.error
import urllib.request

import decky

DEFAULT_SETTINGS = {"host": "", "port": 8085, "poll_interval": 2}
HTTP_TIMEOUT = 3

LEAF_VALUE_RE = re.compile(r"^(-?[\d.]+)\s*(.*)$")


def _settings_path() -> str:
    return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")


def _load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(_settings_path(), "r") as f:
            data = json.load(f)
        settings.update({k: v for k, v in data.items() if k in settings})
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as e:
        decky.logger.warning(f"Failed to read settings, using defaults: {e}")
    return settings


def _save_settings(settings: dict) -> None:
    os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
    tmp_path = _settings_path() + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(settings, f)
    os.replace(tmp_path, _settings_path())


def _icon(node: dict) -> str:
    return os.path.basename(node.get("ImageURL") or "").lower()


def find_nodes_by_icon(node: dict, icon_names: set) -> list:
    acc = []

    def _walk(n):
        if not isinstance(n, dict):
            return
        if _icon(n) in icon_names:
            acc.append(n)
        for child in n.get("Children") or []:
            _walk(child)

    _walk(node)
    return acc


def find_node_by_icon(node: dict, icon_names: set):
    matches = find_nodes_by_icon(node, icon_names)
    return matches[0] if matches else None


def _collect_leaves(node: dict, acc: list) -> None:
    children = node.get("Children") or []
    if not children:
        if "Value" in node:
            acc.append(node)
        return
    for child in children:
        _collect_leaves(child, acc)


def collect_leaves_by_icon(hw_node: dict, icon_name: str) -> list:
    leaves = []
    for category in find_nodes_by_icon(hw_node, {icon_name}):
        _collect_leaves(category, leaves)
    return leaves


def parse_value(raw):
    if not raw:
        return None
    match = LEAF_VALUE_RE.match(raw.strip())
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def find_leaf_value(leaves: list, name_matchers: list):
    for matcher in name_matchers:
        for leaf in leaves:
            if leaf.get("Text") == matcher:
                value = parse_value(leaf.get("Value"))
                if value is not None:
                    return value
    for matcher in name_matchers:
        for leaf in leaves:
            if matcher in (leaf.get("Text") or ""):
                value = parse_value(leaf.get("Value"))
                if value is not None:
                    return value
    return None


def _summarize_cpu(root):
    node = find_node_by_icon(root, {"cpu.png"})
    if node is None:
        return None
    return {
        "name": node.get("Text"),
        "temp_c": find_leaf_value(collect_leaves_by_icon(node, "temperature.png"), ["CPU Package"]),
        "load_pct": find_leaf_value(collect_leaves_by_icon(node, "load.png"), ["CPU Total"]),
        "power_w": find_leaf_value(collect_leaves_by_icon(node, "power.png"), ["CPU Package"]),
    }


def _summarize_memory(root):
    node = find_node_by_icon(root, {"ram.png"})
    if node is None:
        return None
    data_leaves = collect_leaves_by_icon(node, "power.png")
    used_gb = find_leaf_value(data_leaves, ["Used Memory"])
    avail_gb = find_leaf_value(data_leaves, ["Available Memory"])
    total_gb = used_gb + avail_gb if used_gb is not None and avail_gb is not None else None
    return {
        "name": node.get("Text"),
        "load_pct": find_leaf_value(collect_leaves_by_icon(node, "load.png"), ["Memory"]),
        "used_gb": used_gb,
        "total_gb": total_gb,
    }


def _summarize_gpu(root):
    node = find_node_by_icon(root, {"nvidia.png", "amd.png", "ati.png", "intel.png"})
    if node is None:
        return None
    power_leaves = collect_leaves_by_icon(node, "power.png")
    return {
        "name": node.get("Text"),
        "temp_c": find_leaf_value(collect_leaves_by_icon(node, "temperature.png"), ["GPU Core"]),
        "load_pct": find_leaf_value(collect_leaves_by_icon(node, "load.png"), ["GPU Core"]),
        "power_w": find_leaf_value(power_leaves, ["GPU Power"]),
        "vram_used_mb": find_leaf_value(power_leaves, ["GPU Memory Used"]),
        "vram_total_mb": find_leaf_value(power_leaves, ["GPU Memory Total"]),
    }


def _summarize_disks(root):
    nodes = find_nodes_by_icon(root, {"hdd.png"})
    disks = []
    for i, node in enumerate(nodes):
        raw_name = (node.get("Text") or "Disk").strip()
        label = raw_name if len(nodes) == 1 else f"{raw_name} {i + 1}"
        disks.append({
            "name": label,
            "used_pct": find_leaf_value(collect_leaves_by_icon(node, "load.png"), ["Used Space"]),
        })
    return disks


def _summarize_tree(tree: dict) -> dict:
    children = tree.get("Children") or []
    computer_name = children[0].get("Text") if children else tree.get("Text")
    return {
        "error": None,
        "computer_name": computer_name,
        "cpu": _summarize_cpu(tree),
        "memory": _summarize_memory(tree),
        "gpu": _summarize_gpu(tree),
        "disks": _summarize_disks(tree),
    }


def _empty_summary() -> dict:
    return {
        "error": None,
        "computer_name": None,
        "cpu": None,
        "memory": None,
        "gpu": None,
        "disks": [],
    }


def _http_get_json(host: str, port: int) -> dict:
    url = f"http://{host}:{port}/data.json"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read())


async def fetch_and_parse(host: str, port: int) -> dict:
    summary = _empty_summary()
    if not host:
        summary["error"] = "not_configured"
        return summary

    loop = asyncio.get_event_loop()
    try:
        tree = await loop.run_in_executor(None, _http_get_json, host, port)
    except urllib.error.HTTPError:
        summary["error"] = "bad_response"
        return summary
    except urllib.error.URLError as e:
        timed_out = isinstance(e.reason, (socket.timeout, TimeoutError))
        summary["error"] = "timeout" if timed_out else "connection_failed"
        return summary
    except (socket.timeout, TimeoutError):
        summary["error"] = "timeout"
        return summary
    except json.JSONDecodeError as e:
        decky.logger.warning(f"Bad JSON from {host}:{port}: {e}")
        summary["error"] = "bad_response"
        return summary
    except Exception as e:
        decky.logger.error(f"Unexpected error fetching sensors: {e}")
        summary["error"] = "unknown"
        return summary

    try:
        return _summarize_tree(tree)
    except Exception as e:
        decky.logger.error(f"Failed to parse sensor tree: {e}")
        summary["error"] = "parse_failed"
        return summary


class Plugin:
    async def get_settings(self) -> dict:
        return _load_settings()

    async def save_settings(self, host: str, port: int) -> dict:
        settings = _load_settings()
        settings["host"] = (host or "").strip()
        try:
            settings["port"] = int(port)
        except (TypeError, ValueError):
            settings["port"] = DEFAULT_SETTINGS["port"]
        _save_settings(settings)
        return settings

    async def get_sensors(self) -> dict:
        settings = _load_settings()
        return await fetch_and_parse(settings["host"], settings["port"])

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        decky.logger.info("Hardware Monitor loaded")

    async def _unload(self):
        decky.logger.info("Hardware Monitor unloaded")

    async def _uninstall(self):
        decky.logger.info("Hardware Monitor uninstalled")
