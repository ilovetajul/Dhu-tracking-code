/**
 * Entry.gs
 * -----------------------------------------------------------------------
 * Server-side functions called from Form.html via google.script.run.
 * Handles dropdown data for the entry form and validated row inserts
 * into Raw Data. No formulas are ever written - every computed value
 * is produced by Utils.gs and written as a plain value.
 * -----------------------------------------------------------------------
 */

/**
 * Returns everything the Form needs to render its dropdowns, including
 * a Buyer -> Styles history map so the Style field can auto-filter/
 * autocomplete based on what's already been seen for that buyer, while
 * still allowing free-text entry for brand-new styles.
 */
function getFormMasterData() {
  var master = getOrCreateSheet_(CONFIG.SHEET_MASTER);
  ensureMasterHeaders_(master);
  var lists = readMasterLists_(master);

  var buyerStyles = {};
  var raw = getSheet_(CONFIG.SHEET_RAW_DATA);
  if (raw) {
    var lastRow = raw.getLastRow();
    if (lastRow > 1) {
      var values = raw.getRange(2, 1, lastRow - 1, RAW_DATA_NUM_COLS).getValues();
      values.forEach(function (row) {
        var o = rowToObject_(row);
        if (!o.buyer) return;
        if (!buyerStyles[o.buyer]) buyerStyles[o.buyer] = {};
        if (o.style) buyerStyles[o.buyer][o.style] = true;
      });
    }
  }
  Object.keys(buyerStyles).forEach(function (b) {
    buyerStyles[b] = Object.keys(buyerStyles[b]).sort();
  });

  return {
    lines: lists.lines,
    buyers: lists.buyers,
    qiNames: lists.qiNames,
    defectNames: lists.defectNames,
    hourSlots: lists.hourSlots,
    buyerStyles: buyerStyles,
    today: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd')
  };
}

/**
 * Adds a brand-new value typed by the user (a new Buyer, Line, Style,
 * QI, or Defect Name not yet in Master Lists) so it shows up in
 * dropdowns going forward. Silently ignores duplicates.
 */
function addNewMasterValue(type, value) {
  value = str_(value);
  if (!value) return { ok: true };
  var master = getOrCreateSheet_(CONFIG.SHEET_MASTER);
  ensureMasterHeaders_(master);
  var lists = readMasterLists_(master);
  var key = { line: 'lines', buyer: 'buyers', qi: 'qiNames', defect: 'defectNames' }[type];
  if (!key) return { ok: false, error: 'Unknown master list type: ' + type };
  if (lists[key].indexOf(value) === -1) {
    lists[key].push(value);
    lists[key].sort();
    writeMasterLists_(master, lists);
  }
  return { ok: true };
}

var REQUIRED_FIELDS_ = ['date', 'hour', 'line', 'qi', 'buyer', 'style', 'checkQty'];

/**
 * Validates and appends one inspection record. Basic data-entry
 * hygiene (required fields present, quantities non-negative) is
 * enforced here and CAN block submission. Business-rule problems
 * (false reporting, mismatches, etc.) are intentionally NOT blocked -
 * they are detected afterward and flagged, because catching them is
 * the point of the system, not preventing an honest entry.
 */
function submitInspectionRecord(form) {
  try {
    var missing = REQUIRED_FIELDS_.filter(function (f) { return !str_(form[f]); });
    if (missing.length > 0) {
      return { ok: false, error: 'Missing required field(s): ' + missing.join(', ') };
    }

    var qtyFields = ['orderQty', 'prodQty', 'checkQty', 'passQty', 'defectiveQty', 'defectQty', 'rectifiedQty', 'rejectQty'];
    for (var i = 0; i < qtyFields.length; i++) {
      var v = num_(form[qtyFields[i]]);
      if (v < 0) return { ok: false, error: 'Quantities cannot be negative (' + qtyFields[i] + ').' };
    }

    var sheet = getOrCreateSheet_(CONFIG.SHEET_RAW_DATA);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, RAW_DATA_NUM_COLS).setValues([RAW_DATA_HEADERS]);
      formatRawDataSheet_(sheet);
    }

    var recordId = makeRecordId_();
    var newRow = [
      form.date, str_(form.hour), str_(form.line), str_(form.qi), str_(form.buyer), str_(form.style),
      num_(form.orderQty), num_(form.prodQty), num_(form.checkQty), num_(form.passQty),
      num_(form.defectiveQty), str_(form.defectName), num_(form.defectQty), num_(form.rectifiedQty),
      num_(form.rejectQty), str_(form.remarks),
      0, 0, 0, 0, '', recordId // computed columns, filled in below
    ];

    var rowIndex = sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, 1, 1, RAW_DATA_NUM_COLS).setValues([newRow]);

    // A new row can change the status of OTHER existing rows too (e.g.
    // it might complete a time-conflict, or push a QI's hourly total
    // over the realistic limit). Below AUTO_FULL_RECALC_ROW_LIMIT we
    // recalculate the whole sheet so that propagates immediately.
    // Above it, we only recalculate the new row itself (still checked
    // for duplicates/conflicts/limits against the FULL dataset - just
    // not re-writing every other row's cells every submission) to keep
    // data entry fast on very large sheets; run "Recalculate All
    // Records" periodically to fully reconcile older rows.
    var totalDataRows = sheet.getLastRow() - 1;
    if (totalDataRows <= CONFIG.AUTO_FULL_RECALC_ROW_LIMIT) {
      recalculateRows_(sheet, 2, totalDataRows);
    } else {
      recalculateRows_(sheet, rowIndex, 1);
    }

    // Auto-learn new dropdown values so future entries can pick them.
    addNewMasterValue('line', form.line);
    addNewMasterValue('buyer', form.buyer);
    addNewMasterValue('qi', form.qi);
    if (form.defectName) addNewMasterValue('defect', form.defectName);

    CacheService.getScriptCache().removeAll(['dash_filter_options']);

    var statusCell = sheet.getRange(rowIndex, COL.STATUS).getValue();
    var statusNote = sheet.getRange(rowIndex, COL.STATUS).getNote();

    return { ok: true, status: statusCell, reason: statusNote, recordId: recordId };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
