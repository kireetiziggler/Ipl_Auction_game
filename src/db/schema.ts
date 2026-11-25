import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AuctionState, Player, UserProfile } from '../engine/types.ts';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    firebaseUid: text('firebase_uid').unique(),
    username: text('username').notNull(),
    normalizedEmail: text('normalized_email').notNull().unique(),
    passwordHash: text('password_hash'),
    passwordSalt: text('password_salt'),
    favoriteFranchise: text('favorite_franchise').notNull().default('CSK'),
    avatarColor: text('avatar_color').notNull().default('#F59E0B'),
    statsJson: jsonb('stats_json')
      .$type<UserProfile['stats']>()
      .notNull()
      .default({
        auctionsPlayed: 0,
        auctionsWon: 0,
        bestRating: 0,
        avgRating: 0,
        tournamentsWon: 0,
      }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    uniqueIndex('idx_users_normalized_email').on(table.normalizedEmail),
    index('idx_users_firebase_uid').on(table.firebaseUid),
  ]
);

export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: text('id').primaryKey(),
    guestIdentifier: text('guest_identifier').notNull().unique(),
    username: text('username').notNull(),
    favoriteFranchise: text('favorite_franchise').notNull().default('CSK'),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_guest_sessions_token_hash').on(table.tokenHash),
    index('idx_guest_sessions_expires_at').on(table.expiresAt),
  ]
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestSessionId: text('guest_session_id').references(() => guestSessions.id, {
      onDelete: 'cascade',
    }),
    tokenHash: text('token_hash').notNull().unique(),
    sessionType: text('session_type').notNull(), // 'USER' | 'GUEST' | 'ADMIN'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    deviceInfo: text('device_info'),
  },
  (table) => [
    uniqueIndex('idx_user_sessions_token_hash').on(table.tokenHash),
    index('idx_user_sessions_user_id').on(table.userId),
    index('idx_user_sessions_expires_at').on(table.expiresAt),
  ]
);

export const auctionRooms = pgTable(
  'auction_rooms',
  {
    id: text('id').primaryKey(),
    roomCode: text('room_code').notNull().unique(),
    hostUserId: text('host_user_id').references(() => users.id, { onDelete: 'set null' }),
    hostSessionId: text('host_session_id').notNull(),
    status: text('status').notNull().default('LOBBY'), // 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED'
    gameMode: text('game_mode').notNull().default('MULTIPLAYER'),
    rulesetId: text('ruleset_id').notNull(),
    auctionStateJson: jsonb('auction_state_json').$type<AuctionState>().notNull(),
    stateVersion: integer('state_version').notNull().default(1),
    goingOnceSent: boolean('going_once_sent').notNull().default(false),
    goingTwiceSent: boolean('going_twice_sent').notNull().default(false),
    lastAiBidAt: bigint('last_ai_bid_at', { mode: 'number' }).notNull().default(0),
    lotTransitionAt: bigint('lot_transition_at', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('idx_auction_rooms_room_code').on(table.roomCode),
    index('idx_auction_rooms_status').on(table.status),
    index('idx_auction_rooms_expires_at').on(table.expiresAt),
  ]
);

export const roomParticipants = pgTable(
  'room_participants',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => auctionRooms.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: text('session_id').notNull(),
    username: text('username').notNull(),
    franchiseId: text('franchise_id').notNull(),
    isHost: boolean('is_host').notNull().default(false),
    isConnected: boolean('is_connected').notNull().default(true),
    isReady: boolean('is_ready').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_room_participants_room_session').on(table.roomId, table.sessionId),
    uniqueIndex('uq_room_participants_room_franchise').on(table.roomId, table.franchiseId),
    index('idx_room_participants_room_id').on(table.roomId),
    index('idx_room_participants_session_id').on(table.sessionId),
  ]
);

export const auctionEvents = pgTable(
  'auction_events',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => auctionRooms.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    franchiseId: text('franchise_id'),
    playerId: text('player_id'),
    requestId: text('request_id'),
    eventPayloadJson: jsonb('event_payload_json').$type<Record<string, unknown>>().notNull(),
    stateVersion: integer('state_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_auction_events_room_version').on(table.roomId, table.stateVersion),
    index('idx_auction_events_room_created').on(table.roomId, table.createdAt),
    uniqueIndex('uq_auction_events_room_request').on(table.roomId, table.requestId),
  ]
);

export const customPlayers = pgTable(
  'custom_players',
  {
    id: text('id').primaryKey(),
    playerJson: jsonb('player_json').$type<Player>().notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_custom_players_updated_at').on(table.updatedAt)]
);

export const adminAccounts = pgTable(
  'admin_accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    passwordSalt: text('password_salt').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_admin_accounts_username').on(table.username)]
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').primaryKey(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull().default(1),
  },
  (table) => [index('idx_rate_limit_buckets_expires_at').on(table.expiresAt)]
);

export const schedulerLeases = pgTable('scheduler_leases', {
  leaseKey: text('lease_key').primaryKey(),
  ownerId: text('owner_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Drizzle Relations
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(userSessions),
  hostedRooms: many(auctionRooms),
  participations: many(roomParticipants),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
  guestSession: one(guestSessions, {
    fields: [userSessions.guestSessionId],
    references: [guestSessions.id],
  }),
}));

export const auctionRoomsRelations = relations(auctionRooms, ({ one, many }) => ({
  hostUser: one(users, { fields: [auctionRooms.hostUserId], references: [users.id] }),
  participants: many(roomParticipants),
  events: many(auctionEvents),
}));

export const roomParticipantsRelations = relations(roomParticipants, ({ one }) => ({
  room: one(auctionRooms, { fields: [roomParticipants.roomId], references: [auctionRooms.id] }),
  user: one(users, { fields: [roomParticipants.userId], references: [users.id] }),
}));

export const auctionEventsRelations = relations(auctionEvents, ({ one }) => ({
  room: one(auctionRooms, { fields: [auctionEvents.roomId], references: [auctionRooms.id] }),
}));
