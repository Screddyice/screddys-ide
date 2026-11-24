const rateQuery = { resource: "liveRate" };
const totalQuery = { resource: "usage", period: "allTime", page: { limit: 1 } };
const sessionQuery = {
  resource: "sessions",
  period: "allTime",
  sort: { field: "lastUsedAt", direction: "desc" },
  page: { limit: 24 },
};
const speedFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const totalFormat = new Intl.NumberFormat();
const scaleSteps = [100, 200, 400, 800, 1600, 3200];
const scaleRatios = [0, 0.25, 0.5, 0.75, 1];

function watch(ctx, query, show) {
  let stopped = false;
  let revision = 0;
  let unsubscribe;
  function onError(request) {
    if (!stopped && revision === request) show(null);
  }
  void ctx.data
    .subscribe(query, (event) => {
      if (stopped) return;
      if (event.type === "snapshot") {
        revision++;
        show(event.value);
        return;
      }
      if (event.type !== "invalidate") return;
      const request = ++revision;
      if (event.reset) show(null);
      if (event.refetch) {
        void ctx.data.query(query).then(
          (result) => {
            if (!stopped && revision === request) show(result);
          },
          () => onError(request),
        );
      }
    })
    .then(
      (stop) => {
        if (stopped) stop();
        else unsubscribe = stop;
      },
      () => onError(revision),
    );
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

function sessionName(session) {
  const clients = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
  const client = clients[session.client] ?? session.client ?? "Unknown tool";
  return session.title ? `${client} · ${session.title}` : client;
}

function menuLogo(image) {
  // macOS renders custom tray layouts as templates. Keep the SR ring and
  // letters in the alpha channel so the mark adapts to the menu-bar color.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 44;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, 44, 44);
  const pixels = context.getImageData(0, 0, 44, 44);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const green = pixels.data[index + 1];
    pixels.data[index + 3] *= Math.min(1, Math.max(0, (green - 16) / 110));
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function websiteLogo(image, openWebsite) {
  const link = document.createElement("a");
  link.className = "screddy-brand-link";
  link.href = "https://shawn-reddy.com/";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", "Visit shawn-reddy.com");
  const icon = image.cloneNode();
  icon.alt = "";
  link.append(icon);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openWebsite();
  });
  return link;
}

