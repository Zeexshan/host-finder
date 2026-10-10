import { after, before, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc
} from 'firebase/firestore';

const HOUR_MS = 60 * 60 * 1000;
const LIVE_SESSION_ID = 'abc123XYZ456_-99';
const EXPIRED_SESSION_ID = 'expiredSession_1';
const NEW_SESSION_ID = 'newSession_ABC-1';

let testEnv: RulesTestEnvironment;

function playerData(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uid,
    name: 'Player',
    userId: uid,
    lat: 10,
    lng: 20,
    cityName: 'City',
    connectionType: 'wired',
    uploadMbps: 50,
    downloadMbps: 100,
    latencyMs: 30,
    jitterMs: 5,
    pcStrength: 'high',
    canHost: 'yes',
    joinedAt: Date.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + HOUR_MS),
    ...overrides
  };
}

function db(uid: string) {
  return testEnv.authenticatedContext(uid).firestore();
}

before(async () => {
  const hasEmulatorEnv = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HUB);
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-host-finder',
    firestore: hasEmulatorEnv
      ? { rules: readFileSync('firestore.rules', 'utf8') }
      : { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 }
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  const now = Date.now();
  await testEnv.withSecurityRulesDisabled(async context => {
    const adminDb = context.firestore();
    await setDoc(doc(adminDb, 'sessions', LIVE_SESSION_ID), {
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + HOUR_MS),
      createdBy: 'alice'
    });
    await setDoc(doc(adminDb, 'sessions', EXPIRED_SESSION_ID), {
      createdAt: Timestamp.fromMillis(now - 2 * HOUR_MS),
      expiresAt: Timestamp.fromMillis(now - HOUR_MS),
      createdBy: 'alice'
    });
    await setDoc(doc(adminDb, 'sessions', LIVE_SESSION_ID, 'players', 'alice'), playerData('alice', { name: 'Alice' }));
  });
});

describe('sessions', () => {
  test('signed-in user creates a valid session with serverTimestamp', async () => {
    await assertSucceeds(
      setDoc(doc(db('bob'), 'sessions', NEW_SESSION_ID), {
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 23 * HOUR_MS),
        createdBy: 'bob'
      })
    );
  });

  test('session create with expiresAt beyond 24h is denied', async () => {
    await assertFails(
      setDoc(doc(db('bob'), 'sessions', NEW_SESSION_ID), {
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 25 * HOUR_MS),
        createdBy: 'bob'
      })
    );
  });

  test('signed-in user reads a session by id', async () => {
    await assertSucceeds(getDoc(doc(db('bob'), 'sessions', LIVE_SESSION_ID)));
  });

  test('listing sessions is denied', async () => {
    await assertFails(getDocs(collection(db('alice'), 'sessions')));
  });

  test('session update is denied', async () => {
    await assertFails(
      updateDoc(doc(db('alice'), 'sessions', LIVE_SESSION_ID), {
        expiresAt: Timestamp.fromMillis(Date.now() + 2 * HOUR_MS)
      })
    );
  });

  test('session delete is denied', async () => {
    await assertFails(deleteDoc(doc(db('alice'), 'sessions', LIVE_SESSION_ID)));
  });
});

describe('players', () => {
  test('valid player join succeeds', async () => {
    await assertSucceeds(
      setDoc(doc(db('bob'), 'sessions', LIVE_SESSION_ID, 'players', 'bob'), playerData('bob', { name: 'Bob' }))
    );
  });

  test('reading another player doc in a live session succeeds', async () => {
    await assertSucceeds(getDoc(doc(db('bob'), 'sessions', LIVE_SESSION_ID, 'players', 'alice')));
  });

  test('listing players in a live session succeeds', async () => {
    await assertSucceeds(getDocs(collection(db('bob'), 'sessions', LIVE_SESSION_ID, 'players')));
  });

  test('deleting own player doc succeeds', async () => {
    await assertSucceeds(deleteDoc(doc(db('alice'), 'sessions', LIVE_SESSION_ID, 'players', 'alice')));
  });

  test("deleting another user's player doc is denied", async () => {
    await assertFails(deleteDoc(doc(db('bob'), 'sessions', LIVE_SESSION_ID, 'players', 'alice')));
  });

  test("writing another user's player doc is denied", async () => {
    await assertFails(
      setDoc(doc(db('alice'), 'sessions', LIVE_SESSION_ID, 'players', 'bob'), playerData('bob', { name: 'Bob' }))
    );
  });

  test('player doc with an extra field is denied', async () => {
    await assertFails(
      setDoc(
        doc(db('alice'), 'sessions', LIVE_SESSION_ID, 'players', 'alice'),
        playerData('alice', { maliciousExtraField: true })
      )
    );
  });

  test('joining an expired session is denied', async () => {
    await assertFails(
      setDoc(doc(db('alice'), 'sessions', EXPIRED_SESSION_ID, 'players', 'alice'), playerData('alice'))
    );
  });

  test('joining a missing session is denied', async () => {
    await assertFails(
      setDoc(doc(db('alice'), 'sessions', 'non_existent_sess', 'players', 'alice'), playerData('alice'))
    );
  });

  test('player name longer than 24 characters is denied', async () => {
    await assertFails(
      setDoc(
        doc(db('alice'), 'sessions', LIVE_SESSION_ID, 'players', 'alice'),
        playerData('alice', { name: 'SuperLongDisplayNameExceedingTwentyFourCharacters' })
      )
    );
  });
});

describe('unauthenticated access', () => {
  function unauthDb() {
    return testEnv.unauthenticatedContext().firestore();
  }

  test('reading a session is denied', async () => {
    await assertFails(getDoc(doc(unauthDb(), 'sessions', LIVE_SESSION_ID)));
  });

  test('creating a session is denied', async () => {
    await assertFails(
      setDoc(doc(unauthDb(), 'sessions', NEW_SESSION_ID), {
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 23 * HOUR_MS),
        createdBy: 'anon'
      })
    );
  });

  test('reading players is denied', async () => {
    await assertFails(getDocs(collection(unauthDb(), 'sessions', LIVE_SESSION_ID, 'players')));
  });

  test('writing a player doc is denied', async () => {
    await assertFails(
      setDoc(doc(unauthDb(), 'sessions', LIVE_SESSION_ID, 'players', 'alice'), playerData('alice'))
    );
  });
});
