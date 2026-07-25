/**
 * Analytics.gs
 * -----------------------------------------------------------------------
 * All functions here are called from Dashboard.html via google.script.run
 * and return plain JSON-serializable objects. Every function accepts an
 * optional `filters` object:
 *   { dateFrom, dateTo, hour, buyer, style, line, qi, defect }
 * (any key can be omitted / empty string to mean "no filter").
 *
 * Design notes:
 *  - Ratio metrics (DHU%) are always computed from SUMMED numerator and
 *    denominator across the group, never averaged row-by-row, to avoid
 *    distortion when inspection sizes vary.
 *  - Style Summary groups by (Buyer + Style) so identical style codes
 *    from two different buyers are never merged together.
 *  - Reads the sheet once per call (bulk getValues), then does all
 *    filtering/aggregation in memory - this stays fast well past
 *    50,000 rows since there is exactly one round trip to the sheet.
 * -----------------------------------------------------------------------
 */

function getRawDataObjects_() {
  var sheet = getSheet_(CONFIG.SHEET_RAW_DATA);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, RAW_DATA_NUM_COLS).getValues();
  return values.map(function (row, i) {
    var o = rowToObject_(row);
    o._row = i + 2;
    return o;
  });
}

function matchesFilters_(o, f) {
  if (!f) return true;
  if (f.dateFrom && dateKey_(o.date) < f.dateFrom) return false;
  if (f.dateTo && dateKey_(o.date) > f.dateTo) return false;
  if (f.hour && o.hour !== f.hour) return false;
  if (f.buyer && o.buyer !== f.buyer) return false;
  if (f.style && o.style !== f.style) return false;
  if (f.line && o.line !== f.line) return false;
  if (f.qi && o.qi !== f.qi) return false;
  if (f.defect && o.defectName !== f.defect) return false;
  return true;
}

function getFilteredObjects_(filters) {
  return getRawDataObjects_().filter(function (o) { return matchesFilters_(o, filters); });
}

// ---------------------------------------------------------------------
// Filter dropdown options (cached briefly - invalidated on new submit)
// ---------------------------------------------------------------------
function getFilterOptions() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('dash_filter_options');
  if (cached) return JSON.parse(cached);

  var all = getRawDataObjects_();
  var buyers = {}, styles = {}, lines = {}, qis = {}, defects = {}, hours = {};
  var minDate = null, maxDate = null;
  all.forEach(function (o) {
    if (o.buyer) buyers[o.buyer] = true;
    if (o.style) styles[o.style] = true;
    if (o.line) lines[o.line] = true;
    if (o.qi) qis[o.qi] = true;
    if (o.defectName) defects[o.defectName] = true;
    if (o.hour) hours[o.hour] = true;
    var dk = dateKey_(o.date);
    if (dk) {
      if (!minDate || dk < minDate) minDate = dk;
      if (!maxDate || dk > maxDate) maxDate = dk;
    }
  });

  var result = {
    buyers: Object.keys(buyers).sort(),
    styles: Object.keys(styles).sort(),
    lines: Object.keys(lines).sort(),
    qis: Object.keys(qis).sort(),
    defects: Object.keys(defects).sort(),
    hours: Object.keys(hours).sort(),
    minDate: minDate,
    maxDate: maxDate,
    totalRecords: all.length
  };
  cache.put('dash_filter_options', JSON.stringify(result), CONFIG.CACHE_TTL_SECONDS);
  return result;
}

// ---------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------
function getDashboardKPIs(filters) {
  var todayKey = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var all = getFilteredObjects_(filters);
  var today = all.filter(function (o) { return dateKey_(o.date) === todayKey; });

  function totals(arr) {
    var t = { prod: 0, checked: 0, defective: 0, reject: 0 };
    arr.forEach(function (o) {
      t.prod += o.prodQty; t.checked += o.checkQty; t.defective += o.defectiveQty; t.reject += o.rejectQty;
    });
    t.dhu = Math.round(safeDiv_(t.defective, t.checked) * 10000) / 100;
    return t;
  }

  var todayTotals = totals(today);
  var buyers = {}, styles = {}, qis = {}, falseCount = 0;
  all.forEach(function (o) {
    if (o.buyer) buyers[o.buyer] = true;
    if (o.style) styles[o.buyer + '||' + o.style] = true;
    if (o.qi) qis[o.qi] = true;
    if (o.status && o.status !== STATUS.OK) falseCount++;
  });

  return {
    todayProduction: todayTotals.prod,
    todayChecked: todayTotals.checked,
    todayDefective: todayTotals.defective,
    todayReject: todayTotals.reject,
    todayDhu: todayTotals.dhu,
    totalBuyers: Object.keys(buyers).length,
    totalStyles: Object.keys(styles).length,
    totalQIs: Object.keys(qis).length,
    falseReportingCount: falseCount,
    totalRecordsInFilter: all.length
  };
}

