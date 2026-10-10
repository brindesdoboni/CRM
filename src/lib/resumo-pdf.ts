import path from 'node:path';
import PDFDocument from 'pdfkit';
import { formatDate, formatMoney } from './format.js';
import { PAYMENT_METHODS, formatCep, installmentsText, parseNames } from './sales.js';
import type { SettingKey } from './settings.js';

const LOGO = path.resolve(import.meta.dirname, '../../public/logo.png');
const VINHO = '#74201f';
const DOURADO = '#de9e36';
const DOURADO_CLARO = '#fbf1de';
const TEXTO = '#1d2330';
const SUTIL = '#667085';
const BORDA = '#dde1e7';

/** Campos da venda que podem sair no PDF. Custo do frete, margem e lucro ficam de fora de propósito. */
export interface SummarySale {
  code: string; created_at: Date | string; customer_name: string; product: string; product_code?: string | null; color: string | null;
  quantity: number; font: string | null; names: string | null; due_date: Date | string;
  shipping_service: string | null; shipping_price: string | number | null; shipping_days: number | null; shipping_cep: string | null;
  unit_price: string | number | null; discount: string | number | null; payment_method: string | null; installments: number;
  interest_free: boolean; installment_value: string | number | null; down_payment: string | number | null; total: string | number | null;
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));
const money = (v: string | number | null | undefined) => (num(v) === null ? '—' : formatMoney(num(v)));

