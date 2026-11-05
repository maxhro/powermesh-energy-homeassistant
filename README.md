# Powermesh Energie – Home Assistant Integration (Prototyp)

Lokale Energieübersicht für Home Assistant, optional mit
[powermesh.de](https://powermesh.de) verbunden.

> **Status: Prototyp.** Die Integration und powermesh.de befinden sich in Entwicklung.
> Sie ist nicht offiziell Teil von Home Assistant oder HACS.

## Wozu?

Ein Vergleich von Smarthomes und die Ableitung von Verbesserungspotenzial befinden
sich in Entwicklung und sind nicht implementiert. Die lokale Dashboard-Karte
zeigt Solarleistung, Netzbezug, Einspeisung und Akkustand aus ausdrücklich
gewählten HA-Sensoren. Dafür sind weder Konto noch Datenübertragung nötig.
Die optionale Cloud-Verbindung speichert ausschließlich freigegebene Sensorwerte;
das lokale Widget liest keine Messwerte von powermesh.de.

## Deine Daten

Bei **Lokal ohne Konto nutzen** werden keine Daten an powermesh.de übertragen,
kein API-Schlüssel erstellt und kein Offline-Puffer angelegt. Die Integration
speichert nur die ausgewählten Sensorreferenzen in HA. Die Karte liest aktuelle
HA-Zustände und erzeugt keine eigene Messwertablage. Die vorhandene
HA-Recorder-Aufbewahrung und Zugriffsrechte bleiben unverändert.

Die folgenden Angaben betreffen ausschließlich die optionale Cloud-Verbindung.

Übertragen werden Sensor-Kennung, Zeitpunkt, Zahlenwert und Einheit. Zusätzlich
können Home-Assistant-Metadaten wie Anzeigename, Geräte- und Zustandsklasse, Bereich,
Etage, Labels und Gerätekennung gespeichert werden. Diese Angaben können Rückschlüsse
auf deinen Haushalt ermöglichen.

Die Messwerte und Metadaten werden pseudonym deinem Benutzerkonto zugeordnet und bis
zum Ende der Aufbewahrungsfrist gespeichert. Sie werden nicht verkauft oder an Dritte
weitergegeben. Du kannst deine Einwilligung jederzeit widerrufen; dann werden alle
API-Schlüssel gesperrt und alle gespeicherten Messwerte einschließlich Metadaten
gelöscht.

Neue Website-Verbindungen speichern in der Cloud nur den aktuellen Stand je
ausgewähltem Sensor; daraus entsteht keine Verlaufshistorie und keine
Tages-/Monatsbilanz. Deine Home-Assistant-Recorder-Daten und bestehende
Rohwert-Verläufe älterer Einträge bleiben unverändert.

Bei der neuen Website-Einrichtung erstellt Home Assistant ein zufälliges,
lokal gespeichertes Verknüpfungsgeheimnis und zeigt einen kurzlebigen Code.
E-Mail-Adresse, Passwort, E-Mail-Bestätigung und Authenticator werden nur auf
powermesh.de eingerichtet. Der API-Schlüssel kommt erst nach bestätigter
E-Mail-Adresse, MFA und Speicherzustimmung zurück nach Home Assistant. Das
Verknüpfungsgeheimnis wird nach erfolgreicher Schlüsselübernahme entfernt.

## Installation über HACS

[![In HACS öffnen](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=maxhro&repository=powermesh-energy-homeassistant&category=integration)

Der Button öffnet das Repository direkt in deinem HACS. Alternativ von Hand:

1. HACS öffnen → Menü (⋮) → **Benutzerdefinierte Repositories**
2. Repository `https://github.com/maxhro/powermesh-energy-homeassistant`,
   Typ **Integration** → Hinzufügen
3. „Powermesh Energie“ herunterladen und Home Assistant neu starten
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → Powermesh Energie**

Voraussetzung: Home Assistant 2026.10.4
(getesteter Stand) oder neuer. Für die lokale Übersicht genügen passende
Sensoren. Nur die optionale Cloud-Verbindung braucht einen persönlichen
API-Schlüssel oder einen neuen HA-Website-Code. Ältere Betreiber-Einladungen
bleiben als separater Kompatibilitätsweg verfügbar.
Das Integrations-Icon zeigt Home Assistant ab Version 2026.3 an.

## Einrichtung

Beim Hinzufügen der Integration wählst du den lokalen Einstieg oder einen der
optionalen Cloud-Wege. Andere
Home-Assistant-Integrationen und lokale Broker-Einstellungen werden davon nicht
geändert. Für beide Wege gelten die
[Nutzungsbedingungen von powermesh.de](https://powermesh.de/?r=terms).

### Lokal ohne Konto nutzen

1. **Lokal ohne Konto nutzen** wählen.
2. Mindestens eine Quelle auswählen: Solarleistung, Netzbezug oder Einspeisung
   in W/kW, optional Akkustand in Prozent. Die Auswahl ist nach Einheiten
   gefiltert. Netzbezug und Einspeisung brauchen getrennte einseitige Quellen;
   ein vorzeichenbehafteter gemeinsamer Netzsensor wird nicht automatisch geteilt.
3. Speichern. Quellen lassen sich unter **Konfigurieren** ändern oder entfernen.

Es gibt in diesem Weg keine Glättungs-, Intervall- oder Kontoeinrichtung.
Ein bestehender Cloud-Eintrag bleibt eigenständig; lokales Einrichten oder
Entfernen verändert seine Berechtigungen, Messwerte und Puffer nicht.

### Dashboard-Widget

Die mitgelieferte Karte wird nach Einrichtung der Integration lokal in HA
bereitgestellt. Einmalig unter **Einstellungen → Dashboards → Ressourcen**
(bei Bedarf erweiterten Modus aktivieren) diese Ressource hinzufügen:

- URL: `/powermesh-energy/powermesh-energy-card.js`
- Typ: **JavaScript-Modul**

Das Dashboard neu laden, **Bearbeiten → Karte hinzufügen → Powermesh Energie**
wählen. Der grafische Editor kann die lokale **Energieübersicht** übernehmen
oder einzelne Quellen wählen. Die Karte funktioniert auch neben einer
bestehenden Cloud-Einrichtung mit direkt ausgewählten HA-Sensoren.

Alternativ als manuelle Karte:

```yaml
type: custom:powermesh-energy-card
entity: sensor.powermesh_energie_energieubersicht
```

Den tatsächlichen Namen der lokalen Energieübersicht aus HA verwenden.
Die Karte zeigt fehlende Quellen, ungeeignete Einheiten, negative einseitige
Leistung und ungültigen Akkustand ausdrücklich an. Nach standardmäßig 15 Minuten
ohne gemeldete Aktualisierung wird der letzte bekannte Wert als **Veraltet**
markiert; der Grenzwert lässt sich im Karteneditor ändern. Das Datenalter ist
keine Messgeräte-Verfügbarkeitsgarantie. Anklicken öffnet die HA-Sensoransicht.
Keine automatische Verbrauchsbilanz, Tagesaggregation, Sparprognose oder Steuerung.
Native Handy-Widgets sind nicht Teil dieser Dashboard-Karte.

### Vorhandenen API-Schlüssel verwenden

1. Auf powermesh.de anmelden, die Informationen zur Speicherung prüfen, die
   Einwilligung erteilen und einen persönlichen API-Schlüssel erstellen.
2. In Home Assistant **Vorhandenen API-Schlüssel verwenden** wählen und den
   Schlüssel eintragen.
3. Sensoren und Glättung wie unten beschrieben auswählen.

### Neues Konto über Website verbinden

1. **Neues Konto über Website verbinden** wählen und die für die Übertragung
   vorgesehenen Sensoren sowie Glättung auswählen.
2. Home Assistant erzeugt einen einmaligen Code. Öffne den angezeigten Link
   innerhalb von 30 Minuten und gib den Code auf powermesh.de ein.
3. Lege dort E-Mail-Adresse und Passwort fest. Lies und bestätige Datenschutzhinweise
   und Nutzungsbedingungen sowie separat die Speicherung der ausgewählten
   Messwerte/Metadaten. Eine bestehende E-Mail-Adresse wird nicht neu verknüpft.
4. Bestätige den E-Mail-Link und richte auf der Website den Authenticator ein.
   Standardfrist: **7 Tage** ab Kontoanlage. Nach Fristablauf wird das
   unvollständige Konto gesperrt und beim nächsten Website-Bereinigungslauf
   samt zugehörigen Daten gelöscht.
5. Kehre zur wartenden Home-Assistant-Einrichtung zurück und bestätige den
   Abschluss. Erst nach serverseitiger Prüfung von E-Mail, MFA und Speicherzustimmung
   erhält HA den persönlichen API-Schlüssel. Bleibt die Antwort aus, kann die
   Schlüsselabholung sicher wiederholt werden; es wird kein zweiter Schlüssel erstellt.

Der Code ist eine einmalige Website-Berechtigung, kein dauerhafter API-Schlüssel.
HA speichert vorübergehend nur das zufällige Installationsgeheimnis in seiner
geschützten `.storage`-Ablage. Bestehende Konten werden nicht übernommen; dafür
weiterhin einen vorhandenen API-Schlüssel verwenden.

### Betreiber-Einladung (Kompatibilitätsweg)

Dieser getrennte Rückfallweg ist für Installationen, deren Betreiber die
automatische HA-Code-Ausgabe deaktiviert hat oder einen älteren vom Betreiber
ausgestellten Code bereitstellt. Der bestehende Ablauf erfragt E-Mail, Passwort
und Einladungscode in HA und legt danach ein vorläufiges Konto an. Nutze ihn nur,
wenn powermesh.de bzw. der Betreiber diesen Weg ausdrücklich vorgibt.

### Sensoren und Glättung

1. Die Integration schlägt anhand deines **Energie-Dashboards** Sensoren vor. Das ist
   nur eine Orientierung: Du kannst jeden numerischen Sensor auswählen, auch
   Temperatur-Sensoren. Die Auswahl lässt sich später über **Konfigurieren** ändern
   oder auf den Vorschlag zurücksetzen.
2. Im nächsten Schritt legst du je Sensor eine **Glättung** fest – ähnlich dem
   Filter-Helfer von Home Assistant: zeitgewichteter Mittelwert oder Drosselung
   über 10 Sekunden bis 1 Stunde, oder keine Glättung. Standard ist ein
   **1-Minuten-Mittelwert**; dadurch entstehen weniger übertragene Werte.

Die Integration sendet gesammelt in regelmäßigen Abständen und puffert bei
Verbindungsproblemen lokal. Werte werden erst nach einer ausdrücklichen
Speicherbestätigung aus dem Puffer entfernt. Bei einem Schlüsselwechsel werden
ausstehende Werte nicht stillschweigend neu zugeordnet. Der lokale Puffer ist auf die
für dein Benutzerkonto eingerichtete Messwertanzahl begrenzt (Standard: 5.000,
sofern der Betreiber keinen anderen Default konfiguriert hat). Das zuletzt vom
Dienst bestätigte Limit bleibt für denselben API-Schlüssel lokal gespeichert.
Ohne bekanntes Limit werden keine neuen Messwerte gepuffert. Bei vollem Puffer
bleiben vorhandene Werte erhalten; nur weitere neue Werte werden verworfen.
Der Verlust wird gezählt und als Fehler im Home-Assistant-Protokoll gemeldet.
Übertragungsstatus und Reparaturmeldung zeigen den Fehler an, bis nach einer
erfolgreichen Übertragung wieder Platz frei ist. Wird das Limit unter den
aktuellen Füllstand gesenkt, bleiben bereits gespeicherte Werte erhalten;
neue Werte werden bis zum Abbau des Rückstaus nicht aufgenommen.
Große Rückstände werden in mehrere größenbegrenzte Nachrichten aufgeteilt;
das Anfragelimit des Dienstes bleibt dabei wirksam.
Status, ausstehende Werte und letzte Übertragung
siehst du an den Diagnose-Sensoren. Ist ein Update der Integration nötig,
erscheint eine Reparaturmeldung in Home Assistant.

Für Updates über HACS öffne **HACS → Integrationen → Powermesh Energie**,
installiere die angebotene neue Version und starte Home Assistant danach neu.

## Versionen

Diese Integration ist ein Entwicklungsstand in Version **0.8.0** und benötigt
für die neue Website-Verknüpfung API release **0.4.0**. Die optionale
Cloud-Verbindung benötigt einen entsprechend aktualisierten Dienst. Sie wird
unabhängig von der Website und dem Dienst versioniert. Vergleiche und Auswertungen
sind nicht implementiert; die lokale Karte zeigt vorhandene HA-Zustände.
Halte die Integration über HACS aktuell.

## Lokale Tests

### Installationspaket (macOS und Windows)

Mit **PowerShell 7** lässt sich ohne Verbindung zu Home Assistant ein Paket bauen:

```powershell
pwsh -NoProfile -File ./build-package.ps1 -DryRun
pwsh -NoProfile -File ./build-package.ps1 -BuildPackage
```

Das Archiv `dist/powermesh-energy-homeassistant-0.8.0.zip` enthält
`custom_components/powermesh_energy` und die Lizenz, keine Testumgebung, Caches
oder Zugangsdaten. Vorhandene Archive werden nicht überschrieben.
Den enthaltenen Komponentenordner in das Konfigurationsverzeichnis von
Home Assistant entpacken und Home Assistant neu starten. Die Skripte installieren
nichts automatisch und veröffentlichen kein HACS-Release.

Die PowerShell-Paketprüfung läuft mit `node --test tests/package.test.mjs`
(Node wird nur für diese lokale Paketprüfung benötigt).

Mit einer separaten Python-Testumgebung: `pip install -r requirements_test.txt`,
danach `pytest -q` und `python -m compileall -q custom_components`.
Tests verwenden synthetische Daten und ersetzen den Netzwerktransport; sie kontaktieren
keine Produktivsysteme.

## Lizenz

Der Quellcode dieser Integration steht unter der [MIT-Lizenz](LICENSE).
Die Schnittstelle und die Dienste von powermesh.de sind nicht Gegenstand dieser
Lizenz; es werden daran keine Rechte eingeräumt. Ihre Nutzung richtet sich nach
den [Nutzungsbedingungen von powermesh.de](https://powermesh.de/?r=terms) und setzt
einen persönlichen Zugang voraus.

---

**English:** Prototype Home Assistant integration for powermesh.de. Smart-home
comparison and improvement analysis are in development and not implemented. The
service stores only selected sensor readings after explicit consent. The local
dashboard card works without an account or upload. Cloud setup supports an
existing personal API key or a one-use HA pairing code: email, password, email
verification, storage consent and authenticator setup are completed on the
website; HA receives the key only after setup succeeds. The configured deadline
defaults to seven days; incomplete accounts are blocked immediately and removed
by the website maintenance job. A legacy operator-invitation flow remains
available. The powermesh.de terms of use apply. Code: MIT. The service is not
covered by this license.
