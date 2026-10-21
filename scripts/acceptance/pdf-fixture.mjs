/** Build a small multi-page PDF with extractable text for the reader checks. */
export function multiPagePdf(count) {
  const kids = [],
    objects = [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, ""],
      [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    ];
  let next = 4;
  for (let i = 1; i <= count; i++) {
    const page = next++,
      content = next++,
      stream = `BT /F1 18 Tf 40 220 Td (Anynote page ${i}) Tj ET`;
    kids.push(`${page} 0 R`);
    objects.push([
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 320] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`,
    ]);
    objects.push([
      content,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ]);
  }
  objects[1][1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  const total = next - 1;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [id, text] of objects) {
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${text}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++)
    pdf += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  return (
    pdf +
    `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  );
}