/** Gera o PDF "Resumo do pedido" (A4). */
export function saleSummaryPdf(
  sale: SummarySale, settings: Partial<Record<SettingKey, string>>, art: { mime: string; data: Buffer } | null,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Resumo do pedido ${sale.code}`, Author: settings.empresa_nome || 'Brindes DoBoni' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - 48; // deixa espaço para o rodapé
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  // Cabeçalho: logo + dados da empresa
  doc.rect(0, 0, doc.page.width, 6).fill(VINHO);
  doc.image(LOGO, left, 22, { width: 70 });
  const empresa = settings.empresa_nome || 'Brindes DoBoni';
  const linhas = [
    settings.empresa_cnpj ? `CNPJ ${settings.empresa_cnpj}` : '',
    [settings.empresa_telefone, settings.empresa_email].filter(Boolean).join(' · '),
    settings.empresa_site || '',
    settings.empresa_endereco || '',
  ].filter(Boolean);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(VINHO).text(empresa, left + 85, 30, { width: width - 85 });
  doc.font('Helvetica').fontSize(9).fillColor(SUTIL);
  for (const l of linhas) doc.text(l, { width: width - 85 });
  doc.y = Math.max(doc.y, 22 + 70) + 10;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(2).strokeColor(DOURADO).stroke();

  // Título
  doc.moveDown(0.8);
  const titleY = doc.y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(TEXTO).text('RESUMO DO PEDIDO', left, titleY);
  doc.font('Helvetica').fontSize(10).fillColor(SUTIL)
    .text(`Pedido ${sale.code}   ·   ${formatDate(sale.created_at)}`, left, titleY + 4, { width, align: 'right' });
  doc.y = titleY + 26;
  doc.font('Helvetica').fontSize(11).fillColor(TEXTO).text('Cliente: ', left, doc.y, { continued: true })
    .font('Helvetica-Bold').text(sale.customer_name);
  doc.moveDown(1);

  // Itens
  const cols = [
    { label: 'Produto', w: 0.27 }, { label: 'Cor', w: 0.12 }, { label: 'Qtd', w: 0.08, align: 'right' as const },
    { label: 'Personalização', w: 0.23 }, { label: 'Valor unit.', w: 0.15, align: 'right' as const }, { label: 'Subtotal', w: 0.15, align: 'right' as const },
  ];
  const names = parseNames(sale.names);
  const unit = num(sale.unit_price);
  const personalizacao = [
    names.length ? `${names.length} nome${names.length > 1 ? 's' : ''} gravado${names.length > 1 ? 's' : ''}` : '',
    sale.font ? `Fonte: ${sale.font}` : '',
  ].filter(Boolean).join('\n') || '—';
  const row = [
    sale.product, sale.color || '—', String(sale.quantity), personalizacao, money(unit),
    unit === null ? '—' : formatMoney(Math.round(unit * 100) * sale.quantity / 100),
  ];
  const drawRow = (cells: string[], bold: boolean, fill?: string) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    const heights = cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w * width - 10 }));
    const h = Math.max(...heights) + 10;
    ensure(h);
    const y = doc.y;
    if (fill) doc.rect(left, y, width, h).fill(fill);
    let x = left;
    cells.forEach((c, i) => {
      doc.fillColor(bold ? VINHO : TEXTO).text(c, x + 5, y + 5, { width: cols[i].w * width - 10, align: cols[i].align ?? 'left' });
      x += cols[i].w * width;
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor(BORDA).stroke();
    doc.y = y + h;
  };
  drawRow(cols.map((c) => c.label), true, DOURADO_CLARO);
  drawRow(row, false);
  doc.x = left;

  // Nomes gravados (lista completa, em colunas)
  if (names.length) {
    doc.moveDown(0.8);
    ensure(40);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(VINHO).text('Nomes para gravação', left);
    doc.moveDown(0.3);
    const perCol = Math.ceil(names.length / 3);
    const startY = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(TEXTO);
    let maxY = startY;
    for (let c = 0; c < 3; c++) {
      doc.y = startY;
      for (const [i, n] of names.slice(c * perCol, (c + 1) * perCol).entries()) {
        if (doc.y > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; }
        doc.text(`${c * perCol + i + 1}. ${n}`, left + (c * width) / 3, doc.y, { width: width / 3 - 8 });
      }
      maxY = Math.max(maxY, doc.y);
    }
    doc.y = maxY;
    doc.x = left;
  }

  // Arte aprovada (miniatura): o PDF aceita JPG e PNG
  if (art && (art.mime === 'image/png' || art.mime === 'image/jpeg')) {
    doc.moveDown(0.8);
    ensure(135);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(VINHO).text('Arte aprovada', left);
    doc.moveDown(0.3);
    const y = doc.y;
    try {
      doc.image(art.data, left, y, { fit: [170, 110] });
      doc.rect(left, y, 170, 110).lineWidth(0.5).strokeColor(BORDA).stroke();
      doc.y = y + 116;
    } catch {
      doc.font('Helvetica').fontSize(9).fillColor(SUTIL).text('Arte enviada à parte.', left, y);
    }
  } else if (art) {
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(9).fillColor(SUTIL).text('Arte enviada à parte (arquivo em PDF ou outro formato).', left);
  }

  // Frete, pagamento e totais
  doc.moveDown(1);
  ensure(150);
  const boxY = doc.y;
  const half = (width - 16) / 2;
  const box = (x: string | number, title: string, lines: [string, string][]) => {
    const bx = Number(x);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(VINHO).text(title, bx + 10, boxY + 8, { width: half - 20 });
    let y = boxY + 26;
    for (const [k, v] of lines) {
      doc.font('Helvetica').fontSize(9.5).fillColor(SUTIL).text(k, bx + 10, y, { width: 90 });
      doc.font('Helvetica').fontSize(9.5).fillColor(TEXTO).text(v, bx + 100, y, { width: half - 110 });
      y = Math.max(y + 15, doc.y + 3);
    }
    return y;
  };
  const freteLines: [string, string][] = [
    ['Serviço', sale.shipping_service || '—'],
    ['Valor', money(sale.shipping_price)],
    ['Prazo de entrega', sale.shipping_days == null ? '—' : `${sale.shipping_days} dia${sale.shipping_days === 1 ? '' : 's'} úte${sale.shipping_days === 1 ? 'il' : 'is'} após o envio`],
  ];
  if (sale.shipping_cep) freteLines.push(['CEP de entrega', formatCep(sale.shipping_cep)]);
  const parcela = installmentsText(sale.installments, num(sale.installment_value), sale.interest_free, formatMoney);
  const pagLines: [string, string][] = [
    ['Forma', sale.payment_method ? PAYMENT_METHODS[sale.payment_method] ?? sale.payment_method : '—'],
    ['Parcelas', parcela],
  ];
  if (num(sale.down_payment)) pagLines.push(['Entrada', money(sale.down_payment)]);
  const total = num(sale.total);
  if (!sale.interest_free && sale.installments > 1 && total !== null && num(sale.installment_value) !== null) {
    const comJuros = (num(sale.down_payment) ?? 0) + num(sale.installment_value)! * sale.installments;
    pagLines.push(['Total com juros', formatMoney(comJuros)]);
  }
  const yA = box(left, 'Frete', freteLines);
  const yB = box(left + half + 16, 'Pagamento', pagLines);
  const boxH = Math.max(yA, yB) - boxY + 6;
  doc.roundedRect(left, boxY, half, boxH, 6).lineWidth(0.8).strokeColor(BORDA).stroke();
  doc.roundedRect(left + half + 16, boxY, half, boxH, 6).lineWidth(0.8).strokeColor(BORDA).stroke();
  doc.y = boxY + boxH + 12;

  // Totais (à direita) e prazo de produção (à esquerda)
  ensure(90);
  const tx = left + width - 230;
  const totY = doc.y;
  doc.font('Helvetica').fontSize(9.5).fillColor(SUTIL).text('Prazo de produção', left, totY, { width: width - 250 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(TEXTO).text(`até ${formatDate(sale.due_date)}`, left, doc.y + 2, { width: width - 250 });
  doc.font('Helvetica').fontSize(9).fillColor(SUTIL).text('contado a partir da sua aprovação', left, doc.y + 2, { width: width - 250 });
  doc.y = totY;
  const totLine = (k: string, v: string, strong = false) => {
    const y = doc.y;
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 12.5 : 10).fillColor(strong ? VINHO : TEXTO);
    doc.text(k, tx, y, { width: 120 });
    doc.text(v, tx + 120, y, { width: 110, align: 'right' });
    doc.y = y + (strong ? 20 : 15);
  };
  totLine('Produtos', unit === null ? '—' : formatMoney(Math.round(unit * 100) * sale.quantity / 100));
  totLine('Frete', money(sale.shipping_price));
  if (num(sale.discount)) totLine('Desconto', `- ${money(sale.discount)}`);
  doc.moveTo(tx, doc.y).lineTo(tx + 230, doc.y).lineWidth(1).strokeColor(DOURADO).stroke();
  doc.y += 5;
  totLine('Valor total', money(total), true);
  if (sale.installments > 1) {
    doc.font('Helvetica').fontSize(9.5).fillColor(SUTIL).text(parcela, tx, doc.y, { width: 230, align: 'right' });
  }
  doc.x = left;

  // Chamada para aprovação
  doc.moveDown(1.2);
  ensure(50);
  const cy = doc.y;
  doc.roundedRect(left, cy, width, 42, 6).fill(DOURADO_CLARO);
  doc.rect(left, cy, 4, 42).fill(DOURADO);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(VINHO)
    .text('Confira os dados e responda aprovando para iniciarmos a produção', left + 16, cy + 14, { width: width - 32, align: 'center' });

  // Rodapé em todas as páginas
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // escrever no rodapé sem abrir página nova
    const fy = doc.page.height - 32;
    doc.font('Helvetica').fontSize(8).fillColor(SUTIL)
      .text(`${empresa}${settings.empresa_site ? ` · ${settings.empresa_site}` : ''}   ·   Pedido ${sale.code}   ·   Página ${i - range.start + 1} de ${range.count}`,
        left, fy, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
