/**
 * Utils.gs
 * -----------------------------------------------------------------------
 * Central configuration, column map, and the false-reporting / status
 * detection engine. Every other file reads column positions from COL
 * and business thresholds from CONFIG, so this file is the single
 * source of truth for the data model. Change values here, not in
 * individual functions elsewhere.
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// CONFIG - tune these to your factory's reality
// ---------------------------------------------------------------------
var CONFIG = {
  SHEET_RAW_DATA: 'Raw Data',
  SHEET_MASTER: 'Master Lists',

  // A single QI checking more than this many pieces in ONE hour
  // (summed across all styles they checked that hour) is treated as
  // an unrealistic / false report. Adjust to your line speed.
  MAX_HOURLY_CHECK_QTY_PER_QI: 400,

  // DHU% above this, with no other hard rule broken, is flagged as
  // CHECK REQUIRED (soft warning, not a hard violation).
  HIGH_DHU_ALERT_PERCENT: 10,

  CACHE_TTL_SECONDS: 300,
  TIMEZONE: 'Asia/Dhaka',

  // Below this many data rows, every new submission triggers a FULL
  // recalculation pass so cross-row flags (TIME CONFLICT, hourly
  // unrealistic-qty FALSE REPORT) update on every sibling row instantly.
  // Above it, a new submission only computes/writes its OWN row (still
  // checked for duplicates/conflicts against the full dataset - just
  // not re-writing every other row every time) to stay fast at scale.
  // Run "Recalculate All Records" periodically (e.g. end of shift) to
  // fully reconcile cross-row flags on very large sheets.
  AUTO_FULL_RECALC_ROW_LIMIT: 5000
};

// ---------------------------------------------------------------------
// Raw Data column map (1-indexed, matches sheet columns A..V)
// ---------------------------------------------------------------------
var COL = {
  DATE: 1,
  HOUR: 2,
  LINE: 3,
  QI: 4,
  BUYER: 5,
  STYLE: 6,
  ORDER_QTY: 7,
  PROD_QTY: 8,
  CHECK_QTY: 9,
  PASS_QTY: 10,
  DEFECTIVE_QTY: 11,
  DEFECT_NAME: 12,
  DEFECT_QTY: 13,
  RECTIFIED_QTY: 14,
  REJECT_QTY: 15,
  REMARKS: 16,
  DIFF: 17,          // QC Check Qty - Production Qty
  PASS_PLUS_DEF: 18, // Pass Qty + Defective Qty
  BALANCE: 19,       // Defective Qty - Rectified Qty - Reject Qty
  DHU: 20,           // (Defective Qty / QC Check Qty) * 100
  STATUS: 21,
  RECORD_ID: 22
};
var RAW_DATA_NUM_COLS = 22;

var RAW_DATA_HEADERS = [
  'Date', 'Hour', 'Line', 'QI Name', 'Buyer', 'Style',
  'Order Qty', 'Production Qty', 'QC Check Qty', 'Pass Qty',
  'Defective Qty', 'Defect Name', 'Defect Qty', 'Rectified Qty',
  'Reject Qty', 'Remarks',
  'Difference (QC-Prod)', 'Pass+Defective', 'Balance Qty', 'DHU %',
  'Status', 'Record ID'
];

var STATUS = {
  OK: 'OK',
  CHECK_REQUIRED: 'CHECK REQUIRED',
  FALSE_REPORT: 'FALSE REPORT',
  TIME_CONFLICT: 'TIME CONFLICT',
  MISMATCH: 'PASS/DEFECT MISMATCH',
  RECTIFIED_ERROR: 'RECTIFIED ERROR',
  DUPLICATE: 'DUPLICATE ENTRY'
};

// Background colors used to highlight flagged rows on the Raw Data sheet.
var STATUS_COLORS = {
  OK: '#ffffff',
  'CHECK REQUIRED': '#fff3cd',
  'FALSE REPORT': '#f8d7da',
  'TIME CONFLICT': '#f8d7da',
  'PASS/DEFECT MISMATCH': '#f8d7da',
  'RECTIFIED ERROR': '#f8d7da',
  'DUPLICATE ENTRY': '#f8d7da'
};

var MASTER_HEADERS = ['Lines', 'Buyers', 'QI Names', 'Defect Names', 'Hour Slots'];

// ---------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------
function num_(v) {
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function str_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function safeDiv_(a, b) {
  return b > 0 ? (a / b) : 0;
}

function dateKey_(dateVal) {
  // Normalizes a Date object or date-like string to 'yyyy-MM-dd' for
  // grouping/comparison, using the script time zone.
  if (!dateVal) return '';
  var d = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return str_(dateVal);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function makeRecordId_() {
  return Utilities.getUuid().substring(0, 8).toUpperCase();
}

function compositeInspectionKey_(rowObj) {
  // One inspection = one Date+Hour+Line+QI+Buyer+Style combination.
  return [dateKey_(rowObj.date), rowObj.hour, rowObj.line, rowObj.qi, rowObj.buyer, rowObj.style]
    .join('||').toLowerCase();
}

function qiHourKey_(rowObj) {
  return [dateKey_(rowObj.date), rowObj.hour, rowObj.qi].join('||').toLowerCase();
}

/**
 * Converts a raw sheet row (array) into a friendly object using COL.
 * Index math is 0-based here since `row` is a plain array slice.
 */
