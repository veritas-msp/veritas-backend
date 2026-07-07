import express from 'express';
import { pool } from '../../database/db.js';
import verifyJWT from '../../middleware/auth.js';
import { requireRole } from '../../middleware/roles.js';
import { decryptSetting, encryptSettingValue } from '../../utils/settingsHelper.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import multer from 'multer';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const DEFAULT_MAINTENANCE_STATUS = {
  enabled: false,
  maintenanceMode: false,
  message: "L'application est actuellement en maintenance. Veuillez réessayer plus tard.",
  tickerSpeed: 22,
  tickerDirection: "left",
  tickerColor: "#d97706",
};

async function hasSystemTable() {
  if (!process.env.DATABASE_URL) return false;
  try {
    const result = await pool.query(`SELECT to_regclass('v_b_settings_system') AS table_ref`);
    return Boolean(result.rows[0]?.table_ref);
  } catch {
    return false;
  }
}

async function hasSystemColumn(columnName) {
  const cols = await getSystemColumns();
  return cols.has(columnName);
}

async function getSystemColumns() {
  const result = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass('v_b_settings_system')
       AND a.attnum > 0
       AND NOT a.attisdropped`
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function resolveMaintenanceMessageColumn(systemColumns) {
  if (systemColumns.has('maintenance_message')) return 'maintenance_message';
  if (systemColumns.has('maitnenance_message')) return 'maitnenance_message';
  return null;
}

function buildPgEnv(dbParams) {
  return {
    ...process.env,
    PGPASSWORD: String(dbParams.password ?? ''),
    PGUSER: dbParams.user,
    PGHOST: dbParams.host,
    PGPORT: String(dbParams.port),
    PGDATABASE: dbParams.database,
  };
}

async function assertPgTool(command) {
  await execFileAsync(command, ['--version'], { windowsHide: true });
}

async function runPgTool(command, args, dbParams, options = {}) {
  const { maxBuffer = 10 * 1024 * 1024 } = options;
  return execFileAsync(command, args, {
    env: buildPgEnv(dbParams),
    maxBuffer,
    windowsHide: true,
  });
}

async function upsertLegacyEncryptedSetting(key, plainValue) {
  const encrypted = encryptSettingValue(plainValue);

  const updated = await pool.query(
    `UPDATE v_b_settings_system
     SET value_encrypted = $1, value_iv = $2, value_auth_tag = $3
     WHERE key = $4`,
    [encrypted.value_encrypted, encrypted.value_iv, encrypted.value_auth_tag, key]
  );

  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO v_b_settings_system (key, value_encrypted, value_iv, value_auth_tag)
       VALUES ($1, $2, $3, $4)`,
      [key, encrypted.value_encrypted, encrypted.value_iv, encrypted.value_auth_tag]
    );
  }
}

// ───────────────────────────────────────────────
// 📤 Configuration Multer pour l'upload de backups
// ───────────────────────────────────────────────
const backupsDir = path.join(__dirname, '../backups');

