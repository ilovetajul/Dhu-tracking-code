/**
 * Code.gs
 * -----------------------------------------------------------------------
 * Menu, dialog launchers, one-time setup / migration of the Raw Data
 * sheet into the canonical column layout, and the optional Web App
 * entry point (doGet). This is the file Apps Script runs first.
 * -----------------------------------------------------------------------
 */

function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('QC Management System')
    .addItem('📊 Open Dashboard', 'openDashboard')
    .addItem('📝 Open Data Entry Form', 'openForm')
    .addItem('🧭 Open Launcher Sidebar', 'openSidebar')
    .addSeparator()
    .addItem('⚙️ Setup / Initialize System', 'runInitialSetup')
    .addItem('🔄 Rebuild Master Lists from Raw Data', 'rebuildMasterLists')
    .addItem('🧮 Recalculate All Records', 'recalculateAllRecords')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

/**
 * Simple trigger: keeps computed columns in sync if someone edits Raw
 * Data cells by hand instead of using the form. Only reacts to edits
 * in the 16 raw input columns (never the computed columns themselves,
 * to avoid recursive triggering) and only for small, deliberate edits
 * (a handful of rows) - large pastes should be followed up with the
 * "Recalculate All Records" menu item for performance.
 */
function onEdit(e) {
  try {
    var sheet = e.range.getSheet();
    if (sheet.getName() !== CONFIG.SHEET_RAW_DATA) return;
    if (e.range.getRow() < 2) return; // header row
    if (e.range.getColumn() > COL.REMARKS && e.range.getColumn() <= RAW_DATA_NUM_COLS) return; // computed cols
    var editedRows = e.range.getNumRows();
    if (editedRows > 200) return; // large paste - use the menu instead

    var startRow = e.range.getRow();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    // Small edit on a small/medium sheet: safe to do a full recalculation
    // so cross-row flags stay accurate. On very large sheets, only the
    // edited rows are recalculated for speed.
    var totalDataRows = lastRow - 1;
    if (totalDataRows <= CONFIG.AUTO_FULL_RECALC_ROW_LIMIT) {
      recalculateRows_(sheet, 2, totalDataRows);
    } else {
      recalculateRows_(sheet, startRow, editedRows);
    }
    CacheService.getScriptCache().removeAll(['dash_filter_options']);
  } catch (err) {
    // Never let a trigger error block the user's edit.
  }
}

/** Used by HTML templates to include shared partials: <?!= include('Style'); ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------------
// Dialog launchers (menu-driven, run inside Google Sheets)
// ---------------------------------------------------------------------
function openDashboard() {
  var tmpl = HtmlService.createTemplateFromFile('Dashboard');
  var html = tmpl.evaluate().setWidth(1400).setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, 'Quality Inspection Dashboard');
}

function openForm() {
  var tmpl = HtmlService.createTemplateFromFile('Form');
  var html = tmpl.evaluate().setWidth(560).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, 'New Inspection Entry');
}

function openSidebar() {
  var tmpl = HtmlService.createTemplateFromFile('Sidebar');
  var html = tmpl.evaluate().setTitle('QC Management System');
  SpreadsheetApp.getUi().showSidebar(html);
}

// ---------------------------------------------------------------------
// Optional Web App deployment (Deploy > New deployment > Web app).
// Visit .../exec for the Dashboard, or .../exec?page=form for the form.
// ---------------------------------------------------------------------
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) ? e.parameter.page : 'dashboard';
  var tmplName = (page === 'form') ? 'Form' : 'Dashboard';
  var title = (page === 'form') ? 'New Inspection Entry' : 'Quality Inspection Dashboard';
  var tmpl = HtmlService.createTemplateFromFile(tmplName);
  return tmpl.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------
// SETUP / MIGRATION
// Reconciles whatever Raw Data layout already exists into the
// canonical 22-column layout defined in Utils.gs, without losing data.
// Safe to run multiple times.
// ---------------------------------------------------------------------
function runInitialSetup() {
  var ui = SpreadsheetApp.getUi();
  migrateRawDataStructure_();
  var master = getOrCreateSheet_(CONFIG.SHEET_MASTER);
  ensureMasterHeaders_(master);
  seedMasterListsFromRawData_(master, false /* don't wipe existing entries */);
  recalculateAllRecords_();
  ui.alert('Setup complete', 'Raw Data structure verified, Master Lists ready, and all records recalculated.', ui.ButtonSet.OK);
}