function rowToObject_(row) {
  return {
    date: row[COL.DATE - 1],
    hour: str_(row[COL.HOUR - 1]),
    line: str_(row[COL.LINE - 1]),
    qi: str_(row[COL.QI - 1]),
    buyer: str_(row[COL.BUYER - 1]),
    style: str_(row[COL.STYLE - 1]),
    orderQty: num_(row[COL.ORDER_QTY - 1]),
    prodQty: num_(row[COL.PROD_QTY - 1]),
    checkQty: num_(row[COL.CHECK_QTY - 1]),
    passQty: num_(row[COL.PASS_QTY - 1]),
    defectiveQty: num_(row[COL.DEFECTIVE_QTY - 1]),
    defectName: str_(row[COL.DEFECT_NAME - 1]),
    defectQty: num_(row[COL.DEFECT_QTY - 1]),
    rectifiedQty: num_(row[COL.RECTIFIED_QTY - 1]),
    rejectQty: num_(row[COL.REJECT_QTY - 1]),
    remarks: str_(row[COL.REMARKS - 1]),
    diff: num_(row[COL.DIFF - 1]),
    passPlusDef: num_(row[COL.PASS_PLUS_DEF - 1]),
    balance: num_(row[COL.BALANCE - 1]),
    dhu: num_(row[COL.DHU - 1]),
    status: str_(row[COL.STATUS - 1]) || STATUS.OK,
    recordId: str_(row[COL.RECORD_ID - 1])
  };
}

// ---------------------------------------------------------------------
// Core per-row calculations (pure functions, no sheet access)
// ---------------------------------------------------------------------
function calcDifference_(o) { return o.checkQty - o.prodQty; }
function calcPassPlusDefective_(o) { return o.passQty + o.defectiveQty; }
function calcBalance_(o) { return o.defectiveQty - o.rectifiedQty - o.rejectQty; }
function calcDhu_(o) { return safeDiv_(o.defectiveQty, o.checkQty) * 100; }

/**
 * -----------------------------------------------------------------------
 * FALSE REPORTING / STATUS ENGINE
 * -----------------------------------------------------------------------
 * Evaluates the ENTIRE Raw Data set at once (not row-by-row against the
 * whole sheet) so it stays fast at 50,000+ rows: O(n) with lookup maps,
 * not O(n^2).
 *
 * Rule -> Status mapping (first match wins per row, most severe first):
 *   1. Duplicate Date+Hour+Line+QI+Buyer+Style combo   -> DUPLICATE ENTRY
 *   2. Same QI, same Date+Hour, different Lines         -> TIME CONFLICT
 *   3. Checked Qty > Production Qty                     -> FALSE REPORT
 *   4. Same QI checking unrealistic qty in one hour      -> FALSE REPORT
 *   5. Pass Qty + Defective Qty != Checked Qty           -> PASS/DEFECT MISMATCH
 *   6. Rectified Qty > Defective Qty                     -> RECTIFIED ERROR
 *   7. Reject Qty > Defective Qty                        -> RECTIFIED ERROR
 *   8. High DHU% with no hard rule broken (soft warning)  -> CHECK REQUIRED
 *   9. Nothing triggered                                  -> OK
 *
 * Returns: array of { rowIndex (1-based incl header), status, reason }
 * -----------------------------------------------------------------------
 */
