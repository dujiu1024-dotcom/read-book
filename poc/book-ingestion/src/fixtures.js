import { zipSync, strToU8 } from 'fflate';

const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
function epubFixture(title, chapters) {
  const manifest = chapters.map((_, i) => `<item id="c${i+1}" href="chapter${i+1}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((_, i) => `<itemref idref="c${i+1}"/>`).join('');
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">poc-${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>zh</dc:language></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  const files = {
    mimetype: { data: strToU8('application/epub+zip'), level: 0 },
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf)
  };
  chapters.forEach((body, i) => {
    files[`OEBPS/chapter${i+1}.xhtml`] = strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${i+1}章</title></head><body><h1 id="chapter-${i+1}">第${i+1}章</h1><p>${body}</p><aside epub:type="footnote" id="fn1"><p>脚注示例 ${i+1}</p></aside></body></html>`);
  });
  return zipSync(files);
}

function pdfFixture(pages) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const commands = lines.map(({ text, x = 60, y = 760 }) => `BT /F1 12 Tf ${x} ${y} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
    const stream = commands;
    objects[4+i*2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`;
    objects[5+i*2] = `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = new TextEncoder().encode(pdf).length; pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export function getFixture(id) {
  if (id.startsWith('epub-')) {
    const samples = {
      'epub-1': ['原文包含章节、论述段落与脚注。阅读定位需要回到本章对应语义单元。'],
      'epub-2': ['第一章的主要论点。', '第二章延续前文并提出新的论证。', '第三章总结全书主线。'],
      'epub-3': ['本章引用一张示意图片，图片位置与替代文本需要保留。']
    };
    const bytes = epubFixture(id, samples[id]);
    return { name: id + '.epub', type: 'application/epub+zip', bytes };
  }
  if (id.startsWith('pdf-')) {
    const samples = {
      'pdf-1': [[{ text: 'Single column PDF sample', y: 740 }, { text: 'A paragraph with stable text offsets.', y: 710 }]],
      'pdf-2': [[{ text: 'Left column text', x: 50, y: 740 }, { text: 'Right column text', x: 330, y: 740 }]],
      'pdf-3': [[{ text: 'Header - Sample Book', y: 770 }, { text: 'Body paragraph on page one.', y: 710 }, { text: 'Footer 1', y: 30 }], [{ text: 'Header - Sample Book', y: 770 }, { text: 'Body paragraph on page two.', y: 710 }, { text: 'Footer 2', y: 30 }]]
    };
    const bytes = pdfFixture(samples[id]);
    return { name: id + '.pdf', type: 'application/pdf', bytes };
  }
  const text = {
    'txt-1': 'UTF-8 测试\n\n第一段内容。\n\n第二段内容。',
    'txt-2': '长段落测试\n\n' + '这是一段用于测试长文本偏移定位的内容。'.repeat(500),
    'txt-3': 'GB18030 编码回退由用户上传的外部样本覆盖；此固定夹具为 UTF-8 占位样本。'
  }[id];
  return { name: id + '.txt', type: 'text/plain', bytes: new TextEncoder().encode(text) };
}
