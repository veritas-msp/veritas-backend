/**
 * Adapte les migrations historiques qui ciblent « veritas_user »
 * vers l'utilisateur réellement connecté (installations self-hosted).
 */
export function adaptMigrationSql(sql, dbUser) {
  if (!dbUser || !sql) return sql;

  const quotedUser = `"${String(dbUser).replace(/"/g, '""')}"`;
  const escapedUser = String(dbUser).replace(/'/g, "''");

  return sql
    .replace(/\bTO veritas_user\b/gi, `TO ${quotedUser}`)
    .replace(/app_user\s*:=\s*'veritas_user'/gi, `app_user := '${escapedUser}'`);
}
