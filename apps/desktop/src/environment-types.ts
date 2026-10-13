import type { ReceiverSnapshot } from "@vibemate/receiver";

export type EnvironmentKind = "windows" | "wsl" | "ssh";
export type EnvironmentStatus = "stopped" | "starting" | "connected" | "disconnected" | "error";

export interface DeviceRecord {
  deviceId: string;
  name: string;
  kind: "local" | "remote";
}

interface EnvironmentBase {
  environmentId: string;
  deviceId: string;
  name: string;
  enabled: boolean;
  codexApprovalsEnabled?: boolean;
}

export interface WindowsEnvironment extends EnvironmentBase {
  kind: "windows";
}

export interface WslEnvironment extends EnvironmentBase {
  kind: "wsl";
  distribution: string;
}

export interface SshEnvironment extends EnvironmentBase {
  kind: "ssh";
  sshHost: string;
  sshConnection?: SshConnectionSettings;
}

export interface SshConnectionSettings {
  host: string;
  port: number;
  username: string;
  authentication: "password" | "key";
  privateKeyPath?: string;
  hostFingerprint?: string;
}

export interface SshDeviceInput extends Omit<SshConnectionSettings, "hostFingerprint"> {
  name: string;
}

/** Transient IPC input. Never add these fields to EnvironmentConfig or snapshots. */
export interface SshCredentials {
  password?: string;
  passphrase?: string;
}

export interface SshConnectionTest {
  verificationId: string;
  hostname: string;
  architecture: "x64" | "arm64";
  agents: { codex: boolean; copilot: boolean };
}

export type EnvironmentConfig = WindowsEnvironment | WslEnvironment | SshEnvironment;

export type EnvironmentView = EnvironmentConfig & {
  status: EnvironmentStatus;
  error?: string;
  manuallyStarted: boolean;
};

export type AggregatedSession = ReceiverSnapshot["sessions"][number] & {
  deviceId: string;
  environmentId: string;
  environmentName: string;
};

export type AggregatedPermission = ReceiverSnapshot["pendingPermissions"][number] & {
  deviceId: string;
  environmentId: string;
  environmentName: string;
};

export interface DesktopPreferences {
  showPet: boolean;
  showPreview: boolean;
  focus: { kind: "all" | "device" | "environment" | "project" | "session"; id?: string };
}

export interface DesktopConfiguration {
  version: 1;
  devices: DeviceRecord[];
  environments: EnvironmentConfig[];
  preferences: DesktopPreferences;
  onboardingCompleted: boolean;
}

export interface AggregatedSnapshot {
  devices: DeviceRecord[];
  environments: EnvironmentView[];
  sessions: AggregatedSession[];
  pendingPermissions: AggregatedPermission[];
  preferences: DesktopPreferences;
  onboardingCompleted: boolean;
}