function normalizeHeader_(h) {
  return str_(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Canonical field key -> accepted header spellings (normalized).
var HEADER_ALIASES_ = {
  date: ['date'],
  hour: ['hour'],
  line: ['line'],
  qi: ['qiname', 'qi', 'inspectorname', 'inspector'],
  buyer: ['buyer'],
  style: ['style', 'styleno', 'stylenumber'],
  orderQty: ['orderqty', 'orderquantity'],
  prodQty: ['productionqty', 'productionquantity', 'prodqty'],
  checkQty: ['qccheckqty', 'checkqty', 'qccheckquantity'],
  passQty: ['passqty', 'passquantity'],
  defectiveQty: ['defectiveqty', 'defectivequantity'],
  defectName: ['defectname', 'defects', 'defect', 'defecttype'],
  defectQty: ['defectqty', 'defectquantity'],
  rectifiedQty: ['rectifiedqty', 'rectifiedquantity'],
  rejectQty: ['rejectqty', 'rejectquantity'],
  remarks: ['remarks', 'remark', 'comments', 'notes']
};

/**
 * Reads the current Raw Data header row, maps existing columns onto the
 * canonical field list (by alias, case/space/punctuation-insensitive),
 * then rewrites the sheet with the canonical column order. Any values
 * that cannot be mapped are preserved by appending them into Remarks so
 * nothing is silently lost. Missing fields (e.g. a brand-new "Defect
 * Qty" column) are backfilled with a sensible default and the user is
 * left to review flagged rows afterward.
 */
function migrateRawDataStructure_() {
  var sheet = getOrCreateSheet_(CONFIG.SHEET_RAW_DATA);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, RAW_DATA_NUM_COLS).setValues([RAW_DATA_HEADERS]);
    formatRawDataSheet_(sheet);
    return;
  }

  var currentHeaders = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0];
  var alreadyCanonical = currentHeaders.length >= RAW_DATA_NUM_COLS &&
    RAW_DATA_HEADERS.every(function (h, i) { return normalizeHeader_(currentHeaders[i]) === normalizeHeader_(h); });

  if (alreadyCanonical) {
    formatRawDataSheet_(sheet);
    return;
  }

  // Build normalized-header -> old column index map.
  var oldIndexByNorm = {};
  currentHeaders.forEach(function (h, i) {
    oldIndexByNorm[normalizeHeader_(h)] = i; // 0-based
  });

  var fieldOldIndex = {}; // canonical field key -> 0-based old column index (or -1)
  Object.keys(HEADER_ALIASES_).forEach(function (key) {
    var found = -1;
    HEADER_ALIASES_[key].some(function (alias) {
      if (oldIndexByNorm.hasOwnProperty(alias)) { found = oldIndexByNorm[alias]; return true; }
      return false;
    });
    fieldOldIndex[key] = found;
  });

  var numOldDataRows = Math.max(lastRow - 1, 0);
  var oldValues = numOldDataRows > 0 ? sheet.getRange(2, 1, numOldDataRows, currentHeaders.length).getValues() : [];

  var newValues = oldValues.map(function (row) {
    function get(key) {
      var idx = fieldOldIndex[key];
      return idx >= 0 ? row[idx] : '';
    }
    var defectiveQty = num_(get('defectiveQty'));
    var defectQtyRaw = fieldOldIndex.defectQty >= 0 ? num_(get('defectQty')) : defectiveQty; // sensible default
    var newRow = [
      get('date'), get('hour'), get('line'), get('qi'), get('buyer'), get('style'),
      get('orderQty'), get('prodQty'), get('checkQty'), get('passQty'),
      defectiveQty, get('defectName'), defectQtyRaw, get('rectifiedQty'),
      get('rejectQty'), get('remarks'),
      0, 0, 0, 0, '', makeRecordId_() // computed columns filled in by recalculateAllRecords()
    ];
    return newRow;
  });

  sheet.clearContents();
  sheet.clearFormats();
  sheet.getRange(1, 1, 1, RAW_DATA_NUM_COLS).setValues([RAW_DATA_HEADERS]);
  if (newValues.length > 0) {
    sheet.getRange(2, 1, newValues.length, RAW_DATA_NUM_COLS).setValues(newValues);
  }
  formatRawDataSheet_(sheet);
}

