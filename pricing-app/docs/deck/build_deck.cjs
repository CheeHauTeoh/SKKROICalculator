// Management deck for the SK Keong pricing app. Run: NODE_PATH=<dir with pptxgenjs, react-icons, react, react-dom, sharp> node build_deck.cjs
const path = require('path');
const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const fa = require('react-icons/fa6');
const { applyTheme } = require(process.env.PPTX_SKILL + '/scripts/apply_theme.js');

const OUT = process.argv[2] || 'SK_Keong_Pricing_App_Management_Deck.pptx';
const IMG = f => path.join(__dirname, 'img', f);

const THEME = {
  name: 'SK Keong Forest',
  headFontFace: 'Cambria', bodyFontFace: 'Calibri',
  colors: { dk1: '16211C', lt1: 'FFFFFF', dk2: '0B3D2E', lt2: 'EEF3F0', accent1: '0C7A5E', accent2: 'C08419', accent3: 'B23A3A', accent4: '2F5F9E', accent5: '6B776F', accent6: '7FD3B4', hlink: '0C7A5E', folHlink: '075C46' },
};
const HEX = THEME.colors;

async function icon(Comp, color = '#FFFFFF', size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color, size: String(size) }));
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}

(async () => {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5
  pres.author = 'SK Keong pricing app project';
  pres.company = 'SK Keong Trading Sdn. Bhd.';
  pres.title = 'SK Keong pricing app: proposal to management';
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
  const C = pres.SchemeColor;
  const W = 13.333, M = 0.6;

  // ---------------------------------------------------------------- layouts
  const footer = { text: 'SK Keong Trading Sdn. Bhd.  ·  Pricing app proposal  ·  October 2026', options: { x: M, y: 7.0, w: 9, h: 0.3, fontSize: 10, color: C.accent5, margin: 0 } };
  pres.defineSlideMaster({
    title: 'TITLE_DARK', background: { color: C.text2 },
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.0, w: 7.2, h: 2.0, fontSize: 44, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: M, y: 4.2, w: 7.2, h: 1.6, fontSize: 18, color: C.accent6, valign: 'top', align: 'left', margin: 0 }, text: '' } },
    ],
  });
  pres.defineSlideMaster({
    title: 'CONTENT', background: { color: C.background1 },
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.35, w: W - 2 * M, h: 0.75, fontSize: 32, bold: true, color: C.text2, valign: 'bottom', align: 'left', fit: 'shrink', margin: 0 }, text: '' } },
      { placeholder: { options: { name: 'kicker', type: 'body', x: M, y: 1.12, w: W - 2 * M, h: 0.4, fontSize: 16, color: C.accent1, valign: 'top', align: 'left', margin: 0 }, text: '' } },
      { text: footer },
    ],
    slideNumber: { x: W - M - 0.6, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: C.accent5, align: 'right' },
  });
  pres.defineSlideMaster({
    title: 'CLOSE_DARK', background: { color: C.text2 },
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.45, w: W - 2 * M, h: 0.8, fontSize: 36, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: '' } },
      { placeholder: { options: { name: 'kicker', type: 'body', x: M, y: 1.28, w: W - 2 * M, h: 0.4, fontSize: 16, color: C.accent6, valign: 'top', align: 'left', margin: 0 }, text: '' } },
    ],
    slideNumber: { x: W - M - 0.6, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: C.accent6, align: 'right' },
  });

  // ---------------------------------------------------------------- helpers
  const content = (section, title, kicker) => {
    const s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: section });
    s.addText(title, { placeholder: 'title' });
    s.addText(kicker, { placeholder: 'kicker' });
    return s;
  };
  const source = (s, text, y = 6.62) => s.addText(text, { x: M, y, w: W - 2 * M, h: 0.3, fontSize: 10, italic: true, color: C.accent5, margin: 0, isTextBox: true, objectName: 'Source' });
  const iconCircle = async (s, Comp, x, y, d = 0.62, fill = C.accent1, name = 'Icon') => {
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: name + ' circle' });
    const pad = d * 0.24;
    s.addImage({ data: await icon(Comp), x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad, objectName: name });
  };
  const card = (s, x, y, w, h, fill = C.background2, name = 'Card') =>
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: fill }, objectName: name });
  const shadow = () => ({ type: 'outer', color: '000000', blur: 8, offset: 3, angle: 90, opacity: 0.18 });
  const chartText = { catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', dataLabelFontFace: '+mn-lt', titleFontFace: '+mn-lt', legendFontFace: '+mn-lt',
    catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, dataLabelFontSize: 12, catAxisLabelColor: HEX.dk1, valAxisLabelColor: HEX.accent5, dataLabelColor: HEX.dk1 };

  // ================================================================= 1. Title
  pres.addSection({ title: 'Opening' });
  {
    const s = pres.addSlide({ masterName: 'TITLE_DARK', sectionTitle: 'Opening' });
    s.addText([{ text: 'Know the price.', options: { breakLine: true } }, { text: 'Protect the margin.' }], { placeholder: 'title' });
    s.addText([
      { text: '定价有依据，毛利有保障', options: { fontSize: 22, bold: true, breakLine: true } },
      { text: 'A pricing and field-intelligence app for SK Keong Trading', options: { fontSize: 18, color: C.background1, breakLine: true } },
      { text: 'Proposal to management  ·  October 2026', options: { fontSize: 14, color: C.accent6 } },
    ], { placeholder: 'body' });
    s.addImage({ path: IMG('sp-lookup.png'), x: 9.25, y: 0.75, w: 3.3, h: 3.3 * 1950 / 1170, shadow: shadow(), objectName: 'Phone screenshot: price lookup' });
    s.addNotes('Opening. One sentence: today our prices live in people\'s heads; this app puts the right price in every salesperson\'s hand and shows management where margin is really made or lost. The screenshot is the real app, running on sample data. By the end I will ask for three decisions: approve a three-week pilot, name the owners of the data, and confirm the pricing rules.');
  }

  // ================================================================= 2. Summary
  pres.addSection({ title: 'Why' });
  {
    const s = content('Why', 'The proposal on one page', '一页看懂：问题、方案、需要的决定');
    const cols = [
      ['Problem 问题', fa.FaTriangleExclamation, C.accent3, ['Salespeople phone the office to ask prices', 'No agreed floor price, so discounting is inconsistent and invisible', 'Margin cannot be computed for 73 of 178 core SKUs']],
      ['Solution 方案', fa.FaMobileScreen, C.accent1, ['Phone app, Chinese-first, works with no signal', 'Price lookup, visit prep, competitor capture', 'Desk view for cost, margin, prices and history', 'Built and running today on sample data']],
      ['Ask 需要的决定', fa.FaCircleCheck, C.accent2, ['Approve a 3-week pilot on the 178 core SKUs', 'Name owners for cost, prices and users', 'Answer 12 owner decisions on pricing rules']],
    ];
    const cw = 3.85, gap = 0.3, y = 1.95, h = 3.85;
    for (let i = 0; i < 3; i++) {
      const [head, Ic, col, items] = cols[i]; const x = M + i * (cw + gap);
      card(s, x, y, cw, h, C.background2, head + ' card');
      await iconCircle(s, Ic, x + 0.3, y + 0.3, 0.62, col, head + ' icon');
      s.addText(head, { x: x + 1.05, y: y + 0.3, w: cw - 1.3, h: 0.62, fontSize: 20, bold: true, color: C.text2, valign: 'middle', margin: 0, isTextBox: true });
      s.addText(items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1 } })), { x: x + 0.3, y: y + 1.15, w: cw - 0.55, h: h - 1.35, fontSize: 15, color: C.text1, valign: 'top', paraSpaceAfter: 8, margin: 0, isTextBox: true });
    }
    source(s, 'Figures: SK Keong FY2025 sales and purchase analysis (DATA_SPEC). App status: live pilot site, sample data only.');
    s.addNotes('If management reads only one slide, this is it. Problem: prices are asked over the phone, there is no agreed floor, and for 73 of our 178 most important SKUs we cannot even compute margin because purchases and sales use different units. Solution: a phone app for salespeople and a desk view for owner and finance. It is already built and running on sample data. Ask: approve a three-week pilot, name the data owners, and answer twelve owner decisions on pricing rules, such as whether salespeople may ever see cost.');
  }

  // ================================================================= 3. Today
  {
    const s = content('Why', 'Today, prices live on the phone and in memory', '现况：价格靠电话，竞争价靠记忆');
    const rows = [
      [fa.FaPhone, 'Salespeople phone the office for prices', 'Every quote waits on someone at the office answering.'],
      [fa.FaBrain, 'Competitor prices live in people\'s memories', 'Nothing is recorded, so we cannot see where we are losing.'],
      [fa.FaScaleUnbalanced, 'No agreed floor price', 'Each salesperson decides how far to discount, and nobody sees it.'],
      [fa.FaClockRotateLeft, 'No price history', '"What were we charging in March?" cannot be answered.'],
    ];
    let y = 1.9;
    for (const [Ic, head, sub] of rows) {
      await iconCircle(s, Ic, M, y, 0.62, C.accent1, head);
      s.addText([{ text: head, options: { fontSize: 18, bold: true, color: C.text2, breakLine: true } }, { text: sub, options: { fontSize: 14, color: C.accent5 } }], { x: M + 0.85, y: y - 0.05, w: 6.6, h: 0.85, valign: 'middle', margin: 0, isTextBox: true });
      y += 1.12;
    }
    const px = 8.55, pw = W - M - px;
    card(s, px, 1.9, pw, 4.45, C.text2, 'Scale panel');
    s.addText('The business this has to serve', { x: px + 0.35, y: 2.1, w: pw - 0.7, h: 0.4, fontSize: 14, color: C.accent6, margin: 0, isTextBox: true });
    const stats = [['RM27.5m', 'annual sales value'], ['771', 'active customers'], ['1,093', 'SKUs'], ['7', 'salespeople']];
    stats.forEach(([v, l], i) => {
      const sy = 2.65 + i * 0.88;
      s.addText(v, { x: px + 0.35, y: sy, w: 2.2, h: 0.75, fontSize: 32, bold: true, color: C.background1, fontFace: THEME.headFontFace, valign: 'middle', margin: 0, isTextBox: true });
      s.addText(l, { x: px + 2.6, y: sy, w: pw - 2.9, h: 0.75, fontSize: 15, color: C.accent6, valign: 'middle', margin: 0, isTextBox: true });
    });
    source(s, 'Source: SK Keong company profile and FY2025 UBS data, as summarised in the project brief (DATA_SPEC).');
    s.addNotes('This is how pricing works today. A salesperson standing in a shop phones the office. What competitors charge is remembered, not recorded. There is no agreed floor price, so how much each person discounts is a personal judgement nobody sees. And because prices are not kept with dates, we cannot look back. At RM27.5 million a year across 771 customers and 1,093 SKUs, small inconsistencies add up.');
  }

  // ================================================================= 4. Data problem
  {
    const s = content('Why', '41% of core SKUs have no trustworthy margin yet', '数据问题：采购与销售单位不一致，算不出真实毛利');
    s.addChart(pres.charts.DOUGHNUT, [{ name: 'Core SKUs', labels: ['Units align (OK)', 'Units do not align', 'No purchases in FY2025'], values: [104, 73, 1] }], {
      x: M, y: 1.75, w: 4.6, h: 4.6, holeSize: 62, chartColors: [HEX.accent1, HEX.accent3, HEX.accent5], showLegend: true, legendPos: 'b', legendFontSize: 12, legendFontFace: '+mn-lt', legendColor: HEX.dk1,
      showValue: true, showPercent: false, dataLabelColor: 'FFFFFF', dataLabelFontSize: 14, dataLabelFontFace: '+mn-lt', dataLabelFontBold: true, showTitle: false, objectName: 'Core SKUs by cost data quality',
    });
    s.addText([{ text: '178', options: { fontSize: 32, bold: true, color: C.text2, fontFace: THEME.headFontFace, breakLine: true } }, { text: 'core SKUs', options: { fontSize: 13, color: C.accent5 } }], { x: M + 1.55, y: 3.05, w: 1.5, h: 1.0, align: 'center', valign: 'middle', margin: 0, isTextBox: true });
    const tx = 5.7, tw = W - M - tx;
    s.addText('Purchases are booked in cartons or bales; sales in packets or pieces. Dividing value by quantity gives nonsense:', { x: tx, y: 1.8, w: tw, h: 0.7, fontSize: 15, color: C.text1, margin: 0, isTextBox: true });
    const hdr = { bold: true, color: 'FFFFFF', fill: { color: HEX.dk2 }, fontSize: 13, valign: 'middle' };
    const cell = (t, o = {}) => ({ text: t, options: { fontSize: 13, color: HEX.dk1, valign: 'middle', ...o } });
    s.addTable([
      [{ text: 'SKU', options: hdr }, { text: 'Implied cost', options: { ...hdr, align: 'right' } }, { text: 'Implied price', options: { ...hdr, align: 'right' } }, { text: '"Margin"', options: { ...hdr, align: 'right' } }],
      [cell('9.EC22  EC22A+LID'), cell('RM121.80', { align: 'right' }), cell('RM4.86', { align: 'right' }), cell('−2404%', { align: 'right', color: HEX.accent3, bold: true })],
      [cell('70.JP9  JSP 9" plate'), cell('RM53.96', { align: 'right' }), cell('RM19.31', { align: 'right' }), cell('−179%', { align: 'right', color: HEX.accent3, bold: true })],
      [cell('SXLSK  Rubbish bag XL'), cell('RM2.23', { align: 'right' }), cell('RM4.23', { align: 'right' }), cell('+47.4%', { align: 'right', color: HEX.accent1, bold: true })],
    ], { x: tx, y: 2.6, w: tw, colW: [2.75, 1.4, 1.4, 1.48], rowH: 0.42, border: { type: 'solid', pt: 0.75, color: 'D9E2DC' }, fill: { color: 'FFFFFF' }, margin: 0.08, objectName: 'Unit mismatch examples' });
    card(s, tx, 4.6, tw, 1.75, C.background2, 'Fix callout');
    await iconCircle(s, fa.FaListCheck, tx + 0.3, 4.85, 0.62, C.accent1, 'Fix icon');
    s.addText([{ text: 'Fixing it is Milestone 1, and it is finite', options: { bold: true, fontSize: 16, color: C.text2, breakLine: true } },
      { text: 'Finance confirms purchase unit, selling unit and units per carton for 73 SKUs. Until a cost is verified, the app shows 成本待核实 / cost not verified, never a wrong margin.', options: { fontSize: 14, color: C.text1 } }],
      { x: tx + 1.1, y: 4.75, w: tw - 1.35, h: 1.5, valign: 'top', margin: 0, isTextBox: true });
    source(s, 'Source: FY2025 purchase and sales records, cost_data_quality flag in seed_products.csv (DATA_SPEC §3). OK = implied margin between 2% and 60%.');
    s.addNotes('This is the most important slide for finance. Purchases are recorded per carton or bale, sales per packet. Divide value by quantity and EC22 appears to lose 2,400 percent on every packet. That is not real; it is a unit problem. 104 core SKUs look fine, 73 do not line up, and one had no purchases. Until the 73 are fixed, any margin we quote for them is fiction. The app refuses to show a margin for those SKUs until finance enters a verified cost. This is a finite job: 73 SKUs.');
  }

  // ================================================================= 5. Stakes (illustrative)
  {
    const s = content('Why', 'Every 1% of leakage is worth about RM275k a year', '价格流失的代价（示例计算，非预测）');
    s.addChart(pres.charts.BAR, [{ name: 'Annual value', labels: ['0.5% leakage', '1% leakage', '2% leakage'], values: [137.6, 275.2, 550.4] }], {
      x: M, y: 1.75, w: 6.6, h: 4.6, barDir: 'col', chartColors: [HEX.accent2], barGapWidthPct: 70,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFormatCode: '"RM"0.0"k"', valAxisHidden: true, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
      showLegend: false, showTitle: true, title: 'Annual value at each leakage rate', titleFontSize: 13, titleColor: HEX.dk1, ...chartText, objectName: 'Illustrative leakage value',
    });
    const tx = 7.65, tw = W - M - tx;
    card(s, tx, 1.75, tw, 1.55, 'FBF3E4', 'Illustrative warning');
    s.addText([{ text: 'Illustrative arithmetic, not a forecast', options: { bold: true, fontSize: 15, color: C.accent2, breakLine: true } }, { text: 'We do not yet know SK Keong\'s actual leakage. The pilot will measure it from captured quotes.', options: { fontSize: 14, color: C.text1 } }], { x: tx + 0.3, y: 1.9, w: tw - 0.6, h: 1.3, valign: 'top', margin: 0, isTextBox: true });
    const how = [[fa.FaTags, 'A floor price on every quote'], [fa.FaMagnifyingGlassDollar, 'See where we sit above every competitor'], [fa.FaClockRotateLeft, 'Price history shows drift over time']];
    let y = 3.6;
    s.addText('How the app reduces it', { x: tx, y: y, w: tw, h: 0.4, fontSize: 16, bold: true, color: C.text2, margin: 0, isTextBox: true });
    y += 0.6;
    for (const [Ic, t] of how) { await iconCircle(s, Ic, tx, y, 0.5, C.accent1, t); s.addText(t, { x: tx + 0.7, y, w: tw - 0.7, h: 0.5, fontSize: 15, color: C.text1, valign: 'middle', margin: 0, isTextBox: true }); y += 0.72; }
    source(s, 'Calculation: FY2025 sales value RM27,521,859 (DATA_SPEC §9) × leakage rate. Leakage rates are hypothetical.');
    s.addNotes('This slide is arithmetic, not a promise. If one percent of sales value slips away through unnecessary discounts, that is about RM275,000 a year; half a percent is about RM138,000. We do not know the real figure today, and that is the point: nothing records it. During the pilot the app records our quote, the competitor price and whether we won, so after a few weeks we will have a first measured number.');
  }

  // ================================================================= 6. Solution overview
  pres.addSection({ title: 'What' });
  {
    const s = content('What', 'One app, two jobs', '一个应用，两种用户');
    const cols = [
      ['For owner and finance', '老板与财务 · desktop', fa.FaDesktop, C.text2, ['UOM reconciliation: verified cost per selling unit', 'Target margin and tier prices, with full history', 'Price intelligence: our price vs competitors', 'Refresh from UBS exports safely, any time']],
      ['For salespeople', '业务员 · phone, offline', fa.FaMobileScreen, C.accent1, ['Price lookup: list and floor for this customer', 'Visit prep: what similar shops buy that this one does not', 'Competitor capture: three taps and a number', 'Never shows cost or margin']],
    ];
    const cw = 5.55, gap = W - 2 * M - 2 * cw;
    for (let i = 0; i < 2; i++) {
      const [head, sub, Ic, col, items] = cols[i]; const x = M + i * (cw + gap), y = 1.9, h = 3.85;
      card(s, x, y, cw, h, C.background2, head);
      await iconCircle(s, Ic, x + 0.35, y + 0.35, 0.75, col, head + ' icon');
      s.addText([{ text: head, options: { fontSize: 22, bold: true, color: C.text2, breakLine: true } }, { text: sub, options: { fontSize: 14, color: C.accent5 } }], { x: x + 1.3, y: y + 0.3, w: cw - 1.6, h: 0.9, valign: 'middle', margin: 0, isTextBox: true });
      s.addText(items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1 } })), { x: x + 0.4, y: y + 1.45, w: cw - 0.75, h: h - 1.7, fontSize: 16, color: C.text1, valign: 'top', paraSpaceAfter: 10, margin: 0, isTextBox: true });
    }
    s.addShape(pres.shapes.OVAL, { x: W / 2 - 0.42, y: 3.4, w: 0.84, h: 0.84, fill: { color: C.accent2 }, line: { color: 'FFFFFF', width: 3 }, objectName: 'Shared data hub' });
    s.addImage({ data: await icon(fa.FaArrowsRotate), x: W / 2 - 0.22, y: 3.6, w: 0.44, h: 0.44, objectName: 'Sync icon' });
    s.addText('Same prices, one source of truth. Bilingual: 简体中文 first, English second.', { x: M, y: 6.05, w: W - 2 * M, h: 0.35, fontSize: 14, color: C.accent5, align: 'center', margin: 0, isTextBox: true });
    s.addNotes('The app does two jobs from one database. On the desk, the owner and finance hold cost, target margin and the selling prices, and every change is kept with a date and a name. On the phone, salespeople see only what they are allowed to quote, see what else this customer should be buying, and record what competitors charge. The phone side works without signal. Everything is Chinese-first with English underneath.');
  }

  // ================================================================= 7. Salesperson screens
  {
    const s = content('What', 'What a salesperson sees, standing in the shop', '业务员手机画面（真实应用，示例数据）');
    const shots = [
      ['sp-lookup.png', '1  Price lookup 查价', 'List and floor price for this customer\'s tier. Works with no signal.'],
      ['sp-visit.png', '2  Visit prep 拜访准备', 'What similar shops buy that this one doesn\'t, with an opening question.'],
      ['sp-capture.png', '3  Competitor capture 记录竞争价', 'Customer, product, their price, save. Queued offline, synced later.'],
    ];
    const colW = (W - 2 * M - 2 * 0.3) / 3, ih = 3.85, iw = ih * 1170 / 1950;
    shots.forEach(([f, head, sub], i) => {
      const cx = M + i * (colW + 0.3);
      s.addImage({ path: IMG(f), x: cx + (colW - iw) / 2, y: 1.72, w: iw, h: ih, shadow: shadow(), objectName: head });
      s.addText([{ text: head, options: { fontSize: 15, bold: true, color: C.text2, breakLine: true } }, { text: sub, options: { fontSize: 13, color: C.text1 } }], { x: cx, y: 5.72, w: colW, h: 0.95, align: 'center', valign: 'top', margin: 0, isTextBox: true });
    });
    s.addNotes('These are screenshots of the real app on a phone, with sample data. One: type a code or a name and you see the list price and the floor price for this customer\'s tier, in large text. It works in airplane mode. Two: open a customer and the app lists products that similar shops buy from us but this one does not, with a suggested question to open the conversation. This comes from the sales analysis already done. Three: capturing a competitor price is customer, product, number, save. If there is no signal it is stored on the phone and sent when signal returns.');
  }

  // ================================================================= 8. Management screens
  {
    const s = content('What', 'What owner and finance see', '老板与财务画面（真实应用，示例数据）');
    const lw = 6.55, lh = lw * 1376 / 2292;
    s.addImage({ path: IMG('owner-uom.png'), x: M, y: 1.75, w: lw, h: lh, shadow: shadow(), objectName: 'UOM reconciliation screen' });
    const rh = lh, rw = rh * 1280 / 1000, rx = W - M - rw;
    s.addImage({ path: IMG('owner-intel.png'), x: rx, y: 1.75, w: rw, h: rh, shadow: shadow(), objectName: 'Price intelligence screen' });
    const capY = 1.75 + lh + 0.25;
    s.addText([{ text: 'UOM reconciliation 单位核对', options: { fontSize: 15, bold: true, color: C.text2, breakLine: true } }, { text: 'Evidence from UBS on the left; finance enters unit, factor and verified cost. Progress tracked against the core SKUs.', options: { fontSize: 13, color: C.text1 } }], { x: M, y: capY, w: lw, h: 0.95, valign: 'top', margin: 0, isTextBox: true });
    s.addText([{ text: 'Price intelligence 价格情报', options: { fontSize: 15, bold: true, color: C.text2, breakLine: true } }, { text: 'Our list and floor against every competitor price captured (green won, red lost, blue quoted).', options: { fontSize: 13, color: C.text1 } }], { x: rx, y: capY, w: rw, h: 0.95, valign: 'top', margin: 0, isTextBox: true });
    s.addNotes('On the desk side. Left: the unit reconciliation screen, milestone one. For each SKU it shows what UBS says was bought and sold, and finance fills in the units and the verified cost. The counters at the top show progress against the core list. Right: price intelligence for one SKU. The dashed lines are our list and floor price; each dot is a competitor price a salesperson captured, coloured by whether we won, lost, or only quoted. Here our list price sits above every competitor price seen, so the app flags it. A person decides what to do; nothing changes automatically.');
  }

  // ================================================================= 9. Controls
  {
    const s = content('What', 'Rules the system enforces, not just promises', '系统强制执行的规则');
    const items = [
      [fa.FaEyeSlash, 'Salespeople never see cost or margin', 'Enforced on the server, not just hidden on screen. The owner can switch it.'],
      [fa.FaShieldHalved, 'No margin from unverified cost', 'Shows 成本待核实 instead of a wrong number.'],
      [fa.FaClockRotateLeft, 'Price history kept forever', '"What were we charging in March?" has an answer.'],
      [fa.FaUserPen, 'Every change is attributed', 'Who changed what, when, old value and new value.'],
      [fa.FaSignal, 'Works with no signal', 'Lookup and capture work offline and sync automatically.'],
      [fa.FaFileImport, 'Re-importing UBS data is safe', 'The same file twice changes nothing. Entered costs and prices are never overwritten.'],
    ];
    const cw = (W - 2 * M - 2 * 0.3) / 3, ch = 2.15;
    for (let i = 0; i < items.length; i++) {
      const [Ic, head, sub] = items[i]; const x = M + (i % 3) * (cw + 0.3), y = 1.85 + Math.floor(i / 3) * (ch + 0.3);
      card(s, x, y, cw, ch, C.background2, head);
      await iconCircle(s, Ic, x + 0.3, y + 0.3, 0.58, C.accent1, head + ' icon');
      s.addText([{ text: head, options: { fontSize: 16, bold: true, color: C.text2, breakLine: true } }, { text: sub, options: { fontSize: 14, color: C.text1 } }], { x: x + 0.3, y: y + 1.0, w: cw - 0.6, h: ch - 1.1, valign: 'top', margin: 0, isTextBox: true });
    }
    s.addText('The automated test suite run before each deployment covers the first four and the last; offline use was checked in a browser test.', { x: M, y: 6.6, w: W - 2 * M, h: 0.3, fontSize: 12, italic: true, color: C.accent5, margin: 0, isTextBox: true });
    s.addNotes('These are the controls built into the system. The most important for the owner: salespeople never receive cost or margin. That is checked on the server for every response, so a clever phone cannot reveal it. If the owner later wants to change that, it is one switch. The app will not invent a margin from a cost nobody has checked. Every price is kept with its dates, every change has a name on it, the phone side works offline, and refreshing data from UBS can never wipe out what finance has entered.');
  }

  // ================================================================= 10. Two intelligence paths
  {
    const s = content('What', 'For 78% of sales, the field is our only price source', '竞争价格：78% 的销售只能靠现场情报');
    s.addChart(pres.charts.BAR, [
      { name: 'Branded goods', labels: ['Share of sales value'], values: [22] },
      { name: 'Own-brand and commodity', labels: ['Share of sales value'], values: [78] },
    ], { x: M, y: 1.8, w: W - 2 * M, h: 1.45, barDir: 'bar', barGrouping: 'percentStacked', chartColors: [HEX.accent4, HEX.accent1], barGapWidthPct: 20,
      showValue: true, dataLabelPosition: 'ctr', dataLabelFormatCode: '0"%"', dataLabelColor: 'FFFFFF', dataLabelFontBold: true, catAxisHidden: true, valAxisHidden: true,
      valGridLine: { style: 'none' }, catGridLine: { style: 'none' }, showLegend: true, legendPos: 't', legendFontSize: 13, legendFontFace: '+mn-lt', legendColor: HEX.dk1, showTitle: false,
      ...chartText, dataLabelColor: 'FFFFFF', objectName: 'Branded vs commodity share' });
    const cw = (W - 2 * M - 0.3) / 2, y = 3.55, h = 2.9;
    const cards = [
      [fa.FaGlobe, C.accent4, 'Market reference 市场参考价', 'Branded goods only', ['Public Malaysian wholesale prices, always with source link and date', 'Example: Seamaster 250ml × 24 quoted RM6.15–9.38 per carton across four wholesalers', 'Reference only; never changes our prices']],
      [fa.FaStore, C.accent1, 'Field intelligence 现场情报', 'Every SKU', ['Captured by salespeople in the shop', 'Records won, lost or quoted, which builds win-rate data', 'Flags SKUs where we are above every competitor price seen']],
    ];
    cards.forEach(async () => {});
    for (let i = 0; i < 2; i++) {
      const [Ic, col, head, sub, items] = cards[i]; const x = M + i * (cw + 0.3);
      card(s, x, y, cw, h, C.background2, head);
      await iconCircle(s, Ic, x + 0.3, y + 0.3, 0.6, col, head + ' icon');
      s.addText([{ text: head, options: { fontSize: 17, bold: true, color: C.text2, breakLine: true } }, { text: sub, options: { fontSize: 13, color: C.accent5 } }], { x: x + 1.05, y: y + 0.25, w: cw - 1.3, h: 0.75, valign: 'middle', margin: 0, isTextBox: true });
      s.addText(items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1 } })), { x: x + 0.35, y: y + 1.15, w: cw - 0.65, h: h - 1.3, fontSize: 14, color: C.text1, valign: 'top', paraSpaceAfter: 6, margin: 0, isTextBox: true });
    }
    source(s, 'Source: share of FY2025 sales value flagged is_branded, and the Seamaster example, from the project brief (DATA_SPEC §4); not independently re-checked.', 6.6);
    s.addNotes('Where do competitor prices come from? For branded goods such as Seamaster, LYG or Nestlé, about 22 percent of sales, Malaysian wholesale prices can be found online, and the app stores them with the source and date. For the other 78 percent, singlet bags, disposables, greaseproof paper, there is no public price. Searching returns supplier directories. So for most of our sales, the only way to know the market is what salespeople hear in shops. That is why the capture screen is designed to take seconds.');
  }

  // ================================================================= 11. Focus
  pres.addSection({ title: 'How' });
  {
    const s = content('How', 'Start with the 178 SKUs that make 80% of sales', '先做 178 个核心 SKU');
    s.addChart(pres.charts.BAR, [{ name: 'Core SKUs', labels: ['Share of SKUs', 'Share of sales value'], values: [16.3, 79.9] }], {
      x: M, y: 1.75, w: 6.2, h: 4.7, barDir: 'col', chartColors: [HEX.accent5, HEX.accent1], barGapWidthPct: 60, invertedColors: undefined,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFormatCode: '0.0"%"', valAxisHidden: true, valAxisMaxVal: 100, valAxisMinVal: 0, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
      showLegend: false, showTitle: true, title: '178 core SKUs out of 1,093', titleFontSize: 13, titleColor: HEX.dk1, ...chartText, objectName: 'Core SKU concentration',
    });
    const tx = 7.4, tw = W - M - tx;
    s.addText([{ text: '79.9%', options: { fontSize: 60, bold: true, color: C.accent1, fontFace: THEME.headFontFace, breakLine: true } }, { text: 'of sales value comes from 178 SKUs', options: { fontSize: 18, color: C.text2 } }], { x: tx, y: 1.85, w: tw, h: 1.6, valign: 'top', margin: 0, isTextBox: true });
    card(s, tx, 3.75, tw, 2.05, C.background2, 'Why start small');
    s.addText([
      { text: 'Why not all 1,093 at once', options: { bold: true, fontSize: 16, color: C.text2, breakLine: true } },
      { text: 'A list of 1,093 prices will not be maintained, and an out-of-date price is worse than no price. 178 prices can be checked, owned and kept current. The rest follow once the habit exists.', options: { fontSize: 14, color: C.text1 } },
    ], { x: tx + 0.3, y: 3.95, w: tw - 0.6, h: 1.75, valign: 'top', margin: 0, isTextBox: true });
    source(s, 'Source: Pareto analysis of FY2025 sales value (DATA_SPEC §8). Share of SKUs = 178 ÷ 1,093.');
    s.addNotes('We start narrow on purpose. 178 SKUs, about one in six, make almost 80 percent of sales value. If we try to price all 1,093 from day one, the list will not be kept up, and an out-of-date price in a salesperson\'s hand is worse than none. 178 can be checked and owned by finance.');
  }

  // ================================================================= 12. Pilot plan
  {
    const s = content('How', 'A three-week pilot, then decide on rollout', '三周试行计划');
    card(s, M, 1.75, W - 2 * M, 0.62, 'E3F1EB', 'Status today');
    s.addText([{ text: 'Status today  ', options: { bold: true, color: C.accent1 } }, { text: 'All screens built and live at sk-keong-pricing.netlify.app on sample data. Waiting on SK Keong data.', options: { color: C.text1 } }], { x: M + 0.3, y: 1.75, w: W - 2 * M - 0.6, h: 0.62, fontSize: 15, valign: 'middle', margin: 0, isTextBox: true });
    const steps = [
      ['Week 1', 'Set up', ['User logins for all staff', 'Owner answers the 12 decisions', 'Salespeople install the app', 'Unit reconciliation starts']],
      ['Week 2', 'Verify cost, set prices', ['Units and verified cost for the 178 core SKUs', 'Target margin per category', 'Finance sets list and floor prices']],
      ['Week 3', 'Go live in the field', ['Sample data cleared; real data loaded', 'Price lookup, visit prep and capture in daily use']],
      ['After', 'Review and decide', ['Usage and first competitor data', 'Roll out, adjust, or stop', 'Move hosting before company-wide use']],
    ];
    const cw = (W - 2 * M - 3 * 0.3) / 4, y = 2.95;
    for (let i = 0; i < steps.length; i++) {
      const [wk, head, items] = steps[i]; const x = M + i * (cw + 0.3);
      const fill = i === 3 ? C.accent2 : C.accent1;
      s.addShape(pres.shapes.OVAL, { x, y, w: 0.6, h: 0.6, fill: { color: fill }, line: { color: fill }, objectName: wk + ' marker' });
      s.addText(String(i < 3 ? i + 1 : '✓'), { x, y, w: 0.6, h: 0.6, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0, isTextBox: true });
      if (i < 3) s.addShape(pres.shapes.LINE, { x: x + 0.7, y: y + 0.3, w: cw - 0.5, h: 0, line: { color: HEX.accent5, width: 1.5, dashType: 'dash' }, objectName: 'Timeline connector' });
      s.addText([{ text: wk, options: { fontSize: 13, color: C.accent5, breakLine: true } }, { text: head, options: { fontSize: 17, bold: true, color: C.text2 } }], { x, y: y + 0.75, w: cw, h: 0.75, valign: 'top', margin: 0, isTextBox: true });
      s.addText(items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1 } })), { x, y: y + 1.6, w: cw, h: 2.0, fontSize: 14, color: C.text1, valign: 'top', paraSpaceAfter: 6, margin: 0, isTextBox: true });
    }
    s.addNotes('The software is built; what remains is SK Keong\'s data and decisions. Week one: logins, the owner answers the twelve decision questions, salespeople install the app and practise on sample data, and finance starts on units. Week two: verified cost for the 178 core SKUs, target margins, list and floor prices. Week three: sample data is cleared, real data goes in, and salespeople use it every day. Then we review and decide whether to roll out. Current hosting is fine for a pilot of about ten users; before the whole company relies on it, we move it to a small dedicated server.');
  }

  // ================================================================= 13. Success measures
  {
    const s = content('How', 'How we will know the pilot worked', '试行成功的衡量标准');
    const rows = [
      ['Core SKUs with verified cost or confirmed "no purchase"', '178 of 178 by end of week 2', 'Project brief, Milestone 1'],
      ['Find a core SKU\'s price with no signal', 'Under 10 seconds', 'Project brief, Milestone 3'],
      ['Capture a competitor price', '3 taps and a number', 'Project brief, Milestone 4'],
      ['Competitor prices captured per salesperson per week', 'Target to be set by management', 'Decision needed'],
      ['Quotes at or above floor price', 'Baseline measured during pilot', 'Measured from captures'],
    ];
    const hdr = { bold: true, color: 'FFFFFF', fill: { color: HEX.dk2 }, fontSize: 14, valign: 'middle' };
    const c = (t, o = {}) => ({ text: t, options: { fontSize: 14, color: HEX.dk1, valign: 'middle', ...o } });
    s.addTable([
      [{ text: 'Measure', options: hdr }, { text: 'Target', options: hdr }, { text: 'Where the target comes from', options: hdr }],
      ...rows.map(([m, t, src], i) => [c(m), c(t, { bold: true, color: i >= 3 ? HEX.accent2 : HEX.accent1 }), c(src, { color: HEX.accent5 })]),
    ], { x: M, y: 1.8, w: W - 2 * M, colW: [5.6, 3.6, 2.93], rowH: 0.62, border: { type: 'solid', pt: 0.75, color: 'D9E2DC' }, fill: { color: 'FFFFFF' }, margin: 0.1, objectName: 'Pilot success measures' });
    await iconCircle(s, fa.FaBullseye, M, 5.85, 0.55, C.accent2, 'Target icon');
    s.addText('Amber rows need a management decision before the pilot starts.', { x: M + 0.75, y: 5.85, w: 8, h: 0.55, fontSize: 15, color: C.text1, valign: 'middle', margin: 0, isTextBox: true });
    s.addNotes('Five measures. The first three come straight from the project brief: every core SKU has a verified cost or is marked as having no purchases, a price can be found offline in under ten seconds, and a competitor price takes three taps and a number. The last two need your input: how many captures per salesperson per week we expect, and we will measure how often quotes sit at or above the floor so we have a baseline.');
  }

  // ================================================================= 14. Risks
  {
    const s = content('How', 'Risks and how we handle them', '风险与应对');
    const risks = [
      [fa.FaUsers, 'Salespeople don\'t use it', 'Chinese-first, phone-first, offline, capture in about 15 seconds. Weekly capture counts reviewed by the owner.'],
      [fa.FaDatabase, 'Unit or cost data is wrong', 'Only human-verified costs drive margin. Unverified SKUs show no margin at all.'],
      [fa.FaEyeSlash, 'Cost leaks to customers', 'Salespeople\'s phones never receive cost or margin; enforced on the server.'],
      [fa.FaServer, 'Pilot hosting is light', 'Fine for about 10 users. Move to a small dedicated server before company-wide reliance.'],
      [fa.FaUserClock, 'Depends on one person for cost', 'Workbook split by owner; progress visible on screen; finance and purchasing share the UOM task.'],
    ];
    let y = 1.8;
    for (const [Ic, head, sub] of risks) {
      await iconCircle(s, Ic, M, y, 0.55, C.accent2, head);
      s.addText(head, { x: M + 0.8, y, w: 3.9, h: 0.55, fontSize: 16, bold: true, color: C.text2, valign: 'middle', margin: 0, isTextBox: true });
      s.addText(sub, { x: 5.0, y: y - 0.05, w: W - M - 5.0, h: 0.65, fontSize: 14, color: C.text1, valign: 'middle', margin: 0, isTextBox: true });
      y += 0.92;
    }
    s.addNotes('Five risks. The biggest is adoption: if salespeople find it slower than phoning the office, they will not use it. That is why it is Chinese-first, works offline, and capture takes seconds, and the owner should look at capture counts weekly. Data quality: margins only appear once a person has verified the cost. Cost leaking to customers: the phone simply never receives it. Hosting: the current setup is right for a pilot, not for the whole company long term. And the cost work should not sit on one person.');
  }

  // ================================================================= 15. Ask
  pres.addSection({ title: 'Decision' });
  {
    const s = pres.addSlide({ masterName: 'CLOSE_DARK', sectionTitle: 'Decision' });
    s.addText('Decisions needed today', { placeholder: 'title' });
    s.addText('今天需要的决定', { placeholder: 'kicker' });
    const asks = [
      ['1', 'Approve a three-week pilot', 'On the 178 core SKUs, starting on a date we fix today.'],
      ['2', 'Name the owners', 'Finance: unit reconciliation and prices. Owner: tiers and rules. Clerk: users and UBS exports.'],
      ['3', 'Confirm the cost rule', 'Salespeople see list and floor price only; owner and finance see cost and margin.'],
      ['4', 'Agree the success targets', 'Including expected competitor captures per salesperson per week.'],
    ];
    let y = 2.1;
    for (const [n, head, sub] of asks) {
      s.addShape(pres.shapes.OVAL, { x: M, y, w: 0.62, h: 0.62, fill: { color: C.accent2 }, line: { color: C.accent2 }, objectName: 'Decision ' + n });
      s.addText(n, { x: M, y, w: 0.62, h: 0.62, fontSize: 20, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0, isTextBox: true });
      s.addText([{ text: head, options: { fontSize: 20, bold: true, color: C.background1, breakLine: true } }, { text: sub, options: { fontSize: 15, color: C.accent6 } }], { x: M + 0.9, y: y - 0.08, w: 7.4, h: 0.95, valign: 'middle', margin: 0, isTextBox: true });
      y += 1.12;
    }
    const px = 9.1, pw = W - M - px;
    card(s, px, 2.1, pw, 2.75, '134C3B', 'Ready now panel');
    s.addText([
      { text: 'Ready to send today', options: { fontSize: 16, bold: true, color: C.background1, breakLine: true } },
      { text: 'Bilingual data-request workbook (8 sheets) and cover memo', options: { fontSize: 14, color: C.accent6, bullet: true, breakLine: true } },
      { text: 'Live app on sample data for training', options: { fontSize: 14, color: C.accent6, bullet: true, breakLine: true } },
      { text: 'Owner login set up', options: { fontSize: 14, color: C.accent6, bullet: true } },
    ], { x: px + 0.3, y: 2.35, w: pw - 0.6, h: 2.35, valign: 'top', paraSpaceAfter: 8, margin: 0, isTextBox: true });
    s.addNotes('Four decisions. One: approve the three-week pilot on the 178 core SKUs and fix the start date. Two: name owners; we propose finance for unit reconciliation and prices, the owner for tiers and rules, the clerk for user setup and UBS exports. Three: confirm that salespeople see list and floor only. Four: agree the success targets. The data-request workbook and memo are ready to send as soon as we leave this room.');
  }

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log('wrote', OUT);
})().catch(e => { console.error(e); process.exit(1); });
