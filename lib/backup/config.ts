/**
 * Feature toggles for the local-backup + snapshots UI.
 *
 * Set `NEXT_PUBLIC_ENABLE_BACKUP_UI=false` to hide the Settings → Data & Local
 * Backup card, the home-page "Restore backup" controls, and the automatic
 * snapshot driver (default: enabled).
 */
export const BACKUP_UI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_BACKUP_UI !== 'false';
