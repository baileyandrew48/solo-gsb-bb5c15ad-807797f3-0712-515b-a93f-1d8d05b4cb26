/*
 * recon.js —— 馆藏号对账：批量校样 CSV 的 accession 列 与 馆藏登记清单的核对
 * （无 DOM 依赖，可在浏览器与 Node 中运行；CSV 解析复用 batch.js 的 LabelBatch.parseCsv）
 *
 * 号码格式：「年份.批次.三位流水号」（如 2024.03.001）；
 * 允许同前缀闭区间号段（如 2024.03.001-005，右侧仅写三位流水号，前缀与左侧相同）；
 * 展开时保留三位宽度（2024.03.001-005 → 2024.03.001、…、2024.03.005）。
 * 拒绝：格式错误、倒序号段（如 2024.03.005-001），以及任一侧
 * （CSV 侧 / 登记清单侧）展开后号码总数超过 200 个——错误均指出来源行。
 *
 * 对账按展开后的完整号码进行（顺序不同不算差异）：
 *   - CSV 内重号 / 登记清单内重号（含号段交叠）：同一号码在同一侧出现多次；
 *   - 仅在 CSV / 仅在登记清单：同一号码只出现在一侧。
 * 对账只读：本模块不改动任何面板输入，也不影响校样、拼版与打印。
 */
