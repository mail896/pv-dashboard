# Architektur

## Komponenten

| Ebene | Technik | Aufgabe |
|---|---|---|
| Geräte | Modbus TCP, lokale HTTP/RPC-APIs | Messwerte lesen |
| Backend | Python, FastAPI, Uvicorn | parallele Sammlung, Normalisierung, API |
| Speicherung | SQLite im WAL-Modus | Rohmessungen und Statusereignisse |
| Frontend | HTML, CSS, Vanilla JavaScript | responsive Darstellung und Interaktion |
| Diagramme | Chart.js 4.5.1 lokal | Linien-, Balken- und Batteriediagramme |
| Betrieb | systemd, optional Nginx | Prozessüberwachung und HTTPS |

## Messzyklus

Alle Quellen werden parallel gelesen, damit ein langsames Gerät nicht die
anderen blockiert. Der Standardzyklus beträgt fünf Sekunden. Der EZ1-Ausgang
wird höchstens alle zehn Sekunden abgefragt; Status und Alarme nur alle fünf
Minuten. Ein gültiger Wert darf kurze HTTP-Aussetzer bis 45 Sekunden überbrücken.

## Energiebilanz

Die Hauslast wird AC-seitig berechnet:

```text
Hauslast = Solakon-AC + EZ1-AC + Netzfluss
```

DC-PV und Batterie-DC werden nicht zusätzlich addiert, weil ihr Nettoeffekt
bereits in der AC-Abgabe des Hybridwechselrichters enthalten ist.

## Fehlerverhalten

Jede Quelle besitzt einen Online-/Fehlerstatus. Ausfälle werden sichtbar, ohne
andere Quellen zu verwerfen. Energieintegration überspringt Abstände über 30
Sekunden, statt fehlende Energie zu erfinden.
