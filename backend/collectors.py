from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import math
import struct
import time
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen

from .config import Settings
from .modbus import ModbusError, ReadOnlyModbusClient


def _get_json(url: str, timeout: float) -> dict[str, Any]:
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    with urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")
    return payload


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _nested_number(payload: dict[str, Any], *names: str) -> float | None:
    candidates = [payload]
    for key in ("data", "output", "outputData", "result"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.append(nested)
    for candidate in candidates:
        for name in names:
            value = _number(candidate.get(name))
            if value is not None:
                return value
    return None


def _source_error(name: str, error: BaseException) -> dict[str, Any]:
    return {
        "name": name,
        "online": False,
        "error": f"{type(error).__name__}: {error}",
    }


SOURCE_NAMES = {
    "solakon": "Solakon ONE",
    "shelly": "Shelly Pro 3EM",
    "tasmota": "Tasmota IR-Zähler",
    "ez1": "APsystems EZ1 Ost",
}

# The EZ1-M's embedded HTTP server becomes unreliable when all three API
# endpoints are queried every five seconds.  Keep its fast-changing output on
# a modest cadence and retain the last valid value across brief HTTP hiccups.
_EZ1_OUTPUT_INTERVAL_SECONDS = 10.0
_EZ1_STATUS_INTERVAL_SECONDS = 300.0
_EZ1_STALE_GRACE_SECONDS = 45.0
_ez1_cache: dict[str, Any] = {}

SOLAKON_ALARMS = {
    39067: {
        0x0001: "PV-Eingangsspannung zu hoch", 0x0002: "DC-Lichtbogen erkannt",
        0x0004: "PV-String verpolt", 0x0080: "Netzausfall",
        0x0100: "Netzspannung außerhalb Grenzwert", 0x0800: "Netzfrequenz außerhalb Grenzwert",
        0x4000: "Ausgangsüberstrom", 0x8000: "DC-Anteil im Ausgangsstrom zu hoch",
    },
    39068: {
        0x0001: "Fehlerstrom auffällig", 0x0002: "Erdungsfehler",
        0x0004: "Isolationswiderstand zu niedrig", 0x0008: "Temperatur zu hoch",
        0x0200: "Speichersystem gestört", 0x0400: "Inselbetrieb erkannt",
        0x4000: "Offgrid-Ausgang überlastet",
    },
    39069: {
        0x0008: "Externer Lüfter gestört", 0x0010: "Speicher verpolt",
        0x0200: "Zählerverbindung verloren", 0x0400: "BMS-Verbindung verloren",
    },
}


def _decode_solakon_alarms(register_map: dict[int, int]) -> tuple[list[dict[str, Any]], list[int]]:
    alarms: list[dict[str, Any]] = []
    words: list[int] = []
    for address, definitions in SOLAKON_ALARMS.items():
        word = register_map[address]
        words.append(word)
        known_mask = 0
        for bit, label in definitions.items():
            known_mask |= bit
            if word & bit:
                alarms.append({"register": address, "bit": bit, "label": label})
        unknown = word & ~known_mask
        if unknown:
            alarms.append({"register": address, "bit": unknown, "label": f"Unbekannter Alarmcode 0x{unknown:04X}"})
    return alarms, words


def read_solakon(settings: Settings) -> dict[str, Any]:
    client = ReadOnlyModbusClient(
        settings.solakon_host,
        settings.solakon_port,
        settings.solakon_unit_id,
        settings.request_timeout,
    )
    register_map: dict[int, int] = {}
    blocks = (
        (37609, 27),
        (38801, 47),
        (39050, 122),
        (39219, 120),
        (39424, 1),
        (39601, 20),
    )
    for address, count in blocks:
        values = client.read_holding_registers(address, count)
        register_map.update({address + offset: value for offset, value in enumerate(values)})

    def u16(address: int) -> int:
        return register_map[address]

    def i16(address: int) -> int:
        return struct.unpack(">h", struct.pack(">H", u16(address)))[0]

    def i32(address: int) -> int:
        value = (u16(address) << 16) | u16(address + 1)
        return value - (1 << 32) if value & 0x80000000 else value

    soc = u16(37612)
    design_energy_wh = i16(37635) / 0.1
    battery_native_w = i32(39230)
    grid_native_w = i32(39168)
    alarms, alarm_words = _decode_solakon_alarms(register_map)
    state_word = u16(39063)
    operating_state = {0x0001: "Standby", 0x0004: "Betrieb", 0x0040: "Fehler"}.get(
        state_word, f"Status 0x{state_word:04X}"
    )
    return {
        "name": "Solakon ONE",
        "online": True,
        "pv_w": float(i32(39118)),
        "ac_w": float(i32(39134)),
        "grid_w": float(-grid_native_w),
        "house_reported_w": float(i32(39225)),
        "battery_w": float(-battery_native_w),
        "soc_percent": float(soc),
        "battery_temperature_c": i16(37611) / 10,
        "battery_voltage_v": u16(37609) / 10,
        "battery_current_a": i16(37610) / 10,
        "battery_soh_percent": float(u16(37624)),
        "estimated_remaining_wh": design_energy_wh * soc / 100,
        "estimated_remaining": True,
        "internal_temperature_c": i16(39141) / 10,
        "frequency_hz": i16(39139) / 100,
        "operating_state": operating_state,
        "operating_state_raw": state_word,
        "off_grid": bool(u16(39065) & 0x0001),
        "alarm_active": bool(alarms),
        "alarm_words": alarm_words,
        "alarms": alarms,
        "pv_today_kwh": ((u16(39603) << 16) | u16(39604)) / 100,
        "pv_total_kwh": ((u16(39601) << 16) | u16(39602)) / 100,
        "mppts": [
            {
                "name": f"MPPT {index}",
                "voltage_v": i16(39327 + (index - 1) * 4) / 10,
                "current_a": i16(39328 + (index - 1) * 4) / 100,
                "power_w": float(i32(39329 + (index - 1) * 4)),
            }
            for index in range(1, 3)
        ],
        "channels": [
            {
                "name": f"PV {index}",
                "voltage_v": i16(39070 + (index - 1) * 2) / 10,
                "current_a": i16(39071 + (index - 1) * 2) / 100,
                "power_w": float(i32(39279 + (index - 1) * 2)),
            }
            for index in range(1, 5)
        ],
    }


def read_shelly(settings: Settings) -> dict[str, Any]:
    base = f"http://{settings.shelly_host}"
    live = _get_json(f"{base}/rpc/EM.GetStatus?id=0", settings.request_timeout)
    energy = _get_json(f"{base}/rpc/EMData.GetStatus?id=0", settings.request_timeout)
    device = _get_json(f"{base}/rpc/Shelly.GetStatus", settings.request_timeout)
    phases = []
    for prefix, label in (("a", "A"), ("b", "B"), ("c", "C")):
        phases.append(
            {
                "name": label,
                "power_w": _number(live.get(f"{prefix}_act_power")),
                "voltage_v": _number(live.get(f"{prefix}_voltage")),
                "current_a": _number(live.get(f"{prefix}_current")),
                "power_factor": _number(live.get(f"{prefix}_pf")),
            }
        )
    component_errors = []
    for component, values in device.items():
        if isinstance(values, dict) and isinstance(values.get("errors"), list):
            component_errors.extend(f"{component}: {error}" for error in values["errors"])
    system = device.get("sys") if isinstance(device.get("sys"), dict) else {}
    wifi = device.get("wifi") if isinstance(device.get("wifi"), dict) else {}
    temperature = device.get("temperature:0") if isinstance(device.get("temperature:0"), dict) else {}
    return {
        "name": "Shelly Pro 3EM",
        "online": True,
        "grid_w": _number(live.get("total_act_power")),
        "frequency_hz": _number(live.get("a_freq")),
        "phases": phases,
        "import_energy_wh": _number(energy.get("total_act")),
        "export_energy_wh": _number(energy.get("total_act_ret")),
        "operating_state": "Warnung" if component_errors or system.get("restart_required") else "Betrieb",
        "alarm_active": bool(component_errors),
        "alarms": [{"label": error} for error in component_errors],
        "device_temperature_c": _number(temperature.get("tC")),
        "uptime_seconds": _number(system.get("uptime")),
        "reset_reason": system.get("reset_reason"),
        "restart_required": bool(system.get("restart_required")),
        "wifi_rssi": _number(wifi.get("rssi")),
        "wifi_status": wifi.get("status"),
    }


def read_tasmota(settings: Settings) -> dict[str, Any]:
    command = quote("Status 0")
    payload = _get_json(
        f"http://{settings.tasmota_host}/cm?cmnd={command}",
        settings.request_timeout,
    )
    sensors = payload.get("StatusSNS")
    if not isinstance(sensors, dict):
        raise KeyError("StatusSNS missing")
    meter = next(
        (value for key, value in sensors.items() if key != "Time" and isinstance(value, dict)),
        None,
    )
    if meter is None:
        raise KeyError("meter object missing")
    parameters = payload.get("StatusPRM") if isinstance(payload.get("StatusPRM"), dict) else {}
    firmware = payload.get("StatusFWR") if isinstance(payload.get("StatusFWR"), dict) else {}
    runtime = payload.get("StatusSTS") if isinstance(payload.get("StatusSTS"), dict) else {}
    wifi = runtime.get("Wifi") if isinstance(runtime.get("Wifi"), dict) else {}
    return {
        "name": "Tasmota IR-Zähler",
        "online": True,
        "grid_w": _nested_number(meter, "power", "Power"),
        "import_energy_kwh": _nested_number(meter, "consumption", "total_in", "Total_in", "import", "Import"),
        "export_energy_kwh": _nested_number(meter, "production", "total_out", "Total_out", "export", "Export"),
        "device_time": sensors.get("Time"),
        "operating_state": "Betrieb",
        "alarm_active": False,
        "alarms": [],
        "uptime_seconds": _number(runtime.get("UptimeSec")),
        "restart_reason": parameters.get("RestartReason"),
        "boot_count": _number(parameters.get("BootCount")),
        "firmware_version": firmware.get("Version"),
        "heap_kb": _number(runtime.get("Heap")),
        "wifi_rssi_percent": _number(wifi.get("RSSI")),
        "wifi_signal_dbm": _number(wifi.get("Signal")),
        "wifi_downtime": wifi.get("Downtime"),
    }


def read_ez1(settings: Settings) -> dict[str, Any]:
    now = time.monotonic()
    base = f"http://{settings.ez1_host}:{settings.ez1_port}"
    cached_at = float(_ez1_cache.get("output_at", 0.0))
    output = _ez1_cache.get("output")
    if not isinstance(output, dict) or now - cached_at >= _EZ1_OUTPUT_INTERVAL_SECONDS:
        try:
            output = _get_json(f"{base}/getOutputData", max(settings.request_timeout, 4.0))
        except (OSError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
            if not isinstance(output, dict) or now - cached_at > _EZ1_STALE_GRACE_SECONDS:
                raise
            output_stale = True
        else:
            _ez1_cache["output"] = output
            _ez1_cache["output_at"] = now
            cached_at = now
            output_stale = False
    else:
        output_stale = False

    status_at = float(_ez1_cache.get("status_at", 0.0))
    if now - status_at >= _EZ1_STATUS_INTERVAL_SECONDS:
        # Status and alarm data change rarely. Failures here must not discard a
        # perfectly valid power reading.
        for key, endpoint in (("alarm", "getAlarm"), ("on_off", "getOnOff")):
            try:
                _ez1_cache[key] = _get_json(f"{base}/{endpoint}", min(settings.request_timeout, 2.0))
            except (OSError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
                pass
        _ez1_cache["status_at"] = now

    alarm = _ez1_cache.get("alarm") if isinstance(_ez1_cache.get("alarm"), dict) else {}
    on_off = _ez1_cache.get("on_off") if isinstance(_ez1_cache.get("on_off"), dict) else {}
    p1 = _nested_number(output, "p1", "P1")
    p2 = _nested_number(output, "p2", "P2")
    e1 = _nested_number(output, "e1", "E1")
    e2 = _nested_number(output, "e2", "E2")
    te1 = _nested_number(output, "te1", "TE1")
    te2 = _nested_number(output, "te2", "TE2")
    alarm_data = alarm.get("data") if isinstance(alarm.get("data"), dict) else {}
    on_off_data = on_off.get("data") if isinstance(on_off.get("data"), dict) else {}
    alarm_definitions = {
        "og": "Netz-/AC-Verbindung gestört",
        "isce1": "DC-Eingang PV 1 kurzgeschlossen",
        "isce2": "DC-Eingang PV 2 kurzgeschlossen",
        "oe": "Ausgangsstörung",
    }
    alarms = [
        {"code": code, "label": label}
        for code, label in alarm_definitions.items()
        if str(alarm_data.get(code, "0")) == "1"
    ]
    switched_off = str(on_off_data.get("status", "0")) == "1"
    return {
        "name": "APsystems EZ1 Ost",
        "online": True,
        "cached": now - cached_at < _EZ1_OUTPUT_INTERVAL_SECONDS,
        "stale": output_stale,
        "sample_age_seconds": round(max(0.0, now - cached_at), 1),
        "pv_w": (p1 or 0.0) + (p2 or 0.0),
        "mppts": [
            {"name": "Ost 1", "power_w": p1},
            {"name": "Ost 2", "power_w": p2},
        ],
        "energy_since_start_kwh": (e1 or 0.0) + (e2 or 0.0),
        "total_energy_kwh": (te1 or 0.0) + (te2 or 0.0),
        "alarm": alarm,
        "on_off": on_off,
        "operating_state": "Ausgeschaltet" if switched_off else "Betrieb",
        "switched_off": switched_off,
        "alarm_active": bool(alarms),
        "alarms": alarms,
    }


def _safe_read(name: str, reader: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return reader()
    except (OSError, TimeoutError, ValueError, KeyError, json.JSONDecodeError, ModbusError) as error:
        return _source_error(SOURCE_NAMES.get(name, name), error)


def collect_snapshot(settings: Settings) -> dict[str, Any]:
    readers: dict[str, Callable[[], dict[str, Any]]] = {
        "solakon": lambda: read_solakon(settings),
        "shelly": lambda: read_shelly(settings),
        "tasmota": lambda: read_tasmota(settings),
        "ez1": lambda: read_ez1(settings),
    }
    sources: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(readers)) as executor:
        futures = {
            executor.submit(_safe_read, name, reader): name
            for name, reader in readers.items()
        }
        for future in as_completed(futures):
            sources[futures[future]] = future.result()

    solakon = sources["solakon"]
    shelly = sources["shelly"]
    ez1 = sources["ez1"]
    solakon_pv = _number(solakon.get("pv_w")) if solakon.get("online") else None
    solakon_ac = _number(solakon.get("ac_w")) if solakon.get("online") else None
    ez1_pv = _number(ez1.get("pv_w")) if ez1.get("online") else None
    total_pv = (solakon_pv or 0.0) + (ez1_pv or 0.0)
    grid_w = _number(shelly.get("grid_w")) if shelly.get("online") else None
    if grid_w is None and solakon.get("online"):
        grid_w = _number(solakon.get("grid_w"))
    battery_w = _number(solakon.get("battery_w")) if solakon.get("online") else None
    solakon_today_kwh = _number(solakon.get("pv_today_kwh")) if solakon.get("online") else None
    ez1_today_kwh = _number(ez1.get("energy_since_start_kwh")) if ez1.get("online") else None
    solakon_total_kwh = _number(solakon.get("pv_total_kwh")) if solakon.get("online") else None
    ez1_total_kwh = _number(ez1.get("total_energy_kwh")) if ez1.get("online") else None
    # AC-side conservation at the house bus. Solakon PV and battery values are
    # DC-side internal flows; adding them here double-counts conversion paths.
    # The inverter's measured AC output already contains their net contribution.
    house_w = (solakon_ac or 0.0) + (ez1_pv or 0.0) + (grid_w or 0.0)
    house_w = max(0.0, house_w)
    grid_import = max(grid_w or 0.0, 0.0)
    autarky = 100.0 if house_w <= 1 else max(0.0, min(100.0, (1 - grid_import / house_w) * 100))
    online_count = sum(1 for source in sources.values() if source.get("online"))

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sign_convention": {
            "grid": "positive=import, negative=export",
            "battery": "positive=discharge, negative=charge",
        },
        "quality": "complete" if online_count == len(sources) else "partial",
        "grid": {
            "power_w": grid_w,
            "source": "shelly" if shelly.get("online") else "solakon-fallback",
        },
        "pv": {
            "solakon_one_w": solakon_pv,
            "ez1_east_w": ez1_pv,
            "total_w": total_pv,
            "energy_today_kwh": (solakon_today_kwh or 0.0) + (ez1_today_kwh or 0.0),
            "energy_total_kwh": (solakon_total_kwh or 0.0) + (ez1_total_kwh or 0.0),
            "energy_totals": {
                "solakon_one_kwh": solakon_total_kwh,
                "ez1_east_kwh": ez1_total_kwh,
            },
        },
        "battery": {
            "power_w": battery_w,
            "soc_percent": _number(solakon.get("soc_percent")),
            "temperature_c": _number(solakon.get("battery_temperature_c")),
            "energy_remaining_wh": _number(solakon.get("estimated_remaining_wh")),
            "energy_remaining_estimated": bool(solakon.get("estimated_remaining")),
        },
        "house": {
            "consumption_w": house_w,
            "calculation": "solakon_ac + ez1_ac + grid",
            "reported_by_solakon_w": _number(solakon.get("house_reported_w")),
        },
        "autarky_percent": autarky,
        "sources": sources,
    }