function evaluateAllRows_(objects) {
  // objects: array of {rowIndex, o: rowObject}
  var seenKeys = {};        // compositeKey -> first rowIndex seen
  var qiHourLines = {};     // qiHourKey -> Set of lines
  var qiHourCheckSum = {};  // qiHourKey -> summed checkQty

  objects.forEach(function (item) {
    var o = item.o;
    var key = compositeInspectionKey_(o);
    var qhKey = qiHourKey_(o);

    if (!seenKeys[key]) seenKeys[key] = [];
    seenKeys[key].push(item.rowIndex);

    if (!qiHourLines[qhKey]) qiHourLines[qhKey] = {};
    if (o.line) qiHourLines[qhKey][o.line] = true;

    qiHourCheckSum[qhKey] = (qiHourCheckSum[qhKey] || 0) + o.checkQty;
  });

  var results = [];
  objects.forEach(function (item) {
    var o = item.o;
    var key = compositeInspectionKey_(o);
    var qhKey = qiHourKey_(o);
    var status = STATUS.OK;
    var reasons = [];

    var isDuplicate = seenKeys[key] && seenKeys[key].length > 1 && seenKeys[key][0] !== item.rowIndex;
    var linesForQiHour = Object.keys(qiHourLines[qhKey] || {});
    var isTimeConflict = linesForQiHour.length > 1;
    var checkGtProd = o.prodQty > 0 && o.checkQty > o.prodQty;
    var unrealisticQty = (qiHourCheckSum[qhKey] || 0) > CONFIG.MAX_HOURLY_CHECK_QTY_PER_QI;
    var passDefMismatch = calcPassPlusDefective_(o) !== o.checkQty;
    var rectifiedGtDef = o.rectifiedQty > o.defectiveQty;
    var rejectGtDef = o.rejectQty > o.defectiveQty;
    var dhu = calcDhu_(o);
    var highDhu = dhu > CONFIG.HIGH_DHU_ALERT_PERCENT;

    if (isDuplicate) {
      status = STATUS.DUPLICATE;
      reasons.push('Identical Date+Hour+Line+QI+Buyer+Style already recorded in another row.');
    } else if (isTimeConflict) {
      status = STATUS.TIME_CONFLICT;
      reasons.push('QI "' + o.qi + '" is recorded on multiple lines (' + linesForQiHour.join(', ') + ') during the same hour.');
    } else if (checkGtProd) {
      status = STATUS.FALSE_REPORT;
      reasons.push('QC Check Qty (' + o.checkQty + ') exceeds Production Qty (' + o.prodQty + ').');
    } else if (unrealisticQty) {
      status = STATUS.FALSE_REPORT;
      reasons.push('QI "' + o.qi + '" checked ' + qiHourCheckSum[qhKey] + ' pcs in one hour (limit ' + CONFIG.MAX_HOURLY_CHECK_QTY_PER_QI + ').');
    } else if (passDefMismatch) {
      status = STATUS.MISMATCH;
      reasons.push('Pass Qty + Defective Qty (' + calcPassPlusDefective_(o) + ') does not equal QC Check Qty (' + o.checkQty + ').');
    } else if (rectifiedGtDef) {
      status = STATUS.RECTIFIED_ERROR;
      reasons.push('Rectified Qty (' + o.rectifiedQty + ') exceeds Defective Qty (' + o.defectiveQty + ').');
    } else if (rejectGtDef) {
      status = STATUS.RECTIFIED_ERROR;
      reasons.push('Reject Qty (' + o.rejectQty + ') exceeds Defective Qty (' + o.defectiveQty + ').');
    } else if (highDhu) {
      status = STATUS.CHECK_REQUIRED;
      reasons.push('DHU is ' + dhu.toFixed(1) + '%, above the ' + CONFIG.HIGH_DHU_ALERT_PERCENT + '% alert threshold. Not a hard violation - please verify.');
    }

    if (o.defectQty !== o.defectiveQty && o.defectiveQty > 0) {
      // Soft note only; does not override a more severe status already set.
      reasons.push('Defect Qty (' + o.defectQty + ') differs from Defective Qty (' + o.defectiveQty + ').');
      if (status === STATUS.OK) status = STATUS.CHECK_REQUIRED;
    }

    results.push({
      rowIndex: item.rowIndex,
      status: status,
      reason: reasons.join(' ')
    });
  });

  return results;
}

/**
 * Recalculates computed columns (Difference, Pass+Defective, Balance,
 * DHU%, Status) plus Record ID for the given row range, and applies
 * red highlighting to flagged rows. Used both by the single-row submit
 * path and the "Recalculate All" menu action.
 *
 * @param {Sheet} sheet   Raw Data sheet
 * @param {number} startRow 1-based row to start at (>=2, header is row 1)
 * @param {number} numRows  number of data rows to process (use sheet.getLastRow()-1 for all)
 */
