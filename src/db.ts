/**
 * SQLite persistence layer.
 * Stores: user profiles, coaching summaries, goals, analytics events, response ratings.
 * Conversations/messages remain in conversation.ts (JSON file) for now.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.resolve('.cache/maxwell.db');

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DB_PATH);
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    userId       TEXT PRIMARY KEY,
    firstName    TEXT,
    role         TEXT,
    industry     TEXT,
    currentChallenge TEXT,
    goals        TEXT,
    tonePref     TEXT,
    brevityPref  TEXT,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch()),
    updatedAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS coaching_summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    userId       TEXT NOT NULL,
    threadId     TEXT NOT NULL,
    summary      TEXT NOT NULL,
    turnCount    INTEGER NOT NULL,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS user_goals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    userId       TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    targetDate   TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    lastCheckedAt INTEGER,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch()),
    updatedAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    eventType    TEXT NOT NULL,
    userId       TEXT,
    model        TEXT,
    chunkIds     TEXT,
    categoryIds  TEXT,
    isStub       INTEGER,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS response_ratings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    userId       TEXT,
    threadId     TEXT NOT NULL,
    messageIndex INTEGER NOT NULL,
    chunkIds     TEXT,
    helpful      INTEGER NOT NULL,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS reflection_answers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    userId       TEXT NOT NULL,
    questionId   TEXT NOT NULL,
    question     TEXT NOT NULL,
    answer       TEXT NOT NULL,
    extracted    TEXT,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS saved_insights (
    id           TEXT PRIMARY KEY,
    userId       TEXT NOT NULL,
    text         TEXT NOT NULL,
    createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_summaries_user ON coaching_summaries(userId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_goals_user ON user_goals(userId, status);
  CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(eventType, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_ratings_thread ON response_ratings(threadId);
  CREATE INDEX IF NOT EXISTS idx_saved_insights_user ON saved_insights(userId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_reflections_user ON reflection_answers(userId, createdAt DESC);
`);

// Lightweight migration: CREATE TABLE IF NOT EXISTS won't add columns to an
// already-existing table, so add profileNarrative separately and ignore the
// "duplicate column" error on repeat runs.
try {
  db.exec('ALTER TABLE user_profiles ADD COLUMN profileNarrative TEXT');
} catch {
  // already exists
}

export interface DbUserProfile {
  userId: string;
  firstName?: string;
  role?: string;
  industry?: string;
  currentChallenge?: string;
  goals?: string[];
  tonePref?: string;
  brevityPref?: string;
  profileNarrative?: string;
}

export function upsertProfile(p: DbUserProfile): void {
  db.prepare(`
    INSERT INTO user_profiles (userId, firstName, role, industry, currentChallenge, goals, tonePref, brevityPref, profileNarrative, updatedAt)
    VALUES (@userId, @firstName, @role, @industry, @currentChallenge, @goals, @tonePref, @brevityPref, @profileNarrative, unixepoch())
    ON CONFLICT(userId) DO UPDATE SET
      firstName = COALESCE(@firstName, firstName),
      role = COALESCE(@role, role),
      industry = COALESCE(@industry, industry),
      currentChallenge = COALESCE(@currentChallenge, currentChallenge),
      goals = COALESCE(@goals, goals),
      tonePref = COALESCE(@tonePref, tonePref),
      brevityPref = COALESCE(@brevityPref, brevityPref),
      profileNarrative = COALESCE(@profileNarrative, profileNarrative),
      updatedAt = unixepoch()
  `).run({
    ...p,
    goals: p.goals ? JSON.stringify(p.goals) : null,
    profileNarrative: p.profileNarrative ?? null
  });
}

export function getProfile(userId: string): DbUserProfile | undefined {
  const row = db.prepare('SELECT * FROM user_profiles WHERE userId = ?').get(userId) as any;
  if (!row) return undefined;
  return {
    ...row,
    goals: row.goals ? JSON.parse(row.goals) : undefined
  };
}

export function saveReflectionAnswer(userId: string, questionId: string, question: string, answer: string, extracted?: object): void {
  db.prepare(`
    INSERT INTO reflection_answers (userId, questionId, question, answer, extracted)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, questionId, question, answer, extracted ? JSON.stringify(extracted) : null);
}

export function getReflectionAnswers(userId: string): Array<{ questionId: string; question: string; answer: string; createdAt: number }> {
  return db.prepare(`
    SELECT questionId, question, answer, createdAt FROM reflection_answers
    WHERE userId = ? ORDER BY createdAt ASC
  `).all(userId) as Array<{ questionId: string; question: string; answer: string; createdAt: number }>;
}

export function saveInsight(userId: string, id: string, text: string): void {
  db.prepare(`INSERT OR REPLACE INTO saved_insights (id, userId, text) VALUES (?, ?, ?)`).run(id, userId, text);
}

export function deleteInsight(userId: string, id: string): void {
  db.prepare(`DELETE FROM saved_insights WHERE id = ? AND userId = ?`).run(id, userId);
}

export function getSavedInsights(userId: string): Array<{ id: string; text: string; createdAt: number }> {
  return db.prepare(`
    SELECT id, text, createdAt FROM saved_insights
    WHERE userId = ? ORDER BY createdAt DESC
  `).all(userId) as Array<{ id: string; text: string; createdAt: number }>;
}

export function saveCoachingSummary(userId: string, threadId: string, summary: string, turnCount: number): void {
  db.prepare(`
    INSERT INTO coaching_summaries (userId, threadId, summary, turnCount)
    VALUES (?, ?, ?, ?)
  `).run(userId, threadId, summary, turnCount);
}

export function getRecentCoachingSummaries(userId: string, limit = 3): Array<{ summary: string; createdAt: number }> {
  return db.prepare(`
    SELECT summary, createdAt FROM coaching_summaries
    WHERE userId = ? ORDER BY createdAt DESC LIMIT ?
  `).all(userId, limit) as Array<{ summary: string; createdAt: number }>;
}

export interface DbGoal {
  id?: number;
  userId: string;
  title: string;
  description?: string;
  targetDate?: string;
  status?: string;
  lastCheckedAt?: number;
}

export function addGoal(g: DbGoal): number {
  const result = db.prepare(`
    INSERT INTO user_goals (userId, title, description, targetDate)
    VALUES (@userId, @title, @description, @targetDate)
  `).run(g);
  return Number(result.lastInsertRowid);
}

export function getActiveGoals(userId: string): DbGoal[] {
  return db.prepare(`
    SELECT * FROM user_goals WHERE userId = ? AND status = 'active' ORDER BY createdAt DESC
  `).all(userId) as DbGoal[];
}

export function updateGoalStatus(id: number, status: string): void {
  db.prepare('UPDATE user_goals SET status = ?, updatedAt = unixepoch() WHERE id = ?').run(status, id);
}

export function markGoalChecked(userId: string): void {
  db.prepare("UPDATE user_goals SET lastCheckedAt = unixepoch() WHERE userId = ? AND status = 'active'").run(userId);
}

export function needsGoalCheckIn(userId: string, daysSince = 7): boolean {
  const goals = getActiveGoals(userId);
  if (!goals.length) return false;
  const oldest = goals.reduce((min, g) => Math.min(min, g.lastCheckedAt || 0), Infinity);
  const threshold = Date.now() / 1000 - daysSince * 86400;
  return oldest < threshold;
}

export function trackEvent(event: {
  eventType: string;
  userId?: string;
  model?: string;
  chunkIds?: string[];
  categoryIds?: string[];
  isStub?: boolean;
}): void {
  try {
    db.prepare(`
      INSERT INTO analytics_events (eventType, userId, model, chunkIds, categoryIds, isStub)
      VALUES (@eventType, @userId, @model, @chunkIds, @categoryIds, @isStub)
    `).run({
      ...event,
      chunkIds: event.chunkIds ? JSON.stringify(event.chunkIds) : null,
      categoryIds: event.categoryIds ? JSON.stringify(event.categoryIds) : null,
      isStub: event.isStub ? 1 : 0
    });
  } catch {
    // non-critical
  }
}

export function getAnalyticsSummary(): object {
  const since7d = Math.floor(Date.now() / 1000) - 7 * 86400;
  const totalQueries = (db.prepare("SELECT COUNT(*) as n FROM analytics_events WHERE eventType='query' AND createdAt > ?").get(since7d) as any)?.n || 0;
  const stubCount = (db.prepare('SELECT COUNT(*) as n FROM analytics_events WHERE isStub=1 AND createdAt > ?').get(since7d) as any)?.n || 0;
  const totalUsers = (db.prepare('SELECT COUNT(DISTINCT userId) as n FROM user_profiles').get() as any)?.n || 0;
  const totalGoals = (db.prepare("SELECT COUNT(*) as n FROM user_goals WHERE status='active'").get() as any)?.n || 0;
  const helpfulRatings = (db.prepare('SELECT COUNT(*) as n FROM response_ratings WHERE helpful=1 AND createdAt > ?').get(since7d) as any)?.n || 0;
  const totalRatings = (db.prepare('SELECT COUNT(*) as n FROM response_ratings WHERE createdAt > ?').get(since7d) as any)?.n || 0;
  return {
    last7days: {
      queries: totalQueries,
      stubFraction: totalQueries > 0 ? (stubCount / totalQueries).toFixed(2) : 'n/a',
      helpfulRate: totalRatings > 0 ? ((helpfulRatings / totalRatings) * 100).toFixed(0) + '%' : 'n/a'
    },
    allTime: {
      users: totalUsers,
      activeGoals: totalGoals
    }
  };
}

export function saveRating(userId: string | undefined, threadId: string, messageIndex: number, chunkIds: string[], helpful: boolean): void {
  db.prepare(`
    INSERT INTO response_ratings (userId, threadId, messageIndex, chunkIds, helpful)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId || null, threadId, messageIndex, JSON.stringify(chunkIds), helpful ? 1 : 0);
}

export default db;
