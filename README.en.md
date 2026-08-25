# PV Dashboard

[Deutsche Version](README.md) · [Project website](https://mail896.github.io/pv-dashboard/)

Local-first, responsive energy monitoring for Raspberry Pi 5. The project
collects read-only measurements from a Solakon ONE, APsystems EZ1, Shelly Pro
3EM and Tasmota smart-meter reader, stores them in SQLite/WAL and presents live
flows, history, statistics, records, battery analytics and exports.

## What is included

- FastAPI/Uvicorn backend and concurrent local collectors
- vanilla HTML, CSS and JavaScript frontend
- local Chart.js bundle without runtime CDN dependency
- five-second measurement storage and calendar-aware energy integration
- paginated daily statistics and weekly, monthly and annual solar analysis
- paginated battery analysis and URL-persisted 30-row device-event pages
- automatically invalidated SQLite cache for completed solar periods
- compressed machine-readable raw-data export
- systemd deployment example and ten backend/data tests

See the [German README](README.md) for screenshots, quick start and the full
documentation index.