// ---------------------------------------------------------------------
// Style Summary - grouped by Buyer+Style
// ---------------------------------------------------------------------
function getStyleSummary(filters) {
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    if (!o.style) return;
    var key = o.buyer + '||' + o.style;
    if (!groups[key]) {
      groups[key] = {
        buyer: o.buyer, style: o.style, orderQty: 0, prodQty: 0, checkQty: 0,
        passQty: 0, defectiveQty: 0, rejectQty: 0, rectifiedQty: 0,
        qiSet: {}, hourSet: {}
      };
    }
    var g = groups[key];
    g.orderQty = Math.max(g.orderQty, o.orderQty);
    g.prodQty += o.prodQty;
    g.checkQty += o.checkQty;
    g.passQty += o.passQty;
    g.defectiveQty += o.defectiveQty;
    g.rejectQty += o.rejectQty;
    g.rectifiedQty += o.rectifiedQty;
    if (o.qi) g.qiSet[o.qi] = true;
    g.hourSet[dateKey_(o.date) + '|' + o.hour] = true;
  });

  return Object.keys(groups).map(function (key) {
    var g = groups[key];
    return {
      buyer: g.buyer, style: g.style, orderQty: g.orderQty, prodQty: g.prodQty,
      checkQty: g.checkQty, passQty: g.passQty, defectiveQty: g.defectiveQty,
      rejectQty: g.rejectQty, rectifiedQty: g.rectifiedQty,
      dhu: Math.round(safeDiv_(g.defectiveQty, g.checkQty) * 10000) / 100,
      checkedBy: Object.keys(g.qiSet).sort(),
      inspectionHours: Object.keys(g.hourSet).length
    };
  }).sort(function (a, b) { return b.checkQty - a.checkQty; });
}

// ---------------------------------------------------------------------
// Buyer Summary
// ---------------------------------------------------------------------
function getBuyerSummary(filters) {
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    if (!o.buyer) return;
    if (!groups[o.buyer]) {
      groups[o.buyer] = { buyer: o.buyer, styleSet: {}, prodQty: 0, checkQty: 0, defectiveQty: 0, rejectQty: 0, defectSums: {} };
    }
    var g = groups[o.buyer];
    if (o.style) g.styleSet[o.style] = true;
    g.prodQty += o.prodQty;
    g.checkQty += o.checkQty;
    g.defectiveQty += o.defectiveQty;
    g.rejectQty += o.rejectQty;
    if (o.defectName) g.defectSums[o.defectName] = (g.defectSums[o.defectName] || 0) + o.defectQty;
  });

  return Object.keys(groups).map(function (buyer) {
    var g = groups[buyer];
    var topDefect = topKeyByValue_(g.defectSums);
    return {
      buyer: buyer,
      numStyles: Object.keys(g.styleSet).length,
      prodQty: g.prodQty,
      checkQty: g.checkQty,
      defectiveQty: g.defectiveQty,
      rejectQty: g.rejectQty,
      dhu: Math.round(safeDiv_(g.defectiveQty, g.checkQty) * 10000) / 100,
      topDefect: topDefect || '-'
    };
  }).sort(function (a, b) { return b.checkQty - a.checkQty; });
}

function topKeyByValue_(obj) {
  var bestKey = null, bestVal = -Infinity;
  Object.keys(obj).forEach(function (k) { if (obj[k] > bestVal) { bestVal = obj[k]; bestKey = k; } });
  return bestKey;
}

// ---------------------------------------------------------------------
// QI Performance
// Rank = by Checked Qty descending (1 = highest volume). Adjust the
// sort key in the .sort() call below if you'd rather rank by DHU.
// ---------------------------------------------------------------------
function getQIPerformance(filters) {
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    if (!o.qi) return;
    if (!groups[o.qi]) {
      groups[o.qi] = {
        qi: o.qi, checkQty: 0, prodQty: 0, defectiveQty: 0, rejectQty: 0, rectifiedQty: 0,
        styleSet: {}, buyerSet: {}, recordCount: 0, falseCount: 0
      };
    }
    var g = groups[o.qi];
    g.checkQty += o.checkQty;
    g.prodQty += o.prodQty;
    g.defectiveQty += o.defectiveQty;
    g.rejectQty += o.rejectQty;
    g.rectifiedQty += o.rectifiedQty;
    if (o.style) g.styleSet[o.style] = true;
    if (o.buyer) g.buyerSet[o.buyer] = true;
    g.recordCount++;
    if (o.status && o.status !== STATUS.OK) g.falseCount++;
  });

  var list = Object.keys(groups).map(function (qi) {
    var g = groups[qi];
    return {
      qi: qi,
      checkQty: g.checkQty,
      prodQty: g.prodQty,
      numStyles: Object.keys(g.styleSet).length,
      numBuyers: Object.keys(g.buyerSet).length,
      defectiveQty: g.defectiveQty,
      rejectQty: g.rejectQty,
      rectifiedQty: g.rectifiedQty,
      avgCheckedQty: Math.round(safeDiv_(g.checkQty, g.recordCount) * 100) / 100,
      dhu: Math.round(safeDiv_(g.defectiveQty, g.checkQty) * 10000) / 100,
      falseReportingCount: g.falseCount
    };
  }).sort(function (a, b) { return b.checkQty - a.checkQty; });

  list.forEach(function (item, i) { item.rank = i + 1; });
  return list;
}

