import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {},
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${PROBE_HOSTS.join(", ")} between ${DEFAULT_DESKTOP_BACKEND_PORT} and ${MAX_TCP_PORT}.`;
  }
}

export const findAvailablePort = Effect.fn("desktop.backendPort.findAvailable")(function* (
  preferred: number,
) {
  const net = yield* NetService.NetService;
  const count = MAX_TCP_PORT - DEFAULT_DESKTOP_BACKEND_PORT + 1;
  const start = Math.max(preferred, DEFAULT_DESKTOP_BACKEND_PORT);
  for (let offset = 0; offset < count; offset += 1) {
    const port =
      DEFAULT_DESKTOP_BACKEND_PORT + ((start - DEFAULT_DESKTOP_BACKEND_PORT + offset) % count);
    const unavailableHost = yield* Effect.findFirst(PROBE_HOSTS, (host) =>
      net.canListenOnHost(port, host).pipe(Effect.map((available) => !available)),
    );
    if (Option.isNone(unavailableHost)) return port;
  }
  return yield* new DesktopBackendPortUnavailableError();
});
