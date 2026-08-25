(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let activeRange = "24h";
  let historyPoints = [];
  let solarProfileDays = [];
  const solarQuery = new URLSearchParams(window.location.search);
  let solarProfilePeriod = ["month", "year"].includes(solarQuery.get("solar")) ? solarQuery.get("solar") : "week";
  const solarDateQuery = solarQuery.get("solar_date");
  let solarProfileAnchor = /^\d{4}-\d{2}-\d{2}$/.test(solarDateQuery || "") ? new Date(`${solarDateQuery}T12:00:00`) : new Date();
  let temperatureRange = "24h";
  let temperaturePoints = [];
  let historyChart = null;
  let energyChart = null;
  let socChart = null;
  let solarYearChart = null;
  let energyPeriod = "day";
  let energyView = "balance";
  let energyAnchor = new Date();
  let energyPayload = { points: [] };
  let temperatureAlertState = "normal";
  let liveTimer;
  let historyTimer;
  let storageTimer;
  let statisticsTimer;
  let batteryStatisticsTimer;
  let solarProfileTimer;
  let temperatureTimer;
  let economicsTimer;
  let energyTimer;
  let highscoreTimer;
  let latestSnapshot = null;
  let latestStatistics = { days: [] };
  const batteryQueryValue = new URLSearchParams(window.location.search).get("battery");
  let batteryAnchor = /^\d{4}-\d{2}-\d{2}$/.test(batteryQueryValue || "") ? batteryQueryValue : null;
  let batteryPage = { days: [] };
  let deviceEventsCursor = null;
  let dailyPage = { days: [] };
  const dailyQueryValue = new URLSearchParams(window.location.search).get("daily");
  let dailyAnchor = /^\d{4}-\d{2}-\d{2}$/.test(dailyQueryValue || "") ? dailyQueryValue : null;
  let recordingEconomics = null;
  const root = document.documentElement;
  const DASHBOARD_TABS = ["overview", "history", "economics", "system", "info"];
  let dashboardView = "overview";
  let lastTabbedView = "overview";
  try {
    const storedView = localStorage.getItem("pv-dashboard-view");
    if (storedView === "all" || DASHBOARD_TABS.includes(storedView)) dashboardView = storedView;
    const storedTabbedView = localStorage.getItem("pv-dashboard-last-tab");
    if (DASHBOARD_TABS.includes(storedTabbedView)) lastTabbedView = storedTabbedView;
  } catch (_) { /* optional */ }
  const BASE_TARIFF_CT = 28.33;
  const BASE_EXPORT_TARIFF_CT = 6.00;
  const TOTAL_INVESTMENT_EUR = 3551;
  const HISTORIC_EZ_GENERATION_KWH = 3000;
  let tariffCt = BASE_TARIFF_CT;
  let exportTariffCt = BASE_EXPORT_TARIFF_CT;
  try {
    const storedTariff = Number(localStorage.getItem("pv-tariff-ct"));
    if (Number.isFinite(storedTariff) && storedTariff >= 15 && storedTariff <= 50) tariffCt = storedTariff;
  } catch (_) { /* optional */ }
  try {
    const storedExportTariff = Number(localStorage.getItem("pv-export-tariff-ct"));
    if (Number.isFinite(storedExportTariff) && storedExportTariff >= 0 && storedExportTariff <= 15) exportTariffCt = storedExportTariff;
  } catch (_) { /* optional */ }

  const power = (value, signed = false) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const number = Number(value);
    const absolute = Math.abs(number);
    const amount = absolute >= 1000 ? `${(absolute / 1000).toFixed(2)} kW` : `${Math.round(absolute)} W`;
    if (!signed || number === 0) return amount;
    return `${number > 0 ? "+" : "−"}${amount}`;
  };

  const number = (value, unit, digits = 1) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return `${Number(value).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
  };

  const energy = (value, digits = 2) => number(value, "kWh", digits);
  const money = (value, digits = 2) => Number(value || 0).toLocaleString("de-DE", {
    style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits,
  });

  const text = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  const setWidth = (id, value) => { const node = $(id); if (node) node.style.width = `${Math.max(0, Math.min(100, value || 0))}%`; };

  function initTooltips() {
    const definitions = [
      [".meter-strip > div:nth-child(1)", "Kumulierter Netzbezug laut offiziellem IR-Stromzähler."],
      [".meter-strip > div:nth-child(2)", "Kumulierte Einspeisung laut offiziellem IR-Stromzähler."],
      [".meter-strip > div:nth-child(3)", "Heutige Erzeugung aus ONE und EZ1 zusammen."],
      [".meter-strip > div:nth-child(4)", "Gesamterzeugung aus den verfügbaren Anlagenzählern."],
      [".solar-card", "Aktuelle gemeinsame PV-Leistung von Süd/West und Ost."],
      [".house-card", "Errechneter Hausbedarf aus allen gemessenen AC-Flüssen."],
      [".grid-card", "Live-Netzfluss am Shelly: positiv Bezug, negativ Einspeisung."],
      [".battery-card", "Ladezustand, DC-Batterieleistung und AC-Leistung des ONE."],
      [".one-pv-node", "DC-Leistung der direkt am ONE angeschlossenen Süd/West-Module."],
      [".flow-battery-node", "Gesamte vom ONE gemeldete Lade- oder Entladeleistung der Batterie."],
      [".ez1-flow-node", "AC-Erzeugung der separaten Ost-Anlage am Hausnetz."],
      [".flow-home-node", "Hausverbrauch als AC-Bilanz aus Erzeugung und Netzfluss."],
      [".flow-grid-node", "Groß: Shelly-Livewert. Klein: vorzeichenrichtiger Mittelwert über eine Minute."],
      [".solakon-card", "Livewerte der Modul- und MPPT-Eingänge des Solakon ONE."],
      [".ez1-card", "Livewerte der beiden Eingänge des APsystems EZ1."],
      [".phase-card", "Momentane Leistung je Außenleiter am Netzanschlusspunkt."],
      [".diagnostic-card", "Vergleich unabhängiger Messgeräte; Shelly bleibt die Netzreferenz."],
      [".today-grid > div:nth-child(1)", "Aus 5-Sekunden-Werten integrierter Hausverbrauch seit Mitternacht."],
      [".today-grid > div:nth-child(2)", "Aus 5-Sekunden-Werten integrierte PV-Erzeugung seit Mitternacht."],
      [".today-grid > div:nth-child(3)", "Heute aus dem öffentlichen Netz bezogene Energie."],
      [".today-grid > div:nth-child(4)", "Heute ins öffentliche Netz abgegebene Energie."],
      [".today-grid > div:nth-child(5)", "Anteil des Verbrauchs ohne Energiebezug aus dem Netz."],
      [".today-grid > div:nth-child(6)", "Anteil der PV-Erzeugung, der im Haus oder Speicher genutzt wurde."],
      [".today-grid > div:nth-child(7)", "Robuste Schätzung des typischen niedrigen Hausverbrauchs."],
      [".battery-summary > div:nth-child(2)", "Anzahl der Tage, an denen mindestens 99 % erreicht wurden."],
      [".battery-summary > div:nth-child(3)", "Anzahl der Tage, an denen die eingestellte Reserve erreicht wurde."],
      [".battery-summary > div:nth-child(4)", "Einspeisung in Zeiträumen mit bereits vollem Speicher."],
      [".battery-summary > div:nth-child(5)", "Netzbezug in Zeiträumen mit erreichter Batteriereserve."],
      [".battery-summary > div:nth-child(6)", "Konservativer Hinweis auf zusätzlich zeitlich verschiebbare Energie."],
      [".temperature-summary > div", "Messwert und Status aus der lokalen Temperaturaufzeichnung."],
      [".device-status-grid > article", "Zuletzt beobachteter Gerätezustand; das Dashboard arbeitet nur lesend."],
      [".source-grid > div", "Status der lokalen Datenverbindung zu dieser Quelle."],
      [".economics-grid > div", "Rechenwert aus Messenergie und dem gewählten simulierten Tarif."],
      [".amortization-grid > div", "Modellwert auf Basis der dokumentierten Investitions- und Tarifannahmen."],
    ];
    definitions.forEach(([selector, message]) => {
      document.querySelectorAll(selector).forEach((node) => { node.dataset.tooltip = message; });
    });

    const tooltip = document.createElement("div");
    tooltip.className = "dashboard-tooltip";
    tooltip.id = "dashboard-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    let timer = null;
    const hide = () => {
      window.clearTimeout(timer);
      tooltip.classList.remove("visible");
    };
    const position = (node) => {
      const rect = node.getBoundingClientRect();
      const margin = 10;
      const left = Math.max(margin, Math.min(window.innerWidth - tooltip.offsetWidth - margin,
        rect.left + (rect.width - tooltip.offsetWidth) / 2));
      let top = rect.top - tooltip.offsetHeight - 10;
      if (top < margin) top = Math.min(window.innerHeight - tooltip.offsetHeight - margin, rect.bottom + 10);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };
    document.querySelectorAll("[data-tooltip]").forEach((node) => {
      node.setAttribute("aria-describedby", tooltip.id);
      node.addEventListener("pointerenter", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          tooltip.textContent = node.dataset.tooltip;
          tooltip.classList.add("visible");
          position(node);
        }, 750);
      });
      node.addEventListener("pointerleave", hide);
      node.addEventListener("focusin", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          tooltip.textContent = node.dataset.tooltip;
          tooltip.classList.add("visible");
          position(node);
        }, 400);
      });
      node.addEventListener("focusout", hide);
    });
    window.addEventListener("scroll", hide, { passive: true });
  }

  const viewIncludes = (name) => dashboardView === "all" || dashboardView === name;

  function refreshDashboardView() {
    if (viewIncludes("overview") || viewIncludes("economics")) void loadStatistics();
    if (viewIncludes("history")) {
      void loadHistory();
      void loadTemperatureHistory();
      void loadBatteryStatistics();
      void loadSolarProfiles();
      void loadEnergySeries();
      void loadHighscores();
    }
    if (viewIncludes("economics")) {
      void loadEconomics();
    }
    if (viewIncludes("system")) { void loadStorage(); void loadDeviceEvents(); }
  }

  function setDashboardView(view, persist = true) {
    dashboardView = view === "all" || DASHBOARD_TABS.includes(view) ? view : "overview";
    if (dashboardView !== "all") lastTabbedView = dashboardView;
    document.querySelectorAll("[data-dashboard-section]").forEach((section) => {
      section.hidden = dashboardView !== "all" && section.getAttribute("data-dashboard-section") !== dashboardView;
    });
    document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
      const active = dashboardView !== "all" && button.getAttribute("data-dashboard-tab") === dashboardView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const navigation = document.querySelector(".dashboard-tabs");
    navigation?.classList.toggle("all-mode", dashboardView === "all");
    text("all-sections-label", dashboardView === "all" ? "In Tabs anzeigen" : "Alles anzeigen");
    if (persist) {
      try { localStorage.setItem("pv-dashboard-view", dashboardView); } catch (_) { /* optional */ }
      try { localStorage.setItem("pv-dashboard-last-tab", lastTabbedView); } catch (_) { /* optional */ }
    }
    refreshDashboardView();
    window.setTimeout(() => {
      if (viewIncludes("history")) { drawInteractiveHistory(); drawEnergySeries(); drawSocHistory(); drawTemperatureHistory(); drawSolarProfiles(); }
    }, 0);
  }

  function scrollToDashboardContent(view) {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const selector = view === "all"
      ? "[data-dashboard-section]"
      : `[data-dashboard-section="${view}"]`;
    const target = document.querySelector(selector);
    if (!target) return;
    window.requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function renderEconomics() {
    const price = tariffCt / 100;
    const exportPrice = exportTariffCt / 100;
    text("tariff-price", `${tariffCt.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh`);
    text("export-tariff-price", `${exportTariffCt.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh`);
    const slider = $("tariff-slider");
    if (slider && document.activeElement !== slider) slider.value = String(tariffCt);
    const exportSlider = $("export-tariff-slider");
    if (exportSlider && document.activeElement !== exportSlider) exportSlider.value = String(exportTariffCt);
    if (latestSnapshot) {
      const pv = Math.max(Number(latestSnapshot.pv?.total_w || 0), 0);
      const house = Math.max(Number(latestSnapshot.house?.consumption_w || 0), 0);
      const grid = Number(latestSnapshot.grid?.power_w || 0);
      const battery = Math.max(Number(latestSnapshot.battery?.power_w || 0), 0);
      text("pv-value-hour", `${money(pv / 1000 * price, 3)}/h`);
      text("house-value-hour", `${money(house / 1000 * price, 3)}/h`);
      text("grid-value-label", grid >= 0 ? "Bezugskosten aktuell" : "Vergleichswert Einspeisung*");
      text("grid-value-hour", `${money(Math.abs(grid) / 1000 * (grid >= 0 ? price : exportPrice), 3)}/h`);
      text("battery-value-hour", `${money(battery / 1000 * price, 3)}/h`);
      const meterImport = Number(latestSnapshot.sources?.tasmota?.import_energy_kwh);
      const meterExport = Number(latestSnapshot.sources?.tasmota?.export_energy_kwh);
      text("energy-meter-import", Number.isFinite(meterImport) ? energy(meterImport) : "—");
      text("energy-meter-export", Number.isFinite(meterExport) ? energy(meterExport) : "—");
      text("cost-meter-import", Number.isFinite(meterImport) ? money(meterImport * price) : "—");
      text("export-value-meter", Number.isFinite(meterExport) ? money(meterExport * exportPrice) : "—");
    }
    const days = Array.isArray(latestStatistics.days) ? latestStatistics.days : [];
    const today = days[days.length - 1];
    if (today) {
      const imported = Number(today.import_kwh || 0);
      const exported = Number(today.export_kwh || 0);
      const avoided = Math.max(Number(today.consumption_kwh || 0) - imported, 0);
      text("cost-today-import", money(imported * price));
      text("saving-today", money(avoided * price));
      text("export-value-today", money(exported * exportPrice));
      text("energy-today-import", energy(imported));
      text("energy-today-avoided", energy(avoided));
      text("energy-today-export", energy(exported));
    }
    if (recordingEconomics) {
      const imported = Number(recordingEconomics.import_kwh || 0);
      const exported = Number(recordingEconomics.export_kwh || 0);
      const avoided = Number(recordingEconomics.avoided_import_kwh || 0);
      text("cost-recording-import", money(imported * price));
      text("saving-recording", money(avoided * price));
      text("export-value-recording", money(exported * exportPrice));
      text("energy-recording-import", energy(imported));
      text("energy-recording-avoided", energy(avoided));
      text("energy-recording-export", energy(exported));
      const meterExportTotal = Number(latestSnapshot?.sources?.tasmota?.export_energy_kwh);
      const oneGenerationTotal = Number(latestSnapshot?.sources?.solakon?.pv_total_kwh);
      const historicOwnUse = Number.isFinite(meterExportTotal) && Number.isFinite(oneGenerationTotal)
        ? Math.max(HISTORIC_EZ_GENERATION_KWH + oneGenerationTotal - meterExportTotal, 0)
        : null;
      const benefit = historicOwnUse === null ? null : historicOwnUse * price;
      const progress = benefit === null ? null : Math.max(0, Math.min(100, benefit / TOTAL_INVESTMENT_EUR * 100));
      const coverageHours = Number(recordingEconomics.coverage_hours || 0);
      const annualBenefit = coverageHours > 0 ? avoided * price / coverageHours * 8760 : null;
      const remaining = benefit === null ? null : Math.max(TOTAL_INVESTMENT_EUR - benefit, 0);
      const remainingYears = annualBenefit && remaining !== null ? remaining / annualBenefit : null;
      const breakEvenDate = remainingYears === null ? null : new Date(Date.now() + remainingYears * 365.2425 * 86400000);
      text("amortization-historic-energy", historicOwnUse === null ? "—" : energy(historicOwnUse, 0));
      text("amortization-benefit", benefit === null ? "—" : money(benefit));
      text("amortization-percent", progress === null ? "—" : number(progress, "%", 1));
      text("amortization-remaining", remaining === null ? "—" : `${money(remaining)} noch offen`);
      text("amortization-annual", annualBenefit === null ? "—" : `${money(annualBenefit)}/Jahr`);
      text("amortization-payback", remainingYears === null
        ? "kurze Messhistorie"
        : `ca. ${breakEvenDate.toLocaleDateString("de-DE", { month: "long", year: "numeric" })} · noch ${number(remainingYears, "Jahre", 1)}*`);
      setWidth("amortization-bar", progress || 0);
    }
  }

  function syncThemeLabel() {
    const dark = root.dataset.theme === "dark";
    text("theme-label", dark ? "Hell" : "Dunkel");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#101512" : "#f4f7f2");
  }

  function setFlow(id, value, reverse) {
    const node = $(id);
    if (!node) return;
    node.classList.toggle("active", Math.abs(value) > 1);
    node.classList.toggle("idle", Math.abs(value) <= 1);
    node.classList.toggle("reverse", Boolean(reverse));
    text(`${id}-value`, power(Math.abs(value)));
  }

  function setStatus(id, source, expectedOffline = false) {
    const node = $(id);
    if (!node) return;
    node.classList.remove("online", "expected", "offline");
    const label = source.online ? "Live" : expectedOffline ? "Offline · Nacht" : "Offline";
    node.classList.add(source.online ? "online" : expectedOffline ? "expected" : "offline");
    node.title = source.error ? friendlyConnectionError(source.error) : label;
    const labelNode = node.querySelector("b");
    if (labelNode) labelNode.textContent = label;
  }

  function uptimeLabel(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "—";
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    return days ? `${days} T ${hours} h` : `${hours} h`;
  }

  function friendlyConnectionError(error) {
    const message = String(error || "");
    if (/no route to host|errno\s*113/i.test(message)) return "Gerät im Netzwerk nicht erreichbar";
    if (/timed?\s*out|timeout/i.test(message)) return "Zeitüberschreitung bei der Geräteverbindung";
    if (/connection refused|errno\s*111/i.test(message)) return "Gerät lehnt die Verbindung ab";
    if (/urlerror|urlopen/i.test(message)) return "Geräteverbindung fehlgeschlagen";
    return "Keine Verbindung zum Gerät";
  }

  function renderDeviceCard(prefix, source, detail) {
    const online = Boolean(source?.online);
    const alarms = Array.isArray(source?.alarms) ? source.alarms : [];
    const inactive = Boolean(source?.switched_off);
    const state = online ? (source.operating_state || "Betrieb") : "Offline";
    text(`${prefix}-operating-state`, state);
    text(`${prefix}-alarm-summary`, !online ? friendlyConnectionError(source?.error) : alarms.length ? alarms.map((alarm) => alarm.label).join(" · ") : "Keine aktive Warnung");
    text(`${prefix}-state-detail`, detail);
    const badge = $(`${prefix}-state-badge`);
    if (badge) {
      badge.classList.remove("normal", "warning", "inactive");
      badge.classList.add(!online || alarms.length ? "warning" : inactive ? "inactive" : "normal");
      badge.textContent = !online ? "Offline" : alarms.length ? "Alarm" : inactive ? "Aus" : "Normal";
    }
  }

  function renderDeviceStatuses(snapshot) {
    const sources = snapshot.sources || {};
    const one = sources.solakon || {};
    const ez1 = sources.ez1 || {};
    const shelly = sources.shelly || {};
    const tasmota = sources.tasmota || {};
    renderDeviceCard("one", one, `ONE ${number(one.internal_temperature_c, "°C")} · Batterie ${number(one.battery_temperature_c, "°C")} · ${one.off_grid ? "Offgrid" : "netzgekoppelt"}`);
    renderDeviceCard("ez1", ez1, `${power(ez1.pv_w)} aktuell · lokale Alarm-API`);
    renderDeviceCard("shelly", shelly, `${number(shelly.device_temperature_c, "°C")} · Laufzeit ${uptimeLabel(shelly.uptime_seconds)} · WLAN ${number(shelly.wifi_rssi, "dBm", 0)}${shelly.restart_required ? " · Neustart erforderlich" : ""}`);
    renderDeviceCard("tasmota", tasmota, `Firmware ${tasmota.firmware_version || "—"} · Laufzeit ${uptimeLabel(tasmota.uptime_seconds)} · WLAN ${number(tasmota.wifi_signal_dbm, "dBm", 0)}`);
  }

  function empty(container, message) {
    container.replaceChildren();
    const row = document.createElement("p");
    row.className = "empty-row";
    row.textContent = message;
    container.append(row);
  }

  function renderChannels(containerId, channels) {
    const container = $(containerId);
    if (!container) return;
    if (!Array.isArray(channels) || !channels.length) {
      empty(container, "Keine Livewerte verfügbar");
      return;
    }
    container.replaceChildren();
    channels.forEach((channel) => {
      const row = document.createElement("div");
      row.className = "channel-mini";
      const name = document.createElement("span");
      const reading = document.createElement("strong");
      const electric = document.createElement("small");
      name.textContent = channel.name;
      reading.textContent = power(channel.power_w);
      electric.textContent = `${number(channel.voltage_v, "V")} · ${number(channel.current_a, "A", 2)}`;
      row.append(name, reading, electric);
      container.append(row);
    });
  }

  function renderEz1Channels(channels) {
    const container = $("ez1-channels");
    if (!container) return;
    if (!Array.isArray(channels) || !channels.length) {
      empty(container, "Keine Livewerte verfügbar");
      return;
    }
    container.replaceChildren();
    channels.forEach((channel, index) => {
      const row = document.createElement("div");
      row.className = "channel-mini";
      const name = document.createElement("span");
      const reading = document.createElement("strong");
      const detail = document.createElement("small");
      name.textContent = `PV ${index + 1}`;
      reading.textContent = power(channel.power_w);
      detail.textContent = "APsystems · Ost";
      row.append(name, reading, detail);
      container.append(row);
    });
  }

  function renderPhases(phases) {
    const container = $("shelly-phases");
    if (!container) return;
    if (!Array.isArray(phases) || !phases.length) {
      empty(container, "Keine Phasenwerte verfügbar");
      return;
    }
    container.replaceChildren();
    phases.forEach((phase) => {
      const row = document.createElement("div");
      row.className = "phase-row";
      const badge = document.createElement("span");
      badge.className = `phase-badge phase-${String(phase.name).toLowerCase()}`;
      badge.textContent = phase.name;
      const reading = document.createElement("strong");
      const detail = document.createElement("small");
      reading.textContent = power(phase.power_w, true);
      detail.textContent = `${number(phase.voltage_v, "V")} · ${number(phase.current_a, "A", 2)} · PF ${phase.power_factor === null || phase.power_factor === undefined ? "—" : Number(phase.power_factor).toFixed(2)}`;
      row.append(badge, reading, detail);
      container.append(row);
    });
  }

  function renderComparison(snapshot) {
    const container = $("grid-comparison");
    if (!container) return;
    const readings = [
      ["Shelly Pro 3EM · Referenz", snapshot.sources.shelly.grid_w],
      ["Solakon ONE · eigener Meter", snapshot.sources.solakon.grid_w],
      ["IR-Zähler", snapshot.sources.tasmota.grid_w],
    ];
    container.replaceChildren();
    readings.forEach(([label, value]) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      const reading = document.createElement("strong");
      name.textContent = label;
      reading.textContent = power(value, true);
      row.append(name, reading);
      container.append(row);
    });
  }

  function render(snapshot) {
    latestSnapshot = snapshot;
    const grid = Number(snapshot.grid.power_w || 0);
    const battery = Number(snapshot.battery.power_w || 0);
    const soc = Number(snapshot.battery.soc_percent || 0);
    const autarky = Number(snapshot.autarky_percent || 0);
    const ez1Online = Boolean(snapshot.sources.ez1.online);

    text("pv-total", power(snapshot.pv.total_w));
    text("pv-solakon", power(snapshot.pv.solakon_one_w));
    text("pv-ez1", ez1Online ? power(snapshot.pv.ez1_east_w) : "Offline");
    text("house-power", power(snapshot.house.consumption_w));
    text("autarky", `${Math.round(autarky)} %`);
    setWidth("autarky-bar", autarky);
    text("grid-title", grid >= 0 ? "Netzbezug" : "Einspeisung");
    const displayedGrid = grid < -1 ? `−${power(Math.abs(grid))}` : power(grid);
    text("grid-power", displayedGrid);
    text("grid-direction", grid >= 0 ? "Netz → Haus" : "Haus → Netz");
    $("grid-card")?.classList.toggle("export-card", grid < 0);
    text("battery-soc", `${Math.round(soc)} %`);
    text("battery-state", battery > 20 ? "Entlädt" : battery < -20 ? "Lädt" : "Bereit");
    text("battery-power", power(battery));
    const oneAc = Number(snapshot.sources.solakon.ac_w || 0);
    text("one-ac-label", oneAc < -1 ? "ONE AC-Aufnahme · App-Wert" : oneAc > 1 ? "ONE AC-Abgabe · App-Wert" : "ONE AC-Leistung · bereit");
    text("one-ac-output", power(Math.abs(oneAc)));
    text("battery-temp", number(snapshot.battery.temperature_c, "°C"));
    text("temperature-battery-now", number(snapshot.battery.temperature_c, "°C"));
    text("temperature-one-now", number(snapshot.sources.solakon.internal_temperature_c, "°C"));
    evaluateTemperatureStatus();
    const remainingWh = Number(snapshot.battery.energy_remaining_wh);
    const capacityWh = soc > 0 && Number.isFinite(remainingWh) ? remainingWh / (soc / 100) : null;
    text("battery-remaining", Number.isFinite(remainingWh) ? energy(remainingWh / 1000) : "—");
    text("battery-capacity", Number.isFinite(capacityWh) ? energy(capacityWh / 1000) : "—");
    setWidth("battery-bar", soc);

    text("meter-import-total", energy(snapshot.sources.tasmota.import_energy_kwh));
    text("meter-export-total", energy(snapshot.sources.tasmota.export_energy_kwh));
    text("meter-pv-today", energy(snapshot.pv.energy_today_kwh));
    text("meter-pv-lifetime", energy(snapshot.pv.energy_total_kwh));

    const onePv = Number(snapshot.pv.solakon_one_w || 0);
    const ez1Pv = Number(snapshot.pv.ez1_east_w || 0);
    const dcChargeEstimate = battery < -20 ? Math.min(onePv, Math.abs(battery)) : 0;
    text("flow-one-pv", power(onePv));
    text("flow-ez1", ez1Online ? power(ez1Pv) : "Offline");
    text("flow-house", power(snapshot.house.consumption_w));
    text("flow-autarky", `${Math.round(autarky)} % autark`);
    text("flow-battery-title", `ONE / Batterie · ${Math.round(soc)} %`);
    text("flow-battery", power(Math.abs(battery)));
    text("flow-battery-detail", battery > 20 ? "liefert Energie" : battery < -20 ? "nimmt Energie auf" : "kein Fluss");
    text("flow-grid", displayedGrid);
    text("flow-grid-detail", grid >= 0 ? "Bezug" : "Einspeisung");
    const gridAverage = Number(snapshot.grid.average_60s?.power_w);
    if (Number.isFinite(gridAverage)) {
      const averageState = Math.abs(gridAverage) <= 15
        ? "ausgeglichen"
        : gridAverage > 0 ? "Bezug" : "Einspeisung";
      text("flow-grid-average", `Ø 1 min: ${power(gridAverage, true)} · ${averageState}`);
    } else {
      text("flow-grid-average", "Ø 1 min: —");
    }
    setFlow("dc-charge-flow", onePv, false);
    text("dc-charge-flow-value", dcChargeEstimate > 1
      ? `${power(onePv)} DC\n≈ ${power(dcChargeEstimate)} lädt`
      : `${power(onePv)} DC`);
    setFlow("one-ac-flow", oneAc, oneAc < 0);
    text("one-ac-flow-value", oneAc < -1
      ? `${power(Math.abs(oneAc))} AC\n→ Batterie`
      : oneAc > 1 ? `${power(oneAc)} AC\n→ Haus` : power(0));
    setFlow("ez1-ac-flow", ez1Online ? ez1Pv : 0, false);
    setFlow("house-grid-flow", grid, grid > 0);

    setStatus("status-solakon", snapshot.sources.solakon);
    setStatus("status-shelly", snapshot.sources.shelly);
    setStatus("status-tasmota", snapshot.sources.tasmota);
    setStatus("status-ez1", snapshot.sources.ez1, true);
    renderDeviceStatuses(snapshot);
    renderChannels("solakon-channels", snapshot.sources.solakon.channels || snapshot.sources.solakon.mppts || []);
    renderEz1Channels(snapshot.sources.ez1.mppts || []);
    renderPhases(snapshot.sources.shelly.phases || []);
    renderComparison(snapshot);
    renderEconomics();

    const measured = new Date(snapshot.timestamp);
    text("measurement-time", `Messung ${measured.toLocaleString("de-DE")}`);
    text("updated-at", new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    $("live-status")?.classList.remove("warning");
    const label = $("live-status")?.querySelector("b");
    if (label) label.textContent = "Live · 5 Sekunden";
    $("loading")?.setAttribute("hidden", "");
    $("dashboard")?.removeAttribute("hidden");
  }

  function showError(reason) {
    if (!$("dashboard")?.hasAttribute("hidden")) {
      $("live-status")?.classList.add("warning");
      const label = $("live-status")?.querySelector("b");
      if (label) label.textContent = "Verbindung unterbrochen";
      return;
    }
    text("loading-title", "Collector nicht erreichbar");
    text("loading-message", reason || "Live-Daten nicht erreichbar");
    $("retry")?.removeAttribute("hidden");
  }

  async function loadLive() {
    try {
      const response = await fetch("api/live", { cache: "no-store" });
      if (!response.ok) throw new Error(`Live-API antwortet mit ${response.status}`);
      render(await response.json());
    } catch (error) {
      showError(error instanceof Error ? error.message : "Live-Daten nicht erreichbar");
    }
  }

  async function loadHistory() {
    try {
      const response = await fetch(`api/history?range=${encodeURIComponent(activeRange)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Verlauf nicht erreichbar");
      const payload = await response.json();
      historyPoints = Array.isArray(payload.points) ? payload.points : [];
    } catch {
      historyPoints = [];
    }
    drawInteractiveHistory();
  }

  function temperatureMaximum(key) {
    return temperaturePoints.reduce((maximum, point) => {
      const value = Number(point[key]);
      return Number.isFinite(value) && (!maximum || value > maximum.value) ? { value, timestamp: point.timestamp } : maximum;
    }, null);
  }

  function evaluateTemperatureStatus() {
    const current = Number(latestSnapshot?.battery?.temperature_c);
    const recent = temperaturePoints.filter((point) => Date.now() - new Date(point.timestamp).getTime() <= 10 * 60 * 1000);
    const rapidRise = recent.length >= 2
      && Number(recent[recent.length - 1].battery_temperature_c) - Number(recent[0].battery_temperature_c) >= 5;
    if (Number.isFinite(current)) {
      if (current >= 50 || rapidRise) temperatureAlertState = "warning";
      else if (current >= 45 && temperatureAlertState !== "warning") temperatureAlertState = "elevated";
      else if (current < 42) temperatureAlertState = "normal";
    }
    const panel = $("temperature-panel");
    panel?.classList.toggle("warning", temperatureAlertState === "warning");
    panel?.classList.toggle("elevated", temperatureAlertState === "elevated");
    text("temperature-status", temperatureAlertState === "warning"
      ? rapidRise && current < 50 ? "Warnung · schneller Anstieg" : "Warnung · Temperatur hoch"
      : temperatureAlertState === "elevated" ? "Erhöht · weiter beobachten" : "Normaler Beobachtungsbereich");
  }

  function drawTemperatureHistory() {
    const canvas = $("temperature-chart");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const dark = root.dataset.theme === "dark";
    const padding = { top: 14, right: 14, bottom: 30, left: 48 };
    const plotWidth = rect.width - padding.left - padding.right;
    const plotHeight = rect.height - padding.top - padding.bottom;
    const values = temperaturePoints.flatMap((point) => [point.battery_temperature_c, point.internal_temperature_c])
      .map(Number).filter(Number.isFinite);
    const minY = Math.max(0, Math.floor((Math.min(20, ...values) - 3) / 5) * 5);
    const maxY = Math.max(55, Math.ceil((Math.max(50, ...values) + 3) / 5) * 5);
    const y = (value) => padding.top + ((maxY - value) / (maxY - minY)) * plotHeight;
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillStyle = dark ? "rgba(231,235,226,.55)" : "rgba(43,64,50,.62)";
    context.strokeStyle = dark ? "rgba(255,255,255,.08)" : "rgba(43,64,50,.12)";
    for (let value = minY; value <= maxY; value += 5) {
      const yPos = y(value);
      context.beginPath(); context.moveTo(padding.left, yPos); context.lineTo(rect.width - padding.right, yPos); context.stroke();
      context.fillText(`${value} °C`, 3, yPos + 3);
    }
    [[45, "#d49b08"], [50, "#bd443b"]].forEach(([value, color]) => {
      context.save(); context.setLineDash([5, 5]); context.strokeStyle = color; context.beginPath();
      context.moveTo(padding.left, y(value)); context.lineTo(rect.width - padding.right, y(value)); context.stroke(); context.restore();
    });
    if (temperaturePoints.length < 2) return;
    [["battery_temperature_c", dark ? "#76d6ad" : "#16845f", 2.5], ["internal_temperature_c", dark ? "#ef9a61" : "#bb642c", 1.8]].forEach(([key, color, width]) => {
      context.strokeStyle = color; context.lineWidth = width; context.beginPath(); let drawing = false;
      temperaturePoints.forEach((point, index) => {
        const value = Number(point[key]);
        if (!Number.isFinite(value)) { drawing = false; return; }
        const x = padding.left + index / (temperaturePoints.length - 1) * plotWidth;
        if (!drawing) { context.moveTo(x, y(value)); drawing = true; } else context.lineTo(x, y(value));
      });
      context.stroke();
    });
    context.fillStyle = dark ? "rgba(231,235,226,.55)" : "rgba(43,64,50,.62)";
    context.textAlign = "left"; context.fillText(new Date(temperaturePoints[0].timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }), padding.left, rect.height - 7);
    context.textAlign = "right"; context.fillText(new Date(temperaturePoints[temperaturePoints.length - 1].timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }), rect.width - padding.right, rect.height - 7);
  }

  function renderTemperatureHistory() {
    const batteryMax = temperatureMaximum("battery_temperature_c");
    const oneMax = temperatureMaximum("internal_temperature_c");
    const timeLabel = (maximum) => maximum ? new Date(maximum.timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    text("temperature-battery-max", batteryMax ? number(batteryMax.value, "°C") : "—");
    text("temperature-battery-max-time", timeLabel(batteryMax));
    text("temperature-one-max", oneMax ? number(oneMax.value, "°C") : "—");
    text("temperature-one-max-time", timeLabel(oneMax));
    evaluateTemperatureStatus();
    drawTemperatureHistory();
    drawSocHistory();
  }

  async function loadTemperatureHistory() {
    try {
      const response = await fetch(`api/history?range=${encodeURIComponent(temperatureRange)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Temperaturverlauf nicht erreichbar");
      const payload = await response.json();
      temperaturePoints = Array.isArray(payload.points) ? payload.points : [];
    } catch { temperaturePoints = []; }
    renderTemperatureHistory();
  }

  async function loadStorage() {
    try {
      const response = await fetch("api/storage", { cache: "no-store" });
      if (!response.ok) throw new Error("Speicherstatus nicht erreichbar");
      const stats = await response.json();
      text("storage-count", Number(stats.measurements || 0).toLocaleString("de-DE"));
      text("storage-size", `${(Number(stats.database_bytes || 0) / 1024 / 1024).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`);
      text("storage-free", `${(Number(stats.disk_free_bytes || 0) / 1024 / 1024 / 1024).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`);
      const first = stats.first_timestamp ? new Date(stats.first_timestamp) : null;
      const elapsedDays = first
        ? Math.max(1, Math.ceil((Date.now() - first.getTime()) / 86400000))
        : 0;
      const dayLabel = elapsedDays === 1
        ? "1 Tag"
        : `${elapsedDays.toLocaleString("de-DE")} Tage`;
      text("storage-since", first ? `${first.toLocaleDateString("de-DE")} (${dayLabel})` : "—");
    } catch {
      text("storage-count", "—");
      text("storage-size", "—");
      text("storage-since", "—");
      text("storage-free", "—");
    }
  }

  async function loadDeviceEvents(append = false) {
    const container = $("device-event-list");
    if (!container) return;
    const moreButton = $("device-events-more");
    if (moreButton) moreButton.disabled = true;
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (append && deviceEventsCursor) query.set("before_id", String(deviceEventsCursor));
      const response = await fetch(`api/events/devices?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Ereignisse nicht erreichbar");
      const payload = await response.json();
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (!append) container.replaceChildren();
      if (!events.length) { empty(container, "Noch keine Statuswechsel aufgezeichnet"); return; }
      events.forEach((event) => {
        const alarms = Array.isArray(event.alarms) ? event.alarms : [];
        const row = document.createElement("div");
        row.className = "device-event-row";
        const occurred = new Date(event.timestamp);
        const eventText = alarms.length ? alarms.map((alarm) => alarm.label).join(" · ") : `${event.operating_state || "Betrieb"}${event.off_grid ? " · Offgrid" : " · keine Warnung"}`;
        const context = [
          Number.isFinite(Number(event.internal_temperature_c)) ? `ONE ${number(event.internal_temperature_c, "°C")}` : null,
          Number.isFinite(Number(event.battery_temperature_c)) ? `Batt. ${number(event.battery_temperature_c, "°C")}` : null,
          Number.isFinite(Number(event.device_temperature_c)) ? `${number(event.device_temperature_c, "°C")}` : null,
          Number.isFinite(Number(event.power_w)) ? power(event.power_w) : null,
          Number.isFinite(Number(event.uptime_seconds)) ? `Laufzeit ${uptimeLabel(event.uptime_seconds)}` : null,
        ].filter(Boolean).join(" · ") || "—";
        [occurred.toLocaleString("de-DE"), event.device || "—", eventText, context].forEach((value) => {
          const span = document.createElement("span"); span.textContent = value; row.append(span);
        });
        container.append(row);
      });
      deviceEventsCursor = payload.next_before_id || null;
      if (moreButton) moreButton.hidden = !payload.has_more;
    } catch {
      if (!append) empty(container, "Ereignishistorie derzeit nicht erreichbar");
    } finally {
      if (moreButton) moreButton.disabled = false;
    }
  }

  const shiftIsoDate = (isoDate, offset) => {
    const value = new Date(`${isoDate}T12:00:00`);
    value.setDate(value.getDate() + offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  };

  const compactDateRange = (start, end) => {
    if (!start || !end) return "—";
    const first = new Date(`${start}T12:00:00`);
    const last = new Date(`${end}T12:00:00`);
    if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) {
      return `${first.getDate()}.–${last.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
    }
    return `${first.toLocaleDateString("de-DE")}–${last.toLocaleDateString("de-DE")}`;
  };

  function setDailyAnchor(anchor, push = true) {
    dailyAnchor = anchor;
    const url = new URL(window.location.href);
    if (anchor) url.searchParams.set("daily", anchor);
    else url.searchParams.delete("daily");
    window.history[push ? "pushState" : "replaceState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function renderStatistics(payload, currentPayload = payload) {
    dailyPage = payload;
    latestStatistics = currentPayload;
    const days = Array.isArray(payload.days) ? payload.days : [];
    const currentDays = Array.isArray(currentPayload.days) ? currentPayload.days : [];
    const today = currentDays[currentDays.length - 1];
    text("today-consumption", today ? energy(today.consumption_kwh) : "—");
    text("today-pv", today ? energy(today.pv_kwh) : "—");
    text("today-import", today ? energy(today.import_kwh) : "—");
    text("today-export", today ? energy(today.export_kwh) : "—");
    text("today-autarky", today ? number(today.autarky_percent, "%", 0) : "—");
    text("today-self-use", today ? number(today.self_consumption_percent, "%", 0) : "—");
    text("today-base-load", today ? power(today.base_load_w) : "—");
    const container = $("daily-statistics");
    if (!container) return;
    container.replaceChildren();
    const recordedOnPage = days.filter((day) => Number(day.coverage_hours || 0) > 0).length;
    text("daily-range", compactDateRange(payload.page_start, payload.page_end));
    text("daily-count", `${recordedOnPage} von ${Number(payload.total_recorded_days || 0).toLocaleString("de-DE")} aufgezeichneten Tagen`);
    const older = $("daily-older");
    const newer = $("daily-newer");
    const todayButton = $("daily-today");
    if (older) older.disabled = !payload.has_older;
    if (newer) newer.disabled = !payload.has_newer;
    if (todayButton) todayButton.hidden = !payload.has_newer;
    days.slice().reverse().forEach((day) => {
      if (Number(day.coverage_hours || 0) <= 0) return;
      const row = document.createElement("div");
      row.className = "daily-row";
      const incomplete = day.date !== payload.today && Number(day.coverage_hours || 0) < 22.8;
      row.classList.toggle("incomplete", incomplete);
      const date = new Date(`${day.date}T12:00:00`);
      const values = [
        date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }),
        energy(day.consumption_kwh), energy(day.pv_kwh), energy(day.import_kwh),
        energy(day.export_kwh), number(day.autarky_percent, "%", 0), power(day.base_load_w),
      ];
      values.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? "strong" : "span");
        cell.textContent = value;
        row.append(cell);
      });
      row.title = `${Number(day.coverage_hours).toLocaleString("de-DE")} h Messabdeckung${incomplete ? " · unvollständiger Tag" : ""}`;
      container.append(row);
    });
    renderEconomics();
  }

  async function loadStatistics() {
    try {
      const query = new URLSearchParams({ days: "7" });
      if (dailyAnchor) query.set("anchor", dailyAnchor);
      const response = await fetch(`api/statistics?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Statistik nicht erreichbar");
      const payload = await response.json();
      let currentPayload = payload;
      if (payload.has_newer) {
        const currentResponse = await fetch("api/statistics?days=1", { cache: "no-store" });
        if (currentResponse.ok) currentPayload = await currentResponse.json();
      }
      renderStatistics(payload, currentPayload);
    } catch {
      renderStatistics({ days: [] });
    }
  }

  async function loadEconomics() {
    try {
      const response = await fetch("api/economics", { cache: "no-store" });
      if (!response.ok) throw new Error("Wirtschaftsdaten nicht erreichbar");
      recordingEconomics = await response.json();
    } catch {
      recordingEconomics = null;
    }
    renderEconomics();
  }

  function renderBatteryStatistics(payload) {
    batteryPage = payload;
    const summary = payload.summary || {};
    const days = Array.isArray(payload.days) ? payload.days : [];
    const observed = Number(summary.observed_days || 0);
    text("battery-observed-days", observed ? `${observed} Tage` : "—");
    text("battery-full-days", observed ? `${Number(summary.full_days || 0)} / ${observed}` : "—");
    text("battery-empty-days", observed ? `${Number(summary.empty_days || 0)} / ${observed}` : "—");
    text("battery-full-export", energy(summary.export_while_full_kwh || 0));
    text("battery-empty-import", energy(summary.import_while_empty_kwh || 0));
    text("battery-shift-potential", energy(summary.shift_indicator_kwh || 0));
    const container = $("battery-statistics");
    if (!container) return;
    container.replaceChildren();
    text("battery-range", compactDateRange(payload.page_start, payload.page_end));
    text("battery-count", `${observed} erfasste Tage im Zeitraum`);
    const older = $("battery-older");
    const newer = $("battery-newer");
    const current = $("battery-current");
    if (older) older.disabled = !payload.has_older;
    if (newer) newer.disabled = !payload.has_newer;
    if (current) current.hidden = !payload.has_newer;
    const clock = (value) => value
      ? new Date(value).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "—";
    days.filter((day) => Number(day.coverage_hours || 0) > 0).reverse().forEach((day) => {
      const row = document.createElement("div");
      row.className = "battery-row";
      const date = new Date(`${day.date}T12:00:00`);
      const values = [
        date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }),
        day.full_at ? clock(day.full_at) : Number(day.full_hours || 0) > 0 ? "bereits voll" : "—",
        day.empty_at ? clock(day.empty_at) : Number(day.empty_hours || 0) > 0 ? "bereits 10 %" : "—",
        number(day.full_hours, "h", 1),
        number(day.empty_hours, "h", 1), energy(day.charge_kwh), energy(day.discharge_kwh),
      ];
      values.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? "strong" : "span");
        cell.textContent = value;
        row.append(cell);
      });
      row.title = `${Number(day.coverage_hours).toLocaleString("de-DE")} h Messabdeckung`;
      container.append(row);
    });
  }

  async function loadBatteryStatistics() {
    try {
      const query = new URLSearchParams({ days: "7" });
      if (batteryAnchor) query.set("anchor", batteryAnchor);
      const response = await fetch(`api/battery-statistics?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Batteriestatistik nicht erreichbar");
      renderBatteryStatistics(await response.json());
    } catch {
      renderBatteryStatistics({ days: [], summary: {} });
    }
  }

  function drawSolarHeatmap(canvasId, key, rgb, scaleMax) {
    const canvas = $(canvasId);
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const dark = root.dataset.theme === "dark";
    const muted = dark ? "#969f98" : "#69766e";
    const line = dark ? "rgba(238,242,232,.10)" : "rgba(43,64,50,.12)";
    const padding = { left: 49, right: 6, top: 5, bottom: 24 };
    const startMinute = 4 * 60;
    const endMinute = 22 * 60;
    const width = rect.width - padding.left - padding.right;
    const height = rect.height - padding.top - padding.bottom;
    const rowHeight = height / Math.max(1, solarProfileDays.length);
    context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillStyle = muted;
    context.textBaseline = "middle";
    [4, 8, 12, 16, 20].forEach((hour) => {
      const x = padding.left + ((hour * 60 - startMinute) / (endMinute - startMinute)) * width;
      context.strokeStyle = line;
      context.beginPath(); context.moveTo(x, padding.top); context.lineTo(x, padding.top + height); context.stroke();
      context.textAlign = "center";
      context.fillText(`${String(hour).padStart(2, "0")}:00`, x, rect.height - 8);
    });
    solarProfileDays.forEach((day, rowIndex) => {
      const y = padding.top + rowIndex * rowHeight;
      const date = new Date(`${day.date}T12:00:00`);
      context.fillStyle = muted;
      context.textAlign = "left";
      context.fillText(date.toLocaleDateString("de-DE", solarProfilePeriod === "month"
        ? { day: "2-digit", month: "2-digit" }
        : { weekday: "short", day: "2-digit" }), 2, y + rowHeight / 2);
      context.strokeStyle = line;
      context.strokeRect(padding.left, y + 2, width, Math.max(1, rowHeight - 4));
      (day.points || []).forEach((point) => {
        const value = Number(point[key]);
        if (!Number.isFinite(value) || value < 1 || point.minute < startMinute || point.minute > endMinute) return;
        const x = padding.left + ((point.minute - startMinute) / (endMinute - startMinute)) * width;
        const cellWidth = Math.max(2, (10 / (endMinute - startMinute)) * width + 1);
        const alpha = Math.min(.98, .08 + value / scaleMax * .9);
        context.fillStyle = `rgba(${rgb},${alpha})`;
        context.fillRect(x, y + 3, cellWidth, Math.max(1, rowHeight - 6));
      });
    });
  }

  function drawSolarProfiles() {
    const values = solarProfileDays.flatMap((day) => (day.points || []).flatMap((point) => [Number(point.solakon_w || 0), Number(point.ez1_w || 0)]));
    const scaleMax = Math.max(800, ...values);
    drawSolarHeatmap("profile-east", "ez1_w", "37,109,177", scaleMax);
    drawSolarHeatmap("profile-solakon", "solakon_w", "212,155,8", scaleMax);
  }

  function renderSolarProfiles(payload) {
    solarProfileDays = Array.isArray(payload.days) ? payload.days : [];
    const panel = document.querySelector(".solar-profile-panel");
    panel?.classList.toggle("monthly", solarProfilePeriod === "month");
    panel?.classList.remove("yearly");
    text("solar-profile-eyebrow", solarProfilePeriod === "month" ? "Monatsverlauf" : "Wochenverlauf");
    text("solar-method-note", "10‑Minuten-Mittelwerte · Farbe = Leistung · Aktiv ab 10 W");
    text("solar-analysis-note", "„Wechsel“ markiert den ersten stabilen 10‑Minuten-Abschnitt, in dem Süd/West die zuvor stärkere Ostseite um mindestens 20 W überholt. Wolken können den Zeitpunkt verschieben; der saisonale Trend wird mit längerer Historie deutlich.");
    const start = payload.start ? new Date(`${payload.start}T12:00:00`) : null;
    const end = payload.end ? new Date(`${payload.end}T12:00:00`) : null;
    text("solar-period-label", solarProfilePeriod === "month" && end
      ? end.toLocaleDateString("de-DE", { month: "long", year: "numeric" })
      : start && end ? `${start.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}–${end.toLocaleDateString("de-DE")}` : "—");
    const currentButton = $("solar-current");
    const nextButton = $("solar-next");
    const isCurrent = payload.end === payload.today;
    if (currentButton) currentButton.hidden = isCurrent;
    if (nextButton) nextButton.disabled = isCurrent;
    const summary = $("solar-month-summary");
    if (summary) summary.hidden = solarProfilePeriod !== "month";
    if (solarProfilePeriod === "month") {
      const observed = solarProfileDays.filter((day) => day.ez1?.start || day.solakon?.start);
      const starts = observed.flatMap((day) => [day.ez1?.start, day.solakon?.start]).filter(Boolean).sort();
      const ends = observed.flatMap((day) => [day.ez1?.end, day.solakon?.end]).filter(Boolean).sort();
      const eastPeaks = observed.map((day) => Number(day.ez1?.peak_w)).filter(Number.isFinite);
      const solakonPeaks = observed.map((day) => Number(day.solakon?.peak_w)).filter(Number.isFinite);
      const crossovers = observed.map((day) => day.crossover).filter(Boolean).sort();
      text("solar-active-days", `${observed.length} Tage`);
      text("solar-earliest-start", starts[0] || "—");
      text("solar-latest-end", ends[ends.length - 1] || "—");
      text("solar-east-max", eastPeaks.length ? power(Math.max(...eastPeaks)) : "—");
      text("solar-solakon-max", solakonPeaks.length ? power(Math.max(...solakonPeaks)) : "—");
      text("solar-crossover-median", crossovers.length ? crossovers[Math.floor(crossovers.length / 2)] : "—");
    }
    const container = $("solar-profile-days");
    if (container) {
      container.replaceChildren();
      if (solarProfilePeriod === "week") solarProfileDays.slice().reverse().forEach((day) => {
        if (!Array.isArray(day.points) || day.points.length === 0) return;
        const row = document.createElement("div");
        row.className = "profile-row";
        const date = new Date(`${day.date}T12:00:00`);
        const peak = (source) => source?.peak ? `${source.peak} · ${power(source.peak_w)}` : "—";
        const values = [
          date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }),
          day.ez1?.start || "—", peak(day.ez1), day.ez1?.end || "—", day.crossover || "—",
          day.solakon?.start || "—", peak(day.solakon), day.solakon?.end || "—",
        ];
        values.forEach((value, index) => {
          const cell = document.createElement(index === 0 ? "strong" : "span");
          cell.textContent = value;
          row.append(cell);
        });
        container.append(row);
      });
    }
    drawSolarProfiles();
  }

  function renderSolarYear(payload) {
    solarProfileDays = [];
    const panel = document.querySelector(".solar-profile-panel");
    panel?.classList.remove("monthly");
    panel?.classList.add("yearly");
    text("solar-profile-eyebrow", "Jahresverlauf");
    text("solar-method-note", "Tagesertrag aus verdichteten Messwerten · Messlücken werden nicht hochgerechnet");
    text("solar-analysis-note", "Die Kurven zeigen den gemessenen Tagesertrag beider PV-Flächen. Noch nicht aufgezeichnete oder vollständig fehlende Tage bleiben als Lücke sichtbar; der laufende Tag ist naturgemäß unvollständig.");
    text("solar-period-label", String(payload.year || "—"));
    const currentYear = Number(payload.year) === new Date().getFullYear();
    const currentButton = $("solar-current");
    const nextButton = $("solar-next");
    if (currentButton) currentButton.hidden = currentYear;
    if (nextButton) nextButton.disabled = currentYear;
    const summary = $("solar-month-summary");
    if (summary) summary.hidden = true;
    const yearView = $("solar-year-view");
    if (yearView) yearView.hidden = false;
    const months = $("solar-year-months");
    if (months) {
      months.replaceChildren();
      (payload.months || []).forEach((month) => {
        const card = document.createElement("div");
        card.className = `solar-year-month${month.active_days ? "" : " empty"}`;
        const date = new Date(Number(payload.year), Number(month.month) - 1, 1);
        const best = month.best_day ? new Date(`${month.best_day}T12:00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "—";
        card.innerHTML = `<span>${date.toLocaleDateString("de-DE", { month: "long" })}</span><strong>${energy(Number(month.solakon_kwh || 0) + Number(month.ez1_kwh || 0), 1)}</strong><b>Ost ${energy(month.ez1_kwh, 1)} · S/W ${energy(month.solakon_kwh, 1)}</b><small>${month.active_days || 0} Tage · Bester ${best} (${energy(month.best_day_kwh, 1)}) · Ø ${number(month.average_active_hours, "h", 1)}</small>`;
        months.append(card);
      });
    }
    const canvas = $("solar-year-chart");
    if (canvas instanceof HTMLCanvasElement && typeof Chart !== "undefined") {
      const colors = chartColors();
      const points = payload.points || [];
      solarYearChart?.destroy();
      const options = commonChartOptions();
      options.scales.y.beginAtZero = true;
      options.scales.y.ticks.callback = (value) => `${value} kWh`;
      options.scales.x.ticks.maxTicksLimit = 12;
      options.plugins.tooltip.callbacks.title = (items) => items[0]?.label || "";
      solarYearChart = new Chart(canvas, { type: "line", data: {
        labels: points.map((point) => new Date(`${point.date}T12:00:00`).toLocaleDateString("de-DE")),
        datasets: [
          { label: "Ost", unit: "kWh", data: points.map((point) => point.ez1_kwh || null), borderColor: "#256db1", backgroundColor: "#256db1", pointRadius: 0, borderWidth: 1.5, tension: .12, spanGaps: false },
          { label: "Süd / West", unit: "kWh", data: points.map((point) => point.solakon_kwh || null), borderColor: colors.pv, backgroundColor: colors.pv, pointRadius: 0, borderWidth: 1.7, tension: .12, spanGaps: false },
        ],
      }, options, plugins: [chartAreaBackground] });
    }
  }

  async function loadSolarProfiles() {
    try {
      if (solarProfilePeriod === "year") {
        const response = await fetch(`api/solar-year?year=${solarProfileAnchor.getFullYear()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Jahresprofil nicht erreichbar");
        renderSolarYear(await response.json());
        return;
      }
      const yearView = $("solar-year-view");
      if (yearView) yearView.hidden = true;
      const now = new Date();
      let anchor = new Date(solarProfileAnchor);
      let days = 7;
      if (solarProfilePeriod === "month") {
        const sameMonth = anchor.getFullYear() === now.getFullYear() && anchor.getMonth() === now.getMonth();
        anchor = sameMonth ? now : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 12);
        days = anchor.getDate();
      }
      if (anchor > now) anchor = now;
      const anchorValue = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`;
      const response = await fetch(`api/solar-profiles?days=${days}&anchor=${anchorValue}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Solarprofil nicht erreichbar");
      renderSolarProfiles(await response.json());
    } catch {
      renderSolarProfiles({ days: [] });
    }
  }

  function drawHistory() {
    const canvas = $("history-chart");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const padding = { top: 18, right: 14, bottom: 30, left: 52 };
    const dark = root.dataset.theme === "dark";
    const series = dark ? [
      ["pv_total_w", "#f4c84a", 2.8], ["house_w", "#78b4ff", 1.8],
      ["grid_w", "#ed786c", 1.8], ["battery_w", "#7be0b7", 1.8],
    ] : [
      ["pv_total_w", "#d49b08", 2.8], ["house_w", "#347fba", 1.8],
      ["grid_w", "#bd443b", 1.8], ["battery_w", "#16845f", 1.8],
    ];
    const displayValue = (key, value) => key === "battery_w" && Math.abs(value) < 20 ? 0 : value;
    const values = historyPoints.flatMap((point) => series
      .map(([key]) => typeof point[key] === "number" ? displayValue(key, point[key]) : null)
      .filter((value) => value !== null));
    const rawMin = Math.min(0, ...values);
    const rawMax = Math.max(100, ...values);
    const span = Math.max(100, rawMax - rawMin);
    const minY = rawMin < 0 ? rawMin - span * 0.08 : 0;
    const maxY = rawMax + span * 0.08;
    const plotWidth = rect.width - padding.left - padding.right;
    const plotHeight = rect.height - padding.top - padding.bottom;
    const y = (value) => padding.top + ((maxY - value) / (maxY - minY)) * plotHeight;

    context.strokeStyle = dark ? "rgba(255,255,255,.08)" : "rgba(43,64,50,.12)";
    context.fillStyle = dark ? "rgba(231,235,226,.52)" : "rgba(43,64,50,.62)";
    context.lineWidth = 1;
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let index = 0; index <= 4; index += 1) {
      const value = minY + ((maxY - minY) * index) / 4;
      const yPos = y(value);
      context.beginPath(); context.moveTo(padding.left, yPos); context.lineTo(rect.width - padding.right, yPos); context.stroke();
      context.fillText(`${Math.round(value)} W`, 4, yPos + 4);
    }
    const zeroY = y(0);
    context.save();
    context.setLineDash([6, 5]);
    context.lineWidth = 1.5;
    context.strokeStyle = dark ? "rgba(242,243,235,.38)" : "rgba(23,35,27,.34)";
    context.beginPath(); context.moveTo(padding.left, zeroY); context.lineTo(rect.width - padding.right, zeroY); context.stroke();
    context.fillStyle = dark ? "rgba(242,243,235,.7)" : "rgba(23,35,27,.7)";
    context.textAlign = "right";
    context.fillText("Nulllinie · 0 W", rect.width - padding.right, zeroY - 6);
    context.textAlign = "start";
    context.restore();
    if (historyPoints.length < 2) {
      context.fillStyle = dark ? "rgba(231,235,226,.58)" : "rgba(43,64,50,.62)";
      context.font = "14px system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("Verlauf entsteht mit den nächsten Messungen", rect.width / 2, rect.height / 2);
      context.textAlign = "start";
      return;
    }
    series.forEach(([key, color, lineWidth]) => {
      const seriesValues = historyPoints
        .map((point) => typeof point[key] === "number" ? displayValue(key, point[key]) : null)
        .filter((value) => value !== null);
      if (key === "battery_w" && seriesValues.every((value) => value === 0)) return;
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.beginPath();
      let drawing = false;
      historyPoints.forEach((point, index) => {
        const value = typeof point[key] === "number" ? displayValue(key, point[key]) : point[key];
        if (typeof value !== "number") { drawing = false; return; }
        const xPos = padding.left + (index / (historyPoints.length - 1)) * plotWidth;
        if (!drawing) { context.moveTo(xPos, y(value)); drawing = true; } else context.lineTo(xPos, y(value));
      });
      context.stroke();
    });
  }

  function chartColors() {
    const dark = root.dataset.theme === "dark";
    return {
      pv: dark ? "#f4c84a" : "#d49b08", solakon: dark ? "#ffd86a" : "#e8aa13",
      east: dark ? "#f09a42" : "#c96a20", house: dark ? "#78b4ff" : "#347fba",
      grid: dark ? "#ed786c" : "#bd443b", battery: dark ? "#7be0b7" : "#16845f",
      text: dark ? "rgba(231,235,226,.72)" : "rgba(43,64,50,.72)",
      line: dark ? "rgba(255,255,255,.09)" : "rgba(43,64,50,.12)",
    };
  }

  const commonChartOptions = () => {
    const colors = chartColors();
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true, mode: "index", intersect: false, callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toLocaleString("de-DE", { maximumFractionDigits: 2 })} ${context.dataset.unit || ""}` } },
      },
      scales: {
        x: { grid: { color: colors.line }, ticks: { color: colors.text, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 } },
        y: { grid: { color: colors.line }, ticks: { color: colors.text } },
      },
    };
  };

  const chartAreaBackground = {
    id: "chartAreaBackground",
    beforeDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      ctx.save();
      ctx.fillStyle = root.dataset.theme === "dark" ? "#151b17" : "#ffffff";
      ctx.fillRect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
      ctx.restore();
    },
  };

  function drawInteractiveHistory() {
    const canvas = $("history-chart");
    if (!(canvas instanceof HTMLCanvasElement) || typeof Chart === "undefined") return;
    const colors = chartColors();
    const definitions = [
      ["pv_total_w", "PV gesamt", colors.pv, 2.8], ["house_w", "Haus", colors.house, 1.8],
      ["grid_w", "Netz", colors.grid, 1.8], ["battery_w", "Batterie", colors.battery, 1.8],
    ];
    let hidden = {};
    try { hidden = JSON.parse(localStorage.getItem("pv-history-hidden") || "{}"); } catch (_) { hidden = {}; }
    const labels = historyPoints.map((point) => new Date(point.timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
    const datasets = definitions.map(([key, label, color, width]) => ({
      id: key, label, unit: "W", data: historyPoints.map((point) => Number.isFinite(Number(point[key])) ? Number(point[key]) : null),
      borderColor: color, backgroundColor: color, borderWidth: width, pointRadius: 0, pointHoverRadius: 4,
      tension: .12, spanGaps: false, hidden: Boolean(hidden[key]),
    }));
    historyChart?.destroy();
    const options = commonChartOptions();
    options.scales.y.ticks.callback = (value) => `${value} W`;
    options.plugins.tooltip.callbacks.title = (items) => items[0]?.label || "";
    historyChart = new Chart(canvas, { type: "line", data: { labels, datasets }, options, plugins: [chartAreaBackground] });
    document.querySelectorAll("[data-history-series]").forEach((button) => button.classList.toggle("muted", Boolean(hidden[button.dataset.historySeries])));
  }

  function drawSocHistory() {
    const canvas = $("soc-chart");
    if (!(canvas instanceof HTMLCanvasElement) || typeof Chart === "undefined") return;
    const colors = chartColors();
    const labels = temperaturePoints.map((point) => new Date(point.timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
    socChart?.destroy();
    const options = commonChartOptions();
    options.scales.y = { position: "left", min: 0, max: 100, grid: { color: colors.line }, ticks: { color: colors.text, callback: (value) => `${value} %` } };
    options.scales.power = { position: "right", grid: { drawOnChartArea: false }, ticks: { color: colors.text, callback: (value) => `${value} W` } };
    socChart = new Chart(canvas, { type: "line", data: { labels, datasets: [
      { label: "Ladezustand", unit: "%", data: temperaturePoints.map((point) => point.soc_percent), borderColor: colors.battery, backgroundColor: `${colors.battery}22`, fill: true, pointRadius: 0, tension: .15, yAxisID: "y" },
      { label: "Batterieleistung", unit: "W", data: temperaturePoints.map((point) => point.battery_w), borderColor: colors.grid, backgroundColor: colors.grid, pointRadius: 0, borderWidth: 1.5, tension: .1, yAxisID: "power" },
    ] }, options });
  }

  function energyAnchorValue() {
    const year = energyAnchor.getFullYear();
    const month = String(energyAnchor.getMonth() + 1).padStart(2, "0");
    const day = String(energyAnchor.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function shiftEnergyAnchor(direction) {
    const next = new Date(energyAnchor);
    if (energyPeriod === "day") next.setDate(next.getDate() + direction);
    else if (energyPeriod === "week") next.setDate(next.getDate() + 7 * direction);
    else if (energyPeriod === "month") next.setMonth(next.getMonth() + direction);
    else next.setFullYear(next.getFullYear() + direction);
    energyAnchor = next;
  }

  function drawEnergySeries() {
    const canvas = $("energy-chart");
    if (!(canvas instanceof HTMLCanvasElement) || typeof Chart === "undefined") return;
    const points = energyPayload.points || [];
    const colors = chartColors();
    const labels = points.map((point) => energyPeriod === "day" ? point.bucket.slice(11) : point.bucket);
    const base = { borderWidth: 1, borderRadius: 3 };
    let datasets;
    if (energyView === "grid") datasets = [
      { ...base, label: "Netzbezug", unit: "kWh", data: points.map((p) => p.import_kwh), backgroundColor: colors.grid },
      { ...base, label: "Einspeisung", unit: "kWh", data: points.map((p) => -p.export_kwh), backgroundColor: colors.house },
    ];
    else if (energyView === "battery") datasets = [
      { ...base, label: "Batterieabgabe", unit: "kWh", data: points.map((p) => p.battery_discharge_kwh), backgroundColor: colors.battery },
      { ...base, label: "Batterieladung", unit: "kWh", data: points.map((p) => -p.battery_charge_kwh), backgroundColor: colors.east },
    ];
    else datasets = [
      { ...base, label: "PV Süd/West", unit: "kWh", data: points.map((p) => p.pv_solakon_kwh), backgroundColor: colors.solakon, stack: "pv" },
      { ...base, label: "PV Ost", unit: "kWh", data: points.map((p) => p.pv_ez1_kwh), backgroundColor: colors.east, stack: "pv" },
      { ...base, label: "Hausverbrauch", unit: "kWh", data: points.map((p) => p.consumption_kwh), backgroundColor: colors.house, stack: "house" },
    ];
    energyChart?.destroy();
    const options = commonChartOptions();
    options.scales.x.stacked = energyView === "balance";
    options.scales.y.stacked = energyView === "balance";
    options.scales.y.ticks.callback = (value) => `${value} kWh`;
    options.plugins.tooltip.callbacks.label = (context) => {
      const valueKwh = Math.abs(Number(context.parsed.y || 0));
      const coveredSeconds = Number(points[context.dataIndex]?.covered_seconds || 0);
      const averageW = coveredSeconds > 0 ? valueKwh * 3_600_000 / coveredSeconds : null;
      const lines = [`${context.dataset.label}: ${valueKwh.toLocaleString("de-DE", { maximumFractionDigits: 3 })} kWh`];
      if (Number.isFinite(averageW)) lines.push(`Ø ${averageW.toLocaleString("de-DE", { maximumFractionDigits: 0 })} W`);
      return lines;
    };
    energyChart = new Chart(canvas, { type: "bar", data: { labels, datasets }, options });
  }

  async function loadEnergySeries() {
    try {
      const response = await fetch(`api/energy-series?period=${encodeURIComponent(energyPeriod)}&anchor=${energyAnchorValue()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Energieserie nicht erreichbar");
      energyPayload = await response.json();
    } catch { energyPayload = { points: [] }; }
    const start = energyPayload.start ? new Date(`${energyPayload.start}T12:00:00`) : energyAnchor;
    const end = energyPayload.end ? new Date(`${energyPayload.end}T12:00:00`) : energyAnchor;
    text("energy-period-label", energyPeriod === "day" ? start.toLocaleDateString("de-DE") : `${start.toLocaleDateString("de-DE")} – ${new Date(end.getTime() - 86400000).toLocaleDateString("de-DE")}`);
    const csv = $("energy-csv");
    if (csv) csv.href = `api/energy-series.csv?period=${encodeURIComponent(energyPeriod)}&anchor=${energyAnchorValue()}`;
    const coveredSeconds = (energyPayload.points || []).reduce((sum, point) => sum + Number(point.covered_seconds || 0), 0);
    text("energy-coverage-note", `${(coveredSeconds / 3600).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h Messabdeckung · Messlücken über 30 Sekunden werden nicht hochgerechnet.`);
    const nextButton = $("energy-next");
    const periodEnd = energyPayload.end ? new Date(`${energyPayload.end}T00:00:00`) : new Date();
    if (nextButton) nextButton.disabled = energyPeriod === "years" || periodEnd > new Date();
    const previousButton = $("energy-previous");
    if (previousButton) previousButton.disabled = energyPeriod === "years";
    drawEnergySeries();
  }

  async function loadHighscores() {
    try {
      const response = await fetch("api/highscores", { cache: "no-store" });
      if (!response.ok) throw new Error("Rekorde nicht erreichbar");
      const payload = await response.json();
      text("highscore-since", payload.since ? `Seit ${new Date(payload.since).toLocaleString("de-DE")} · Tagesenergie und Momentanleistung getrennt` : "Noch keine Messwerte");
      text("highscore-completeness", `${payload.complete_days || 0} vollständige Tage (mindestens 95 % Messabdeckung)`);
      const daily = $("daily-highscores"); daily?.replaceChildren();
      (payload.daily || []).forEach((item) => {
        const row = document.createElement("div"); row.className = "highscore-row";
        const colorClass = item.label.startsWith("PV-") ? "record-pv" : item.label.startsWith("Haus") ? "record-house" : item.label.startsWith("Batterie") ? "record-battery" : "record-grid";
        row.classList.add(colorClass);
        const maximum = `${Number(item.maximum.value_kwh).toLocaleString("de-DE", { maximumFractionDigits: 2 })} kWh<small>${new Date(`${item.maximum.date}T12:00:00`).toLocaleDateString("de-DE")}</small>`;
        if (Number(payload.complete_days || 0) < 2) {
          row.classList.add("single-value");
          row.innerHTML = `<span>${item.label}</span><strong>Bisher ${maximum}</strong>`;
        } else {
          row.innerHTML = `<span>${item.label}</span><strong>${maximum}</strong><strong>${Number(item.minimum.value_kwh).toLocaleString("de-DE", { maximumFractionDigits: 2 })} kWh<small>${new Date(`${item.minimum.date}T12:00:00`).toLocaleDateString("de-DE")}</small></strong>`;
        }
        daily?.append(row);
      });
      groupHighscoreRows(daily);
      const instant = $("instant-highscores"); instant?.replaceChildren();
      const instantOrder = { "PV-Leistung": 0, Hauslast: 1, Netzbezug: 2, Einspeisung: 3, Batterieladung: 4, Batterieabgabe: 5, Batterieentladung: 5 };
      (payload.instantaneous || []).filter(Boolean).sort((a, b) => (instantOrder[a.label] ?? 99) - (instantOrder[b.label] ?? 99)).forEach((item) => {
        const row = document.createElement("div"); row.className = "highscore-row single-value";
        const colorClass = item.label.startsWith("PV-") ? "record-pv" : item.label.startsWith("Haus") ? "record-house" : item.label.startsWith("Batterie") ? "record-battery" : "record-grid";
        row.classList.add(colorClass);
        const displayLabel = item.label === "Batterieabgabe" ? "Batterieentladung" : item.label;
        row.innerHTML = `<span>${displayLabel}</span><strong>${Number(item.value_w).toLocaleString("de-DE", { maximumFractionDigits: 0 })} W<small>${new Date(item.timestamp).toLocaleString("de-DE")}</small></strong>`;
        instant?.append(row);
      });
      groupHighscoreRows(instant);
    } catch { text("highscore-since", "Rekorde derzeit nicht erreichbar"); }
  }

  function groupHighscoreRows(container) {
    if (!container) return;
    const rows = [...container.children];
    if (rows.length < 6) return;
    const fragment = document.createDocumentFragment();
    rows.forEach((row, index) => {
      if (index === 2 || index === 4) {
        const group = document.createElement("div");
        group.className = `highscore-group ${index === 2 ? "record-grid-group" : "record-battery-group"}`;
        group.append(rows[index], rows[index + 1]);
        fragment.append(group);
      } else if (index !== 3 && index !== 5) {
        fragment.append(row);
      }
    });
    container.replaceChildren(fragment);
  }

  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      activeRange = button.getAttribute("data-range") || "24h";
      document.querySelectorAll("[data-range]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      void loadHistory();
    });
  });
  document.querySelectorAll("[data-history-series]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.historySeries;
      if (!key) return;
      let hidden = {};
      try { hidden = JSON.parse(localStorage.getItem("pv-history-hidden") || "{}"); } catch (_) { hidden = {}; }
      hidden[key] = !hidden[key];
      try { localStorage.setItem("pv-history-hidden", JSON.stringify(hidden)); } catch (_) { /* optional */ }
      drawInteractiveHistory();
    });
  });
  $("history-series-all")?.addEventListener("click", () => {
    try { localStorage.removeItem("pv-history-hidden"); } catch (_) { /* optional */ }
    drawInteractiveHistory();
  });
  document.querySelectorAll("[data-energy-period]").forEach((button) => {
    button.addEventListener("click", () => {
      energyPeriod = button.dataset.energyPeriod || "month";
      energyAnchor = new Date();
      document.querySelectorAll("[data-energy-period]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      void loadEnergySeries();
    });
  });
  const persistSolarProfileState = () => {
    const url = new URL(window.location.href);
    if (solarProfilePeriod !== "week") url.searchParams.set("solar", solarProfilePeriod);
    else url.searchParams.delete("solar");
    const now = new Date();
    const isCurrent = solarProfileAnchor.getFullYear() === now.getFullYear()
      && solarProfileAnchor.getMonth() === now.getMonth()
      && (solarProfilePeriod === "month" || solarProfilePeriod === "year" || solarProfileAnchor.toDateString() === now.toDateString());
    if (isCurrent) url.searchParams.delete("solar_date");
    else url.searchParams.set("solar_date", `${solarProfileAnchor.getFullYear()}-${String(solarProfileAnchor.getMonth() + 1).padStart(2, "0")}-${String(solarProfileAnchor.getDate()).padStart(2, "0")}`);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };
  document.querySelectorAll("[data-solar-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.solarPeriod === solarProfilePeriod);
    button.addEventListener("click", () => {
      solarProfilePeriod = button.dataset.solarPeriod || "week";
      solarProfileAnchor = new Date();
      document.querySelectorAll("[data-solar-period]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      persistSolarProfileState();
      void loadSolarProfiles();
    });
  });
  const shiftSolarProfile = (direction) => {
    const next = new Date(solarProfileAnchor);
    if (solarProfilePeriod === "year") next.setFullYear(next.getFullYear() + direction, 0, 1);
    else if (solarProfilePeriod === "month") next.setMonth(next.getMonth() + direction, 1);
    else next.setDate(next.getDate() + direction * 7);
    solarProfileAnchor = next > new Date() ? new Date() : next;
    persistSolarProfileState();
    void loadSolarProfiles();
  };
  $("solar-previous")?.addEventListener("click", () => shiftSolarProfile(-1));
  $("solar-next")?.addEventListener("click", () => shiftSolarProfile(1));
  $("solar-current")?.addEventListener("click", () => { solarProfileAnchor = new Date(); persistSolarProfileState(); void loadSolarProfiles(); });
  document.querySelectorAll("[data-energy-view]").forEach((button) => {
    button.addEventListener("click", () => {
      energyView = button.dataset.energyView || "balance";
      document.querySelectorAll("[data-energy-view]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      drawEnergySeries();
    });
  });
  $("energy-previous")?.addEventListener("click", () => { shiftEnergyAnchor(-1); void loadEnergySeries(); });
  $("energy-next")?.addEventListener("click", () => { shiftEnergyAnchor(1); void loadEnergySeries(); });
  $("daily-older")?.addEventListener("click", () => {
    if (!dailyPage.page_start || !dailyPage.has_older) return;
    setDailyAnchor(shiftIsoDate(dailyPage.page_start, -1));
    void loadStatistics();
  });
  $("daily-newer")?.addEventListener("click", () => {
    if (!dailyPage.page_end || !dailyPage.has_newer) return;
    const nextAnchor = shiftIsoDate(dailyPage.page_end, 7);
    setDailyAnchor(nextAnchor >= dailyPage.today ? null : nextAnchor);
    void loadStatistics();
  });
  const showCurrentDailyPage = () => {
    if (!dailyPage.has_newer && !dailyAnchor) return;
    setDailyAnchor(null);
    void loadStatistics();
  };
  $("daily-period")?.addEventListener("click", showCurrentDailyPage);
  $("daily-today")?.addEventListener("click", showCurrentDailyPage);
  const setBatteryAnchor = (anchor) => {
    batteryAnchor = anchor;
    const url = new URL(window.location.href);
    if (anchor) url.searchParams.set("battery", anchor); else url.searchParams.delete("battery");
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };
  $("battery-older")?.addEventListener("click", () => {
    if (!batteryPage.page_start || !batteryPage.has_older) return;
    setBatteryAnchor(shiftIsoDate(batteryPage.page_start, -1)); void loadBatteryStatistics();
  });
  $("battery-newer")?.addEventListener("click", () => {
    if (!batteryPage.page_end || !batteryPage.has_newer) return;
    const next = shiftIsoDate(batteryPage.page_end, 7);
    setBatteryAnchor(next >= batteryPage.today ? null : next); void loadBatteryStatistics();
  });
  const showCurrentBatteryPage = () => { setBatteryAnchor(null); void loadBatteryStatistics(); };
  $("battery-period")?.addEventListener("click", showCurrentBatteryPage);
  $("battery-current")?.addEventListener("click", showCurrentBatteryPage);
  window.addEventListener("popstate", () => {
    const query = new URLSearchParams(window.location.search);
    const value = query.get("daily");
    const batteryValue = query.get("battery");
    dailyAnchor = /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
    batteryAnchor = /^\d{4}-\d{2}-\d{2}$/.test(batteryValue || "") ? batteryValue : null;
    if (viewIncludes("overview") || viewIncludes("economics")) void loadStatistics();
    if (viewIncludes("history")) void loadBatteryStatistics();
  });
  $("energy-csv")?.addEventListener("click", (event) => {
    event.preventDefault();
    const csv = $("energy-csv");
    if (!csv) return;
    const target = new URL(csv.href, window.location.href);
    const next = `${target.pathname}${target.search}`;
    window.location.assign(`csv-auth/login?next=${encodeURIComponent(next)}`);
  });
  const rawExportEnd = $("raw-export-end");
  const rawExportStart = $("raw-export-start");
  if (rawExportEnd && rawExportStart) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    const localDate = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    rawExportEnd.value = localDate(today);
    rawExportStart.value = localDate(start);
  }
  $("raw-export-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const start = rawExportStart?.value || "";
    const end = rawExportEnd?.value || "";
    const resolution = $("raw-export-resolution")?.value || "5s";
    const target = new URL("api/raw-data.csv.zip", window.location.href);
    target.search = new URLSearchParams({ start, end, resolution }).toString();
    const next = `${target.pathname}${target.search}`;
    window.location.assign(`csv-auth/login?next=${encodeURIComponent(next)}`);
  });
  document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.getAttribute("data-dashboard-tab") || "overview";
      setDashboardView(view);
      scrollToDashboardContent(view);
    });
  });
  $("all-sections-toggle")?.addEventListener("click", () => {
    const view = dashboardView === "all" ? lastTabbedView : "all";
    setDashboardView(view);
    scrollToDashboardContent(view);
  });
  document.querySelectorAll("[data-temp-range]").forEach((button) => {
    button.addEventListener("click", () => {
      temperatureRange = button.getAttribute("data-temp-range") || "24h";
      document.querySelectorAll("[data-temp-range]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      void loadTemperatureHistory();
    });
  });
  $("retry")?.addEventListener("click", () => void loadLive());
  $("device-events-more")?.addEventListener("click", () => void loadDeviceEvents(true));
  const tariffSlider = $("tariff-slider");
  if (tariffSlider) tariffSlider.value = String(tariffCt);
  tariffSlider?.addEventListener("input", () => {
    tariffCt = Number(tariffSlider.value);
    try { localStorage.setItem("pv-tariff-ct", String(tariffCt)); } catch (_) { /* optional */ }
    renderEconomics();
  });
  $("tariff-reset")?.addEventListener("click", () => {
    tariffCt = BASE_TARIFF_CT;
    try { localStorage.setItem("pv-tariff-ct", String(tariffCt)); } catch (_) { /* optional */ }
    renderEconomics();
  });
  const exportTariffSlider = $("export-tariff-slider");
  if (exportTariffSlider) exportTariffSlider.value = String(exportTariffCt);
  exportTariffSlider?.addEventListener("input", () => {
    exportTariffCt = Number(exportTariffSlider.value);
    try { localStorage.setItem("pv-export-tariff-ct", String(exportTariffCt)); } catch (_) { /* optional */ }
    renderEconomics();
  });
  $("export-tariff-reset")?.addEventListener("click", () => {
    exportTariffCt = BASE_EXPORT_TARIFF_CT;
    try { localStorage.setItem("pv-export-tariff-ct", String(exportTariffCt)); } catch (_) { /* optional */ }
    renderEconomics();
  });
  $("theme-toggle")?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("pv-theme", root.dataset.theme); } catch (_) { /* optional */ }
    syncThemeLabel();
    drawHistory();
    drawInteractiveHistory();
    drawEnergySeries();
    drawSocHistory();
    drawTemperatureHistory();
    drawSolarProfiles();
  });
  window.addEventListener("resize", () => {
    historyChart?.resize(); energyChart?.resize(); socChart?.resize(); solarYearChart?.resize();
    drawTemperatureHistory(); drawSolarProfiles();
  });
  syncThemeLabel();
  initTooltips();
  void loadLive();
  setDashboardView(dashboardView, false);
  liveTimer = window.setInterval(loadLive, 5000);
  historyTimer = window.setInterval(() => { if (viewIncludes("history")) void loadHistory(); }, 30000);
  temperatureTimer = window.setInterval(() => { if (viewIncludes("history")) void loadTemperatureHistory(); }, 60000);
  storageTimer = window.setInterval(() => { if (viewIncludes("system")) { void loadStorage(); void loadDeviceEvents(); } }, 30000);
  statisticsTimer = window.setInterval(() => { if (viewIncludes("overview") || viewIncludes("economics")) void loadStatistics(); }, 60000);
  economicsTimer = window.setInterval(() => { if (viewIncludes("economics")) void loadEconomics(); }, 60000);
  batteryStatisticsTimer = window.setInterval(() => { if (viewIncludes("history")) void loadBatteryStatistics(); }, 60000);
  solarProfileTimer = window.setInterval(() => { if (viewIncludes("history")) void loadSolarProfiles(); }, 300000);
  energyTimer = window.setInterval(() => { if (viewIncludes("history")) void loadEnergySeries(); }, 300000);
  highscoreTimer = window.setInterval(() => { if (viewIncludes("history")) void loadHighscores(); }, 300000);
  window.addEventListener("beforeunload", () => { clearInterval(liveTimer); clearInterval(historyTimer); clearInterval(temperatureTimer); clearInterval(storageTimer); clearInterval(statisticsTimer); clearInterval(economicsTimer); clearInterval(batteryStatisticsTimer); clearInterval(solarProfileTimer); clearInterval(energyTimer); clearInterval(highscoreTimer); });
})();
