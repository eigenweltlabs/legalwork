"""Generate two synthetic, searchable PDF packets for the calculation-card demo."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import simpleSplit

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)

def build(filename, title, mandate):
    path = OUT / filename
    c = canvas.Canvas(str(path), pagesize=(595.28, 841.89))
    c.setTitle(title)
    c.setAuthor("LegalWork demo / synthetic DeadlineBench case")
    c.setFillColor(HexColor("#153F35")); c.rect(0, 798, 595.28, 44, fill=1, stroke=0)
    c.setFillColor(HexColor("#FFFFFF")); c.setFont("Helvetica-Bold", 10)
    c.drawString(46, 815, "LEGALWORK  /  DEMONSTRATIONSFALL")
    c.setFillColor(HexColor("#14221F")); c.setFont("Helvetica-Bold", 24)
    c.drawString(46, 746, title)
    c.setFont("Helvetica", 10); c.setFillColor(HexColor("#65716D"))
    c.drawString(46, 722, "Fiktiver Aktenauszug. Keine echte Gerichtsakte. Keine echten Beteiligten.")
    y = 674
    def section(label, paragraphs):
        nonlocal y
        c.setFillColor(HexColor("#153F35")); c.setFont("Helvetica-Bold", 10)
        c.drawString(46, y, label.upper()); y -= 25
        c.setFillColor(HexColor("#14221F")); c.setFont("Helvetica", 12)
        for p in paragraphs:
            for line in simpleSplit(p, "Helvetica", 12, 496):
                c.drawString(46,y,line); y-=18
            y-=12
        y-=14
    section("Mahnbescheid / DB-MAHN-07", ["Amtsgericht Wedding, Berlin.", "Mahnbescheid persönlich zugestellt am 12.01.2026.", "Aufforderung, binnen zwei Wochen zu zahlen oder mitzuteilen, ob widersprochen wird.", "Die spätere Verfahrensakte liegt nicht bei."])
    section("Mandatsnotiz", [mandate])
    c.setStrokeColor(HexColor("#DDE4E0")); c.line(46, 92, 548, 92)
    c.setFont("Helvetica", 9); c.setFillColor(HexColor("#65716D"))
    for i,line in enumerate(simpleSplit("Grundlage: DeadlineBench v0.8.0, germany/missing-facts--docket-payment-order-longstop. Für die erste Datei wurde nur der Auftrag zur gewöhnlichen Antwortfrist angepasst.","Helvetica",9,496)):
        c.drawString(46,73-i*13,line)
    c.save()
    return path

print(build("01-ordinary-response.pdf", "Gewöhnliche Antwortfrist", "Bitte die im Mahnbescheid genannte Zweiwochenfrist als gewöhnliche Antwortfrist im Kalender vormerken. Die gesetzliche äußerste Grenze für einen Widerspruch ist nicht Gegenstand dieses Auftrags."))
print(build("02-absolute-objection-cutoff.pdf", "Äußerste Widerspruchsgrenze", "Bitte den letzten überhaupt noch zulässigen Tag für einen Widerspruch gegen den Mahnbescheid bestimmen. Bitte einen endgültigen Kalendertag für diesen Vorgang bestimmen, Kennung d01. Gefragt ist die gesetzliche äußerste Grenze, nicht eine vorsorgliche Wiedervorlage oder die im Formular genannte Antwortfrist."))
