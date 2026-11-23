import * as Schema from "effect/Schema";

const CoreDevice = Schema.Struct({
  hardwareProperties: Schema.optional(
    Schema.Struct({
      deviceType: Schema.optional(Schema.String),
      udid: Schema.optional(Schema.String),
    }),
  ),
  connectionProperties: Schema.optional(
    Schema.Struct({
      transportType: Schema.optional(Schema.String),
      pairingState: Schema.optional(Schema.String),
      tunnelState: Schema.optional(Schema.String),
    }),
  ),
  deviceProperties: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      developerModeStatus: Schema.optional(Schema.String),
    }),
  ),
});

const decodeCoreDevices = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ result: Schema.Struct({ devices: Schema.Array(CoreDevice) }) }),
  ),
);

export function readCoreDevices(stdout: string): ReadonlyArray<typeof CoreDevice.Type> | undefined {
  const decoded = decodeCoreDevices(stdout);
  return decoded._tag === "Some" ? decoded.value.result.devices : undefined;
}

export function selectPhoneRoute(
  devices: ReadonlyArray<typeof CoreDevice.Type> | undefined,
  usbAttached: boolean | undefined,
) {
  const wired = (devices ?? []).filter(
    ({ hardwareProperties, connectionProperties }) =>
      hardwareProperties?.deviceType === "iPhone" &&
      connectionProperties?.transportType === "wired" &&
      (usbAttached !== false || connectionProperties.tunnelState === "connected"),
  );
  const targets = wired.flatMap(
    ({ hardwareProperties, connectionProperties, deviceProperties }) => {
      const id = hardwareProperties?.udid;
      return id &&
        connectionProperties?.pairingState === "paired" &&
        connectionProperties.tunnelState !== "unavailable" &&
        deviceProperties?.developerModeStatus === "enabled"
        ? [{ id, name: deviceProperties.name ?? "iPhone" }]
        : [];
    },
  );
  if (targets.length > 0) return { route: "usb", targets } as const;
  if (wired.length > 0 || usbAttached === true) {
    return {
      route: "blocked",
      message:
        "An iPhone is attached over USB. Unlock it, trust this Mac, and enable Developer Mode for wired control.",
    } as const;
  }
  if (usbAttached !== false) {
    return {
      route: "blocked",
      message: "Could not verify whether an iPhone is attached by USB.",
    } as const;
  }
  return { route: "mirroring" } as const;
}
