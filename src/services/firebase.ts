import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { FranchiseId, SavedAuction, UserProfile } from '../engine/types';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
if (typeof window !== 'undefined') {
  testConnection();
}

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export function subscribeFirebaseAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}

function sanitizeUsername(name: string | null | undefined): string {
  const cleaned = (name || 'Franchise Owner').replace(/[<>]/g, '').trim().slice(0, 40);
  return cleaned.length >= 2 ? cleaned : 'Franchise Owner';
}

function sanitizeDocId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length >= 1 ? cleaned : `auc_${Date.now()}`;
}

export async function ensureCloudUserProfile(
  user: User,
  fallbackFranchise: FranchiseId = 'CSK'
): Promise<UserProfile> {
  const docPath = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      return {
        id: user.uid,
        username: String(d.username || sanitizeUsername(user.displayName)),
        email: user.email ?? undefined,
        isGuest: false,
        favoriteFranchise: (d.favoriteFranchise as FranchiseId) || fallbackFranchise,
        avatarColor: '#F59E0B',
        stats: {
          auctionsPlayed: Number(d.auctionsPlayed) || 0,
          auctionsWon: Number(d.auctionsWon) || 0,
          bestRating: Number(d.bestRating) || 0,
          avgRating: Number(d.avgRating) || 0,
          tournamentsWon: Number(d.tournamentsWon) || 0,
        },
      };
    }

    const username = sanitizeUsername(user.displayName || user.email?.split('@')[0]);
    const payload = {
      uid: user.uid,
      username,
      favoriteFranchise: fallbackFranchise,
      auctionsPlayed: 0,
      auctionsWon: 0,
      bestRating: 0,
      avgRating: 0,
      tournamentsWon: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, payload);
    return {
      id: user.uid,
      username,
      email: user.email ?? undefined,
      isGuest: false,
      favoriteFranchise: fallbackFranchise,
      avatarColor: '#F59E0B',
      stats: {
        auctionsPlayed: 0,
        auctionsWon: 0,
        bestRating: 0,
        avgRating: 0,
        tournamentsWon: 0,
      },
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docPath);
  }
}

export async function updateCloudUserProfile(
  uid: string,
  profile: UserProfile
): Promise<void> {
  const docPath = `users/${uid}`;
  try {
    const ref = doc(db, 'users', uid);
    const played = Math.max(0, Math.min(100000, Math.round(profile.stats.auctionsPlayed)));
    const won = Math.max(0, Math.min(played, Math.round(profile.stats.auctionsWon)));
    await updateDoc(ref, {
      username: sanitizeUsername(profile.username),
      favoriteFranchise: profile.favoriteFranchise,
      auctionsPlayed: played,
      auctionsWon: won,
      bestRating: Math.max(0, Math.min(100, Math.round(profile.stats.bestRating))),
      avgRating: Math.max(0, Math.min(100, Math.round(profile.stats.avgRating))),
      tournamentsWon: Math.max(0, Math.min(10000, Math.round(profile.stats.tournamentsWon))),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, docPath);
  }
}

export interface CloudAuctionSummary {
  id: string;
  userId: string;
  roomCode: string;
  completedAt: number;
  mode: SavedAuction['mode'];
  rulesetName: string;
  aiDifficulty: SavedAuction['aiDifficulty'];
  userFranchiseId: FranchiseId;
  winnerFranchiseId: FranchiseId;
  userScore: number;
  winnerScore: number;
  userRank: number;
  userSquadPlayerIds: string[];
  userPlayingXIIds: string[];
  leaderboardSummary: { franchiseId: FranchiseId; rank: number; score: number }[];
}

export async function saveCloudAuctionHistory(
  uid: string,
  record: SavedAuction,
  playingXIIds: string[] = []
): Promise<void> {
  const auctionId = sanitizeDocId(record.id);
  const docPath = `users/${uid}/auctions/${auctionId}`;
  try {
    const squadIds = (record.stateSnapshot.teams[record.userFranchiseId]?.squad || [])
      .map((s) => s.playerId)
      .slice(0, 25);
    const xiIds = playingXIIds.slice(0, 11);
    const leaderboardSummary = Object.values(record.ratings)
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, 10)
      .map((r, i) => ({
        franchiseId: r.franchiseId,
        rank: i + 1,
        score: Math.max(0, Math.min(100, Math.round(r.overallScore))),
      }));

    await setDoc(doc(db, 'users', uid, 'auctions', auctionId), {
      id: auctionId,
      userId: uid,
      roomCode: record.roomCode.slice(0, 16),
      completedAt: Math.round(record.completedAt),
      mode: record.mode,
      rulesetName: record.rulesetName.slice(0, 80),
      aiDifficulty: record.aiDifficulty,
      userFranchiseId: record.userFranchiseId,
      winnerFranchiseId: record.winnerFranchiseId,
      userScore: Math.max(0, Math.min(100, Number(record.userScore) || 0)),
      winnerScore: Math.max(0, Math.min(100, Number(record.winnerScore) || 0)),
      userRank: Math.max(1, Math.min(10, Math.round(record.userRank))),
      userSquadPlayerIds: squadIds,
      userPlayingXIIds: xiIds,
      leaderboardSummary,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, docPath);
  }
}

export async function loadCloudAuctionHistory(uid: string): Promise<CloudAuctionSummary[]> {
  const colPath = `users/${uid}/auctions`;
  try {
    const q = query(
      collection(db, 'users', uid, 'auctions'),
      where('userId', '==', uid),
      orderBy('completedAt', 'desc'),
      limit(30)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as CloudAuctionSummary);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colPath);
  }
}

export async function deleteCloudAuctionHistory(uid: string, auctionId: string): Promise<void> {
  const safeId = sanitizeDocId(auctionId);
  const docPath = `users/${uid}/auctions/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'auctions', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}
