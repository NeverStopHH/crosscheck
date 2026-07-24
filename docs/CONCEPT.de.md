# Original-Konzept (Nick, 2026-07-24)

> Dieses Dokument ist das unveränderte Ausgangskonzept, aus dem Crosscheck entstanden ist.
> Die daraus abgeleitete (und an einigen Stellen bewusst abweichende) Architektur steht in [DESIGN.md](DESIGN.md);
> die Abweichungen sind dort in §9 (Non-Goals) begründet.

## Konzept: Kollaborierende Developer-Agents über mehrere Nutzer hinweg

### Ausgangsproblem

In modernen Entwicklerteams arbeiten mehrere Personen parallel mit Coding-Agents wie Claude Code, Codex, Cursor oder GitHub Copilot.

Ein großer Teil der eigentlichen Entwicklungsarbeit findet dabei zunächst lokal statt. Der Code ist noch nicht committed, nicht gepusht und häufig auch noch nicht vollständig umgesetzt. Dadurch wissen andere Entwickler und deren Agents nicht, was parallel bereits untersucht, geplant oder verändert wird.

Git zeigt erst relativ spät, dass sich Arbeiten überschneiden. Zu diesem Zeitpunkt wurden häufig bereits mehrere Stunden investiert oder widersprüchliche Lösungen implementiert.

Das Problem betrifft dabei nicht nur klassische Merge-Konflikte auf Dateiebene. Viel wichtiger sind Überschneidungen auf inhaltlicher, analytischer und architektonischer Ebene.

### Die Grundidee

Die lokal arbeitenden Agents verschiedener Entwickler sollen kontrolliert miteinander kommunizieren können.

Dabei geht es nicht nur darum, mitzuteilen, welche Dateien gerade bearbeitet werden. Die Agents sollen auch verstehen:

* an welchem Problem ein anderer Entwickler arbeitet,
* welche Symptome untersucht wurden,
* welche Hypothesen geprüft wurden,
* welche Diagnose der andere Agent gestellt hat,
* welche Root Cause vermutet oder bestätigt wurde,
* welche Ansätze bereits ausgeschlossen wurden,
* welche Architekturentscheidungen getroffen wurden,
* welche Änderungen geplant oder bereits lokal umgesetzt wurden,
* welche offenen Unsicherheiten weiterhin bestehen.

Dadurch entsteht eine gemeinsame Wissens- und Koordinationsebene über die lokale Arbeit aller Entwickler.

### Ein besonders wichtiger Anwendungsfall

Zwei Entwickler können am gleichen Thema arbeiten, ohne exakt dieselben Dateien zu verändern.

Beispielsweise untersucht Agent A ein Problem und kommt zu der Diagnose:

> Die fehlerhafte Team-Zuordnung entsteht in der Plan Resolution.

Agent B untersucht parallel ein ähnliches Verhalten und erkennt:

> Die Plan Resolution ist zwar der sichtbare Fehlerpunkt, die eigentliche Root Cause liegt aber bereits in der fehlerhaften Entity Resolution beziehungsweise im fehlenden Mapping beim Import.

Heute würden diese Erkenntnisse möglicherweise getrennt voneinander bleiben. Agent A würde einen Fix in der Plan Resolution bauen, obwohl Agent B bereits erkannt hat, dass dieser Fix lediglich das Symptom behandelt.

In einem kollaborierenden Agent-System könnte Agent B die bestehende Diagnose ergänzen:

> Die bisherige Diagnose ist teilweise korrekt, greift aber vermutlich eine Ebene zu spät. Die tiefere Ursache liegt im vorgelagerten Mapping.

Agent A könnte daraufhin:

* seine geplante Lösung überprüfen,
* unnötige Änderungen vermeiden,
* seine Diagnose aktualisieren,
* Tests auf die tiefere Root Cause ausrichten,
* oder gemeinsam mit Agent B eine bessere Lösung entwickeln.

Der Nutzen besteht deshalb nicht nur in der Vermeidung von Code-Konflikten. Das System verbessert auch die Qualität von Diagnosen und technischen Entscheidungen.

### Gemeinsame Diagnose statt isolierter Problemlösung

Das System sollte Erkenntnisse nicht einfach überschreiben. Diagnosen sollten schrittweise erweitert und präzisiert werden können.

Eine Diagnose könnte beispielsweise folgende Struktur besitzen:

**Beobachtung** — Kunden oder Konten erscheinen ohne korrekte Plan-Zuordnung.

**Erste Hypothese** — Die Plan Resolution schlägt bei bestimmten Konten fehl.

**Evidenz** — Mehrere Konten werden als „unknown plan" gespeichert.

**Erweiterte Hypothese** — Die Plan Resolution erhält bereits unvollständige oder falsch aufgelöste Entities.

