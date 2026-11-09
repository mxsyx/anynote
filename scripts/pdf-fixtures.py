"""RM25 reproducible fixtures (reportlab 4.4.5, pypdf 6.1.1)."""
from io import BytesIO
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from pypdf import PdfReader, PdfWriter

root = Path(__file__).resolve().parents[1] / 'tests/fixtures/pdf'
root.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
source = BytesIO()
c = canvas.Canvas(source, pagesize=(400, 300), invariant=True, pageCompression=0)
for i in range(8):
    c.setFillColorRGB(1, 0, 0)
    c.rect(70, 60, 30, 20, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont('Helvetica', 16)
    c.drawString(100, 150, f'Anynote page {i + 1}')
    c.setFont('Times-Roman', 12)
    c.drawString(100, 125, 'Mixed fonts 123')
    c.setFont('STSong-Light', 16)
    c.drawString(100, 100, '中文测试')
    c.saveState()
    c.translate(280, 90)
    c.rotate(30)
    c.setFont('Helvetica', 12)
    c.drawString(0, 0, 'Tilted')
    c.restoreState()
    c.showPage()
c.save()
writer = PdfWriter()
for i, page in enumerate(PdfReader(source).pages):
    page.cropbox.lower_left = (40, 30)
    page.cropbox.upper_right = (360, 270)
    page.rotate((i % 4) * 90)
    writer.add_page(page)
writer.write(root / 'geometry.pdf')
writer.encrypt('rm25-test', owner_password='rm25-owner', algorithm='RC4-128')
writer.write(root / 'encrypted.pdf')
