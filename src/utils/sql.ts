/**
 * Quote an SQL identifier using double-quotes (ANSI SQL / PostgreSQL / SQLite).
 * Use for table/column names to prevent SQL injection.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote an SQL identifier using backticks (MySQL / MariaDB).
 */
export function quoteIdentifierMysql(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}
