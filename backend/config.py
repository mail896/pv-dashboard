from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


def _float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value else default


@dataclass(frozen=True)
class Settings:
    solakon_host: str = os.getenv("SOLAKON_HOST", "192.0.2.10")
    solakon_port: int = int(os.getenv("SOLAKON_PORT", "502"))
    solakon_unit_id: int = int(os.getenv("SOLAKON_UNIT_ID", "1"))
    shelly_host: str = os.getenv("SHELLY_HOST", "192.0.2.20")
    tasmota_host: str = os.getenv("TASMOTA_HOST", "192.0.2.30")
    ez1_host: str = os.getenv("EZ1_HOST", "192.0.2.40")
    ez1_port: int = int(os.getenv("EZ1_PORT", "8050"))
    poll_seconds: float = _float_env("POLL_SECONDS", 5.0)
    request_timeout: float = _float_env("REQUEST_TIMEOUT", 3.0)
    database_path: Path = Path(
        os.getenv("DATABASE_PATH", str(Path(__file__).resolve().parents[1] / "data" / "energy.sqlite3"))
    )


settings = Settings()
