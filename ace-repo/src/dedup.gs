/**
 * dedup.gs — Deduplication pipeline for registration data
 *
 * Problem: The same person may submit the SurveyCake form multiple times
 * (e.g., updating their information, re-registering for a new cohort).
 * Raw row count was ~980 with ~75% duplicate rate.
 *
 * Strategy: Treat (Column A, Column B, Column C) as a composite key.
 * Keep only the FIRST occurrence of each unique key.
 *
 * Source sheet:  報名總表  (raw data from SurveyCake export)
 * Target sheet:  去重報名總表  (deduplicated, used downstream)
 *
 * Run modes:
 *   - Manual:    Run testRemoveDuplicatesABC() from the GAS editor
 *   - Scheduled: Run createABCTimeTrigger() once to set up a daily trigger
 */

/**
 * Main deduplication function.
 * Reads 報名總表, deduplicates on cols A+B+C, writes to 去重報名總表.
 */
function removeDuplicatesABC() {
  const spreadsheet = SpreadsheetApp.openById('YOUR_SPREADSHEET_ID_HERE');

  const sourceSheet = spreadsheet.getSheetByName('報名總表')
    || spreadsheet.getSheets()[0];  // Fallback to first sheet if name not found

  let targetSheet = spreadsheet.getSheetByName('去重報名總表');
  if (!targetSheet) {
    targetSheet = spreadsheet.insertSheet('去重報名總表');
  }

  const data    = sourceSheet.getDataRange().getValues();
  const headers = data[0];

  const uniqueData = [headers];  // Always keep header row
  const seen       = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Composite key from first three columns (name, email, identity)
    const key = `${row[0]}|${row[1]}|${row[2]}`;

    if (!seen[key]) {
      uniqueData.push(row);
      seen[key] = true;
    }
  }

  const duplicatesRemoved = data.length - uniqueData.length;

  targetSheet.clearContents();
  if (uniqueData.length > 0) {
    targetSheet.getRange(1, 1, uniqueData.length, uniqueData[0].length).setValues(uniqueData);
  }

  Logger.log(`Deduplication complete.`);
  Logger.log(`Source: ${sourceSheet.getName()} (${data.length - 1} data rows)`);
  Logger.log(`Output: ${targetSheet.getName()} (${uniqueData.length - 1} unique rows)`);
  Logger.log(`Removed: ${duplicatesRemoved} duplicate rows`);

  return {
    sourceRows:   data.length - 1,
    uniqueRows:   uniqueData.length - 1,
    duplicates:   duplicatesRemoved,
  };
}

/**
 * Sets up a daily trigger to run removeDuplicatesABC at 09:00.
 * Call this once from the GAS editor; do not call repeatedly.
 */
function createABCTimeTrigger() {
  // Remove any existing trigger for this function to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'removeDuplicatesABC')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('removeDuplicatesABC')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  Logger.log('Trigger created: removeDuplicatesABC will run daily at 09:00');
}

// ── Utility functions ──────────────────────────────

/** Manual test runner */
function testRemoveDuplicatesABC() {
  const result = removeDuplicatesABC();
  Logger.log(`Result: ${JSON.stringify(result)}`);
}

/** Lists all active project triggers */
function viewTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log(`Active triggers: ${triggers.length}`);
  triggers.forEach((t, i) => Logger.log(`  [${i}] ${t.getHandlerFunction()}`));
}

/** Removes all project triggers (use with caution) */
function deleteAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers deleted.');
}