(function (global) {
  'use strict';

  var MAX_EXPAND = 200; // 每一侧（CSV 侧 / 登记清单侧）展开后的号码总数上限

  // 单个号码：年份(4 位).批次(2 位).流水号(3 位)；号段：右侧仅写三位流水号
  var ITEM_RE = /^(\d{4})\.(\d{2})\.(\d{3})(?:-(\d{3}))?$/;

  /**
   * 解析单个号码或同前缀闭区间号段。
   * @param {string} raw 原始文本（内部去首尾空白）
   * @returns {{raw:string,prefix:string,start:number,end:number,numbers:string[]}|{error:string}}
   *   numbers 为展开后的完整号码（保留三位宽度）；error 为格式错误或倒序的说明。
   */
  function parseItem(raw) {
    var text = String(raw == null ? '' : raw).trim();
    var m = text.match(ITEM_RE);
    if (!m) {
      return { error: '「' + (text || '（空）') + '」格式错误：号码应为「年份.批次.三位流水号」' +
        '（如 2024.03.001），或同前缀闭区间号段（如 2024.03.001-005）。' };
    }
    var prefix = m[1] + '.' + m[2];
    var start = parseInt(m[3], 10);
    var end = m[4] !== undefined ? parseInt(m[4], 10) : start;
    if (end < start) {
      return { error: '「' + text + '」号段倒序：起始流水号 ' + m[3] +
        ' 大于终止流水号 ' + m[4] + '，闭区间需从小到大（如 2024.03.001-005）。' };
    }
    var numbers = [];
    for (var n = start; n <= end; n++) {
      numbers.push(prefix + '.' + ('00' + n).slice(-3)); // 展开保留三位宽度
    }
    return { raw: text, prefix: prefix, start: start, end: end, numbers: numbers };
  }

  /**
   * 解析馆藏登记清单：每行一项（单个号码或同前缀号段），空行忽略。
   * @param {string} text 清单原文
   * @returns {{items:Array<{line:number,raw:string,numbers:string[]}>,
   *            errors:string[], total:number}}
   *   line 为源文本行号（从 1 起，空行计入）；total 为展开后的号码总数；
   *   格式错误逐行收集，展开总数超过 200 个时指出触发行并中止本侧解析。
   */
  function parseRegistry(text) {
    var lines = String(text == null ? '' : text).split(/\r\n?|\n/);
    var items = [];
    var errors = [];
    var total = 0;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (raw === '') continue; // 空行忽略
      var item = parseItem(raw);
      if (item.error) {
        errors.push('清单第 ' + (i + 1) + ' 行：' + item.error);
        continue;
      }
      total += item.numbers.length;
      if (total > MAX_EXPAND) {
        errors.push('清单第 ' + (i + 1) + ' 行「' + item.raw + '」展开后，' +
          '登记清单一侧号码总数超过 ' + MAX_EXPAND + ' 个上限，请拆分后分批核对。');
        return { items: items, errors: errors, total: total };
      }
      items.push({ line: i + 1, raw: item.raw, numbers: item.numbers });
    }
    return { items: items, errors: errors, total: total };
  }

  /**
   * 从批量校样 CSV 提取 accession 列并逐条展开。
   * 表头须含额外的 accession 列（列名去首尾空白、忽略大小写，顺序任意）；
   * 对账要求各记录的 accession 去首尾空白后非空；列数不符的记录无法定位
   * accession，同样阻塞对账（错误定位到记录号，记录号从 1 起、不含表头）。
   * @param {string} text CSV 原文（即「批量校样」区的内容）
   * @returns {{items:Array<{no:number,line:number,raw:string,numbers:string[]}>,
   *            errors:string[], total:number}}
   */
  function extractCsv(text) {
    var result = { items: [], errors: [], total: 0 };

    var parsed = global.LabelBatch.parseCsv(text);
    if (parsed.errors.length) {
      result.errors = parsed.errors.map(function (e) { return 'CSV ' + e; });
      return result;
    }
    if (!parsed.rows.length) {
      result.errors.push('请先在「批量校样」区粘贴含表头与 accession 列的 CSV 内容。');
      return result;
    }

    // 表头：定位 accession 列（列名去首尾空白、忽略大小写；重复列报错）
    var headerCells = parsed.rows[0].cells;
    var accCol = -1;
    for (var i = 0; i < headerCells.length; i++) {
      if (headerCells[i].trim().toLowerCase() === 'accession') {
        if (accCol >= 0) {
          result.errors.push('CSV 表头存在重复的 accession 列，请去重后重试。');
          return result;
        }
        accCol = i;
      }
    }
    if (accCol < 0) {
      result.errors.push('CSV 表头缺少 accession 列：对账需要在表头中增加馆藏号列' +
        '（如 title,zh,en,accession，顺序任意）。');
      return result;
    }

    var colCount = headerCells.length;
    var dataRows = parsed.rows.slice(1);
    if (!dataRows.length) {
      result.errors.push('CSV 中没有数据记录：表头之后每行一条，各记录的 accession 均须填写。');
      return result;
    }

    for (var k = 0; k < dataRows.length; k++) {
      var row = dataRows[k];
      var no = k + 1;
      if (row.cells.length !== colCount) {
        result.errors.push('CSV 第 ' + no + ' 条记录：列数不符（本记录 ' + row.cells.length +
          ' 列，表头 ' + colCount + ' 列），无法定位 accession 列；请先修正 CSV。');
        continue;
      }
      var raw = String(row.cells[accCol] == null ? '' : row.cells[accCol]).trim();
      if (!raw) {
        result.errors.push('CSV 第 ' + no + ' 条记录：accession 为空，' +
          '对账要求各记录均填写馆藏号。');
        continue;
      }
      var item = parseItem(raw);
      if (item.error) {
        result.errors.push('CSV 第 ' + no + ' 条记录：' + item.error);
        continue;
      }
      result.total += item.numbers.length;
      if (result.total > MAX_EXPAND) {
        result.errors.push('CSV 第 ' + no + ' 条记录「' + item.raw + '」展开后，' +
          'CSV 一侧号码总数超过 ' + MAX_EXPAND + ' 个上限，请拆分后分批核对。');
        return result;
      }
      result.items.push({ no: no, line: row.line, raw: item.raw, numbers: item.numbers });
    }
    return result;
  }

  // 把一侧的展开号码汇成 号码 → 来源列表 的映射（同一来源不重复计入）
  function buildSourceMap(items, labelOf) {
    var map = Object.create(null);
    items.forEach(function (it) {
      var src = labelOf(it);
      it.numbers.forEach(function (num) {
        if (!map[num]) map[num] = [];
        if (map[num].indexOf(src) < 0) map[num].push(src);
      });
    });
    return map;
  }

  /**
   * 对账：按展开后的完整号码比较两侧（号码为定宽格式，按字典序排列即数值序；
   * 顺序不同不算差异）。
   * @param {Array} csvItems extractCsv 的 items（来源记为「CSV 第 N 条记录」）
   * @param {Array} listItems parseRegistry 的 items（来源记为「清单第 N 行」）
   * @returns {{csvTotal:number, listTotal:number, matched:number,
   *            csvDupes:Array<{number:string,sources:string[]}>,
   *            listDupes:Array<{number:string,sources:string[]}>,
   *            onlyCsv:Array<{number:string,sources:string[]}>,
   *            onlyList:Array<{number:string,sources:string[]}>}}
   *   csvDupes / listDupes 为各侧内部的重号（含号段交叠，来源 ≥ 2 处）；
   *   onlyCsv / onlyList 为仅在一侧出现的号码及其来源。
   */
  function reconcile(csvItems, listItems) {
    var csvMap = buildSourceMap(csvItems, function (it) { return 'CSV 第 ' + it.no + ' 条记录'; });
    var listMap = buildSourceMap(listItems, function (it) { return '清单第 ' + it.line + ' 行'; });

    var csvTotal = 0, listTotal = 0;
    csvItems.forEach(function (it) { csvTotal += it.numbers.length; });
    listItems.forEach(function (it) { listTotal += it.numbers.length; });

    var csvDupes = [], onlyCsv = [], matched = 0;
    Object.keys(csvMap).sort().forEach(function (num) {
      var sources = csvMap[num];
      if (sources.length > 1) csvDupes.push({ number: num, sources: sources });
      if (listMap[num]) matched++;
      else onlyCsv.push({ number: num, sources: sources });
    });

    var listDupes = [], onlyList = [];
    Object.keys(listMap).sort().forEach(function (num) {
      var sources = listMap[num];
      if (sources.length > 1) listDupes.push({ number: num, sources: sources });
      if (!csvMap[num]) onlyList.push({ number: num, sources: sources });
    });

    return {
      csvTotal: csvTotal, listTotal: listTotal, matched: matched,
      csvDupes: csvDupes, listDupes: listDupes,
      onlyCsv: onlyCsv, onlyList: onlyList
    };
  }

  var api = {
    MAX_EXPAND: MAX_EXPAND,
    parseItem: parseItem,
    parseRegistry: parseRegistry,
    extractCsv: extractCsv,
    reconcile: reconcile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LabelRecon = api;
})(typeof window !== 'undefined' ? window : globalThis);