**Tiefere Root Cause** — Beim Import werden Stripe- und CRM-Entities nicht konsistent zusammengeführt.

**Verworfen** — Der Stripe-Extractor selbst klickt oder lädt die falschen Konten.

**Nächster Test** — Prüfung der Entity IDs direkt nach dem Ingestion-Schritt und vor der Plan Resolution.

Andere Agents könnten dann neue Evidenz hinzufügen, Hypothesen bestätigen, widersprechen oder eine tiefere Ursache identifizieren.

Das wäre im Grunde ein gemeinsamer, lebender Diagnosebaum für technische Probleme.

### Welche Informationen Agents teilen sollten

1. **Arbeitskontext**: Repository, Branch, lokaler Base Commit, aktueller Task, betroffene Komponenten, verwendeter Agent, verantwortlicher Entwickler
2. **Entwicklungsabsicht**: geplante Änderungen, wahrscheinlich betroffene Dateien, betroffene Klassen und Funktionen, APIs oder Datenmodelle, die verändert werden könnten, erwartete Seiteneffekte
3. **Diagnosewissen**: beobachtetes Problem, aktuelle Hypothese, vermutete Root Cause, vorhandene Evidenz, bereits geprüfte Ansätze, verworfene Hypothesen, offene Fragen, empfohlene nächste Tests
4. **Lokaler Entwicklungsstatus**: Analyse, Planung, Implementierung, Tests, blockiert, abgeschlossen, verworfen
5. **Relevante technische Entscheidungen**: warum ein bestimmter Ansatz gewählt wurde, welche Alternativen geprüft wurden, welche Annahmen gelten, welche Abhängigkeiten bestehen, welche temporären Workarounds eingebaut wurden

### Konflikte, die erkannt werden sollten

* **Direkte Code-Konflikte**: Zwei Agents verändern dieselbe Datei oder Funktion.
* **Semantische Konflikte**: Zwei Agents verändern unterschiedliche Dateien, verfolgen aber widersprüchliche Lösungen.
* **Architekturkonflikte**: Ein Agent führt eine neue Abstraktion ein, während ein anderer parallel die alte Struktur erweitert.
* **Diagnosekonflikte**: Zwei Agents erklären dasselbe Problem mit unterschiedlichen Root Causes.
* **Abhängigkeitskonflikte**: Die Lösung eines Agents setzt eine API oder Datenstruktur voraus, die ein anderer Agent gerade verändert.
* **Doppelte Arbeit**: Zwei Agents untersuchen unabhängig dieselbe Frage oder implementieren dieselbe Funktion.
* **Wissensüberschneidungen**: Ein Agent verfügt bereits über Erkenntnisse, die die Arbeit eines anderen Agents verkürzen oder verbessern könnten.

### Wichtige Systemfunktionen

Agent Presence · Intent Sharing · Diagnosis Sharing · Semantic Matching · Root-Cause Linking · Proaktive Hinweise · Agent-to-Agent Questions · Evidence Exchange · Decision History · Human Approval

### Technische Grundarchitektur (ursprüngliche Skizze)

Lokaler Agent-Connector pro Entwicklerrechner; zentraler Team-Service mit Presence Store, Context Store, Diagnosis Graph, Semantic Search, Conflict Detector, Notification Layer, Permission Layer. Vorgeschlagener Stack: FastAPI oder Node.js, PostgreSQL, pgvector, Redis oder WebSockets, Git-Integration, optional Slack.

*(Anmerkung: Die finale Architektur in DESIGN.md weicht hier bewusst ab — kein Redis, keine WebSockets, kein Python-Service, kein Daemon; Begründungen in DESIGN.md §2 und RESEARCH.md §4.)*

### Sinnvoller MVP (ursprüngliche Skizze)

1. Session Registration
2. Shared Diagnosis Notes
3. Semantic Similarity Search
4. Proaktive Context Injection
5. Overlap Warning

### Langfristige Vision

Langfristig entsteht eine Art gemeinsames technisches Gedächtnis des Entwicklerteams: warum Fehler entstanden sind, welche Diagnosen falsch waren, welche Root Causes bestätigt wurden, welche Lösungen bereits versucht wurden, welche Architekturentscheidungen getroffen wurden, welche lokalen Arbeiten aktuell laufen, und welche Erkenntnisse für andere Entwickler relevant sein könnten.

Der eigentliche Mehrwert liegt nicht darin, dass Agents einfach miteinander chatten. Der Mehrwert liegt darin, dass mehrere Agents gemeinsam ein besseres Verständnis eines Problems entwickeln, sich gegenseitig korrigieren, tiefere Root Causes erkennen und verhindern, dass Entwickler auf Grundlage unvollständiger Diagnosen parallel falsche oder widersprüchliche Lösungen bauen.
