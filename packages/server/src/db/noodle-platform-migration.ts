type Row = Record<string, unknown>;

/**
 * `noodle_accounts` used to carry `visibility: "public" | "private"` and
 * `public_account_id`. "Private" wrongly implied a real privacy guarantee; the axis
 * is really which simulated platform an account lives on, so it became
 * `platform: "noodle" | "noodler"` and `noodle_account_id`.
 *
 * This must run before rows are normalized against the schema. The loader falls back
 * to a column's default when neither its key nor its db name is present, so an
 * un-migrated NoodleR profile would silently load as `platform: "noodle"` and leak
 * into the public Noodle timeline.
 *
 * Idempotent: rows that already carry `platform` are returned untouched.
 */
export function migrateLegacyNoodleAccountRow(row: Row): Row {
  const hasPlatform = row.platform !== undefined;
  const hasNoodleAccountId = row.noodleAccountId !== undefined || row.noodle_account_id !== undefined;
  if (hasPlatform && hasNoodleAccountId) return row;

  const migrated: Row = { ...row };
  if (!hasPlatform) {
    migrated.platform = row.visibility === "private" ? "noodler" : "noodle";
  }
  if (!hasNoodleAccountId) {
    // `in` rather than `??`: an explicit null link must stay a null link.
    if ("publicAccountId" in row) migrated.noodleAccountId = row.publicAccountId;
    else if ("public_account_id" in row) migrated.noodleAccountId = row.public_account_id;
  }
  // The legacy keys are deliberately left in place rather than deleted. A build from before
  // the rename reads them; strip them and a downgrade silently republishes every NoodleR
  // account onto the public Noodle timeline. See schema/noodle.ts.
  return migrated;
}
