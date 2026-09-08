import {
  ButtonItem,
  Dropdown,
  Field,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaMicrochip } from "react-icons/fa";

const POLL_INTERVAL_MIN = 1;
const POLL_INTERVAL_MAX = 10;
const THRESHOLD_MIN = 30;
const THRESHOLD_MAX = 100;

interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
}

interface Thresholds {
  cpu_temp_c: number;
  gpu_temp_c: number;
}

interface Settings {
  profiles: Profile[];
  active_profile_id: string | null;
  poll_interval: number;
  thresholds: Thresholds;
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
const addProfile = callable<[name: string, host: string, port: number], Settings>("add_profile");
const updateProfile = callable<
  [profile_id: string, name: string, host: string, port: number],
  Settings
>("update_profile");
const deleteProfile = callable<[profile_id: string], Settings>("delete_profile");
const setActiveProfile = callable<[profile_id: string], Settings>("set_active_profile");
const setPollInterval = callable<[poll_interval: number], Settings>("set_poll_interval");
const setThresholds = callable<[cpu_temp_c: number, gpu_temp_c: number], Settings>("set_thresholds");

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Add a PC below to get started.",
  connection_failed: "Can't reach that host. Check the address and that Hardware Monitor's web server is running.",
  timeout: "Connection timed out. Check the address and your network.",
  bad_response: "Got an unexpected response from the host.",
  parse_failed: "Couldn't read sensor data from the response.",
  unknown: "Something went wrong fetching sensor data.",
};

function fmt(value: number | null | undefined, digits = 0, suffix = ""): string {
  return value == null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function warningStyle(
  value: number | null | undefined,
  thresholdC: number | null | undefined
): { color: string; fontWeight: number } | undefined {
  if (value == null || thresholdC == null || value < thresholdC) return undefined;
  return { color: "#ff6b6b", fontWeight: 600 };
}

function useDebouncedSave<T>(
  save: (value: T) => Promise<Settings>,
  onSaved: (s: Settings) => void,
  delayMs = 400
) {
  const timerRef = useRef<number | undefined>(undefined);
  return (value: T) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      const result = await save(value);
      onSaved(result);
    }, delayMs);
  };
}

