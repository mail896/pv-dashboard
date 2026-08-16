# Sicherheit und Veröffentlichungsgrenzen

## Grundsätze

- Gerätezugriffe sind ausschließlich lesend.
- Der App-Prozess läuft als eigener Benutzer und bindet nur an Loopback.
- Programmdateien sind nicht durch den App-Benutzer beschreibbar.
- Nur das SQLite-Datenverzeichnis benötigt Schreibrechte.
- Chart.js liegt lokal; zur Laufzeit ist kein CDN notwendig.

## Nicht enthalten

Dieses Repository enthält keine Produktionsdatenbank, privaten IP-Adressen,
MAC-/Gerätekennungen, Kennwörter, API-Schlüssel, TOTP-Secrets, Backupziele,
Mailkonfiguration oder lokale Projekt-State-Dateien.

## Exporte

CSV-Dateien enthalten detaillierte Haushalts- und Energietelemetrie. Ein
öffentlicher Reverse Proxy muss die Exportpfade authentifizieren, Rate-Limits
setzen und sichere Cookies/HTTPS verwenden. Die Produktionsintegration nutzt
eine separate PAM-/TOTP-Schicht, die wegen ihrer Host- und Kontobindung nicht
als universelle Beispielkonfiguration veröffentlicht wird.

Sicherheitsprobleme bitte nicht mit Produktionsdetails in öffentlichen Issues
melden, sondern zunächst über GitHubs private Security-Advisory-Funktion.
