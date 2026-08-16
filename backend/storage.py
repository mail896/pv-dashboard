from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import sqlite3
from typing import Any
from zoneinfo import ZoneInfo


RANGES = {
    "1h": (timedelta(hours=1), 60),
    "24h": (timedelta(hours=24), 300),
    "7d": (timedelta(days=7), 1800),
    "30d": (timedelta(days=30), 7200),
}


class Storage:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS measurements (
                    id INTEGER PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    pv_total_w REAL,
                    pv_solakon_w REAL,
                    pv_ez1_w REAL,
                    house_w REAL,
                    grid_w REAL,
                    battery_w REAL,
                    soc_percent REAL,
                    autarky_percent REAL,
                    quality TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_measurements_timestamp ON measurements(timestamp)"
            )
            measurement_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(measurements)").fetchall()
            }
            temperature_columns_added = False
            for column in ("battery_temperature_c", "internal_temperature_c"):
                if column not in measurement_columns:
                    connection.execute(f"ALTER TABLE measurements ADD COLUMN {column} REAL")
                    temperature_columns_added = True
            if temperature_columns_added:
                connection.execute(
                    """
                    UPDATE measurements
                    SET battery_temperature_c = json_extract(snapshot_json, '$.battery.temperature_c'),
                        internal_temperature_c = json_extract(snapshot_json, '$.sources.solakon.internal_temperature_c')
                    """
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS source_events (
                    id INTEGER PRIMARY KEY,
                    source TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    online INTEGER NOT NULL,
                    detail_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_source_events_source_timestamp ON source_events(source, timestamp)"
            )
            event_count = connection.execute(
                "SELECT COUNT(*) AS count FROM source_events WHERE source = 'ez1'"
            ).fetchone()["count"]
            if event_count == 0:
                rows = connection.execute(
                    "SELECT timestamp, snapshot_json FROM measurements ORDER BY timestamp ASC"
                ).fetchall()
                previous_state: bool | None = None
                for row in rows:
                    snapshot = json.loads(row["snapshot_json"])
                    source = snapshot.get("sources", {}).get("ez1", {})
                    state = bool(source.get("online"))
                    if state != previous_state:
                        connection.execute(
                            "INSERT INTO source_events(source, timestamp, online, detail_json) VALUES ('ez1', ?, ?, ?)",
                            (row["timestamp"], int(state), json.dumps({"error": source.get("error")}, ensure_ascii=False)),
                        )
                        previous_state = state
            connection.execute("PRAGMA optimize")

    def insert(self, snapshot: dict[str, Any]) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO measurements (
                    timestamp, pv_total_w, pv_solakon_w, pv_ez1_w, house_w,
                    grid_w, battery_w, soc_percent, autarky_percent, quality,
                    snapshot_json, battery_temperature_c, internal_temperature_c
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot["timestamp"],
                    snapshot["pv"]["total_w"],
                    snapshot["pv"]["solakon_one_w"],
                    snapshot["pv"]["ez1_east_w"],
                    snapshot["house"]["consumption_w"],
                    snapshot["grid"]["power_w"],
                    snapshot["battery"]["power_w"],
                    snapshot["battery"]["soc_percent"],
                    snapshot["autarky_percent"],
                    snapshot["quality"],
                    json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
                    snapshot.get("battery", {}).get("temperature_c"),
                    snapshot.get("sources", {}).get("solakon", {}).get("internal_temperature_c"),
                ),
            )
            ez1 = snapshot.get("sources", {}).get("ez1", {})
            online = bool(ez1.get("online"))
            previous = connection.execute(
                "SELECT online FROM source_events WHERE source = 'ez1' ORDER BY timestamp DESC LIMIT 1"
            ).fetchone()
            if previous is None or bool(previous["online"]) != online:
                connection.execute(
                    "INSERT INTO source_events(source, timestamp, online, detail_json) VALUES ('ez1', ?, ?, ?)",
                    (snapshot["timestamp"], int(online), json.dumps({"error": ez1.get("error")}, ensure_ascii=False, separators=(",", ":"))),
                )
            if ez1.get("online"):
                detail = {
                    "operating_state": ez1.get("operating_state"),
                    "switched_off": bool(ez1.get("switched_off")),
                    "alarms": ez1.get("alarms", []),
                    "power_w": ez1.get("pv_w"),
                }
                signature = json.dumps({key: detail[key] for key in ("switched_off", "alarms")}, ensure_ascii=False, separators=(",", ":"))
                previous = connection.execute(
                    "SELECT detail_json FROM source_events WHERE source = 'ez1_status' ORDER BY timestamp DESC LIMIT 1"
                ).fetchone()
                previous_signature = None
                if previous:
                    previous_detail = json.loads(previous["detail_json"])
                    previous_signature = json.dumps({key: previous_detail.get(key) for key in ("switched_off", "alarms")}, ensure_ascii=False, separators=(",", ":"))
                if signature != previous_signature:
                    connection.execute(
                        "INSERT INTO source_events(source, timestamp, online, detail_json) VALUES ('ez1_status', ?, ?, ?)",
                        (snapshot["timestamp"], int(not detail["alarms"]), json.dumps(detail, ensure_ascii=False, separators=(",", ":"))),
                    )
            solakon = snapshot.get("sources", {}).get("solakon", {})
            if solakon.get("online"):
                detail = {
                    "operating_state": solakon.get("operating_state"),
                    "operating_state_raw": solakon.get("operating_state_raw"),
                    "off_grid": bool(solakon.get("off_grid")),
                    "alarm_words": solakon.get("alarm_words", []),
                    "alarms": solakon.get("alarms", []),
                    "internal_temperature_c": solakon.get("internal_temperature_c"),
                    "battery_temperature_c": solakon.get("battery_temperature_c"),
                    "pv_w": solakon.get("pv_w"),
                    "ac_w": solakon.get("ac_w"),
                }
                signature = json.dumps({key: detail[key] for key in ("operating_state_raw", "off_grid", "alarm_words")}, separators=(",", ":"))
                previous = connection.execute(
                    "SELECT detail_json FROM source_events WHERE source = 'solakon_status' ORDER BY timestamp DESC LIMIT 1"
                ).fetchone()
                previous_signature = None
                if previous:
                    previous_detail = json.loads(previous["detail_json"])
                    previous_signature = json.dumps({key: previous_detail.get(key) for key in ("operating_state_raw", "off_grid", "alarm_words")}, separators=(",", ":"))
                if signature != previous_signature:
                    connection.execute(
                        "INSERT INTO source_events(source, timestamp, online, detail_json) VALUES ('solakon_status', ?, ?, ?)",
                        (snapshot["timestamp"], int(not detail["alarms"]), json.dumps(detail, ensure_ascii=False, separators=(",", ":"))),
                    )
            for event_source, source_key, detail_keys, signature_keys in (
                ("shelly_status", "shelly", ("operating_state", "alarms", "device_temperature_c", "uptime_seconds", "reset_reason", "restart_required", "wifi_rssi"), ("operating_state", "alarms", "reset_reason", "restart_required")),
                ("tasmota_status", "tasmota", ("operating_state", "alarms", "uptime_seconds", "restart_reason", "boot_count", "firmware_version", "heap_kb", "wifi_rssi_percent", "wifi_signal_dbm"), ("operating_state", "alarms", "restart_reason", "boot_count")),
            ):
                source = snapshot.get("sources", {}).get(source_key, {})
                if not source.get("online"):
                    continue
                detail = {key: source.get(key) for key in detail_keys}
                signature = json.dumps({key: detail.get(key) for key in signature_keys}, ensure_ascii=False, separators=(",", ":"))
                previous = connection.execute(
                    "SELECT detail_json FROM source_events WHERE source = ? ORDER BY timestamp DESC LIMIT 1",
                    (event_source,),
                ).fetchone()
                previous_signature = None
                if previous:
                    previous_detail = json.loads(previous["detail_json"])
                    previous_signature = json.dumps({key: previous_detail.get(key) for key in signature_keys}, ensure_ascii=False, separators=(",", ":"))
                if signature != previous_signature:
                    connection.execute(
                        "INSERT INTO source_events(source, timestamp, online, detail_json) VALUES (?, ?, ?, ?)",
                        (event_source, snapshot["timestamp"], int(not detail.get("alarms")), json.dumps(detail, ensure_ascii=False, separators=(",", ":"))),
                    )

    def latest(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT snapshot_json FROM measurements ORDER BY timestamp DESC LIMIT 1"
            ).fetchone()
        return json.loads(row["snapshot_json"]) if row else None

    def recent_grid_average(self, seconds: int = 60) -> dict[str, Any]:
        """Return the signed grid mean over the latest measured interval."""
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT timestamp, grid_w FROM measurements ORDER BY id DESC LIMIT 30"
            ).fetchall()
        if not rows:
            return {"power_w": None, "samples": 0, "window_seconds": seconds}
        latest = datetime.fromisoformat(rows[0]["timestamp"])
        cutoff = latest - timedelta(seconds=seconds)
        values = [
            float(row["grid_w"])
            for row in rows
            if row["grid_w"] is not None and datetime.fromisoformat(row["timestamp"]) >= cutoff
        ]
        return {
            "power_w": sum(values) / len(values) if values else None,
            "samples": len(values),
            "window_seconds": seconds,
        }

    def solakon_events(self, limit: int = 20) -> dict[str, Any]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT timestamp, detail_json FROM source_events WHERE source = 'solakon_status' ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return {"events": [{"timestamp": row["timestamp"], **json.loads(row["detail_json"])} for row in rows]}

    def device_events(self, limit: int = 30) -> dict[str, Any]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT source, timestamp, detail_json FROM source_events WHERE source IN ('solakon_status', 'ez1_status', 'shelly_status', 'tasmota_status') ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
        names = {"solakon_status": "Solakon ONE", "ez1_status": "APsystems EZ1", "shelly_status": "Shelly Pro 3EM", "tasmota_status": "IR-Leser"}
        return {"events": [{"device": names[row["source"]], "timestamp": row["timestamp"], **json.loads(row["detail_json"])} for row in rows]}

    def stats(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS latest FROM measurements"
            ).fetchone()
        related_files = (
            self.path,
            self.path.with_name(f"{self.path.name}-wal"),
            self.path.with_name(f"{self.path.name}-shm"),
        )
        database_bytes = sum(path.stat().st_size for path in related_files if path.exists())
        disk = shutil.disk_usage(self.path.parent)
        return {
            "measurements": row["count"],
            "first_timestamp": row["first"],
            "latest_timestamp": row["latest"],
            "database_bytes": database_bytes,
            "disk_free_bytes": disk.free,
        }

    def history(self, range_name: str) -> dict[str, Any]:
        duration, bucket_seconds = RANGES.get(range_name, RANGES["24h"])
        start = datetime.now(timezone.utc) - duration
        columns = (
            "pv_total_w",
            "pv_solakon_w",
            "pv_ez1_w",
            "house_w",
            "grid_w",
            "battery_w",
            "soc_percent",
            "battery_temperature_c",
            "internal_temperature_c",
        )
        averages = ", ".join(f"AVG({column}) AS {column}" for column in columns)
        query = f"""
            SELECT
                CAST(strftime('%s', timestamp) / ? AS INTEGER) * ? AS bucket,
                {averages}
            FROM measurements
            WHERE timestamp >= ?
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        with self.connect() as connection:
            rows = connection.execute(
                query,
                (bucket_seconds, bucket_seconds, start.isoformat(timespec="seconds")),
            ).fetchall()
        points = []
        for row in rows:
            point = {column: row[column] for column in columns}
            point["timestamp"] = datetime.fromtimestamp(row["bucket"], tz=timezone.utc).isoformat()
            points.append(point)
        return {
            "range": range_name if range_name in RANGES else "24h",
            "bucket_seconds": bucket_seconds,
            "points": points,
        }

    def daily_statistics(self, days: int = 7) -> dict[str, Any]:
        """Integrate power samples into local calendar-day energy totals.

        Intervals longer than 30 seconds are discarded so collector downtime is
        never extrapolated into fictitious energy consumption.
        """
        local_zone = ZoneInfo("Europe/Berlin")
        now_local = datetime.now(local_zone)
        first_day = now_local.date() - timedelta(days=max(1, days) - 1)
        start_local = datetime.combine(first_day, datetime.min.time(), tzinfo=local_zone)
        start_utc = start_local.astimezone(timezone.utc)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, pv_total_w, house_w, grid_w, battery_w
                FROM measurements
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (start_utc.isoformat(timespec="seconds"),),
            ).fetchall()

        totals: dict[str, dict[str, float]] = {}
        covered_seconds: dict[str, float] = {}
        house_samples: dict[str, list[float]] = {}
        previous: sqlite3.Row | None = None
        previous_time: datetime | None = None
        for row in rows:
            current_time = datetime.fromisoformat(row["timestamp"])
            if previous is not None and previous_time is not None:
                elapsed = (current_time - previous_time).total_seconds()
                day = previous_time.astimezone(local_zone).date().isoformat()
                if 0 < elapsed <= 30 and current_time.astimezone(local_zone).date().isoformat() == day:
                    values = totals.setdefault(day, {
                        "consumption_kwh": 0.0,
                        "pv_kwh": 0.0,
                        "import_kwh": 0.0,
                        "export_kwh": 0.0,
                        "battery_charge_kwh": 0.0,
                        "battery_discharge_kwh": 0.0,
                    })
                    for key, column, transform in (
                        ("consumption_kwh", "house_w", lambda value: max(value, 0.0)),
                        ("pv_kwh", "pv_total_w", lambda value: max(value, 0.0)),
                        ("import_kwh", "grid_w", lambda value: max(value, 0.0)),
                        ("export_kwh", "grid_w", lambda value: max(-value, 0.0)),
                        ("battery_charge_kwh", "battery_w", lambda value: max(-value, 0.0)),
                        ("battery_discharge_kwh", "battery_w", lambda value: max(value, 0.0)),
                    ):
                        a = transform(float(previous[column] or 0.0))
                        b = transform(float(row[column] or 0.0))
                        values[key] += ((a + b) / 2.0) * elapsed / 3_600_000.0
                    covered_seconds[day] = covered_seconds.get(day, 0.0) + elapsed
                    house_value = float(previous["house_w"] or 0.0)
                    if 20.0 <= house_value <= 2000.0:
                        house_samples.setdefault(day, []).append(house_value)
            previous = row
            previous_time = current_time

        result = []
        for offset in range(max(1, days)):
            day = (first_day + timedelta(days=offset)).isoformat()
            values = totals.get(day, {
                "consumption_kwh": 0.0, "pv_kwh": 0.0, "import_kwh": 0.0,
                "export_kwh": 0.0, "battery_charge_kwh": 0.0,
                "battery_discharge_kwh": 0.0,
            })
            consumption = values["consumption_kwh"]
            pv = values["pv_kwh"]
            values["autarky_percent"] = 100.0 if consumption <= 0 else max(
                0.0, min(100.0, (1.0 - values["import_kwh"] / consumption) * 100.0)
            )
            values["self_consumption_percent"] = 0.0 if pv <= 0 else max(
                0.0, min(100.0, (1.0 - values["export_kwh"] / pv) * 100.0)
            )
            samples = sorted(house_samples.get(day, []))
            if samples:
                percentile_index = min(len(samples) - 1, max(0, round((len(samples) - 1) * 0.10)))
                values["base_load_w"] = samples[percentile_index]
            else:
                values["base_load_w"] = 0.0
            result.append({
                "date": day,
                **{key: round(value, 3) for key, value in values.items()},
                "coverage_hours": round(covered_seconds.get(day, 0.0) / 3600.0, 2),
            })
        return {"timezone": "Europe/Berlin", "days": result}

    def energy_series(self, period: str = "month", anchor: str | None = None) -> dict[str, Any]:
        """Return calendar-aware energy buckets calculated on the server.

        Values are integrated from the original five-second samples. Gaps over
        30 seconds are deliberately omitted rather than estimated.
        """
        if period not in {"day", "week", "month", "year", "years"}:
            raise ValueError(f"Ungültiger Zeitraum: {period}")
        zone = ZoneInfo("Europe/Berlin")
        today = datetime.now(zone).date()
        try:
            selected = date.fromisoformat(anchor) if anchor else today
        except ValueError as error:
            raise ValueError("Ungültiges Ankerdatum") from error

        if period == "day":
            start_date, end_date = selected, selected + timedelta(days=1)
        elif period == "week":
            start_date = selected - timedelta(days=selected.weekday())
            end_date = start_date + timedelta(days=7)
        elif period == "month":
            start_date = selected.replace(day=1)
            end_date = (start_date.replace(day=28) + timedelta(days=4)).replace(day=1)
        elif period == "year":
            start_date, end_date = date(selected.year, 1, 1), date(selected.year + 1, 1, 1)
        else:
            with self.connect() as connection:
                bounds = connection.execute("SELECT MIN(timestamp) first, MAX(timestamp) latest FROM measurements").fetchone()
            first = datetime.fromisoformat(bounds["first"]).astimezone(zone).date() if bounds["first"] else selected
            latest = datetime.fromisoformat(bounds["latest"]).astimezone(zone).date() if bounds["latest"] else selected
            start_date, end_date = date(first.year, 1, 1), date(latest.year + 1, 1, 1)

        start_local = datetime.combine(start_date, datetime.min.time(), tzinfo=zone)
        end_local = datetime.combine(end_date, datetime.min.time(), tzinfo=zone)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, pv_total_w, pv_solakon_w, pv_ez1_w,
                       house_w, grid_w, battery_w
                FROM measurements
                WHERE timestamp >= ? AND timestamp < ?
                ORDER BY timestamp ASC
                """,
                (start_local.astimezone(timezone.utc).isoformat(), end_local.astimezone(timezone.utc).isoformat()),
            ).fetchall()

        def bucket_key(moment: datetime) -> str:
            local = moment.astimezone(zone)
            if period == "day":
                return local.strftime("%Y-%m-%dT%H:00")
            if period in {"week", "month"}:
                return local.date().isoformat()
            if period == "year":
                return local.strftime("%Y-%m")
            return str(local.year)

        totals: dict[str, dict[str, float]] = {}
        previous: sqlite3.Row | None = None
        previous_time: datetime | None = None
        metrics = (
            ("pv_total_kwh", "pv_total_w", lambda value: max(value, 0.0)),
            ("pv_solakon_kwh", "pv_solakon_w", lambda value: max(value, 0.0)),
            ("pv_ez1_kwh", "pv_ez1_w", lambda value: max(value, 0.0)),
            ("consumption_kwh", "house_w", lambda value: max(value, 0.0)),
            ("import_kwh", "grid_w", lambda value: max(value, 0.0)),
            ("export_kwh", "grid_w", lambda value: max(-value, 0.0)),
            ("battery_charge_kwh", "battery_w", lambda value: max(-value, 0.0)),
            ("battery_discharge_kwh", "battery_w", lambda value: max(value, 0.0)),
        )
        for row in rows:
            current_time = datetime.fromisoformat(row["timestamp"])
            if previous is not None and previous_time is not None:
                elapsed = (current_time - previous_time).total_seconds()
                key = bucket_key(previous_time)
                if 0 < elapsed <= 30 and bucket_key(current_time) == key:
                    values = totals.setdefault(key, {name: 0.0 for name, _, _ in metrics})
                    for name, column, transform in metrics:
                        a = transform(float(previous[column] or 0.0))
                        b = transform(float(row[column] or 0.0))
                        values[name] += ((a + b) / 2.0) * elapsed / 3_600_000.0
                    values["covered_seconds"] = values.get("covered_seconds", 0.0) + elapsed
            previous, previous_time = row, current_time

        points = []
        for key in sorted(totals):
            values = totals[key]
            consumption, pv = values["consumption_kwh"], values["pv_total_kwh"]
            values["autarky_percent"] = 100.0 if consumption <= 0 else max(0.0, min(100.0, (1 - values["import_kwh"] / consumption) * 100))
            values["self_consumption_percent"] = 0.0 if pv <= 0 else max(0.0, min(100.0, (1 - values["export_kwh"] / pv) * 100))
            points.append({"bucket": key, **{name: round(value, 4) for name, value in values.items()}})
        return {
            "period": period, "anchor": selected.isoformat(), "start": start_date.isoformat(),
            "end": end_date.isoformat(), "timezone": "Europe/Berlin", "points": points,
        }

    def highscores(self) -> dict[str, Any]:
        """Separate energy records (complete days) from instantaneous peaks."""
        with self.connect() as connection:
            first = connection.execute("SELECT MIN(timestamp) value FROM measurements").fetchone()["value"]
            rows = connection.execute(
                """
                SELECT
                  MAX(pv_total_w) max_pv, MAX(house_w) max_house,
                  MAX(grid_w) max_import, MIN(grid_w) max_export,
                  MAX(battery_w) max_discharge, MIN(battery_w) max_charge
                FROM measurements
                """
            ).fetchone()
            times = {}
            for name, column, direction in (
                ("pv", "pv_total_w", "DESC"), ("house", "house_w", "DESC"),
                ("import", "grid_w", "DESC"), ("export", "grid_w", "ASC"),
                ("battery_discharge", "battery_w", "DESC"), ("battery_charge", "battery_w", "ASC"),
            ):
                hit = connection.execute(f"SELECT timestamp, {column} value FROM measurements WHERE {column} IS NOT NULL ORDER BY {column} {direction} LIMIT 1").fetchone()
                times[name] = {"timestamp": hit["timestamp"], "value_w": abs(round(hit["value"], 1))} if hit else None

        daily = self.daily_statistics(3660)["days"]
        complete = [item for item in daily if item["coverage_hours"] >= 22.8]
        daily_records = []
        definitions = (
            ("PV-Erzeugung", "pv_kwh"), ("Hausverbrauch", "consumption_kwh"),
            ("Netzbezug", "import_kwh"), ("Einspeisung", "export_kwh"),
            ("Batterieladung", "battery_charge_kwh"), ("Batterieentladung", "battery_discharge_kwh"),
        )
        for label, key in definitions:
            if complete:
                maximum = max(complete, key=lambda item: item[key])
                minimum = min(complete, key=lambda item: item[key])
                daily_records.append({"label": label, "maximum": {"date": maximum["date"], "value_kwh": maximum[key]}, "minimum": {"date": minimum["date"], "value_kwh": minimum[key]}})
        return {
            "since": first, "complete_days": len(complete), "daily": daily_records,
            "instantaneous": [
                {"label": "PV-Leistung", **times["pv"]} if times["pv"] else None,
                {"label": "Hauslast", **times["house"]} if times["house"] else None,
                {"label": "Netzbezug", **times["import"]} if times["import"] else None,
                {"label": "Einspeisung", **times["export"]} if times["export"] else None,
                {"label": "Batterieabgabe", **times["battery_discharge"]} if times["battery_discharge"] else None,
                {"label": "Batterieladung", **times["battery_charge"]} if times["battery_charge"] else None,
            ],
        }

    def economics_totals(self) -> dict[str, Any]:
        """Integrate the measured energy balance over the complete recording.

        Gaps longer than 30 seconds are excluded, matching daily_statistics.
        Prices deliberately remain a frontend concern so What-if values never
        alter or become part of the measured source data.
        """
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, house_w, grid_w, snapshot_json
                FROM measurements
                ORDER BY timestamp ASC
                """
            ).fetchall()

        totals = {
            "consumption_kwh": 0.0,
            "import_kwh": 0.0,
            "export_kwh": 0.0,
        }
        covered_seconds = 0.0
        previous: sqlite3.Row | None = None
        previous_time: datetime | None = None
        for row in rows:
            current_time = datetime.fromisoformat(row["timestamp"])
            if previous is not None and previous_time is not None:
                elapsed = (current_time - previous_time).total_seconds()
                if 0 < elapsed <= 30:
                    for key, column, transform in (
                        ("consumption_kwh", "house_w", lambda value: max(value, 0.0)),
                        ("import_kwh", "grid_w", lambda value: max(value, 0.0)),
                        ("export_kwh", "grid_w", lambda value: max(-value, 0.0)),
                    ):
                        a = transform(float(previous[column] or 0.0))
                        b = transform(float(row[column] or 0.0))
                        totals[key] += ((a + b) / 2.0) * elapsed / 3_600_000.0
                    covered_seconds += elapsed
            previous = row
            previous_time = current_time

        avoided_import = max(totals["consumption_kwh"] - totals["import_kwh"], 0.0)
        meter_at_start = {"import_kwh": None, "export_kwh": None}
        for row in rows:
            sources = json.loads(row["snapshot_json"]).get("sources", {})
            tasmota = sources.get("tasmota", {})
            if tasmota.get("import_energy_kwh") is not None or tasmota.get("export_energy_kwh") is not None:
                meter_at_start = {
                    "import_kwh": tasmota.get("import_energy_kwh"),
                    "export_kwh": tasmota.get("export_energy_kwh"),
                }
                break
        return {
            **{key: round(value, 3) for key, value in totals.items()},
            "avoided_import_kwh": round(avoided_import, 3),
            "coverage_hours": round(covered_seconds / 3600.0, 2),
            "first_timestamp": rows[0]["timestamp"] if rows else None,
            "latest_timestamp": rows[-1]["timestamp"] if rows else None,
            "meter_at_recording_start": meter_at_start,
        }

    def battery_statistics(self, days: int = 31) -> dict[str, Any]:
        """Describe usable battery limits and energy around them.

        The Solakon reserve is treated as operationally empty at 10 %; full is
        reached at 99 %. Gaps above 30 seconds are never extrapolated.
        """
        local_zone = ZoneInfo("Europe/Berlin")
        now_local = datetime.now(local_zone)
        day_count = max(1, days)
        first_day = now_local.date() - timedelta(days=day_count - 1)
        start_local = datetime.combine(first_day, datetime.min.time(), tzinfo=local_zone)
        start_utc = start_local.astimezone(timezone.utc)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, grid_w, battery_w, soc_percent
                FROM measurements
                WHERE timestamp >= ? AND soc_percent IS NOT NULL
                ORDER BY timestamp ASC
                """,
                (start_utc.isoformat(timespec="seconds"),),
            ).fetchall()

        daily: dict[str, dict[str, Any]] = {}
        previous: sqlite3.Row | None = None
        previous_time: datetime | None = None
        previous_soc: float | None = None
        for row in rows:
            current_time = datetime.fromisoformat(row["timestamp"])
            current_local = current_time.astimezone(local_zone)
            day = current_local.date().isoformat()
            values = daily.setdefault(day, {
                "coverage_seconds": 0.0,
                "full_seconds": 0.0,
                "empty_seconds": 0.0,
                "charge_kwh": 0.0,
                "discharge_kwh": 0.0,
                "export_while_full_kwh": 0.0,
                "import_while_empty_kwh": 0.0,
                "full_at": None,
                "empty_at": None,
            })
            soc = float(row["soc_percent"])
            if soc >= 99.0 and (previous_soc is None or previous_soc < 99.0):
                values["full_at"] = values["full_at"] or current_local.isoformat()
            if soc <= 10.0 and (previous_soc is None or previous_soc > 10.0):
                values["empty_at"] = values["empty_at"] or current_local.isoformat()

            if previous is not None and previous_time is not None:
                elapsed = (current_time - previous_time).total_seconds()
                previous_local = previous_time.astimezone(local_zone)
                previous_day = previous_local.date().isoformat()
                if 0 < elapsed <= 30 and previous_day == day:
                    interval = daily.setdefault(previous_day, values)
                    interval["coverage_seconds"] += elapsed
                    prior_soc = float(previous["soc_percent"])
                    battery_a = float(previous["battery_w"] or 0.0)
                    battery_b = float(row["battery_w"] or 0.0)
                    grid_a = float(previous["grid_w"] or 0.0)
                    grid_b = float(row["grid_w"] or 0.0)
                    interval["charge_kwh"] += (
                        max(-battery_a, 0.0) + max(-battery_b, 0.0)
                    ) / 2.0 * elapsed / 3_600_000.0
                    interval["discharge_kwh"] += (
                        max(battery_a, 0.0) + max(battery_b, 0.0)
                    ) / 2.0 * elapsed / 3_600_000.0
                    if prior_soc >= 99.0:
                        interval["full_seconds"] += elapsed
                        interval["export_while_full_kwh"] += (
                            max(-grid_a, 0.0) + max(-grid_b, 0.0)
                        ) / 2.0 * elapsed / 3_600_000.0
                    if prior_soc <= 10.0:
                        interval["empty_seconds"] += elapsed
                        interval["import_while_empty_kwh"] += (
                            max(grid_a, 0.0) + max(grid_b, 0.0)
                        ) / 2.0 * elapsed / 3_600_000.0
            previous = row
            previous_time = current_time
            previous_soc = soc

        result = []
        for offset in range(day_count):
            day = (first_day + timedelta(days=offset)).isoformat()
            values = daily.get(day, {})
            result.append({
                "date": day,
                "coverage_hours": round(float(values.get("coverage_seconds", 0.0)) / 3600.0, 3),
                "full_at": values.get("full_at"),
                "empty_at": values.get("empty_at"),
                "full_hours": round(float(values.get("full_seconds", 0.0)) / 3600.0, 2),
                "empty_hours": round(float(values.get("empty_seconds", 0.0)) / 3600.0, 2),
                "charge_kwh": round(float(values.get("charge_kwh", 0.0)), 3),
                "discharge_kwh": round(float(values.get("discharge_kwh", 0.0)), 3),
                "export_while_full_kwh": round(float(values.get("export_while_full_kwh", 0.0)), 3),
                "import_while_empty_kwh": round(float(values.get("import_while_empty_kwh", 0.0)), 3),
            })

        observed = [day for day in result if day["coverage_hours"] > 0]
        shift_indicator = sum(
            min(day["export_while_full_kwh"], day["import_while_empty_kwh"])
            for day in observed
        )
        return {
            "timezone": "Europe/Berlin",
            "thresholds": {"full_percent": 99, "empty_percent": 10},
            "summary": {
                "observed_days": len(observed),
                "full_days": sum(day["full_at"] is not None or day["full_hours"] > 0 for day in observed),
                "empty_days": sum(day["empty_at"] is not None or day["empty_hours"] > 0 for day in observed),
                "export_while_full_kwh": round(sum(day["export_while_full_kwh"] for day in observed), 3),
                "import_while_empty_kwh": round(sum(day["import_while_empty_kwh"] for day in observed), 3),
                "shift_indicator_kwh": round(shift_indicator, 3),
            },
            "days": result,
        }

    def solar_profiles(self, days: int = 7, bucket_minutes: int = 10) -> dict[str, Any]:
        """Build local-time daily production profiles for east and south/west."""
        local_zone = ZoneInfo("Europe/Berlin")
        day_count = max(1, days)
        bucket_size = max(5, bucket_minutes)
        now_local = datetime.now(local_zone)
        first_day = now_local.date() - timedelta(days=day_count - 1)
        start_local = datetime.combine(first_day, datetime.min.time(), tzinfo=local_zone)
        start_utc = start_local.astimezone(timezone.utc)
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, pv_solakon_w, pv_ez1_w
                FROM measurements
                WHERE timestamp >= ? ORDER BY timestamp ASC
                """,
                (start_utc.isoformat(timespec="seconds"),),
            ).fetchall()

        buckets: dict[str, dict[int, dict[str, list[float]]]] = {}
        for row in rows:
            timestamp = datetime.fromisoformat(row["timestamp"]).astimezone(local_zone)
            day = timestamp.date().isoformat()
            minute = (timestamp.hour * 60 + timestamp.minute) // bucket_size * bucket_size
            values = buckets.setdefault(day, {}).setdefault(minute, {"solakon": [], "ez1": []})
            if row["pv_solakon_w"] is not None:
                values["solakon"].append(max(0.0, float(row["pv_solakon_w"])))
            if row["pv_ez1_w"] is not None:
                values["ez1"].append(max(0.0, float(row["pv_ez1_w"])))

        def clock(minute: int | None) -> str | None:
            return None if minute is None else f"{minute // 60:02d}:{minute % 60:02d}"

        result = []
        for offset in range(day_count):
            day = (first_day + timedelta(days=offset)).isoformat()
            points = []
            for minute, values in sorted(buckets.get(day, {}).items()):
                solakon = sum(values["solakon"]) / len(values["solakon"]) if values["solakon"] else None
                ez1 = sum(values["ez1"]) / len(values["ez1"]) if values["ez1"] else None
                points.append({
                    "minute": minute,
                    "solakon_w": None if solakon is None else round(solakon, 1),
                    "ez1_w": None if ez1 is None else round(ez1, 1),
                })
            active_solakon = [point for point in points if (point["solakon_w"] or 0) >= 10]
            active_ez1 = [point for point in points if (point["ez1_w"] or 0) >= 10]
            peak_solakon = max(active_solakon, key=lambda point: point["solakon_w"], default=None)
            peak_ez1 = max(active_ez1, key=lambda point: point["ez1_w"], default=None)
            crossover = None
            east_was_ahead = False
            for point in points:
                solakon = point["solakon_w"] or 0.0
                ez1 = point["ez1_w"] or 0.0
                if solakon < 10 or ez1 < 10:
                    continue
                difference = solakon - ez1
                if difference <= -20:
                    east_was_ahead = True
                elif east_was_ahead and difference >= 20:
                    crossover = point["minute"]
                    break
            result.append({
                "date": day,
                "points": points,
                "solakon": {
                    "start": clock(active_solakon[0]["minute"] if active_solakon else None),
                    "peak": clock(peak_solakon["minute"] if peak_solakon else None),
                    "peak_w": peak_solakon["solakon_w"] if peak_solakon else None,
                    "end": clock(active_solakon[-1]["minute"] if active_solakon else None),
                },
                "ez1": {
                    "start": clock(active_ez1[0]["minute"] if active_ez1 else None),
                    "peak": clock(peak_ez1["minute"] if peak_ez1 else None),
                    "peak_w": peak_ez1["ez1_w"] if peak_ez1 else None,
                    "end": clock(active_ez1[-1]["minute"] if active_ez1 else None),
                },
                "crossover": clock(crossover),
            })
        return {
            "timezone": "Europe/Berlin",
            "bucket_minutes": bucket_size,
            "threshold_w": 10,
            "days": result,
        }

    def source_availability(self, source: str, days: int = 366) -> dict[str, Any]:
        local_zone = ZoneInfo("Europe/Berlin")
        start = datetime.now(timezone.utc) - timedelta(days=max(1, days))
        with self.connect() as connection:
            events = connection.execute(
                """
                SELECT timestamp, online, detail_json FROM source_events
                WHERE source = ? AND timestamp >= ? ORDER BY timestamp ASC
                """,
                (source, start.isoformat(timespec="seconds")),
            ).fetchall()
        payload = []
        for event in events:
            timestamp = datetime.fromisoformat(event["timestamp"])
            detail = json.loads(event["detail_json"] or "{}")
            payload.append({
                "timestamp": timestamp.isoformat(),
                "local_timestamp": timestamp.astimezone(local_zone).isoformat(),
                "date": timestamp.astimezone(local_zone).date().isoformat(),
                "online": bool(event["online"]),
                "error": detail.get("error"),
            })
        return {"source": source, "timezone": "Europe/Berlin", "retention_days": days, "events": payload}
