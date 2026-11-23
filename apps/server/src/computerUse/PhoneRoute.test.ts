import { describe, expect, it } from "vite-plus/test";

import { selectPhoneRoute } from "./PhoneRoute.ts";

const phone = {
  hardwareProperties: { udid: "00008101-00123456", deviceType: "iPhone" },
  deviceProperties: { name: "Test iPhone", developerModeStatus: "enabled" },
  connectionProperties: {
    transportType: "wired",
    pairingState: "paired",
    tunnelState: "connected",
  },
};

describe("physical iPhone routing", () => {
  it("targets the paired wired iPhone by its hardware UDID", () => {
    expect(selectPhoneRoute([phone], true)).toEqual({
      route: "usb",
      targets: [{ id: phone.hardwareProperties.udid, name: "Test iPhone" }],
    });
  });

  it("routes to Mirroring when the known phones are wireless or simulated", () => {
    const device = (transportType: string) => ({
      ...phone,
      connectionProperties: { ...phone.connectionProperties, transportType },
    });
    expect(selectPhoneRoute([device("localNetwork"), device("sameMachine")], false)).toEqual({
      route: "mirroring",
    });
  });

  it("keeps the USB route blocked if the connected phone is untrusted or Developer Mode is off", () => {
    expect(selectPhoneRoute([], true)).toMatchObject({ route: "blocked" });
    expect(
      selectPhoneRoute(
        [
          {
            ...phone,
            deviceProperties: { ...phone.deviceProperties, developerModeStatus: "disabled" },
          },
        ],
        true,
      ),
    ).toMatchObject({ route: "blocked" });
  });

  it("requires positive evidence before it falls back to Mirroring", () => {
    expect(selectPhoneRoute(undefined, undefined)).toMatchObject({ route: "blocked" });
    expect(selectPhoneRoute(undefined, false)).toEqual({ route: "mirroring" });
  });
});
