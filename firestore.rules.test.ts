import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Static verification suite for the "Dirty Dozen" invariants in firestore.rules.
 * Full emulator execution can be run locally via `firebase emulators:exec`.
 */
describe('Firestore Security Rules Invariants (Dirty Dozen Coverage)', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const draftPath = path.resolve(process.cwd(), 'DRAFT_firestore.rules');
  const readRules = () =>
    fs.existsSync(rulesPath)
      ? fs.readFileSync(rulesPath, 'utf-8')
      : fs.readFileSync(draftPath, 'utf-8');

  it('enforces default-deny global catch-all first', () => {
    const rules = readRules();
    expect(rules).toContain("rules_version = '2';");
    expect(rules).toContain('match /{document=**}');
    expect(rules).toContain('allow read, write: if false;');
  });

  it('requires verified email on writes and isolates PII to owner only', () => {
    const rules = readRules();
    expect(rules).toContain('request.auth.token.email_verified == true');
    expect(rules).toContain('allow get: if isValidId(userId) && isOwner(userId);');
    expect(rules).toContain('allow list: if false;');
  });

  it('prevents shadow fields, identity spoofing, and immortal field tampering', () => {
    const rules = readRules();
    expect(rules).toContain('data.keys().hasAll(');
    expect(rules).toContain('data.keys().hasOnly(');
    expect(rules).toContain('incoming().createdAt == existing().createdAt');
    expect(rules).toContain('incoming().updatedAt == request.time');
    expect(rules).toContain('incoming().diff(existing()).affectedKeys().hasOnly(');
  });

  it('enforces Master Gate, terminal immutability, bounded arrays, and secure list queries on auctions', () => {
    const rules = readRules();
    expect(rules).toContain('exists(/databases/$(database)/documents/users/$(userId))');
    expect(rules).toContain('allow list: if isOwner(userId)');
    expect(rules).toContain('resource.data.userId == request.auth.uid');
    expect(rules).toContain('allow update: if false;');
    expect(rules).toContain('data.userSquadPlayerIds.size() <= 25');
    expect(rules).toContain('data.userPlayingXIIds.size() <= 11');
  });
});
