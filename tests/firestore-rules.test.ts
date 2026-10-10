import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment
} from '@firebase/rules-unit-testing';
import * as fs from 'fs';
import { Timestamp, doc, getDoc, getDocs, collection, setDoc } from 'firebase/firestore';

export async function runRulesTests() {
  const rules = fs.readFileSync('firestore.rules', 'utf8');
  let testEnv: RulesTestEnvironment | null = null;

  try {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-rules-test',
      firestore: {
        rules,
        host: '127.0.0.1',
        port: 8080
      }
    });

    const aliceAuth = testEnv.authenticatedContext('alice');
    const bobAuth = testEnv.authenticatedContext('bob');
    const unauth = testEnv.unauthenticatedContext();

    const aliceDb = aliceAuth.firestore();
    const bobDb = bobAuth.firestore();

    const validSessionId = 'abc123XYZ456_-99';
    const now = Date.now();
    const sessionData = {
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + 3600000),
      createdBy: 'alice'
    };

    await testEnv.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'sessions', validSessionId), sessionData);
      await setDoc(doc(context.firestore(), 'sessions', 'expired_session_1'), {
        createdAt: Timestamp.fromMillis(now - 7200000),
        expiresAt: Timestamp.fromMillis(now - 3600000),
        createdBy: 'alice'
      });
    });

    await assertFails(getDocs(collection(aliceDb, 'sessions')));

    await assertFails(
      setDoc(doc(aliceDb, 'sessions', validSessionId, 'players', 'bob'), {
        id: 'bob',
        name: 'Bob',
        userId: 'bob',
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
        joinedAt: now,
        expiresAt: Timestamp.fromMillis(now + 3600000)
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, 'sessions', validSessionId, 'players', 'alice'), {
        id: 'alice',
        name: 'Alice',
        userId: 'alice',
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
        joinedAt: now,
        expiresAt: Timestamp.fromMillis(now + 3600000),
        maliciousExtraField: true
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, 'sessions', 'expired_session_1', 'players', 'alice'), {
        id: 'alice',
        name: 'Alice',
        userId: 'alice',
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
        joinedAt: now,
        expiresAt: Timestamp.fromMillis(now + 3600000)
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, 'sessions', 'non_existent_sess', 'players', 'alice'), {
        id: 'alice',
        name: 'Alice',
        userId: 'alice',
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
        joinedAt: now,
        expiresAt: Timestamp.fromMillis(now + 3600000)
      })
    );

    await assertFails(
      setDoc(doc(aliceDb, 'sessions', validSessionId, 'players', 'alice'), {
        id: 'alice',
        name: 'SuperLongDisplayNameExceedingTwentyFourCharacters',
        userId: 'alice',
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
        joinedAt: now,
        expiresAt: Timestamp.fromMillis(now + 3600000)
      })
    );

    return {
      listSessionsDenied: true,
      anotherUserPlayerWriteDenied: true,
      extraFieldDenied: true,
      expiredOrMissingSessionDenied: true,
      oversizedNameDenied: true
    };
  } finally {
    if (testEnv) {
      await testEnv.cleanup();
    }
  }
}
