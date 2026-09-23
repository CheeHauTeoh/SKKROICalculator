// Bilingual cover memo for the SK Keong team: what we need, from whom, by when.
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType, ShadingType, BorderStyle, LevelFormat } = require('docx');
const FONT = 'Arial';
const P = (text, o = {}) => new Paragraph({ spacing: { after: 120 }, ...o.para, children: (Array.isArray(text) ? text : [text]).map(t => typeof t === 'string' ? new TextRun({ text: t, font: FONT, size: o.size || 21, bold: o.bold, color: o.color }) : t) });
const H1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, font: FONT, size: 28, bold: true, color: '0C7A5E' })] });
const H2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: t, font: FONT, size: 24, bold: true })] });
const bullet = t => new Paragraph({ numbering: { reference: 'bul', level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: t, font: FONT, size: 21 })] });
const W = [1700, 3600, 1900, 1400, 1160]; const TW = W.reduce((a, b) => a + b, 0);
const cell = (t, w, head = false) => new TableCell({ width: { size: w, type: WidthType.DXA }, shading: head ? { type: ShadingType.CLEAR, fill: 'E4F0EB', color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 90, right: 90 },
  children: String(t).split('\n').map(line => new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: line, font: FONT, size: 19, bold: head })] })) });
const row = (cells, head = false) => new TableRow({ children: cells.map((c, i) => cell(c, W[i], head)) });
const table = (rows) => new Table({ width: { size: TW, type: WidthType.DXA }, columnWidths: W, rows: rows.map((r, i) => row(r, i === 0)) });

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 21 } } } },
  numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children: [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'SK Keong 价格应用 · 资料收集与决策清单', font: FONT, size: 34, bold: true, color: '0C7A5E' })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'SK Keong pricing app · data request and decision list', font: FONT, size: 24, color: '4A574F' })] }),
    P(['发给 To: ', new TextRun({ text: '老板、财务 (Yun Jun Ooi)、文员、7 位业务员   Owner, Finance (Yun Jun Ooi), Clerk, 7 salespeople', font: FONT, size: 21 })]),
    P('附件 Attachment: SK_Keong_Pricing_App_Data_Request.xlsx（8 张工作表 8 sheets）'),
    P('应用地址 App: https://sk-keong-pricing.netlify.app（目前是示例数据 sample data for now）'),

    H1('1. 为什么需要这些资料  Why we need this'),
    P('应用已经建好，但现在跑的是示例数据。要让业务员在客户店里查到正确的价格，需要贵公司提供三类东西：人（谁用）、规则（怎么定价）、数字（成本和价格）。其中最关键、也最耗时的是「单位核对」：采购按箱/包记录，销售按小包/个记录，178 个核心 SKU 里有 73 个因此算不出真实成本。这一步不完成，毛利和建议价都不可信。'),
    P('The app is built and running on sample data. For salespeople to see correct prices in a customer\'s shop, we need three things from SK Keong: people (who uses it), rules (how pricing works) and numbers (cost and prices). The critical and slowest item is UOM reconciliation: purchases are booked in cartons or bales, sales in packets or pieces, so 73 of the 178 core SKUs have no usable cost today. Until that is done, margins and suggested prices cannot be trusted.', { color: '4A574F' }),

    H1('2. 需要什么、谁负责、什么时候  What, who, when'),
    table([
      ['工作表 Sheet', '内容 Content', '负责人 Owner', '时间 When', '优先 Priority'],
      ['1 用户 Users', '每位使用者：用户名（UBS 业务员代码）、姓名、角色、手机型号。\nEvery user: username (UBS salesperson code), name, role, phone model.', '老板 / 文员\nOwner / Clerk', '第1周\nWeek 1', '高 High'],
      ['2 单位核对 UOM', '178 个核心 SKU：采购单位、销售单位、换算系数、核实成本（对照供应商发票）。先做 73 个「单位可疑」的。\n178 core SKUs: purchase unit, selling unit, factor, verified cost (check a supplier invoice). Start with the 73 flagged UOM_SUSPECT.', '财务 + 采购\nFinance + Purchasing', '第1–2周\nWeek 1–2', '最高 Critical'],
      ['3 价格等级 Tiers', '等级名称；客户类型 × 规模 → 等级 的规则。\nTier names; rule: customer type × size → tier.', '老板 Owner', '第2周\nWeek 2', '高 High'],
      ['4 目标毛利 Margins', '每个品类的目标毛利 % 和底价折扣 %。\nTarget margin % and floor discount % per category.', '老板 + 财务\nOwner + Finance', '第2周\nWeek 2', '高 High'],
      ['5 核心价格 Prices', '核心 SKU 现有目录价 / 底价（每个等级）。\nCurrent list / floor price per tier for core SKUs.', '财务 Finance', '第2–3周\nWeek 2–3', '高 High'],
      ['6 客户等级 Customers', '需要手动指定等级的客户；确认类型、规模、业务员。\nCustomers needing a manual tier; confirm type, size, salesperson.', '老板 + 业务员\nOwner + Sales', '第3周\nWeek 3', '中 Medium'],
      ['7 竞争对手 Competitors', '常见竞争对手；品牌货的公开价格来源。\nCommon competitors; public price sources for branded SKUs.', '业务员 + 老板\nSales + Owner', '第3周\nWeek 3', '中 Medium'],
      ['8 决策 Decisions', '12 项老板要拍板的规则（如业务员能否看成本）。\n12 rules the owner decides (e.g. may salespeople see cost).', '老板 Owner', '第1周\nWeek 1', '高 High'],
    ]),
    P(''),
    P('另外还需要从 UBS 导出（不用手填）：按客户 × 货号的年度销售明细，以及采购明细。这两份用来显示每个客户的常购商品，以及每月刷新数据。', { para: { spacing: { before: 120 } } }),
    P('Also needed as UBS exports (no manual filling): annual sales by customer × item, and purchases by item. These feed each customer\'s "regular items" and the monthly refresh.', { color: '4A574F' }),

    H1('3. 单位核对怎么做  How to do the UOM reconciliation'),
    bullet('每个 SKU 一行。灰色格是系统从 UBS 推算的证据：采购单位、采购数量和金额、推算的每采购单位成本；销售单位、数量、推算售价。  One row per SKU. Grey cells are evidence from UBS: purchase unit, qty, value and implied cost per purchase unit; selling unit, qty, implied price.'),
    bullet('填三个黄色格：采购单位（例如 CTN）、销售单位（例如 PKT）、换算系数（1 箱 = 多少包）。表格会算出「推算成本/销售单位」。  Fill three yellow cells: purchase unit (e.g. CTN), selling unit (e.g. PKT), factor (packets per carton). The sheet computes a suggested cost per selling unit.'),
    bullet('核对一张最近的供应商发票，把确认的每销售单位成本填到「核实成本」。这个数字一旦填写，永远优先于推算值。  Check a recent supplier invoice and put the confirmed cost per selling unit in "verified cost". Once entered it always overrides the implied figure.'),
    bullet('本财年没有采购的 SKU，在「确认无采购」填 Y，不要猜成本。  SKUs with no purchases this FY: put Y in "no purchase confirmed"; do not guess a cost.'),
    bullet('例子 Example：9.EC22 EC22A+LID 采购 RM121.80/箱，1 箱 = 25 包 → 每包 RM4.87；售价 RM4.86/包 → 这个 SKU 实际是亏本或定价错误，正是要发现的问题。  9.EC22 costs RM121.80 per carton, 25 packets per carton → RM4.87 per packet; it sells at RM4.86 per packet, so it is loss-making or mispriced. That is exactly what this exercise is meant to surface.'),

    H1('4. 填写规则  Rules for filling in'),
    bullet('只改黄色格；灰色格请勿改动；绿色是示例行，请覆盖或删除。  Edit yellow cells only; do not touch grey; green rows are examples to overwrite or delete.'),
    bullet('每张表第 5 行的列名请勿改动，导入需要它。  Keep the column headers exactly; the import relies on them.'),
    bullet('金额用马币，两位小数，不写 RM；百分比写 25 代表 25%。  Money in RM to two decimals without "RM"; percentages as 25 for 25 %.'),
    bullet('不确定就在「备注」写问题，不要猜。  If unsure, write the question in Notes rather than guess.'),
    bullet('交回：把整个文件发回，或在应用「导入 / 更新」页面上传另存为 CSV 的工作表；导入前会先显示识别到的列，确认后才写入。重复上传同一份文件不会产生重复。  Return the workbook, or upload sheets saved as CSV on the app\'s Import page; it previews the detected columns before writing anything, and re-uploading the same file changes nothing.'),

    H1('5. 之后会发生什么  What happens next'),
    bullet('第 1 周：建立用户账号，老板确认决策清单，业务员手机装好应用（示例数据）。  Week 1: user accounts created, owner confirms the decision list, salespeople install the app (sample data).'),
    bullet('第 2 周：单位核对完成 → 导入核实成本 → 按目标毛利生成建议价，财务审核后设定目录价和底价。  Week 2: UOM done → verified costs imported → suggested prices from target margin, finance reviews and sets list and floor.'),
    bullet('第 3 周：清空示例数据，导入真实客户与价格，业务员开始查价和记录竞争价。  Week 3: sample data cleared, real customers and prices loaded, salespeople start price lookup and competitor capture.'),
    P(''),
    P('联系人 Contact: ______________________    日期 Date: ______________', { bold: true }),
  ] }],
});
Packer.toBuffer(doc).then(b => { fs.writeFileSync('SK_Keong_Pricing_App_Data_Request_Memo.docx', b); console.log('memo saved'); });