// ---------------------------------------------------------------------
// Hourly Analysis - grouped by hour-of-day slot across the filtered range
// ---------------------------------------------------------------------
function getHourlyAnalysis(filters) {
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    if (!o.hour) return;
    if (!groups[o.hour]) {
      groups[o.hour] = { hour: o.hour, prodQty: 0, checkQty: 0, defectiveQty: 0, rejectQty: 0, defectSums: {}, styleSums: {}, qiSums: {} };
    }
    var g = groups[o.hour];
    g.prodQty += o.prodQty;
    g.checkQty += o.checkQty;
    g.defectiveQty += o.defectiveQty;
    g.rejectQty += o.rejectQty;
    if (o.defectName) g.defectSums[o.defectName] = (g.defectSums[o.defectName] || 0) + o.defectQty;
    if (o.style) g.styleSums[o.style] = (g.styleSums[o.style] || 0) + o.checkQty;
    if (o.qi) g.qiSums[o.qi] = (g.qiSums[o.qi] || 0) + o.checkQty;
  });

  return Object.keys(groups).sort().map(function (hour) {
    var g = groups[hour];
    return {
      hour: hour, prodQty: g.prodQty, checkQty: g.checkQty, defectiveQty: g.defectiveQty, rejectQty: g.rejectQty,
      dhu: Math.round(safeDiv_(g.defectiveQty, g.checkQty) * 10000) / 100,
      topDefect: topKeyByValue_(g.defectSums) || '-',
      topStyle: topKeyByValue_(g.styleSums) || '-',
      topQI: topKeyByValue_(g.qiSums) || '-'
    };
  });
}

// ---------------------------------------------------------------------
// Line Performance
// ---------------------------------------------------------------------
function getLinePerformance(filters) {
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    if (!o.line) return;
    if (!groups[o.line]) {
      groups[o.line] = { line: o.line, prodQty: 0, checkQty: 0, defectiveQty: 0, defectSums: {}, qiSums: {} };
    }
    var g = groups[o.line];
    g.prodQty += o.prodQty;
    g.checkQty += o.checkQty;
    g.defectiveQty += o.defectiveQty;
    if (o.defectName) g.defectSums[o.defectName] = (g.defectSums[o.defectName] || 0) + o.defectQty;
    if (o.qi) g.qiSums[o.qi] = (g.qiSums[o.qi] || 0) + o.checkQty;
  });

  return Object.keys(groups).sort().map(function (line) {
    var g = groups[line];
    return {
      line: line, prodQty: g.prodQty, checkQty: g.checkQty, defectiveQty: g.defectiveQty,
      dhu: Math.round(safeDiv_(g.defectiveQty, g.checkQty) * 10000) / 100,
      topDefect: topKeyByValue_(g.defectSums) || '-',
      topQI: topKeyByValue_(g.qiSums) || '-'
    };
  });
}

// ---------------------------------------------------------------------
// Top-N leaderboards (thin wrappers over the summaries above)
// ---------------------------------------------------------------------
function getTopDefects(filters, n) {
  n = n || 10;
  var all = getFilteredObjects_(filters);
  var sums = {};
  all.forEach(function (o) { if (o.defectName) sums[o.defectName] = (sums[o.defectName] || 0) + o.defectQty; });
  return Object.keys(sums).map(function (k) { return { name: k, qty: sums[k] }; })
    .sort(function (a, b) { return b.qty - a.qty; }).slice(0, n);
}

function getTopStylesByDhu(filters, n) {
  n = n || 10;
  return getStyleSummary(filters).filter(function (s) { return s.checkQty > 0; })
    .sort(function (a, b) { return b.dhu - a.dhu; }).slice(0, n);
}

