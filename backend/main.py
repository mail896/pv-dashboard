from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import csv
from datetime import date, datetime, time, timedelta, timezone
import io
import logging
import os
from pathlib import Path
import tempfile
from typing import Any, AsyncIterator
from zoneinfo import ZoneInfo
import zipfile

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from .collectors import collect_snapshot
from .config import settings
from .storage import RANGES, Storage


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("pv-dashboard")
storage = Storage(settings.database_path)
latest_snapshot: dict[str, Any] | None = storage.latest()
project_root = Path(__file__).resolve().parents[1]


async def collector_loop() -> None:
    global latest_snapshot
    while True:
        started = asyncio.get_running_loop().time()
        try:
            snapshot = await asyncio.to_thread(collect_snapshot, settings)
            await asyncio.to_thread(storage.insert, snapshot)
            latest_snapshot = snapshot
        except Exception:
            logger.exception("collector cycle failed")
        elapsed = asyncio.get_running_loop().time() - started
        await asyncio.sleep(max(0.25, settings.poll_seconds - elapsed))


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(collector_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="PV Dashboard API",
    description="Read-only collector for Solakon ONE, Shelly Pro 3EM, Tasmota and APsystems EZ1.",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(project_root / "frontend" / "index.html")


@app.get("/assets/dashboard.css", include_in_schema=False)
def dashboard_css() -> FileResponse:
    return FileResponse(project_root / "app" / "globals.css", media_type="text/css")


@app.get("/assets/dashboard.js", include_in_schema=False)
def dashboard_js() -> FileResponse:
    return FileResponse(project_root / "frontend" / "dashboard.js", media_type="text/javascript")


@app.get("/assets/chart.umd.min.js", include_in_schema=False)
def chart_js() -> FileResponse:
    return FileResponse(project_root / "frontend" / "chart.umd.min.js", media_type="text/javascript")


@app.get("/assets/homer-home.png", include_in_schema=False)
def homer_home_image() -> FileResponse:
    return FileResponse(project_root / "frontend" / "homer-home.png", media_type="image/png")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "has_snapshot": latest_snapshot is not None,
        "poll_seconds": settings.poll_seconds,
    }


@app.get("/api/live")
def live() -> dict[str, Any]:
    if latest_snapshot is None:
        raise HTTPException(status_code=503, detail="Noch kein Messwert verfügbar")
    payload = dict(latest_snapshot)
    payload["grid"] = dict(latest_snapshot.get("grid", {}))
    payload["grid"]["average_60s"] = storage.recent_grid_average(60)
    return payload


@app.get("/api/storage")
def storage_stats() -> dict[str, Any]:
    return storage.stats()


@app.get("/api/history")
def history(range: str = Query(default="24h")) -> dict[str, Any]:
    if range not in RANGES:
        raise HTTPException(status_code=400, detail=f"Ungültiger Zeitraum: {range}")
    return storage.history(range)


