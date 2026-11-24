# Firestore Security Specification — IPL Auction Arena

## 1. Data Invariants
1. Every `/users/{userId}` document can only be created, read, or updated by the verified authenticated user whose `request.auth.uid == userId`.
2. Every `/users/{userId}/auctions/{auctionId}` document requires its parent `/users/{userId}` document to exist (`Master Gate`), and its `userId` field must strictly match both `{userId}` and `request.auth.uid`.
3. Completed auction history documents are append-only (no client mutation after creation) and may only be deleted by their verified owner.
4. All document IDs (`userId`, `auctionId`) must match `^[a-zA-Z0-9_-]+$` and be <= 128 chars.
5. All string fields enforce explicit `.size()` bounds; all list fields enforce strict `.size() <= MAX` limits; all timestamps match `request.time`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated Profile Read**: Anonymous caller attempts `get` on `/users/uid_alice`.
2. **Cross-User Profile Read (PII Leak)**: Authenticated `uid_bob` attempts `get` on `/users/uid_alice`.
3. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts `create` on `/users/uid_unverified`.
4. **Shadow Field Injection on Profile Create**: Owner injects `{ isAdmin: true }` alongside valid profile fields.
5. **Identity Spoofing on Profile Create**: `uid_alice` attempts `create` on `/users/uid_alice` with `{ uid: "uid_bob" }`.
6. **Immortal Timestamp Tampering**: Owner attempts `update` on `/users/uid_alice` changing `createdAt`.
7. **Value Poisoning on Profile Update**: Owner updates `username` with a 500-character string or boolean.
8. **Orphaned Auction History Create**: User writes to `/users/uid_new/auctions/auc_1` before parent `/users/uid_new` exists.
9. **Cross-Owner Auction History Create**: `uid_bob` attempts `create` on `/users/uid_alice/auctions/auc_1`.
10. **Unbounded Array Resource Exhaustion**: Owner attempts `create` on `/users/uid_alice/auctions/auc_2` with 500 items in `userSquadPlayerIds`.
11. **Terminal History Mutation**: Owner attempts `update` on an existing `/users/uid_alice/auctions/auc_1` to alter `userRank` from 4 to 1.
12. **ID Poisoning**: Caller attempts `create` on `/users/uid_alice/auctions/bad$id!..` or a 200-char document ID.
