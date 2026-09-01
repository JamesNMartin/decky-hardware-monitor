import asyncio
import json
import os
import re
import socket
import urllib.error
import urllib.request
import uuid

import decky

DEFAULT_PORT = 8085
DEFAULT_THRESHOLDS = {"cpu_temp_c": 85, "gpu_temp_c": 85}
POLL_INTERVAL_MIN, POLL_INTERVAL_MAX = 1, 10
THRESHOLD_MIN, THRESHOLD_MAX = 30, 100
HTTP_TIMEOUT = 3

LEAF_VALUE_RE = re.compile(r"^(-?[\d.]+)\s*(.*)$")


def _default_settings() -> dict:
    return {
        "profiles": [],
        "active_profile_id": None,
        "poll_interval": 2,
        "thresholds": dict(DEFAULT_THRESHOLDS),
    }


def _settings_path() -> str:
    return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")


def _migrate_legacy_settings(raw: dict) -> dict:
    """Convert the pre-profiles {host, port, poll_interval} shape into the profile schema."""
    host = (raw.get("host") or "").strip()
    profiles = []
    active_id = None
    if host:
        try:
            port = int(raw.get("port", DEFAULT_PORT))
        except (TypeError, ValueError):
            port = DEFAULT_PORT
        active_id = uuid.uuid4().hex
        profiles.append({"id": active_id, "name": "My PC", "host": host, "port": port})
    decky.logger.info(f"Migrating legacy settings (host={host!r}) to profile schema")
    return {
        "profiles": profiles,
        "active_profile_id": active_id,
        "poll_interval": raw.get("poll_interval", 2),
        "thresholds": dict(DEFAULT_THRESHOLDS),
    }


def _load_settings() -> dict:
    try:
        with open(_settings_path(), "r") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return _default_settings()
    except (json.JSONDecodeError, OSError) as e:
        decky.logger.warning(f"Failed to read settings, using defaults: {e}")
        return _default_settings()

    needs_migration = "host" in raw and "profiles" not in raw
    if needs_migration:
        raw = _migrate_legacy_settings(raw)

    settings = _default_settings()
    if isinstance(raw.get("profiles"), list):
        settings["profiles"] = raw["profiles"]
    if raw.get("active_profile_id") is not None:
        settings["active_profile_id"] = raw["active_profile_id"]
    try:
        settings["poll_interval"] = int(raw.get("poll_interval", settings["poll_interval"]))
    except (TypeError, ValueError):
        pass
    if isinstance(raw.get("thresholds"), dict):
        settings["thresholds"].update(raw["thresholds"])

    if needs_migration:
        _save_settings(settings)

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

    async def add_profile(self, name: str, host: str, port: int) -> dict:
        settings = _load_settings()
        host = (host or "").strip()
        try:
            port = int(port)
        except (TypeError, ValueError):
            port = DEFAULT_PORT
        profile = {
            "id": uuid.uuid4().hex,
            "name": (name or "").strip() or host or "New PC",
            "host": host,
            "port": port,
        }
        settings["profiles"].append(profile)
        if settings["active_profile_id"] is None:
            settings["active_profile_id"] = profile["id"]
        _save_settings(settings)
        return settings

    async def update_profile(self, profile_id: str, name: str, host: str, port: int) -> dict:
        settings = _load_settings()
        target = next((p for p in settings["profiles"] if p["id"] == profile_id), None)
        if target is None:
            decky.logger.warning(f"update_profile: unknown id {profile_id!r}")
            return settings
        target["name"] = (name or "").strip() or target["name"]
        target["host"] = (host or "").strip()
        try:
            target["port"] = int(port)
        except (TypeError, ValueError):
            pass
        _save_settings(settings)
        return settings

    async def delete_profile(self, profile_id: str) -> dict:
        settings = _load_settings()
        settings["profiles"] = [p for p in settings["profiles"] if p["id"] != profile_id]
        if settings["active_profile_id"] == profile_id:
            settings["active_profile_id"] = settings["profiles"][0]["id"] if settings["profiles"] else None
        _save_settings(settings)
        return settings

    async def set_active_profile(self, profile_id: str) -> dict:
        settings = _load_settings()
        if any(p["id"] == profile_id for p in settings["profiles"]):
            settings["active_profile_id"] = profile_id
        else:
            decky.logger.warning(f"set_active_profile: unknown id {profile_id!r}")
        _save_settings(settings)
        return settings

    async def set_poll_interval(self, poll_interval: int) -> dict:
        settings = _load_settings()
        try:
            value = int(poll_interval)
        except (TypeError, ValueError):
            value = settings["poll_interval"]
        settings["poll_interval"] = max(POLL_INTERVAL_MIN, min(POLL_INTERVAL_MAX, value))
        _save_settings(settings)
        return settings

    async def set_thresholds(self, cpu_temp_c: float, gpu_temp_c: float) -> dict:
        settings = _load_settings()

        def _clamp(v, fallback):
            try:
                return max(THRESHOLD_MIN, min(THRESHOLD_MAX, float(v)))
            except (TypeError, ValueError):
                return fallback

        settings["thresholds"]["cpu_temp_c"] = _clamp(cpu_temp_c, settings["thresholds"]["cpu_temp_c"])
        settings["thresholds"]["gpu_temp_c"] = _clamp(gpu_temp_c, settings["thresholds"]["gpu_temp_c"])
        _save_settings(settings)
        return settings

    async def get_sensors(self) -> dict:
        settings = _load_settings()
        profile = next(
            (p for p in settings["profiles"] if p["id"] == settings["active_profile_id"]), None
        )
        if profile is None:
            summary = _empty_summary()
            summary["error"] = "not_configured"
            return summary
        return await fetch_and_parse(profile["host"], profile["port"])

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        decky.logger.info("Hardware Monitor loaded")

    async def _unload(self):
        decky.logger.info("Hardware Monitor unloaded")

    async def _uninstall(self):
        decky.logger.info("Hardware Monitor uninstalled")