function Content() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sensors, setSensors] = useState<SensorSummary | null>(null);

  const [profileFormOpen, setProfileFormOpen] = useState<"none" | "add" | "edit">("none");
  const [profileFormId, setProfileFormId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const savingProfileRef = useRef(false);

  const [pollIntervalInput, setPollIntervalInput] = useState(2);
  const [cpuThresholdInput, setCpuThresholdInput] = useState(85);
  const [gpuThresholdInput, setGpuThresholdInput] = useState(85);
  const [settingsExpanded, setSettingsExpanded] = useState(true);

  const debouncedSetPollInterval = useDebouncedSave<number>(setPollInterval, setSettings);
  const debouncedSetThresholds = useDebouncedSave<[number, number]>(
    ([cpu, gpu]) => setThresholds(cpu, gpu),
    setSettings
  );

  useEffect(() => {
    (async () => {
      const loaded = await getSettings();
      setSettings(loaded);
      setPollIntervalInput(loaded.poll_interval);
      setCpuThresholdInput(loaded.thresholds.cpu_temp_c);
      setGpuThresholdInput(loaded.thresholds.gpu_temp_c);
      setSettingsExpanded(!loaded.active_profile_id);
    })();
  }, []);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    let timer: number | undefined;
    const intervalMs = Math.max(POLL_INTERVAL_MIN, settings.poll_interval) * 1000;

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
        if (!cancelled) timer = window.setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [settings?.poll_interval, settings?.active_profile_id]);

  const activeProfile = settings?.profiles.find((p) => p.id === settings.active_profile_id) ?? null;

  const openAddForm = () => {
    setProfileFormOpen("add");
    setProfileFormId(null);
    setNameInput("");
    setHostInput("");
    setPortInput("8085");
  };

  const openEditForm = (p: Profile) => {
    setProfileFormOpen("edit");
    setProfileFormId(p.id);
    setNameInput(p.name);
    setHostInput(p.host);
    setPortInput(String(p.port));
  };

  const closeForm = () => setProfileFormOpen("none");

  const handleSaveProfileForm = async () => {
    const trimmedHost = hostInput.trim();
    const portNum = Number(portInput);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toaster.toast({ title: "Invalid port", body: "Port must be a number between 1 and 65535." });
      return;
    }
    if (savingProfileRef.current) return;
    savingProfileRef.current = true;
    try {
      const result =
        profileFormOpen === "add"
          ? await addProfile(nameInput.trim(), trimmedHost, portNum)
          : await updateProfile(profileFormId!, nameInput.trim(), trimmedHost, portNum);
      setSettings(result);
      closeForm();
      toaster.toast({ title: "Hardware Monitor", body: "Profile saved." });
    } finally {
      savingProfileRef.current = false;
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteProfile(id);
    setSettings(result);
  };

  const handleSetActive = async (id: string) => {
    const result = await setActiveProfile(id);
    setSettings(result);
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

      <PanelSection title={sensors?.cpu?.name ? `CPU — ${sensors.cpu.name}` : "CPU"}>
        {sensors?.cpu ? (
          <>
            <PanelSectionRow>
              <Field label="Load">{fmt(sensors.cpu.load_pct, 0, "%")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Temperature">
                <span style={warningStyle(sensors.cpu.temp_c, settings?.thresholds.cpu_temp_c)}>
                  {fmt(sensors.cpu.temp_c, 1, "°C")}
                </span>
              </Field>
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

      <PanelSection title={sensors?.gpu?.name ? `GPU — ${sensors.gpu.name}` : "GPU"}>
        {sensors?.gpu ? (
          <>
            <PanelSectionRow>
              <Field label="Load">{fmt(sensors.gpu.load_pct, 0, "%")}</Field>
            </PanelSectionRow>
            <PanelSectionRow>
              <Field label="Temperature">
                <span style={warningStyle(sensors.gpu.temp_c, settings?.thresholds.gpu_temp_c)}>
                  {fmt(sensors.gpu.temp_c, 1, "°C")}
                </span>
              </Field>
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
          <ButtonItem layout="below" onClick={() => setSettingsExpanded((v) => !v)}>
            {settingsExpanded ? "Hide Settings" : "Show Settings"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {settingsExpanded && (
        <>
          <PanelSection title="Warnings">
            <PanelSectionRow>
              <SliderField
                label="CPU temp warning"
                value={cpuThresholdInput}
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                step={1}
                showValue
                valueSuffix="°C"
                onChange={(v) => {
                  setCpuThresholdInput(v);
                  debouncedSetThresholds([v, gpuThresholdInput]);
                }}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <SliderField
                label="GPU temp warning"
                value={gpuThresholdInput}
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                step={1}
                showValue
                valueSuffix="°C"
                onChange={(v) => {
                  setGpuThresholdInput(v);
                  debouncedSetThresholds([cpuThresholdInput, v]);
                }}
              />
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="General">
            <PanelSectionRow>
              <SliderField
                label="Refresh interval"
                value={pollIntervalInput}
                min={POLL_INTERVAL_MIN}
                max={POLL_INTERVAL_MAX}
                step={1}
                showValue
                valueSuffix="s"
                onChange={(v) => {
                  setPollIntervalInput(v);
                  debouncedSetPollInterval(v);
                }}
              />
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Profiles">
            <PanelSectionRow>
              <Dropdown
                rgOptions={(settings?.profiles ?? []).map((p) => ({
                  data: p.id,
                  label: `${p.name} (${p.host}:${p.port})`,
                }))}
                selectedOption={settings?.active_profile_id ?? null}
                strDefaultLabel="No PC selected"
                onChange={(opt) => handleSetActive(opt.data)}
              />
            </PanelSectionRow>

            {settings && settings.profiles.length === 0 && profileFormOpen === "none" && (
              <PanelSectionRow>
                <Field label="No PCs configured yet" />
              </PanelSectionRow>
            )}

            {profileFormOpen === "none" && (
              <>
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={openAddForm}>
                    Add PC
                  </ButtonItem>
                </PanelSectionRow>
                {activeProfile && (
                  <>
                    <PanelSectionRow>
                      <ButtonItem layout="below" onClick={() => openEditForm(activeProfile)}>
                        Edit
                      </ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                      <ButtonItem layout="below" onClick={() => handleDelete(activeProfile.id)}>
                        Delete
                      </ButtonItem>
                    </PanelSectionRow>
                  </>
                )}
              </>
            )}

            {profileFormOpen !== "none" && (
              <>
                <PanelSectionRow>
                  <TextField label="Name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
                </PanelSectionRow>
                <PanelSectionRow>
                  <TextField
                    label="Host / IP"
                    value={hostInput}
                    onChange={(e) => setHostInput(e.target.value)}
                  />
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
                  <ButtonItem layout="below" onClick={handleSaveProfileForm}>
                    Save
                  </ButtonItem>
                </PanelSectionRow>
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={closeForm}>
                    Cancel
                  </ButtonItem>
                </PanelSectionRow>
              </>
            )}
          </PanelSection>
        </>
      )}
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