export async function activate(ctx) {
  const logo = new Image();
  logo.crossOrigin = "anonymous";
  logo.src = ctx.asset("screddy.png");
  await logo.decode();
  const trayMark = menuLogo(logo);
  const titleMark = document.querySelector(".app-title > .app-title-mark");
  const openWebsite = () => {
    void ctx.backend
      .call("openWebsite")
      .catch((error) => console.warn("Could not open shawn-reddy.com", error));
  };
  const titleLogo = titleMark && websiteLogo(logo, openWebsite);
  if (titleLogo) {
    titleLogo.classList.add("screddy-title-brand");
    titleMark.after(titleLogo);
  }
  const rateListeners = new Set();
  let latestRate = null;
  let stopRate;

  function trackRate() {
    stopRate ??= watch(ctx, rateQuery, (result) => {
      latestRate = result?.availability === "available" ? result.rows[0] : null;
      for (const update of rateListeners) update();
    });
  }

  let trayReported = false;
  return {
    renderTray(canvas, { height }) {
      const inset = Math.round(height * 0.055);
      canvas
        .getContext("2d")
        .drawImage(trayMark, inset, inset, height - inset * 2, height - inset * 2);
      trackRate();
      // Tells Screddy this SR mark is in the menu bar, so it does not add a second one.
      if (!trayReported) {
        trayReported = true;
        void ctx.backend.call("trayShown").catch(() => {
          trayReported = false;
        });
      }
    },
    mount(container, initial) {
      const panel = document.createElement("section");
      panel.className = "screddy-speedometer";
      panel.setAttribute("aria-label", "Screddy Token Speedometer");
      panel.innerHTML = `
        <div class="screddy-speedometer-activity" hidden>
          <span>Computer Use</span><strong data-applications></strong>
        </div>
        <div class="screddy-speedometer-heading">
          <span>Token Speedometer</span>
          <span data-status>Sampling</span>
        </div>
        <div class="screddy-speedometer-dial">
          <div class="screddy-speedometer-track" aria-hidden="true">
            <div class="screddy-speedometer-fill"></div>
            <div class="screddy-speedometer-scale"></div>
          </div>
          <div class="screddy-speedometer-speed">
            <span class="screddy-speedometer-label">Combined output</span>
            <strong data-speed>—</strong>
            <span class="screddy-speedometer-unit">tok/s</span>
          </div>
        </div>
        <div class="screddy-speedometer-total">
          <strong data-total>—</strong>
          <span class="screddy-speedometer-label" data-total-label>All-time tokens</span>
        </div>
        <div class="screddy-speedometer-session-field">
          <span class="screddy-speedometer-session-label" aria-hidden="true">All threads</span>
          <select class="screddy-speedometer-session" aria-label="Threads for token total" data-tm-native-select disabled>
            <option value="">All threads</option>
          </select>
        </div>`;
      panel
        .querySelector(".screddy-speedometer-heading > span")
        .prepend(websiteLogo(logo, openWebsite));
      const track = panel.querySelector(".screddy-speedometer-track");
      const scaleRow = panel.querySelector(".screddy-speedometer-scale");
      const marks = scaleRatios.map(() => {
        const mark = document.createElement("span");
        scaleRow.append(mark);
        return mark;
      });
      const status = panel.querySelector("[data-status]");
      const speed = panel.querySelector("[data-speed]");
      const total = panel.querySelector("[data-total]");
      const totalLabel = panel.querySelector("[data-total-label]");
      const sessionPicker = panel.querySelector("select");
      const sessionLabel = panel.querySelector(".screddy-speedometer-session-label");
      const activity = panel.querySelector(".screddy-speedometer-activity");
      const applicationNames = activity.querySelector("[data-applications]");
      let scale = scaleSteps[0];
      let stopUsage;
      let sessions = [];
      let chosenId = "";
      let aggregateTotal = null;
      let activityTimer;
      let activityRevision = 0;

      function renderRate() {
        const sample = latestRate;
        const live = sample?.state === "live" && Number.isFinite(sample.speed) && sample.speed >= 0;
        const idle = sample?.state === "idle";
        const rate = live ? sample.speed : 0;
        if (rate > scale)
          scale = scaleSteps.find((step) => step >= rate) ?? Math.ceil(rate / 1000) * 1000;
        const fraction = Math.min(1, rate / scale);
        status.textContent = live
          ? "Live"
          : idle
            ? "Idle"
            : sample?.reason === "waitingForSample"
              ? "Sampling"
              : "Awaiting data";
        status.classList.toggle("is-live", live);
        speed.textContent = live || idle ? speedFormat.format(rate) : "—";
        track.style.setProperty("--fill", `${fraction * 100}%`);
        track.classList.toggle("is-hot", fraction >= 0.9);
        marks.forEach((mark, index) => {
          mark.textContent = totalFormat.format(scaleRatios[index] * scale);
          // A little clearance keeps labels legible when the slanted edge is crossing them.
          mark.classList.toggle(
            "is-filled",
            fraction === 1 || fraction > scaleRatios[index] + 0.07,
          );
        });
      }

      function renderSession() {
        const label = sessionPicker.selectedOptions[0]?.text ?? "All threads";
        sessionLabel.textContent = label;
        sessionPicker.title = label;
        const tokens =
          chosenId === ""
            ? aggregateTotal
            : sessions.find((row) => row.id === chosenId)?.totalTokens;
        total.textContent = Number.isFinite(tokens) ? totalFormat.format(tokens) : "—";
        totalLabel.textContent = chosenId === "" ? "All-time tokens" : "Thread tokens";
      }

      function updateSessions(result) {
        sessions = result?.availability === "available" ? result.rows : [];
        if (!sessions.some((row) => row.id === chosenId)) chosenId = "";
        const labels = [
          ["", "All threads"],
          ...sessions.map((session) => [session.id, sessionName(session)]),
        ];
        const existing = Array.from(sessionPicker.options);
        if (
          existing.length !== labels.length ||
          !existing.every(
            (option, index) =>
              option.value === labels[index][0] && option.text === labels[index][1],
          )
        ) {
          sessionPicker.replaceChildren(...labels.map(([id, label]) => new Option(label, id)));
        }
        sessionPicker.disabled = sessions.length === 0;
        sessionPicker.value = chosenId;
        renderSession();
      }
      sessionPicker.addEventListener("change", () => {
        chosenId = sessionPicker.value;
        renderSession();
      });

      async function pollActivity(revision) {
        const applications = await ctx.backend.call("activeApplications").catch(() => []);
        if (revision !== activityRevision) return;
        activity.hidden = applications.length === 0;
        applicationNames.textContent = applications
          .map((name) => name ?? "Application unavailable")
          .join(", ");
        activityTimer = setTimeout(() => void pollActivity(revision), 1000);
      }

      function stopReading() {
        activityRevision++;
        clearTimeout(activityTimer);
        activity.hidden = true;
        stopUsage?.();
        stopUsage = undefined;
        rateListeners.delete(renderRate);
      }

      function update({ visible }) {
        if (visible === false) {
          stopReading();
          return;
        }
        trackRate();
        rateListeners.add(renderRate);
        renderRate();
        if (!stopUsage) {
          const stopTotal = watch(ctx, totalQuery, (result) => {
            aggregateTotal =
              result?.availability === "available" ? result.rows[0]?.totalTokens : null;
            renderSession();
          });
          const stopSessions = watch(ctx, sessionQuery, updateSessions);
          stopUsage = () => {
            stopTotal();
            stopSessions();
          };
          void pollActivity(++activityRevision);
        }
      }

      container.append(panel);
      update(initial);
      return {
        update,
        dispose() {
          stopReading();
          panel.remove();
        },
      };
    },
    dispose() {
      titleLogo?.remove();
      stopRate?.();
    },
  };
}