function recalculateRows_(sheet, startRow, numRows) {
  if (numRows <= 0) return;

  // Status/duplicate/time-conflict detection needs the FULL dataset for
  // context (a duplicate of a row far above still counts), so we always
  // read the whole sheet for evaluation, but only WRITE the requested
  // range back - this keeps writes cheap while detection stays accurate.
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var allValues = sheet.getRange(2, 1, lastRow - 1, RAW_DATA_NUM_COLS).getValues();
  var allObjects = allValues.map(function (row, i) {
    return { rowIndex: i + 2, o: rowToObject_(row) };
  });

  // Assign Record IDs to any rows missing one (new rows).
  allObjects.forEach(function (item) {
    if (!item.o.recordId) {
      item.o.recordId = makeRecordId_();
    }
  });

  var statusResults = evaluateAllRows_(allObjects);
  var statusByRow = {};
  statusResults.forEach(function (r) { statusByRow[r.rowIndex] = r; });

  var writeStart = startRow;
  var writeEnd = startRow + numRows - 1;

  var outputRows = [];
  var noteRows = [];
  var colorRows = [];

  for (var i = 0; i < allObjects.length; i++) {
    var item = allObjects[i];
    if (item.rowIndex < writeStart || item.rowIndex > writeEnd) continue;
    var o = item.o;
    var diff = calcDifference_(o);
    var passPlusDef = calcPassPlusDefective_(o);
    var balance = calcBalance_(o);
    var dhu = calcDhu_(o);
    var statusInfo = statusByRow[item.rowIndex] || { status: STATUS.OK, reason: '' };

    outputRows.push([diff, passPlusDef, balance, Math.round(dhu * 100) / 100, statusInfo.status, o.recordId]);
    noteRows.push(statusInfo.reason);
    colorRows.push(STATUS_COLORS[statusInfo.status] || '#ffffff');
  }

  if (outputRows.length === 0) return;

  var targetRange = sheet.getRange(writeStart, COL.DIFF, outputRows.length, 6);
  targetRange.setValues(outputRows);

  // Notes on the Status cell explain WHY a row was flagged, without
  // needing an extra visible column.
  var statusRange = sheet.getRange(writeStart, COL.STATUS, outputRows.length, 1);
  var statusNotes = noteRows.map(function (r) { return [r]; });
  statusRange.setNotes(statusNotes);

  // Highlight the full row red-ish when flagged, white when OK.
  var fullRowRange = sheet.getRange(writeStart, 1, outputRows.length, RAW_DATA_NUM_COLS);
  var backgrounds = colorRows.map(function (c) {
    var arr = [];
    for (var j = 0; j < RAW_DATA_NUM_COLS; j++) arr.push(c);
    return arr;
  });
  fullRowRange.setBackgrounds(backgrounds);
}

/**
 * Reads the Master Lists sheet (5 columns: Lines, Buyers, QI Names,
 * Defect Names, Hour Slots) into arrays, skipping blank cells.
 */
function readMasterLists_(master) {
  var lastRow = master.getLastRow();
  var result = { lines: [], buyers: [], qiNames: [], defectNames: [], hourSlots: [] };
  if (lastRow < 2) return result;
  var values = master.getRange(2, 1, lastRow - 1, MASTER_HEADERS.length).getValues();
  values.forEach(function (row) {
    if (str_(row[0])) result.lines.push(str_(row[0]));
    if (str_(row[1])) result.buyers.push(str_(row[1]));
    if (str_(row[2])) result.qiNames.push(str_(row[2]));
    if (str_(row[3])) result.defectNames.push(str_(row[3]));
    if (str_(row[4])) result.hourSlots.push(str_(row[4]));
  });
  return result;
}

/**
 * Writes 5 parallel lists back into Master Lists, one per column,
 * padding shorter columns with blanks. Overwrites the whole data range.
 */
function writeMasterLists_(master, lists) {
  var maxLen = Math.max(lists.lines.length, lists.buyers.length, lists.qiNames.length,
    lists.defectNames.length, lists.hourSlots.length, 1);
  var out = [];
  for (var i = 0; i < maxLen; i++) {
    out.push([
      lists.lines[i] || '', lists.buyers[i] || '', lists.qiNames[i] || '',
      lists.defectNames[i] || '', lists.hourSlots[i] || ''
    ]);
  }
  var lastRow = master.getLastRow();
  if (lastRow > 1) {
    master.getRange(2, 1, lastRow - 1, MASTER_HEADERS.length).clearContent();
  }
  master.getRange(2, 1, out.length, MASTER_HEADERS.length).setValues(out);
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name);
}

function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}