function getTopBuyersByDhu(filters, n) {
  n = n || 10;
  return getBuyerSummary(filters).filter(function (b) { return b.checkQty > 0; })
    .sort(function (a, b) { return b.dhu - a.dhu; }).slice(0, n);
}

function getTopQIsByChecked(filters, n) {
  n = n || 10;
  return getQIPerformance(filters).slice(0, n); // already sorted by checkQty desc
}

function getTopQIsByDhu(filters, n) {
  n = n || 10;
  return getQIPerformance(filters).filter(function (q) { return q.checkQty > 0; })
    .sort(function (a, b) { return b.dhu - a.dhu; }).slice(0, n);
}

function getTopQIsByFalseReporting(filters, n) {
  n = n || 10;
  return getQIPerformance(filters).filter(function (q) { return q.falseReportingCount > 0; })
    .sort(function (a, b) { return b.falseReportingCount - a.falseReportingCount; }).slice(0, n);
}

// ---------------------------------------------------------------------
// Trend data (Daily / Weekly / Monthly / Hourly DHU, Defect / Reject /
// Rectified trend). groupBy: 'day' | 'week' | 'month'
// ---------------------------------------------------------------------
function trendBucketKey_(o, groupBy) {
  var dk = dateKey_(o.date);
  if (!dk) return null;
  if (groupBy === 'day') return dk;
  var d = new Date(dk + 'T00:00:00');
  if (groupBy === 'month') return dk.substring(0, 7); // yyyy-MM
  if (groupBy === 'week') {
    var onejan = new Date(d.getFullYear(), 0, 1);
    var week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return d.getFullYear() + '-W' + (week < 10 ? '0' + week : week);
  }
  return dk;
}

function getTrendData(filters, groupBy) {
  groupBy = groupBy || 'day';
  var all = getFilteredObjects_(filters);
  var groups = {};
  all.forEach(function (o) {
    var key = trendBucketKey_(o, groupBy);
    if (!key) return;
    if (!groups[key]) groups[key] = { checkQty: 0, defectiveQty: 0, rejectQty: 0, rectifiedQty: 0 };
    groups[key].checkQty += o.checkQty;
    groups[key].defectiveQty += o.defectiveQty;
    groups[key].rejectQty += o.rejectQty;
    groups[key].rectifiedQty += o.rectifiedQty;
  });

  var labels = Object.keys(groups).sort();
  return {
    labels: labels,
    dhu: labels.map(function (k) { return Math.round(safeDiv_(groups[k].defectiveQty, groups[k].checkQty) * 10000) / 100; }),
    defective: labels.map(function (k) { return groups[k].defectiveQty; }),
    reject: labels.map(function (k) { return groups[k].rejectQty; }),
    rectified: labels.map(function (k) { return groups[k].rectifiedQty; }),
    checked: labels.map(function (k) { return groups[k].checkQty; })
  };
}

// ---------------------------------------------------------------------
// False Reporting table (flagged records with the reason note)
// ---------------------------------------------------------------------
function getFlaggedRecords(filters, limit) {
  limit = limit || 500;
  var sheet = getSheet_(CONFIG.SHEET_RAW_DATA);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var all = getRawDataObjects_().filter(function (o) { return matchesFilters_(o, filters) && o.status !== STATUS.OK; });
  all.sort(function (a, b) { return b._row - a._row; }); // most recent first
  var limited = all.slice(0, limit);

  if (limited.length === 0) return [];
  var rows = limited.map(function (o) { return o._row; });
  var minRow = Math.min.apply(null, rows), maxRow = Math.max.apply(null, rows);
  var notesRange = sheet.getRange(minRow, COL.STATUS, maxRow - minRow + 1, 1).getNotes();

  return limited.map(function (o) {
    return {
      date: dateKey_(o.date), hour: o.hour, line: o.line, qi: o.qi, buyer: o.buyer, style: o.style,
      checkQty: o.checkQty, passQty: o.passQty, defectiveQty: o.defectiveQty, rejectQty: o.rejectQty,
      rectifiedQty: o.rectifiedQty, status: o.status, reason: notesRange[o._row - minRow][0] || '', recordId: o.recordId
    };
  });
}

function getProductionVsChecked(filters) {
  // Simple two-series comparison for the Overview chart, bucketed daily.
  var t = getTrendData(filters, 'day');
  var all = getFilteredObjects_(filters);
  var prodByDay = {};
  all.forEach(function (o) {
    var k = dateKey_(o.date);
    if (!k) return;
    prodByDay[k] = (prodByDay[k] || 0) + o.prodQty;
  });
  return {
    labels: t.labels,
    production: t.labels.map(function (k) { return prodByDay[k] || 0; }),
    checked: t.checked
  };
}