function formatRawDataSheet_(sheet) {
  sheet.setFrozenRows(1);
  var headerRange = sheet.getRange(1, 1, 1, RAW_DATA_NUM_COLS);
  headerRange.setFontWeight('bold').setBackground('#1a3d8f').setFontColor('#ffffff');
  sheet.setColumnWidth(COL.REMARKS, 220);
  try { sheet.hideColumns(COL.RECORD_ID); } catch (err) { /* ignore if already hidden */ }
  if (sheet.getMaxColumns() > RAW_DATA_NUM_COLS) {
    sheet.deleteColumns(RAW_DATA_NUM_COLS + 1, sheet.getMaxColumns() - RAW_DATA_NUM_COLS);
  }
}

function ensureMasterHeaders_(master) {
  var lastCol = master.getLastColumn();
  if (lastCol < MASTER_HEADERS.length || master.getLastRow() === 0) {
    master.getRange(1, 1, 1, MASTER_HEADERS.length).setValues([MASTER_HEADERS]);
    master.getRange(1, 1, 1, MASTER_HEADERS.length).setFontWeight('bold').setBackground('#1a3d8f').setFontColor('#ffffff');
    master.setFrozenRows(1);
  }
}

/**
 * Pulls distinct Lines / Buyers / QI Names / Defect Names already
 * present in Raw Data into Master Lists, without duplicating entries
 * the user has already typed in manually. Hour Slots are seeded once
 * with a sensible default set if the column is empty.
 */
function seedMasterListsFromRawData_(master, wipeFirst) {
  var raw = getSheet_(CONFIG.SHEET_RAW_DATA);
  if (!raw) return;
  var lastRow = raw.getLastRow();

  var existing = readMasterLists_(master);
  var sets = {
    Lines: new Set(wipeFirst ? [] : existing.lines),
    Buyers: new Set(wipeFirst ? [] : existing.buyers),
    'QI Names': new Set(wipeFirst ? [] : existing.qiNames),
    'Defect Names': new Set(wipeFirst ? [] : existing.defectNames)
  };

  if (lastRow > 1) {
    var values = raw.getRange(2, 1, lastRow - 1, RAW_DATA_NUM_COLS).getValues();
    values.forEach(function (row) {
      var o = rowToObject_(row);
      if (o.line) sets.Lines.add(o.line);
      if (o.buyer) sets.Buyers.add(o.buyer);
      if (o.qi) sets['QI Names'].add(o.qi);
      if (o.defectName) sets['Defect Names'].add(o.defectName);
    });
  }

  var hourSlots = existing.hourSlots.length ? existing.hourSlots : [
    '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00',
    '13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00', '17:00-18:00',
    '18:00-19:00', '19:00-20:00', '20:00-21:00'
  ];

  writeMasterLists_(master, {
    lines: Array.from(sets.Lines).sort(),
    buyers: Array.from(sets.Buyers).sort(),
    qiNames: Array.from(sets['QI Names']).sort(),
    defectNames: Array.from(sets['Defect Names']).sort(),
    hourSlots: hourSlots
  });
}

function rebuildMasterLists() {
  var master = getOrCreateSheet_(CONFIG.SHEET_MASTER);
  ensureMasterHeaders_(master);
  seedMasterListsFromRawData_(master, true /* wipe and rebuild purely from Raw Data */);
  SpreadsheetApp.getUi().alert('Master Lists rebuilt from current Raw Data.');
}

function recalculateAllRecords_() {
  var sheet = getSheet_(CONFIG.SHEET_RAW_DATA);
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  recalculateRows_(sheet, 2, lastRow - 1);
  CacheService.getScriptCache().removeAll(['dash_filter_options']);
  return lastRow - 1;
}

/** Menu-bound wrapper: runs the recalculation and confirms with an alert. */
function recalculateAllRecords() {
  var count = recalculateAllRecords_();
  SpreadsheetApp.getUi().alert('Recalculated ' + count + ' record(s). Flagged rows are highlighted red.');
}
