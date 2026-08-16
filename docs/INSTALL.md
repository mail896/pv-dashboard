# Installation und Betrieb

## Voraussetzungen

- Raspberry Pi 5 oder anderer ARM64/x86-64 Linux-Rechner
- Python 3.11 oder neuer
- lokale Erreichbarkeit der eingebundenen Energiegeräte
- optional Nginx oder Caddy für HTTPS

## Benutzer und Verzeichnis

Für den Dauerbetrieb empfiehlt sich ein eigener Systembenutzer ohne Login-Shell.
Der Prozess benötigt nur Lesezugriff auf Programmdateien und Schreibzugriff auf
das Datenverzeichnis.

```bash
sudo install -d -o root -g root /opt/pv-dashboard
sudo install -d -o pv-dashboard -g pv-dashboard -m 0750 /opt/pv-dashboard/data
python3 -m venv /opt/pv-dashboard/.venv
/opt/pv-dashboard/.venv/bin/pip install -r requirements.txt
```

Kopiere `.env.example` nach `/etc/pv-dashboard.env`, ersetze die reservierten
Beispieladressen und setze Dateirechte auf `0640` oder strenger.

## systemd

`deploy/pv-dashboard.service` startet Uvicorn ausschließlich auf
`127.0.0.1:8000`. Passe Pfade und Benutzer bei Bedarf an.

```bash
sudo install -m 0644 deploy/pv-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pv-dashboard.service
curl http://127.0.0.1:8000/health
```

## Reverse Proxy

Veröffentliche nur den Loopback-Dienst über einen HTTPS-Reverse-Proxy. Wenn CSV
oder Rohdaten öffentlich erreichbar sind, müssen beide Exportpfade zusätzlich
authentifiziert und begrenzt werden. Die konkrete PAM-/TOTP-Konfiguration bleibt
bewusst deployment-spezifisch.

## Betrieb

- SQLite-Datei, `-wal` und `-shm` gemeinsam sichern.
- `/health` und Aktualität des letzten Messpunkts überwachen.
- Messlücken nicht durch künstliche Werte auffüllen.
- Gerätezugriffe read-only halten.
