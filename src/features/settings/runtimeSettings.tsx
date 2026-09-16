/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "watermark-studio.runtime-settings.v1";

export interface RuntimeSettingsState {
  useMainThreadRender: boolean;
  forceSoftwareWebCodecs: boolean;
  maxConcurrency: number;
}

function detectInitialMaxConcurrency() {
  if (typeof navigator === "undefined") {
    return 1;
  }

  const rawCoreCount = Number(navigator.hardwareConcurrency ?? 1);
  const coreCount = Number.isFinite(rawCoreCount) ? Math.max(1, Math.round(rawCoreCount)) : 1;

  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  const rawDeviceMemory = Number(navigatorWithMemory.deviceMemory ?? 0);
  const deviceMemory =
    Number.isFinite(rawDeviceMemory) && rawDeviceMemory > 0 ? rawDeviceMemory : 4;

  const cpuLimited = Math.max(1, Math.min(8, Math.floor(coreCount * 0.75)));
  const memoryLimited =
    deviceMemory >= 16
      ? 8
      : deviceMemory >= 8
        ? 6
        : deviceMemory >= 4
          ? 4
          : deviceMemory >= 2
            ? 2
            : 1;

  return Math.max(1, Math.min(64, Math.min(cpuLimited, memoryLimited)));
}

function createDefaultRuntimeSettings(): RuntimeSettingsState {
  return {
    useMainThreadRender: false,
    forceSoftwareWebCodecs: false,
    maxConcurrency: detectInitialMaxConcurrency(),
  };
}

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettingsState = createDefaultRuntimeSettings();

interface RuntimeSettingsContextValue {
  settings: RuntimeSettingsState;
  setUseMainThreadRender: (value: boolean) => void;
  setForceSoftwareWebCodecs: (value: boolean) => void;
  setMaxConcurrency: (value: number) => void;
  resetSettings: () => void;
}

const RuntimeSettingsContext = createContext<RuntimeSettingsContextValue | null>(null);

function sanitizeMaxConcurrency(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RUNTIME_SETTINGS.maxConcurrency;
  return Math.max(1, Math.min(64, Math.round(numeric)));
}

function loadSettings(): RuntimeSettingsState {
  if (typeof window === "undefined") return DEFAULT_RUNTIME_SETTINGS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RUNTIME_SETTINGS;

    const parsed = JSON.parse(raw) as Partial<RuntimeSettingsState>;
    return {
      useMainThreadRender: Boolean(parsed.useMainThreadRender),
      forceSoftwareWebCodecs: Boolean(parsed.forceSoftwareWebCodecs),
      maxConcurrency: sanitizeMaxConcurrency(parsed.maxConcurrency),
    };
  } catch {
    return DEFAULT_RUNTIME_SETTINGS;
  }
}

export function RuntimeSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<RuntimeSettingsState>(() => loadSettings());

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const value = useMemo<RuntimeSettingsContextValue>(
    () => ({
      settings,
      setUseMainThreadRender: (next: boolean) => {
        setSettings((prev) => ({ ...prev, useMainThreadRender: next }));
      },
      setForceSoftwareWebCodecs: (next: boolean) => {
        setSettings((prev) => ({ ...prev, forceSoftwareWebCodecs: next }));
      },
      setMaxConcurrency: (next: number) => {
        setSettings((prev) => ({ ...prev, maxConcurrency: sanitizeMaxConcurrency(next) }));
      },
      resetSettings: () => {
        const defaults = createDefaultRuntimeSettings();
        setSettings(defaults);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      },
    }),
    [settings],
  );

  return (
    <RuntimeSettingsContext.Provider value={value}>{children}</RuntimeSettingsContext.Provider>
  );
}

export function useRuntimeSettings() {
  const context = useContext(RuntimeSettingsContext);
  if (!context) {
    throw new Error("useRuntimeSettings must be used within RuntimeSettingsProvider");
  }
  return context;
}
