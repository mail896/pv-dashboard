# API und Exporte

| Pfad | Inhalt |
|---|---|
| `/health` | Dienststatus und Messintervall |
| `/api/live` | letzter normalisierter Snapshot |
| `/api/history?range=24h` | verdichteter Leistungsverlauf |
| `/api/energy-series` | kalendarische Energieblöcke |
| `/api/energy-series.csv` | kompakte Energie-CSV |
| `/api/raw-data.csv.zip` | ZIP-komprimierte Rohdaten-CSV |
| `/api/statistics` | Tagesstatistiken |
| `/api/highscores` | Tages- und Momentrekorde |
| `/api/battery-statistics` | Speicheranalyse |
| `/api/solar-profiles` | Ausrichtungs-/Sonnenprofil |

## Rohdatenexport

Parameter: `start`, `end` im ISO-Format und `resolution` mit `5s`, `1m` oder
`15m`.

- 5 Sekunden: maximal sieben tatsächlich vorhandene Tage, inklusive JSON-Snapshot
- 1 Minute: maximal 31 Tage, Mittelwerte plus Stichprobenzahl
- 15 Minuten: maximal 366 Tage, Mittelwerte plus Stichprobenzahl

Produktiv sollten beide Exportpfade über den Reverse Proxy geschützt werden.
Die Anwendung selbst nimmt keine Benutzerverwaltung vor.
