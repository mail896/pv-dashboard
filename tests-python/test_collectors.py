from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

import backend.collectors as collectors
from backend.collectors import collect_snapshot
from backend.config import Settings
from backend.storage import Storage


class CollectorTests(unittest.TestCase):
    def tearDown(self) -> None:
        collectors._ez1_cache.clear()

    def test_ez1_keeps_last_output_during_brief_timeout(self) -> None:
        output = {"data": {"p1": 120, "p2": 130, "e1": 1, "e2": 2, "te1": 10, "te2": 20}}
        with (
            patch("backend.collectors.time.monotonic", side_effect=[100.0, 115.0]),
            patch(
                "backend.collectors._get_json",
                side_effect=[output, TimeoutError("alarm"), TimeoutError("switch"), TimeoutError("output")],
            ),
        ):
            first = collectors.read_ez1(Settings())
            second = collectors.read_ez1(Settings())

        self.assertEqual(first["pv_w"], 250.0)
        self.assertTrue(second["online"])
        self.assertTrue(second["stale"])
        self.assertEqual(second["pv_w"], 250.0)
        self.assertEqual(second["sample_age_seconds"], 15.0)

    def test_normalizes_energy_balance_and_offline_ez1(self) -> None:
        solakon = {
            "name": "Solakon ONE",
            "online": True,
            "pv_w": 800.0,
            "ac_w": 700.0,
            "grid_w": -100.0,
            "house_reported_w": 500.0,
            "battery_w": 200.0,
            "soc_percent": 55.0,
            "battery_temperature_c": 28.0,
            "estimated_remaining_wh": 1160.0,
            "estimated_remaining": True,
        }
        shelly = {"name": "Shelly Pro 3EM", "online": True, "grid_w": -250.0}
        tasmota = {"name": "Tasmota", "online": True, "grid_w": -245.0}
        ez1 = {"name": "APsystems EZ1 Ost", "online": False, "error": "offline"}
        with (
            patch("backend.collectors.read_solakon", return_value=solakon),
            patch("backend.collectors.read_shelly", return_value=shelly),
            patch("backend.collectors.read_tasmota", return_value=tasmota),
            patch("backend.collectors.read_ez1", return_value=ez1),
        ):
            snapshot = collect_snapshot(Settings())

        self.assertEqual(snapshot["pv"]["total_w"], 800.0)
        self.assertIsNone(snapshot["pv"]["ez1_east_w"])
        self.assertEqual(snapshot["grid"]["power_w"], -250.0)
        self.assertEqual(snapshot["house"]["consumption_w"], 450.0)
        self.assertEqual(snapshot["house"]["calculation"], "solakon_ac + ez1_ac + grid")
        self.assertEqual(snapshot["autarky_percent"], 100.0)
        self.assertEqual(snapshot["quality"], "partial")

    def test_storage_round_trip_and_history(self) -> None:
        snapshot = {
            "timestamp": "2026-08-09T20:00:00+00:00",
            "pv": {"total_w": 100.0, "solakon_one_w": 80.0, "ez1_east_w": 20.0},
            "house": {"consumption_w": 120.0},
            "grid": {"power_w": 20.0},
            "battery": {"power_w": 0.0, "soc_percent": 50.0, "temperature_c": 31.5},
            "sources": {"solakon": {"internal_temperature_c": 34.2}, "ez1": {"online": True}},
            "autarky_percent": 83.3,
            "quality": "complete",
        }
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot)
            self.assertEqual(storage.latest(), snapshot)
            history = storage.history("30d")
            self.assertEqual(len(history["points"]), 1)
            self.assertEqual(history["points"][0]["pv_total_w"], 100.0)
            self.assertEqual(history["points"][0]["battery_temperature_c"], 31.5)
            self.assertEqual(history["points"][0]["internal_temperature_c"], 34.2)

    def test_recent_grid_average_is_signed_and_limited_to_one_minute(self) -> None:
        now = datetime.now(timezone.utc).replace(microsecond=0)

        def snapshot(at: datetime, grid_w: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": 0.0, "solakon_one_w": 0.0, "ez1_east_w": 0.0},
                "house": {"consumption_w": max(grid_w, 0.0)},
                "grid": {"power_w": grid_w},
                "battery": {"power_w": 0.0, "soc_percent": 50.0},
                "autarky_percent": 0.0,
                "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(now - timedelta(seconds=70), 1000.0))
            storage.insert(snapshot(now - timedelta(seconds=55), -10.0))
            storage.insert(snapshot(now, 10.0))
            average = storage.recent_grid_average(60)

        self.assertEqual(average["samples"], 2)
        self.assertEqual(average["window_seconds"], 60)
        self.assertAlmostEqual(average["power_w"], 0.0)

    def test_battery_statistics_detects_operational_limits(self) -> None:
        now = datetime.now(timezone.utc).replace(microsecond=0)

        def snapshot(at: datetime, soc: float, battery_w: float, grid_w: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": 0.0, "solakon_one_w": 0.0, "ez1_east_w": 0.0},
                "house": {"consumption_w": max(grid_w + battery_w, 0.0)},
                "grid": {"power_w": grid_w},
                "battery": {"power_w": battery_w, "soc_percent": soc},
                "autarky_percent": 0.0,
                "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(now - timedelta(seconds=15), 50.0, 0.0, 0.0))
            storage.insert(snapshot(now - timedelta(seconds=10), 10.0, 500.0, 1000.0))
            storage.insert(snapshot(now - timedelta(seconds=5), 10.0, 500.0, 1000.0))
            storage.insert(snapshot(now, 99.0, -500.0, -1000.0))
            stats = storage.battery_statistics(1)

        self.assertEqual(stats["thresholds"], {"full_percent": 99, "empty_percent": 10})
        self.assertEqual(stats["summary"]["observed_days"], 1)
        self.assertEqual(stats["summary"]["full_days"], 1)
        self.assertEqual(stats["summary"]["empty_days"], 1)
        self.assertIsNotNone(stats["days"][0]["full_at"])
        self.assertIsNotNone(stats["days"][0]["empty_at"])
        self.assertGreater(stats["days"][0]["import_while_empty_kwh"], 0)

    def test_economics_totals_integrates_measured_flows_and_skips_gaps(self) -> None:
        start = datetime.now(timezone.utc).replace(microsecond=0)

        def snapshot(at: datetime, house_w: float, grid_w: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": 0.0, "solakon_one_w": 0.0, "ez1_east_w": 0.0},
                "house": {"consumption_w": house_w},
                "grid": {"power_w": grid_w},
                "battery": {"power_w": 0.0, "soc_percent": 50.0},
                "autarky_percent": 0.0,
                "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(start, 1000.0, 400.0))
            storage.insert(snapshot(start + timedelta(seconds=10), 1000.0, 400.0))
            storage.insert(snapshot(start + timedelta(seconds=50), 9000.0, 9000.0))
            totals = storage.economics_totals()

        self.assertAlmostEqual(totals["consumption_kwh"], 10 / 3600, places=3)
        self.assertAlmostEqual(totals["import_kwh"], 4 / 3600, places=3)
        self.assertAlmostEqual(totals["avoided_import_kwh"], 6 / 3600, places=3)
        self.assertAlmostEqual(totals["coverage_hours"], 10 / 3600, places=2)
        self.assertEqual(totals["meter_at_recording_start"], {"import_kwh": None, "export_kwh": None})

    def test_compaction_preserves_numeric_samples_and_meter_origin(self) -> None:
        old = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
        recent = datetime(2026, 4, 9, 12, 0, tzinfo=timezone.utc)

        def snapshot(at: datetime, meter_kwh: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": 500.0, "solakon_one_w": 400.0, "ez1_east_w": 100.0},
                "house": {"consumption_w": 600.0}, "grid": {"power_w": 100.0},
                "battery": {"power_w": 0.0, "soc_percent": 50.0},
                "sources": {"tasmota": {"import_energy_kwh": meter_kwh, "export_energy_kwh": 12.0}},
                "autarky_percent": 83.3, "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(old, 1000.0))
            storage.insert(snapshot(old + timedelta(seconds=5), 1000.1))
            storage.insert(snapshot(recent, 1100.0))
            result = storage.compact_redundant_json(90, now=datetime(2026, 4, 10, tzinfo=timezone.utc))
            repeated = storage.compact_redundant_json(90, now=datetime(2026, 4, 10, tzinfo=timezone.utc))
            with storage.connect() as connection:
                rows = connection.execute(
                    """
                    SELECT timestamp, pv_total_w, pv_solakon_w, pv_ez1_w,
                           house_w, grid_w, battery_w, soc_percent,
                           autarky_percent, quality, snapshot_json
                    FROM measurements ORDER BY id
                    """
                ).fetchall()
            totals = storage.economics_totals()

        self.assertEqual(result["compacted_rows"], 2)
        self.assertEqual(repeated["compacted_rows"], 0)
        self.assertGreater(result["released_payload_bytes"], 0)
        self.assertEqual(rows[0]["snapshot_json"], "{}")
        self.assertEqual(rows[0]["pv_total_w"], 500.0)
        self.assertEqual(rows[0]["pv_solakon_w"], 400.0)
        self.assertEqual(rows[0]["pv_ez1_w"], 100.0)
        self.assertEqual(rows[0]["house_w"], 600.0)
        self.assertEqual(rows[0]["grid_w"], 100.0)
        self.assertEqual(rows[0]["battery_w"], 0.0)
        self.assertEqual(rows[0]["soc_percent"], 50.0)
        self.assertEqual(rows[0]["autarky_percent"], 83.3)
        self.assertEqual(rows[0]["quality"], "complete")
        self.assertNotEqual(rows[2]["snapshot_json"], "{}")
        self.assertEqual(totals["meter_at_recording_start"], {"import_kwh": 1000.0, "export_kwh": 12.0})

    def test_solar_profiles_detects_orientation_crossover(self) -> None:
        now = datetime.now(timezone.utc).replace(microsecond=0)

        def snapshot(at: datetime, solakon: float, east: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": solakon + east, "solakon_one_w": solakon, "ez1_east_w": east},
                "house": {"consumption_w": solakon + east},
                "grid": {"power_w": 0.0},
                "battery": {"power_w": 0.0, "soc_percent": 50.0},
                "autarky_percent": 100.0,
                "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(now - timedelta(minutes=20), 50.0, 250.0))
            storage.insert(snapshot(now - timedelta(minutes=10), 300.0, 100.0))
            profiles = storage.solar_profiles(1)

        today = profiles["days"][0]
        self.assertEqual(profiles["bucket_minutes"], 10)
        self.assertIsNotNone(today["ez1"]["start"])
        self.assertIsNotNone(today["solakon"]["start"])
        self.assertIsNotNone(today["crossover"])

    def test_closed_solar_profile_cache_is_reused_and_invalidated(self) -> None:
        now = datetime.now(timezone.utc)
        previous_month_end = now.replace(day=1) - timedelta(days=1)

        def snapshot(at: datetime, watts: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": watts * 2, "solakon_one_w": watts, "ez1_east_w": watts},
                "house": {"consumption_w": watts * 2}, "grid": {"power_w": 0.0},
                "battery": {"power_w": 0.0, "soc_percent": 50.0},
                "autarky_percent": 100.0, "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            storage.insert(snapshot(previous_month_end.replace(hour=12), 200.0))
            first = storage.solar_profiles(1, anchor=previous_month_end.date().isoformat())
            second = storage.solar_profiles(1, anchor=previous_month_end.date().isoformat())
            storage.insert(snapshot(previous_month_end.replace(hour=13), 300.0))
            third = storage.solar_profiles(1, anchor=previous_month_end.date().isoformat())

        self.assertEqual(first["cache"], "created")
        self.assertEqual(second["cache"], "hit")
        self.assertEqual(third["cache"], "created")

    def test_energy_series_uses_calendar_buckets_and_skips_long_gaps(self) -> None:
        def snapshot(at: datetime, pv_w: float, house_w: float, grid_w: float, battery_w: float) -> dict:
            return {
                "timestamp": at.isoformat(),
                "pv": {"total_w": pv_w, "solakon_one_w": pv_w * 0.75, "ez1_east_w": pv_w * 0.25},
                "house": {"consumption_w": house_w},
                "grid": {"power_w": grid_w},
                "battery": {"power_w": battery_w, "soc_percent": 50.0},
                "autarky_percent": 0.0,
                "quality": "complete",
            }

        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            start = datetime(2026, 8, 14, 10, 0, tzinfo=timezone.utc)
            storage.insert(snapshot(start, 1000.0, 800.0, 200.0, -100.0))
            storage.insert(snapshot(start + timedelta(seconds=10), 1000.0, 800.0, 200.0, -100.0))
            storage.insert(snapshot(start + timedelta(seconds=50), 9000.0, 9000.0, 9000.0, 9000.0))
            series = storage.energy_series("day", "2026-08-14")

        self.assertEqual(series["start"], "2026-08-14")
        self.assertEqual(series["end"], "2026-08-15")
        self.assertEqual(len(series["points"]), 1)
        point = series["points"][0]
        self.assertEqual(point["bucket"], "2026-08-14T12:00")
        self.assertAlmostEqual(point["covered_seconds"], 10.0)
        self.assertAlmostEqual(point["pv_total_kwh"], 10 / 3600, places=4)
        self.assertAlmostEqual(point["import_kwh"], 2 / 3600, places=4)
        self.assertAlmostEqual(point["battery_charge_kwh"], 1 / 3600, places=4)

    def test_highscores_separate_complete_daily_energy_from_instantaneous_power(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(Path(directory) / "energy.sqlite3")
            first = datetime(2026, 8, 13, 10, 0, tzinfo=timezone.utc)
            second = first + timedelta(minutes=1)

            def snapshot(at: datetime, pv_w: float, grid_w: float) -> dict:
                return {
                    "timestamp": at.isoformat(),
                    "pv": {"total_w": pv_w, "solakon_one_w": pv_w, "ez1_east_w": 0.0},
                    "house": {"consumption_w": pv_w + grid_w},
                    "grid": {"power_w": grid_w},
                    "battery": {"power_w": 0.0, "soc_percent": 50.0},
                    "autarky_percent": 0.0,
                    "quality": "complete",
                }

            storage.insert(snapshot(first, 900.0, 100.0))
            storage.insert(snapshot(second, 1500.0, -400.0))
            complete_days = {"days": [
                {"date": "2026-08-13", "coverage_hours": 23.0, "pv_kwh": 4.0, "consumption_kwh": 5.0, "import_kwh": 2.0, "export_kwh": 1.0, "battery_charge_kwh": 0.5, "battery_discharge_kwh": 0.4},
                {"date": "2026-08-14", "coverage_hours": 12.0, "pv_kwh": 99.0, "consumption_kwh": 99.0, "import_kwh": 99.0, "export_kwh": 99.0, "battery_charge_kwh": 99.0, "battery_discharge_kwh": 99.0},
            ]}
            with patch.object(storage, "daily_statistics", return_value=complete_days):
                records = storage.highscores()

        self.assertEqual(records["complete_days"], 1)
        self.assertEqual(records["daily"][0]["maximum"], {"date": "2026-08-13", "value_kwh": 4.0})
        pv_record = next(item for item in records["instantaneous"] if item and item["label"] == "PV-Leistung")
        export_record = next(item for item in records["instantaneous"] if item and item["label"] == "Einspeisung")
        self.assertEqual(pv_record["value_w"], 1500.0)
        self.assertEqual(export_record["value_w"], 400.0)


if __name__ == "__main__":
    unittest.main()
