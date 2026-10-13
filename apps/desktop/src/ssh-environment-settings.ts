import { randomUUID } from "node:crypto";
import type { DesktopConfiguration, SshConnectionSettings, SshDeviceInput, SshEnvironment } from "./environment-types.js";
import { connectionSettings } from "./ssh-connection.js";

export function previousFingerprint(environment: SshEnvironment | undefined, input: SshDeviceInput): string | undefined {
  const previous = environment?.sshConnection;
  return previous && previous.host.toLowerCase() === input.host.toLowerCase() && previous.port === input.port
    ? previous.hostFingerprint : undefined;
}

/** Only validated connection settings enter persistent configuration. */
export function configureSshEnvironment(
  current: DesktopConfiguration,
  input: SshDeviceInput,
  verified?: SshConnectionSettings,
  environmentId?: string,
): { configuration: DesktopConfiguration; environment: SshEnvironment } {
  const configuration = structuredClone(current);
  const existing = configuration.environments.find(item => environmentId
    ? item.environmentId === environmentId
    : item.kind === "ssh" && item.sshConnection?.host.toLowerCase() === input.host.toLowerCase()
      && item.sshConnection.port === input.port && item.sshConnection.username === input.username);
  if (environmentId && (!existing || existing.kind !== "ssh")) throw new Error("设备不存在，请刷新设置后重试");
  const connection = connectionSettings(input, verified?.hostFingerprint ?? previousFingerprint(existing?.kind === "ssh" ? existing : undefined, input));
  let environment: SshEnvironment;
  if (existing?.kind === "ssh") {
    environment = existing;
    environment.name = input.name; environment.sshHost = input.host; environment.sshConnection = connection;
    const device = configuration.devices.find(item => item.deviceId === environment.deviceId);
    if (device) device.name = input.name;
  } else {
    const deviceId = randomUUID();
    configuration.devices.push({ deviceId, name: input.name, kind: "remote" });
    environment = {
      environmentId: randomUUID(), deviceId, name: input.name, kind: "ssh", sshHost: input.host,
      sshConnection: connection, enabled: false, codexApprovalsEnabled: false,
    };
    configuration.environments.push(environment);
  }
  return { configuration, environment };
}
