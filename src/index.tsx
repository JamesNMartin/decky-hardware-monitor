import {
  ButtonItem,
  Field,
  PanelSection,
  PanelSectionRow,
  TextField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaMicrochip } from "react-icons/fa";

const POLL_INTERVAL_MS = 2000;

interface Settings {
  host: string;
  port: number;
  poll_interval: number;
}

interface CpuSummary {
  name: string | null;
  temp_c: number | null;
  load_pct: number | null;
  power_w: number | null;
}

interface MemorySummary {
  name: string | null;
  load_pct: number | null;
  used_gb: number | null;
  total_gb: number | null;
}

interface GpuSummary {
  name: string | null;
  temp_c: number | null;
  load_pct: number | null;
  power_w: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
}

interface DiskSummary {
  name: string;
  used_pct: number | null;
}

interface SensorSummary {
  error: string | null;
  computer_name: string | null;
  cpu: CpuSummary | null;
  memory: MemorySummary | null;
  gpu: GpuSummary | null;
  disks: DiskSummary[];
}

const getSensors = callable<[], SensorSummary>("get_sensors");
const getSettings = callable<[], Settings>("get_settings");
const saveSettings = callable<[host: string, port: number], Settings>("save_settings");

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Enter your PC's address below to get started.",
  connection_failed: "Can't reach that host. Check the address and that Hardware Monitor's web server is running.",
  timeout: "Connection timed out. Check the address and your network.",
  bad_response: "Got an unexpected response from the host.",
  parse_failed: "Couldn't read sensor data from the response.",
  unknown: "Something went wrong fetching sensor data.",
};

function fmt(value: number | null | undefined, digits = 0, suffix = ""): string {
  return value == null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function Content() {
  const [sensors, setSensors] = useState<SensorSummary | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const savingRef = useRef(false);

  useEffect(() => {
    (async () => {
      const loaded = await getSettings();
      setHostInput(loaded.host);
      setPortInput(String(loaded.port));
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const result = await getSensors();
        if (!cancelled) setSensors(result);
      } catch {
        if (!cancelled) {
          setSensors({
            error: "unknown",
            computer_name: null,
            cpu: null,
            memory: null,
            gpu: null,
            disks: [],
          });
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const handleSave = async () => {
    const trimmedHost = hostInput.trim();
    const portNum = Number(portInput);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toaster.toast({ title: "Invalid port", body: "Port must be a number between 1 and 65535." });
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await saveSettings(trimmedHost, portNum);
      toaster.toast({ title: "Hardware Monitor", body: "Settings saved." });
    } finally {
      savingRef.current = false;
    }
  };

  const errorMessage = sensors?.error ? ERROR_MESSAGES[sensors.error] ?? ERROR_MESSAGES.unknown : null;

  return (
    <>
      {errorMessage && (
        <PanelSection title="Status">
          <PanelSectionRow>
            <Field label={errorMessage} />
          </PanelSectionRow>
        </PanelSection>
      )}

      <PanelSection title="CPU">
        {sensors?.cpu ? (
          <>
            <PanelSectionRow>
              <Field label="Load">{fmt(sensors.cpu.load_pct, 0, "%")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Temperature">{fmt(sensors.cpu.temp_c, 1, "°C")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Power">{fmt(sensors.cpu.power_w, 1, "W")}</Field>
            </PanelSectionRow>
          </>
        ) : (
          <PanelSectionRow>
            <Field label="Not detected" />
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Memory">
        {sensors?.memory ? (
          <>
            <PanelSectionRow>
              <Field label="Load">{fmt(sensors.memory.load_pct, 0, "%")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Used">
                {fmt(sensors.memory.used_gb, 1, " GB")} / {fmt(sensors.memory.total_gb, 1, " GB")}
              </Field>
            </PanelSectionRow>
          </>
        ) : (
          <PanelSectionRow>
            <Field label="Not detected" />
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="GPU">
        {sensors?.gpu ? (
          <>
            <PanelSectionRow>
              <Field label="Load">{fmt(sensors.gpu.load_pct, 0, "%")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Temperature">{fmt(sensors.gpu.temp_c, 1, "°C")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Power">{fmt(sensors.gpu.power_w, 1, "W")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="VRAM">
                {fmt(sensors.gpu.vram_used_mb, 0, " MB")} / {fmt(sensors.gpu.vram_total_mb, 0, " MB")}
              </Field>
            </PanelSectionRow>
          </>
        ) : (
          <PanelSectionRow>
            <Field label="Not detected" />
          </PanelSectionRow>
        )}
      </PanelSection>

      {sensors && sensors.disks.length > 0 && (
        <PanelSection title="Disks">
          {sensors.disks.map((disk) => (
            <PanelSectionRow key={disk.name}>
              <Field label={disk.name}>{fmt(disk.used_pct, 0, "% used")}</Field>
            </PanelSectionRow>
          ))}
        </PanelSection>
      )}

      <PanelSection title="Settings">
        <PanelSectionRow>
          <TextField label="Host / IP" value={hostInput} onChange={(e) => setHostInput(e.target.value)} />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Port"
            value={portInput}
            mustBeNumeric
            onChange={(e) => setPortInput(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleSave}>
            Save
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  return {
    name: "Hardware Monitor",
    titleView: <div className={staticClasses.Title}>Hardware Monitor</div>,
    content: <Content />,
    icon: <FaMicrochip />,
    onDismount() {},
  };
});