// Créer le dossier backups s'il n'existe pas
fs.mkdir(backupsDir, { recursive: true }).catch(() => {});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, backupsDir);
  },
  filename: (req, file, cb) => {
    // Garder le nom original ou ajouter un timestamp
    const originalName = file.originalname;
    const ext = path.extname(originalName);
    const name = path.basename(originalName, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    cb(null, `${name}-${timestamp}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500 MB max
  },
  fileFilter: (req, file, cb) => {
    // Accepter uniquement les fichiers .sql et .dump
    if (file.originalname.endsWith('.sql') || file.originalname.endsWith('.dump')) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers .sql et .dump sont autorisés'));
    }
  }
});

// ───────────────────────────────────────────────
// 🔧 Helper : Extraire les paramètres de connexion DB
// ───────────────────────────────────────────────
async function getDBConnectionParams() {
  // Priorité 1 : DATABASE_URL (pour Docker)
  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      return {
        host: url.hostname,
        port: url.port || '5432',
        database: url.pathname.slice(1), // Enlever le premier /
        user: url.username,
        password: url.password
      };
    } catch (err) {
      console.error('Erreur lors du parsing de DATABASE_URL:', err);
    }
  }
  
  // Priorité 2 : Settings depuis la base de données
  try {
    const dbSettings = await pool.query(
      `SELECT key, value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE section = 'database'`
    );
    const settingsMap = {};
    dbSettings.rows.forEach(row => {
      settingsMap[row.key] = decryptSetting(row);
    });
    
    if (settingsMap.db_host && settingsMap.db_name && settingsMap.db_user) {
      return {
        host: settingsMap.db_host,
        port: settingsMap.db_port || '5432',
        database: settingsMap.db_name,
        user: settingsMap.db_user,
        password: settingsMap.db_password || ''
      };
    }
  } catch (err) {
    console.error('Erreur lors de la lecture des settings:', err);
  }
  
  // Priorité 3 : Variables d'environnement
  return {
    host: process.env.DB_HOST || process.env.POSTGRES_HOST || 'localhost',
    port: process.env.DB_PORT || process.env.POSTGRES_PORT || '5432',
    database: process.env.DB_NAME || process.env.POSTGRES_DB || 'veritas_db',
    user: process.env.DB_USER || process.env.POSTGRES_USER || 'veritas_user',
    password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || ''
  };
}

// ───────────────────────────────────────────────
// 🔧 GET /status — Statut de la maintenance
// ───────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const tableExists = await hasSystemTable();
    if (!tableExists) {
      return res.json(DEFAULT_MAINTENANCE_STATUS);
    }

    const systemColumns = await getSystemColumns();
    const messageColumn = resolveMaintenanceMessageColumn(systemColumns);
    const hasLegacySchema = systemColumns.has('key') || systemColumns.has('value_encrypted');
    const hasMonoLineSchema = !hasLegacySchema;
    let isEnabled = false;
    let message = 'L\'application est actuellement en maintenance. Veuillez réessayer plus tard.';
    let tickerSpeed = 22;
    let tickerDirection = 'left';
    let tickerColor = '#d97706';

    if (hasMonoLineSchema) {
      if (!messageColumn) {
        throw new Error('Colonne message de maintenance introuvable (maintenance_message).');
      }
      const result = await pool.query(
        `SELECT maintenance_mode, ${messageColumn} AS maintenance_message, ticker_color, ticker_speed, ticker_direction
         FROM v_b_settings_system
         WHERE id = 1
         LIMIT 1`
      );
      const row = result.rows[0];
      isEnabled = Boolean(row?.maintenance_mode);
      message = (row?.maintenance_message || '').trim() || message;
      tickerSpeed = Number.isFinite(Number(row?.ticker_speed))
        ? Math.max(5, Math.min(60, Number(row.ticker_speed)))
        : 22;
      tickerDirection = row?.ticker_direction === 'right' ? 'right' : 'left';
      tickerColor = /^#([0-9A-Fa-f]{6})$/.test(row?.ticker_color || '')
        ? row.ticker_color
        : '#d97706';
    } else {
      const modeResult = await pool.query(
        `SELECT *
         FROM v_b_settings_system
         WHERE key = 'MAINTENANCE_MODE'
         LIMIT 1`
      );
      if (modeResult.rows[0]) {
        isEnabled = decryptSetting(modeResult.rows[0]) === 'true';
      }

      const msgResult = await pool.query(
        `SELECT *
         FROM v_b_settings_system
         WHERE key = 'MAINTENANCE_MESSAGE'
         LIMIT 1`
      );
      if (msgResult.rows[0]) {
        message = (decryptSetting(msgResult.rows[0]) || '').trim() || message;
      }

      const speedResult = await pool.query(
        `SELECT *
         FROM v_b_settings_system
         WHERE key = 'MAINTENANCE_TICKER_SPEED'
         LIMIT 1`
      );
      if (speedResult.rows[0]) {
        const parsed = Number.parseInt(decryptSetting(speedResult.rows[0]), 10);
        if (Number.isFinite(parsed)) tickerSpeed = Math.max(5, Math.min(60, parsed));
      }

      const directionResult = await pool.query(
        `SELECT *
         FROM v_b_settings_system
         WHERE key = 'MAINTENANCE_TICKER_DIRECTION'
         LIMIT 1`
      );
      if (directionResult.rows[0]) {
        tickerDirection = String(decryptSetting(directionResult.rows[0]) || '').toLowerCase() === 'right' ? 'right' : 'left';
      }

      const colorResult = await pool.query(
        `SELECT *
         FROM v_b_settings_system
         WHERE key = 'MAINTENANCE_TICKER_COLOR'
         LIMIT 1`
      );
      if (colorResult.rows[0]) {
        const savedColor = String(decryptSetting(colorResult.rows[0]) || '').trim();
        if (/^#([0-9A-Fa-f]{6})$/.test(savedColor)) tickerColor = savedColor;
      }
    }
    
    res.json({
      enabled: isEnabled,
      maintenanceMode: isEnabled, // Pour compatibilité
      message: message,
      tickerSpeed,
      tickerDirection,
      tickerColor,
    });
  } catch (err) {
    console.error('GET /maintenance/status error:', err);
    res.json(DEFAULT_MAINTENANCE_STATUS);
  }
});

// ───────────────────────────────────────────────
// 🔧 POST /toggle — Activer/Désactiver maintenance
// ───────────────────────────────────────────────
router.post('/toggle', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    // Accepter les deux formats pour compatibilité
    const enable = req.body.enable !== undefined ? req.body.enable : req.body.enabled;
    const maintenanceMessage = req.body.maintenanceMessage || req.body.message;
    const rawTickerSpeed = req.body.tickerSpeed;
    const rawTickerDirection = req.body.tickerDirection;
    const rawTickerColor = req.body.tickerColor;
    
    const systemColumns = await getSystemColumns();
    const messageColumn = resolveMaintenanceMessageColumn(systemColumns);
    const hasLegacySchema = systemColumns.has('key') || systemColumns.has('value_encrypted');
    const hasMonoLineSchema = !hasLegacySchema;
    const parsedSpeed = Number.parseInt(rawTickerSpeed, 10);
    const normalizedSpeed = Number.isFinite(parsedSpeed) ? Math.min(60, Math.max(5, parsedSpeed)) : 22;
    const normalizedDirection = String(rawTickerDirection).toLowerCase() === 'right' ? 'right' : 'left';
    const normalizedColor = /^#([0-9A-Fa-f]{6})$/.test(String(rawTickerColor || '').trim())
      ? String(rawTickerColor).trim()
      : '#d97706';

    if (hasMonoLineSchema) {
      if (!messageColumn) {
        throw new Error('Colonne message de maintenance introuvable (maintenance_message).');
      }
      const hasCreatedAt = systemColumns.has('created_at');
      const hasUpdatedAt = systemColumns.has('updated_at');

      const currentResult = await pool.query(
        `SELECT maintenance_mode, ${messageColumn} AS maintenance_message, ticker_speed, ticker_direction, ticker_color
         FROM v_b_settings_system
         WHERE id = 1
         LIMIT 1`
      );
      const current = currentResult.rows[0] || {};

      const nextMode = Boolean(enable);
      const nextMessage =
        maintenanceMessage !== undefined
          ? String(maintenanceMessage)
          : (current.maintenance_message || 'L\'application est actuellement en maintenance. Veuillez réessayer plus tard.');
      const nextSpeed =
        rawTickerSpeed !== undefined
          ? normalizedSpeed
          : (Number.isFinite(Number(current.ticker_speed)) ? Math.min(60, Math.max(5, Number(current.ticker_speed))) : 22);
      const nextDirection =
        rawTickerDirection !== undefined
          ? normalizedDirection
          : (current.ticker_direction === 'right' ? 'right' : 'left');
      const nextColor =
        rawTickerColor !== undefined
          ? normalizedColor
          : (/^#([0-9A-Fa-f]{6})$/.test(current.ticker_color || '') ? current.ticker_color : '#d97706');

      const updateClauses = [
        'maintenance_mode = $1',
        `${messageColumn} = $2`,
        'ticker_color = $3',
        'ticker_speed = $4',
        'ticker_direction = $5',
      ];
      if (hasUpdatedAt) {
        updateClauses.push('updated_at = NOW()');
      }

      const updatedMono = await pool.query(
        `UPDATE v_b_settings_system
         SET ${updateClauses.join(', ')}
         WHERE id = 1`,
        [nextMode, nextMessage, nextColor, nextSpeed, nextDirection]
      );

      if (updatedMono.rowCount === 0) {
        const insertColumns = [
          'id',
          'maintenance_mode',
          messageColumn,
          'ticker_color',
          'ticker_speed',
          'ticker_direction',
        ];
        const insertValues = ['1', '$1', '$2', '$3', '$4', '$5'];

        if (hasCreatedAt) {
          insertColumns.push('created_at');
          insertValues.push('NOW()');
        }
        if (hasUpdatedAt) {
          insertColumns.push('updated_at');
          insertValues.push('NOW()');
        }

        await pool.query(
          `INSERT INTO v_b_settings_system (${insertColumns.join(', ')})
           VALUES (${insertValues.join(', ')})`,
          [nextMode, nextMessage, nextColor, nextSpeed, nextDirection]
        );
      }
    } else {
      await upsertLegacyEncryptedSetting('MAINTENANCE_MODE', enable ? 'true' : 'false');

      if (maintenanceMessage !== undefined) {
        await upsertLegacyEncryptedSetting('MAINTENANCE_MESSAGE', String(maintenanceMessage));
      }

      if (rawTickerSpeed !== undefined) {
        await upsertLegacyEncryptedSetting('MAINTENANCE_TICKER_SPEED', String(normalizedSpeed));
      }

      if (rawTickerDirection !== undefined) {
        await upsertLegacyEncryptedSetting('MAINTENANCE_TICKER_DIRECTION', normalizedDirection);
      }

      if (rawTickerColor !== undefined) {
        await upsertLegacyEncryptedSetting('MAINTENANCE_TICKER_COLOR', normalizedColor);
      }
    }
    
    res.json({ 
      success: true, 
      enabled: enable,
      maintenanceMode: enable // Pour compatibilité
    });
  } catch (err) {
    let currentDb = null;
    try {
      const dbRes = await pool.query('SELECT current_database() AS name');
      currentDb = dbRes.rows[0]?.name || null;
    } catch {
      currentDb = null;
    }
    console.error('POST /maintenance/toggle error:', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
      where: err?.where,
      constraint: err?.constraint,
      currentDb,
      stack: err?.stack,
    });
    res.status(500).json({
      error: 'Erreur serveur: ' + err.message,
      code: err?.code || null,
      detail: err?.detail || null,
      hint: err?.hint || null,
      constraint: err?.constraint || null,
      currentDb,
    });
  }
});

// ───────────────────────────────────────────────
// 💾 GET /backups — Liste des sauvegardes
// ───────────────────────────────────────────────
router.get('/backups', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    
    // Créer le dossier s'il n'existe pas
    try {
      await fs.access(backupsDir);
    } catch {
      await fs.mkdir(backupsDir, { recursive: true });
    }
    
    const files = await fs.readdir(backupsDir);
    const backups = [];
    
    for (const file of files) {
      if (file.endsWith('.sql') || file.endsWith('.dump')) {
        const filePath = path.join(backupsDir, file);
        const stats = await fs.stat(filePath);
        backups.push({
          filename: file,
          size: stats.size,
          created_at: stats.birthtime,
          modified_at: stats.mtime
        });
      }
    }
    
    // Trier par date de création (plus récent en premier)
    backups.sort((a, b) => b.created_at - a.created_at);
    
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ───────────────────────────────────────────────
// 📥 POST /backup/upload — Uploader un backup
// ───────────────────────────────────────────────
router.post('/backup/upload', verifyJWT, requireRole('admin'), upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }
    
    const stats = await fs.stat(req.file.path);
    
    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: stats.size,
      created_at: stats.birthtime
    });
  } catch (err) {
    // Supprimer le fichier en cas d'erreur
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch {}
    }
    res.status(500).json({ error: 'Erreur lors de l\'upload: ' + err.message });
  }
});

// ───────────────────────────────────────────────
// 💾 POST /backup — Créer une sauvegarde
// ───────────────────────────────────────────────
router.post('/backup', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    // S'assurer que le dossier backups existe
    try {
      await fs.access(backupsDir);
    } catch {
      await fs.mkdir(backupsDir, { recursive: true });
    }
    
    // Récupérer les paramètres de connexion DB
    const dbParams = await getDBConnectionParams();
    
    if (!dbParams.database || !dbParams.user) {
      return res.status(400).json({ error: 'Paramètres de base de données manquants' });
    }
    
    // Générer le nom de fichier avec timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `backup-${timestamp}.sql`;
    const filepath = path.join(backupsDir, filename);
    
    // Vérifier que pg_dump est disponible (tester avec --version qui fonctionne sur tous les OS)
    try {
      await assertPgTool('pg_dump');
    } catch {
      return res.status(500).json({ 
        error: 'pg_dump n\'est pas installé ou n\'est pas dans le PATH. Veuillez installer PostgreSQL client tools.' 
      });
    }
    
    // Créer la sauvegarde avec pg_dump (format SQL plain)
    const pgDumpArgs = [
      '-h', dbParams.host,
      '-p', String(dbParams.port),
      '-U', dbParams.user,
      '-d', dbParams.database,
      '-F', 'p', // format plain SQL
      '--clean',
      '--if-exists',
      '-f', filepath, // fichier de sortie
    ];

    const { stdout, stderr } = await runPgTool('pg_dump', pgDumpArgs, dbParams);
    
    // Vérifier que le fichier existe et n'est pas vide
    let stats;
    try {
      stats = await fs.stat(filepath);
      if (stats.size === 0) {
        return res.status(500).json({ 
          error: 'La sauvegarde a été créée mais le fichier est vide. Vérifiez les permissions et la connexion à la base de données.' 
        });
      }
    } catch (statErr) {
      return res.status(500).json({ 
        error: 'Le fichier de sauvegarde n\'a pas pu être créé: ' + statErr.message 
      });
    }
    
    res.json({
      success: true,
      filename: filename,
      size: stats.size,
      created_at: stats.birthtime
    });
  } catch (err) {
    console.error('Erreur lors de la création de la sauvegarde:', err);
    const errorMessage = err.stderr || err.message || 'Erreur inconnue';
    res.status(500).json({ 
      error: 'Erreur lors de la création de la sauvegarde: ' + errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ───────────────────────────────────────────────
// 🗑️ DELETE /backup/:filename — Supprimer une sauvegarde
// ───────────────────────────────────────────────
router.delete('/backup/:filename', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({ error: 'Nom de fichier requis' });
    }
    
    // Sécuriser le nom de fichier pour éviter les path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Nom de fichier invalide' });
    }
    
    const filepath = path.join(backupsDir, filename);
    
    // Vérifier que le fichier existe
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({ error: 'Fichier de sauvegarde introuvable' });
    }
    
    // Vérifier que c'est bien un fichier de sauvegarde
    if (!filename.endsWith('.sql') && !filename.endsWith('.dump')) {
      return res.status(400).json({ error: 'Type de fichier non autorisé' });
    }
    
    // Supprimer le fichier
    await fs.unlink(filepath);
    
    res.json({ success: true, message: 'Sauvegarde supprimée avec succès' });
  } catch (err) {
    console.error('Erreur lors de la suppression de la sauvegarde:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression: ' + err.message });
  }
});

// ───────────────────────────────────────────────
// 🔄 POST /restore — Restaurer une sauvegarde
// ───────────────────────────────────────────────
router.post('/restore', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Nom de fichier requis' });
    }
    
    // Sécuriser le nom de fichier pour éviter les path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Nom de fichier invalide' });
    }
    
    const filepath = path.join(backupsDir, filename);
    
    // Vérifier que le fichier existe
    try {
      await fs.access(filepath);
    } catch {
      return res.status(404).json({ error: 'Fichier de sauvegarde introuvable' });
    }
    
    // Vérifier que c'est bien un fichier de sauvegarde
    if (!filename.endsWith('.sql') && !filename.endsWith('.dump')) {
      return res.status(400).json({ error: 'Type de fichier non autorisé' });
    }
    
    // Récupérer les paramètres de connexion DB
    const dbParams = await getDBConnectionParams();
    
    if (!dbParams.database || !dbParams.user) {
      return res.status(400).json({ error: 'Paramètres de base de données manquants' });
    }
    
    // Arrêter toutes les connexions actives à la base de données (optionnel, continue même en cas d'erreur)
    try {
      await pool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `, [dbParams.database]);
      console.log('Connexions actives terminées avec succès');
    } catch (err) {
      // C'est juste un avertissement, on continue quand même
      console.warn('Avertissement lors de l\'arrêt des connexions:', err.message);
      console.warn('La restauration va continuer, mais certaines connexions peuvent rester actives');
    }
    
    // Déterminer le format du fichier
    const isDump = filename.endsWith('.dump');
    
    // Vérifier que les outils nécessaires sont disponibles
    try {
      if (isDump) {
        await assertPgTool('pg_restore');
      } else {
        await assertPgTool('psql');
      }
    } catch {
      const toolName = isDump ? 'pg_restore' : 'psql';
      return res.status(500).json({ 
        error: `${toolName} n'est pas installé ou n'est pas dans le PATH. Veuillez installer PostgreSQL client tools.` 
      });
    }
    
    // Construire la commande de restauration
    let restoreCommand;
    let restoreArgs;
    if (isDump) {
      restoreCommand = 'pg_restore';
      restoreArgs = [
        '-h', dbParams.host,
        '-p', String(dbParams.port),
        '-U', dbParams.user,
        '-d', dbParams.database,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        filepath,
      ];
    } else {
      restoreCommand = 'psql';
      restoreArgs = [
        '-h', dbParams.host,
        '-p', String(dbParams.port),
        '-U', dbParams.user,
        '-d', dbParams.database,
        '-f', filepath,
      ];
    }

    // Exécuter la commande de restauration
    console.log(`Début de la restauration: ${filename}`);
    const { stdout, stderr } = await runPgTool(restoreCommand, restoreArgs, dbParams, {
      maxBuffer: 50 * 1024 * 1024,
    });
    
    // Afficher les sorties pour le débogage
    if (stdout) {
      console.log('Sortie de la restauration:', stdout);
    }
    if (stderr && !stderr.includes('NOTICE')) {
      // Les NOTICE sont normaux, on ne les considère pas comme des erreurs
      console.warn('Avertissements lors de la restauration:', stderr);
    }
    
    console.log(`Restauration terminée avec succès: ${filename}`);
    res.json({ success: true, message: 'Sauvegarde restaurée avec succès' });
  } catch (err) {
    console.error('Erreur lors de la restauration:', err);
    const errorMessage = err.stderr || err.message || 'Erreur inconnue';
    res.status(500).json({ 
      error: 'Erreur lors de la restauration: ' + errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ───────────────────────────────────────────────
// 📥 GET /backup/plan — Récupérer le plan de sauvegarde
// ───────────────────────────────────────────────
router.get('/backup/plan', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    const scheduleResult = await pool.query(
      `SELECT value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE key = 'backup_schedule'`
    );
    const retentionResult = await pool.query(
      `SELECT value, value_encrypted, value_iv, value_auth_tag FROM v_b_settings WHERE key = 'backup_retention_days'`
    );
    
    const schedule = scheduleResult.rows[0] 
      ? decryptSetting(scheduleResult.rows[0]) || '0 2 * * *'
      : '0 2 * * *';
    
    const retention = retentionResult.rows[0]
      ? parseInt(decryptSetting(retentionResult.rows[0]) || '14', 10)
      : 14;
    
    res.json({
      schedule: schedule,
      retention_days: retention
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ───────────────────────────────────────────────
// 💾 POST /backup/plan — Sauvegarder le plan de sauvegarde
// ───────────────────────────────────────────────
router.post('/backup/plan', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    const { schedule, retention_days } = req.body;
    
    await pool.query(
      `INSERT INTO v_b_settings (section, key, value) 
       VALUES ('maintenance', 'backup_schedule', $1)
       ON CONFLICT (section, key) DO UPDATE SET value = $1`,
      [schedule || '0 2 * * *']
    );
    
    await pool.query(
      `INSERT INTO v_b_settings (section, key, value) 
       VALUES ('maintenance', 'backup_retention_days', $1)
       ON CONFLICT (section, key) DO UPDATE SET value = $1`,
      [String(retention_days || 14)]
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ───────────────────────────────────────────────
// 🚀 POST /deploy — Exécuter le script de déploiement
// ───────────────────────────────────────────────
router.post('/deploy', verifyJWT, requireRole('admin'), async (req, res) => {
  try {
    const deployScript = String(process.env.DEPLOY_SCRIPT_PATH || '').trim();
    if (!deployScript) {
      return res.status(501).json({
        error: 'Déploiement non configuré. Définissez DEPLOY_SCRIPT_PATH (chemin absolu vers le script).',
      });
    }

    console.log('Exécution du script de déploiement...');

    const { stdout, stderr } = await execFileAsync(deployScript, [], {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    
    if (stderr && !stderr.includes('WARNING')) {
      console.error('Erreur lors du déploiement:', stderr);
      return res.status(500).json({ 
        error: 'Erreur lors du déploiement', 
        details: stderr,
        output: stdout 
      });
    }
    
    console.log('Déploiement terminé avec succès');
    res.json({ 
      success: true, 
      message: 'Déploiement terminé avec succès',
      output: stdout,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Erreur lors de l\'exécution du script de déploiement:', err);
    res.status(500).json({ 
      error: 'Erreur lors du déploiement', 
      details: err.message,
      code: err.code
    });
  }
});

export default router;