@app.get("/api/energy-series")
def energy_series(period: str = Query(default="month"), anchor: str | None = Query(default=None)) -> dict[str, Any]:
    try:
        return storage.energy_series(period, anchor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/energy-series.csv")
def energy_series_csv(period: str = Query(default="month"), anchor: str | None = Query(default=None)) -> Response:
    try:
        payload = storage.energy_series(period, anchor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    columns = ("bucket", "pv_total_kwh", "pv_solakon_kwh", "pv_ez1_kwh", "consumption_kwh", "import_kwh", "export_kwh", "battery_charge_kwh", "battery_discharge_kwh", "autarky_percent", "self_consumption_percent", "covered_seconds")
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(payload["points"])
    filename = f"schulzihausen-energie-{period}-{payload['anchor']}.csv"
    return Response(stream.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/raw-data.csv.zip")
def raw_data_csv_zip(
    start: str = Query(...),
    end: str = Query(...),
    resolution: str = Query(default="5s"),
) -> FileResponse:
    """Export protected telemetry as a compressed, machine-readable CSV."""
    try:
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Start und Ende müssen ISO-Daten sein.") from error
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="Das Enddatum liegt vor dem Startdatum.")
    local_zone = ZoneInfo("Europe/Berlin")
    with storage.connect() as connection:
        bounds = connection.execute("SELECT MIN(timestamp), MAX(timestamp) FROM measurements").fetchone()
    if not bounds or not bounds[0] or not bounds[1]:
        raise HTTPException(status_code=404, detail="Es sind noch keine Messdaten vorhanden.")
    available_start_at = datetime.fromisoformat(bounds[0]).astimezone(timezone.utc)
    available_end_at = datetime.fromisoformat(bounds[1]).astimezone(timezone.utc)
    available_start = available_start_at.astimezone(local_zone).date()
    available_end = available_end_at.astimezone(local_zone).date()
    if end_date < available_start or start_date > available_end:
        raise HTTPException(status_code=404, detail=f"Keine Messdaten im gewählten Zeitraum; verfügbar ab {available_start}.")
    start_date = max(start_date, available_start)
    end_date = min(end_date, available_end)

    limits = {"5s": 7, "1m": 31, "15m": 366}
    if resolution not in limits:
        raise HTTPException(status_code=400, detail="Ungültige Auflösung.")
    requested_start_at = datetime.combine(start_date, time.min, tzinfo=local_zone).astimezone(timezone.utc)
    requested_end_at = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=local_zone).astimezone(timezone.utc)
    actual_start_at = max(requested_start_at, available_start_at)
    actual_end_at = min(requested_end_at, available_end_at)
    actual_seconds = max(0.0, (actual_end_at - actual_start_at).total_seconds())
    if actual_seconds > limits[resolution] * 86400:
        raise HTTPException(status_code=400, detail=f"Bei {resolution} sind maximal {limits[resolution]} Tage erlaubt.")

    start_utc = datetime.combine(start_date, time.min, tzinfo=local_zone).astimezone(timezone.utc)
    end_utc = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=local_zone).astimezone(timezone.utc)
    core_columns = (
        "pv_total_w", "pv_solakon_w", "pv_ez1_w", "house_w", "grid_w",
        "battery_w", "soc_percent", "autarky_percent",
        "battery_temperature_c", "internal_temperature_c",
    )
    temporary = tempfile.NamedTemporaryFile(prefix="pv-raw-export-", suffix=".zip", delete=False)
    archive_path = Path(temporary.name)
    temporary.close()
    csv_name = f"schulzihausen-rohdaten-{start_date}-{end_date}-{resolution}.csv"
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            with archive.open(csv_name, "w") as binary:
                text_stream = io.TextIOWrapper(binary, encoding="utf-8-sig", newline="", write_through=True)
                writer = csv.writer(text_stream)
                with storage.connect() as connection:
                    if resolution == "5s":
                        columns = ("measurement_id", "timestamp", *core_columns, "quality", "snapshot_json")
                        writer.writerow(columns)
                        rows = connection.execute(
                            f"SELECT id, timestamp, {', '.join(core_columns)}, quality, snapshot_json FROM measurements WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp",
                            (start_utc.isoformat(timespec="seconds"), end_utc.isoformat(timespec="seconds")),
                        )
                        for row in rows:
                            writer.writerow(row)
                    else:
                        seconds = 60 if resolution == "1m" else 900
                        columns = ("timestamp", *core_columns, "sample_count")
                        writer.writerow(columns)
                        averages = ", ".join(f"AVG({column})" for column in core_columns)
                        rows = connection.execute(
                            f"SELECT CAST(strftime('%s', timestamp) / ? AS INTEGER) * ? AS bucket, {averages}, COUNT(*) FROM measurements WHERE timestamp >= ? AND timestamp < ? GROUP BY bucket ORDER BY bucket",
                            (seconds, seconds, start_utc.isoformat(timespec="seconds"), end_utc.isoformat(timespec="seconds")),
                        )
                        for row in rows:
                            writer.writerow((datetime.fromtimestamp(row[0], timezone.utc).isoformat(), *row[1:]))
                text_stream.flush()
                text_stream.detach()
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename=f"schulzihausen-rohdaten-{start_date}-{end_date}-{resolution}.zip",
        background=BackgroundTask(os.unlink, archive_path),
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/api/highscores")
def highscores() -> dict[str, Any]:
    return storage.highscores()


@app.get("/api/statistics")
def statistics(
    days: int = Query(default=7, ge=1, le=31),
    anchor: str | None = Query(default=None),
) -> dict[str, Any]:
    try:
        return storage.daily_statistics(days, anchor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/economics")
def economics() -> dict[str, Any]:
    return storage.economics_totals()


@app.get("/api/battery-statistics")
def battery_statistics(days: int = Query(default=31, ge=1, le=3660)) -> dict[str, Any]:
    return storage.battery_statistics(days)


@app.get("/api/solar-profiles")
def solar_profiles(
    days: int = Query(default=7, ge=1, le=31),
    anchor: str | None = Query(default=None),
) -> dict[str, Any]:
    try:
        return storage.solar_profiles(days, anchor=anchor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/solar-year")
def solar_year(year: int = Query(default=datetime.now().year, ge=2000, le=2100)) -> dict[str, Any]:
    return storage.solar_year(year)


@app.get("/api/availability/ez1")
def ez1_availability(days: int = Query(default=366, ge=1, le=3660)) -> dict[str, Any]:
    return storage.source_availability("ez1", days)


@app.get("/api/events/solakon")
def solakon_events(limit: int = Query(default=20, ge=1, le=100)) -> dict[str, Any]:
    return storage.solakon_events(limit)


@app.get("/api/events/devices")
def device_events(limit: int = Query(default=30, ge=1, le=100)) -> dict[str, Any]:
    return storage.device_events(limit)
