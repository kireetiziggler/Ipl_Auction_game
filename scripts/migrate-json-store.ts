import crypto from 'crypto';
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { closeDatabasePool, db } from '../src/db/index.ts';
import { adminAccounts, customPlayers, users } from '../src/db/schema.ts';
import type { FranchiseId, Player, UserProfile } from '../src/engine/types.ts';
import { sanitizeAndValidatePlayer } from '../src/server/adminService.ts';
import { isValidFranchiseId, normalizeEmail, sanitizeText } from '../src/server/config.ts';

dotenv.config();

interface LegacyStoredUser {
  id?: string;
  username?: string;
  email?: string;
  passwordHash?: string;
  passwordSalt?: string;
  favoriteFranchise?: FranchiseId;
  avatarColor?: string;
  stats?: UserProfile['stats'];
}

interface LegacyPersistedStore {
  users?: LegacyStoredUser[];
  customPlayers?: Array<Record<string, unknown>>;
  adminHash?: string;
  adminSalt?: string;
}

export interface JsonMigrationSummary {
  storeFound: boolean;
  backupPath: string | null;
  usersImported: number;
  usersSkipped: number;
  customPlayersImported: number;
  customPlayersSkipped: number;
  adminImported: boolean;
  adminSkipped: boolean;
}

export async function migrateJsonStoreToPostgres(
  storePath = path.resolve(process.cwd(), 'data', 'arena-store.json')
): Promise<JsonMigrationSummary> {
  const summary: JsonMigrationSummary = {
    storeFound: false,
    backupPath: null,
    usersImported: 0,
    usersSkipped: 0,
    customPlayersImported: 0,
    customPlayersSkipped: 0,
    adminImported: false,
    adminSkipped: false,
  };

  if (!fs.existsSync(storePath)) {
    return summary;
  }

  summary.storeFound = true;
  const rawContent = fs.readFileSync(storePath, 'utf-8');
  const parsed = JSON.parse(rawContent) as LegacyPersistedStore;

  // Create timestamped backup before importing; NEVER delete the original file.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${storePath}.backup.${stamp}`;
  fs.copyFileSync(storePath, backupPath);
  summary.backupPath = backupPath;

  const now = new Date();

  await db.transaction(async (tx) => {
    // 1) Migrate users idempotently (skip duplicates by normalized email without overwriting)
    const legacyUsers = Array.isArray(parsed.users) ? parsed.users : [];
    for (const u of legacyUsers) {
      const email = normalizeEmail(u.email);
      const username = sanitizeText(u.username, 40);
      if (!email || !username || !u.passwordHash || !u.passwordSalt) {
        summary.usersSkipped += 1;
        continue;
      }

      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.normalizedEmail, email))
        .limit(1);
      if (existing.length > 0) {
        summary.usersSkipped += 1;
        continue;
      }

      const fav: FranchiseId = isValidFranchiseId(u.favoriteFranchise) ? u.favoriteFranchise : 'CSK';
      await tx
        .insert(users)
        .values({
          id: sanitizeText(u.id, 64) || `usr_${crypto.randomBytes(10).toString('hex')}`,
          username,
          normalizedEmail: email,
          passwordHash: u.passwordHash,
          passwordSalt: u.passwordSalt,
          favoriteFranchise: fav,
          avatarColor: sanitizeText(u.avatarColor, 20) || '#F59E0B',
          statsJson: u.stats ?? {
            auctionsPlayed: 0,
            auctionsWon: 0,
            bestRating: 0,
            avgRating: 0,
            tournamentsWon: 0,
          },
          createdAt: now,
          updatedAt: now,
          isActive: true,
        })
        .onConflictDoNothing();
      summary.usersImported += 1;
    }

    // 2) Migrate custom players idempotently (skip existing IDs without silently overwriting)
    const legacyPlayers = Array.isArray(parsed.customPlayers) ? parsed.customPlayers : [];
    for (const rawPlayer of legacyPlayers) {
      const safe: Player | null = sanitizeAndValidatePlayer(
        rawPlayer,
        'Migrated Legacy JSON Player'
      );
      if (!safe) {
        summary.customPlayersSkipped += 1;
        continue;
      }
      const existing = await tx
        .select({ id: customPlayers.id })
        .from(customPlayers)
        .where(eq(customPlayers.id, safe.id))
        .limit(1);
      if (existing.length > 0) {
        summary.customPlayersSkipped += 1;
        continue;
      }
      await tx
        .insert(customPlayers)
        .values({
          id: safe.id,
          playerJson: safe,
          createdBy: 'json-migration',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      summary.customPlayersImported += 1;
    }

    // 3) Migrate admin account credentials if present and no admin exists yet
    if (parsed.adminHash && parsed.adminSalt) {
      const existingAdmin = await tx.select({ id: adminAccounts.id }).from(adminAccounts).limit(1);
      if (existingAdmin.length === 0) {
        await tx
          .insert(adminAccounts)
          .values({
            id: `adm_${crypto.randomBytes(8).toString('hex')}`,
            username: 'admin',
            passwordHash: parsed.adminHash,
            passwordSalt: parsed.adminSalt,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        summary.adminImported = true;
      } else {
        summary.adminSkipped = true;
      }
    }
  });

  return summary;
}

// Run directly when executed via `tsx scripts/migrate-json-store.ts`
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'migrate-json-store.ts'));

if (isDirectExecution) {
  migrateJsonStoreToPostgres()
    .then((summary) => {
      if (!summary.storeFound) {
        console.log('[MigrateJSON] No legacy data/arena-store.json found. Nothing to migrate.');
      } else {
        console.log('[MigrateJSON] Migration completed safely:');
        console.log(`  Backup created: ${summary.backupPath}`);
        console.log(
          `  Users: ${summary.usersImported} imported, ${summary.usersSkipped} skipped`
        );
        console.log(
          `  Custom Players: ${summary.customPlayersImported} imported, ${summary.customPlayersSkipped} skipped`
        );
        console.log(
          `  Admin Account: ${summary.adminImported ? 'imported' : summary.adminSkipped ? 'already exists (skipped)' : 'none in JSON'}`
        );
      }
    })
    .catch((err) => {
      console.error('[MigrateJSON] Migration failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabasePool();
    });
}
