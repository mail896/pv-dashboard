# Datenmodell und Vorzeichen

## Tabelle `measurements`

Jede Zeile enthält dauerhaft Zeitstempel, Gesamt-/Teil-PV, Hauslast, Netzfluss,
Batterieleistung, Ladezustand, Autarkie, Messqualität und Temperaturen. Zusätzlich
wird zunächst der vollständige normalisierte JSON-Snapshot gespeichert.

Die numerischen 5-Sekunden-Spalten bleiben unbegrenzt erhalten. Ein täglicher,
ressourcenbegrenzter Wartungslauf ersetzt lediglich das redundante JSON von Zeilen,
die älter als 90 Tage sind, durch `{}`. Sämtliche Diagramme, Energieintegrationen,
Rekorde und Langzeitauswertungen verwenden die numerischen Spalten und bleiben
daher unverändert. Der Zählerstand zu Aufzeichnungsbeginn wird vor der ersten
Kompaktierung separat in `storage_metadata` bewahrt.

SQLite gibt dabei Seiten zur Wiederverwendung innerhalb der Datenbank frei; ein
blockierendes automatisches `VACUUM` ist bewusst nicht vorgesehen. Die Datei muss
nach der ersten Kompaktierung daher nicht sofort kleiner werden, wächst danach aber
wesentlich langsamer.

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
