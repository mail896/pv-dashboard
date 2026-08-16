# Datenmodell und Vorzeichen

## Tabelle `measurements`

Jede Zeile enthält Zeitstempel, Gesamt-/Teil-PV, Hauslast, Netzfluss,
Batterieleistung, Ladezustand, Autarkie, Messqualität, Temperaturen und den
vollständigen normalisierten JSON-Snapshot.

## Vorzeichen

- Netz positiv: Bezug
- Netz negativ: Einspeisung
- Batterie positiv: Entladung
- Batterie negativ: Ladung

Getrennt benannte Energiegrößen wie `import_kwh`, `export_kwh`,
`battery_charge_kwh` und `battery_discharge_kwh` werden als positive Beträge
ausgegeben.

## Qualität

Die Energieintegration verwendet reale Zeitabstände. Lücken über 30 Sekunden
werden ausgelassen und über `covered_seconds` beziehungsweise Messabdeckung
transparent gemacht. Tagesrekorde berücksichtigen nur ausreichend vollständige
Tage.
