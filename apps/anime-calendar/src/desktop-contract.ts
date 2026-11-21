// Public, dependency-free protocol contract; module health is a separate concern.
export const desktopContract = {
  manifestVersion: 1,
  protocol: { min: 2, max: 2 },
  capabilities: ["accounts-v1", "device-binding-v1", "desktop-commands-v1", "host-transport-v2"],
  requiredClientCapabilities: ["accounts-v1", "device-binding-v1", "desktop-commands-v1", "host-transport-v2"],
};
export function unsupportedDesktop(headers: Headers) {
  const value = headers.get("x-desktop-protocol");
  return value !== null && value !== "2";
}
