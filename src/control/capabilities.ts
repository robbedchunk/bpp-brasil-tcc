export const CONTROL_PROTOCOL_VERSION = 1;

export const CONTROL_PREVIEW_ACTIONS = [
  "collect",
  "discover",
  "daily",
  "classify",
  "index",
] as const;

export const CONTROL_EXECUTION_ACTIONS = [
  "collect",
  "discover",
  "daily",
  "classify",
  "index-export",
] as const;

export interface ControlCapabilities {
  protocolVersion: number;
  observation: {
    literalReadOnlyDatabase: boolean;
    schemaCapabilityInspection: boolean;
    processLockInspection: boolean;
  };
  preview: {
    literalReadOnly: boolean;
    actions: readonly string[];
  };
  execution: {
    guardedByCli: boolean;
    actions: readonly string[];
  };
}

export const CONTROL_CAPABILITIES = {
  protocolVersion: CONTROL_PROTOCOL_VERSION,
  observation: {
    literalReadOnlyDatabase: true,
    schemaCapabilityInspection: true,
    processLockInspection: true,
  },
  preview: {
    literalReadOnly: true,
    actions: CONTROL_PREVIEW_ACTIONS,
  },
  execution: {
    guardedByCli: true,
    actions: CONTROL_EXECUTION_ACTIONS,
  },
} as const satisfies ControlCapabilities;

export function controlCapabilities(): ControlCapabilities {
  return CONTROL_CAPABILITIES;
}
