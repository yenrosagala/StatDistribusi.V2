"""Generate a clean, placeholder-based PPTX template for the dashboard.

Shapes are named so the fill script can find them by name:
  - Title (textbox)
  - Subtitle (textbox)
  - Chart1, Chart2 (picture placeholders)
  - Table1, Table2 (table placeholders)
  - Narrative (textbox)
"""
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

NAVY = RGBColor(0x1E, 0x40, 0xAF)
GREY = RGBColor(0x64, 0x74, 0x8B)

def make_template(out_path):
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    # --- Title slide ---
    s = prs.slides.add_slide(blank)
    t = s.shapes.add_textbox(Inches(0.5), Inches(2.5), Inches(12.3), Inches(1.2))
    t.name = "Title"
    tf = t.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = "Judul Laporan"
    r.font.size = Pt(32)
    r.font.bold = True
    r.font.color.rgb = NAVY
    p.alignment = PP_ALIGN.CENTER

    sub = s.shapes.add_textbox(Inches(0.5), Inches(3.8), Inches(12.3), Inches(0.8))
    sub.name = "Subtitle"
    tf2 = sub.text_frame
    p2 = tf2.paragraphs[0]
    r2 = p2.add_run()
    r2.text = "Subjudul"
    r2.font.size = Pt(16)
    r2.font.color.rgb = GREY
    p2.alignment = PP_ALIGN.CENTER

    # --- Data slide (charts + tables + narrative) ---
    s2 = prs.slides.add_slide(blank)
    title2 = s2.shapes.add_textbox(Inches(0.4), Inches(0.2), Inches(12.5), Inches(0.7))
    title2.name = "SlideTitle"
    tf3 = title2.text_frame
    p3 = tf3.paragraphs[0]
    r3 = p3.add_run()
    r3.text = "Judul Slide"
    r3.font.size = Pt(22)
    r3.font.bold = True
    r3.font.color.rgb = NAVY

    # Chart placeholders (pictures)
    c1 = s2.shapes.add_picture_placeholder if hasattr(s2.shapes, 'add_picture_placeholder') else None
    # Use textboxes as placeholders for chart images (we'll replace with pictures)
    ph1 = s2.shapes.add_textbox(Inches(0.4), Inches(1.1), Inches(6.15), Inches(3.5))
    ph1.name = "Chart1"
    ph1.text_frame.text = "[Chart1]"
    ph2 = s2.shapes.add_textbox(Inches(6.8), Inches(1.1), Inches(6.15), Inches(3.5))
    ph2.name = "Chart2"
    ph2.text_frame.text = "[Chart2]"

    # Table placeholders
    ph3 = s2.shapes.add_textbox(Inches(0.4), Inches(4.8), Inches(6.15), Inches(2.2))
    ph3.name = "Table1"
    ph3.text_frame.text = "[Table1]"
    ph4 = s2.shapes.add_textbox(Inches(6.8), Inches(4.8), Inches(6.15), Inches(2.2))
    ph4.name = "Table2"
    ph4.text_frame.text = "[Table2]"

    # Narrative
    nar = s2.shapes.add_textbox(Inches(0.4), Inches(7.1), Inches(12.5), Inches(0.3))
    nar.name = "Narrative"
    nar.text_frame.text = "[Narrative]"

    prs.save(out_path)
    print("Saved template:", out_path)

if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "dashboard_template.pptx"
    make_template(out)
