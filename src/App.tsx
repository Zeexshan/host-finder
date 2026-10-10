import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react';
import {
  Globe2,
  Copy,
  Check,
  Wifi,
  Cable,
  Gauge,
  Activity,
  AlertTriangle,
  RotateCw,
  Trophy,
  ShieldCheck,
  Trash2,
  Info,
  Users,
  Compass,
  Radio,
  CheckCircle2,
  Sparkles,
  Search,
  Lock,
  Layers
} from 'lucide-react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  Timestamp,
  serverTimestamp
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged, User } from 'firebase/auth';

const GlobeView = lazy(() => import('./GlobeView'));

interface Player {
  id: string;
  name: string;
  userId: string;
  lat: number;
  lng: number;
  cityName: string;
  connectionType: 'wired' | 'wifi';
  uploadMbps: number;
  downloadMbps: number;
  latencyMs: number;
  jitterMs: number;
  pcStrength: 'low' | 'medium' | 'high';
  canHost: 'yes' | 'no' | 'only_if_needed';
  radminPings?: Record<string, number>;
  joinedAt: number;
}

interface SessionDoc {
  createdAt: Timestamp;
  expiresAt: Timestamp;
  createdBy: string;
}

interface GeocodingResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
}

interface CandidateScore {
  player: Player;
  worstPing: number;
  worstTargetPlayer?: Player;
  averagePing: number;
  distanceToCentroidKm: number;
  uploadScore: number;
  stabilityScore: number;
  hardwareScore: number;
  overallScore: number;
  uploadWarning?: string;
  breakdown: {
    baseLatency: number;
    centralityPenalty: number;
    uploadPenalty: number;
    wifiPenalty: number;
    jitterPenalty: number;
    pcBonus: number;
  };
  explanation: string;
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAOJ96bDA7_IyZUfS7hwDsZPrbmDzlZFTg",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "host-finder-985be.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "host-finder-985be",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "host-finder-985be.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "65478399967",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:65478399967:web:e0c8bdca3cc469fce7566a"
};

function generateCryptoSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

function roundCoord(val: number): number {
  return Math.round(val * 10) / 10;
}

function calculateGreatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateEstimatedPing(p1: Player, p2: Player): { ping: number; isMeasured: boolean } {
  if (p1.id === p2.id) return { ping: 0, isMeasured: false };
  if (p1.radminPings && p1.radminPings[p2.id] !== undefined) {
    return { ping: p1.radminPings[p2.id], isMeasured: true };
  }
  if (p2.radminPings && p2.radminPings[p1.id] !== undefined) {
    return { ping: p2.radminPings[p1.id], isMeasured: true };
  }
  const distanceKm = calculateGreatCircleKm(p1.lat, p1.lng, p2.lat, p2.lng);
  const est = Math.round((distanceKm / 100) * 1.8 + 10);
  return { ping: Math.max(5, est), isMeasured: false };
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string>('');

  const [sessionId, setSessionId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || '';
  });
  const [sessionDoc, setSessionDoc] = useState<SessionDoc | null>(null);
  const [sessionLoading, setSessionLoading] = useState<boolean>(false);
  const [sessionNotFound, setSessionNotFound] = useState<boolean>(false);
  const [sessionExpired, setSessionExpired] = useState<boolean>(false);

  const [players, setPlayers] = useState<Record<string, Player>>({});

  const [rankingMode, setRankingMode] = useState<'central' | 'minimize_max' | 'best_avg'>('central');
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [hasAnalyzed, setHasAnalyzed] = useState<boolean>(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  const [name, setName] = useState<string>('');
  const [cityName, setCityName] = useState<string>('');
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [connectionType, setConnectionType] = useState<'wired' | 'wifi'>('wired');
  const [uploadMbps, setUploadMbps] = useState<number>(50);
  const [downloadMbps, setDownloadMbps] = useState<number>(150);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [jitterMs, setJitterMs] = useState<number | null>(null);
  const [pcStrength, setPcStrength] = useState<'low' | 'medium' | 'high'>('high');
  const [canHost, setCanHost] = useState<'yes' | 'no' | 'only_if_needed'>('yes');
  const [customPings, setCustomPings] = useState<Record<string, number>>({});

  const [isTestingNet, setIsTestingNet] = useState<boolean>(false);
  const [netTestError, setNetTestError] = useState<string>('');
  const [geoSearching, setGeoSearching] = useState<boolean>(false);
  const [geoResults, setGeoResults] = useState<GeocodingResult[]>([]);
  const [geoError, setGeoError] = useState<string>('');
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [locatingError, setLocatingError] = useState<string>('');
  const [showSecurityModal, setShowSecurityModal] = useState<boolean>(false);

  useEffect(() => {
    try {
      const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const unsubscribe = onAuthStateChanged(auth, user => {
        if (user) {
          setCurrentUser(user);
          setAuthError('');
        } else {
          signInAnonymously(auth).catch(err => {
            setAuthError(err.message || 'Firebase anonymous sign-in failed');
          });
        }
      });
      return () => unsubscribe();
    } catch (err: any) {
      setAuthError(err.message || 'Firebase initialization failed');
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !currentUser) {
      setSessionDoc(null);
      setSessionNotFound(false);
      setSessionExpired(false);
      return;
    }

    setSessionLoading(true);
    setSessionNotFound(false);
    setSessionExpired(false);

    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const sessionRef = doc(db, 'sessions', sessionId);

    const unsubSession = onSnapshot(
      sessionRef,
      snap => {
        setSessionLoading(false);
        if (!snap.exists()) {
          setSessionNotFound(true);
          setSessionDoc(null);
          return;
        }
        const data = snap.data() as SessionDoc;
        setSessionDoc(data);
        if (data.expiresAt && data.expiresAt.toMillis() <= Date.now()) {
          setSessionExpired(true);
        } else {
          setSessionExpired(false);
        }
      },
      () => {
        setSessionLoading(false);
        setSessionNotFound(true);
      }
    );

    const playersRef = collection(db, 'sessions', sessionId, 'players');
    const unsubPlayers = onSnapshot(
      playersRef,
      snap => {
        const list: Record<string, Player> = {};
        snap.forEach(docSnap => {
          list[docSnap.id] = docSnap.data() as Player;
        });
        setPlayers(list);
      },
      () => {
        setPlayers({});
      }
    );

    return () => {
      unsubSession();
      unsubPlayers();
    };
  }, [sessionId, currentUser]);

  const runNetworkBenchmark = useCallback(async () => {
    setIsTestingNet(true);
    setNetTestError('');
    const times: number[] = [];
    const endpoints = [
      'https://cloudflare.com/cdn-cgi/trace',
      'https://1.1.1.1/cdn-cgi/trace',
      'https://dns.google/resolve?name=example.com'
    ];

    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      const start = performance.now();
      try {
        await fetch(ep, { mode: 'no-cors', cache: 'no-store' });
        times.push(performance.now() - start);
      } catch {
        // network failure
      }
    }

    setIsTestingNet(false);

    if (times.length === 0) {
      setNetTestError('Network probe failed. Endpoints unreachable.');
      return;
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    let diffSum = 0;
    for (let i = 1; i < times.length; i++) {
      diffSum += Math.abs(times[i] - times[i - 1]);
    }
    const computedJitter = times.length > 1 ? Math.max(1, Math.round(diffSum / (times.length - 1))) : 2;

    setLatencyMs(avg);
    setJitterMs(computedJitter);
  }, []);

  const handleCitySearch = useCallback(async (query: string) => {
    setCityName(query);
    if (query.trim().length < 2) {
      setGeoResults([]);
      setGeoError('');
      return;
    }
    setGeoSearching(true);
    setGeoError('');
    try {
      const resp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`
      );
      if (!resp.ok) throw new Error('Search failed');
      const data = await resp.json();
      if (data.results && data.results.length > 0) {
        setGeoResults(data.results);
      } else {
        setGeoResults([]);
        setGeoError('No matching cities found');
      }
    } catch {
      setGeoError('Could not reach geocoding service');
      setGeoResults([]);
    } finally {
      setGeoSearching(false);
    }
  }, []);

  const selectCity = useCallback((res: GeocodingResult) => {
    const title = [res.name, res.admin1, res.country].filter(Boolean).join(', ');
    setCityName(title);
    setLat(roundCoord(res.latitude));
    setLng(roundCoord(res.longitude));
    setGeoResults([]);
    setGeoError('');
  }, []);

  const detectCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocatingError('Geolocation is not supported by your browser.');
      return;
    }
    setIsLocating(true);
    setLocatingError('');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const roundedLat = roundCoord(pos.coords.latitude);
        const roundedLng = roundCoord(pos.coords.longitude);
        setLat(roundedLat);
        setLng(roundedLng);
        setCityName(`Approximate Area (${roundedLat}°, ${roundedLng}°)`);
        setIsLocating(false);
      },
      err => {
        setIsLocating(false);
        if (err.code === 1) {
          setLocatingError('Location permission denied. Please search for your city instead.');
        } else {
          setLocatingError('Unable to determine location. Please search for your city.');
        }
      },
      { timeout: 10000, enableHighAccuracy: false }
    );
  }, []);

  const createNewSession = useCallback(async () => {
    if (!currentUser) return;
    const newId = generateCryptoSessionId();
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const sessionRef = doc(db, 'sessions', newId);

    const now = Date.now();
    const docData = {
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),
      createdBy: currentUser.uid
    };

    try {
      await setDoc(sessionRef, docData);
      const url = new URL(window.location.href);
      url.searchParams.set('session', newId);
      window.history.pushState({}, '', url.toString());
      setSessionId(newId);
      setSessionDoc({
        createdAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),
        createdBy: currentUser.uid
      });
      setSessionNotFound(false);
      setSessionExpired(false);
      setHasAnalyzed(false);
      setSelectedHostId(null);
    } catch (err: any) {
      setAuthError(err.message || 'Failed to create session on Firestore.');
    }
  }, [currentUser]);

  const copyMagicLink = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2200);
    });
  }, [sessionId]);

  const handleJoinOrUpdate = useCallback(async () => {
    if (!currentUser || !sessionId || !name.trim() || lat === null || lng === null) return;
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const playerRef = doc(db, 'sessions', sessionId, 'players', currentUser.uid);

    const cleanName = name.trim().slice(0, 24);
    const myPlayer: Player = {
      id: currentUser.uid,
      userId: currentUser.uid,
      name: cleanName,
      cityName: cityName.trim().slice(0, 60) || 'Approximate City Area',
      lat,
      lng,
      connectionType,
      uploadMbps: Math.max(1, Math.min(2000, uploadMbps)),
      downloadMbps: Math.max(1, Math.min(2000, downloadMbps)),
      latencyMs: latencyMs !== null ? Math.max(0, Math.min(1000, latencyMs)) : 20,
      jitterMs: jitterMs !== null ? Math.max(0, Math.min(500, jitterMs)) : 2,
      pcStrength,
      canHost,
      radminPings: customPings,
      joinedAt: Date.now()
    };

    try {
      await setDoc(playerRef, myPlayer);
    } catch (err: any) {
      setAuthError(err.message || 'Failed to update player entry in Firestore.');
    }
  }, [
    currentUser,
    sessionId,
    name,
    cityName,
    lat,
    lng,
    connectionType,
    uploadMbps,
    downloadMbps,
    latencyMs,
    jitterMs,
    pcStrength,
    canHost,
    customPings
  ]);

  const handleRemoveMyData = useCallback(async () => {
    if (!currentUser || !sessionId) return;
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const playerRef = doc(db, 'sessions', sessionId, 'players', currentUser.uid);
    try {
      await deleteDoc(playerRef);
      setName('');
      setCityName('');
      setLat(null);
      setLng(null);
    } catch (err: any) {
      setAuthError(err.message || 'Failed to remove player data.');
    }
  }, [currentUser, sessionId]);

  const playersList = useMemo(() => {
    return Object.values(players);
  }, [players]);

  const currentPlayer = useMemo(() => {
    if (!currentUser) return null;
    return players[currentUser.uid] || null;
  }, [players, currentUser]);

  useEffect(() => {
    if (currentPlayer) {
      setName(currentPlayer.name);
      setCityName(currentPlayer.cityName);
      setLat(currentPlayer.lat);
      setLng(currentPlayer.lng);
      setConnectionType(currentPlayer.connectionType);
      setUploadMbps(currentPlayer.uploadMbps);
      setDownloadMbps(currentPlayer.downloadMbps);
      setLatencyMs(currentPlayer.latencyMs);
      setJitterMs(currentPlayer.jitterMs);
      setPcStrength(currentPlayer.pcStrength);
      setCanHost(currentPlayer.canHost);
      setCustomPings(currentPlayer.radminPings || {});
    }
  }, [currentPlayer]);

  const geographicCentroid = useMemo(() => {
    if (playersList.length === 0) return { lat: 0, lng: 0 };
    let x = 0;
    let y = 0;
    let z = 0;
    playersList.forEach(p => {
      const latRad = (p.lat * Math.PI) / 180;
      const lngRad = (p.lng * Math.PI) / 180;
      x += Math.cos(latRad) * Math.cos(lngRad);
      y += Math.cos(latRad) * Math.sin(lngRad);
      z += Math.sin(latRad);
    });
    const total = playersList.length;
    x /= total;
    y /= total;
    z /= total;
    const centralLng = Math.atan2(y, x);
    const hyp = Math.sqrt(x * x + y * y);
    const centralLat = Math.atan2(z, hyp);
    return {
      lat: (centralLat * 180) / Math.PI,
      lng: (centralLng * 180) / Math.PI
    };
  }, [playersList]);

  const candidateRankings = useMemo((): CandidateScore[] => {
    if (playersList.length < 2) return [];

    const candidates = playersList.filter(p => p.canHost !== 'no');
    if (candidates.length === 0) return [];

    const peerCount = playersList.length - 1;
    const isLargeGroup = playersList.length >= 15;
    const minRequiredUpload = Math.max(15, peerCount * 2.2);

    const results: CandidateScore[] = candidates.map(candidate => {
      const otherPlayers = playersList.filter(p => p.id !== candidate.id);
      let totalPing = 0;
      let worstPing = 0;
      let worstTarget: Player | undefined;

      otherPlayers.forEach(other => {
        const { ping } = calculateEstimatedPing(candidate, other);
        totalPing += ping;
        if (ping > worstPing) {
          worstPing = ping;
          worstTarget = other;
        }
      });

      const averagePing = Math.round(totalPing / otherPlayers.length);
      const distanceToCentroidKm = Math.round(
        calculateGreatCircleKm(candidate.lat, candidate.lng, geographicCentroid.lat, geographicCentroid.lng)
      );

      let uploadPenalty = 0;
      let uploadWarning: string | undefined;

      if (candidate.uploadMbps < minRequiredUpload) {
        uploadPenalty += (minRequiredUpload - candidate.uploadMbps) * 3;
        uploadWarning = `Upload (${candidate.uploadMbps} Mbps) is low for hosting ${peerCount} players simultaneously.`;
      }
      if (isLargeGroup && candidate.uploadMbps < 25) {
        uploadPenalty += 55;
        uploadWarning = `Warning: Upload under 25 Mbps is dangerous for a 20-player room. Packet loss will occur.`;
      }

      const wifiPenalty = candidate.connectionType === 'wifi' ? 18 : 0;
      const jitterPenalty = Math.max(0, candidate.jitterMs - 3) * 1.8;

      let pcBonus = 0;
      if (candidate.pcStrength === 'high') pcBonus = -8;
      if (candidate.pcStrength === 'low') pcBonus = 25;

      let willingnessPenalty = 0;
      if (candidate.canHost === 'only_if_needed') willingnessPenalty = 15;

      const centralityPenalty = Math.round((distanceToCentroidKm / 500) * (isLargeGroup ? 4.5 : 2.5));

      let baseMetric = averagePing;
      if (rankingMode === 'minimize_max') {
        baseMetric = worstPing;
      } else if (rankingMode === 'central') {
        baseMetric = Math.round(averagePing * 0.45 + worstPing * 0.55);
      }

      const overallScore = Math.max(
        1,
        Math.round(
          baseMetric +
            centralityPenalty +
            uploadPenalty +
            wifiPenalty +
            jitterPenalty +
            pcBonus +
            willingnessPenalty
        )
      );

      const explanationParts: string[] = [];
      if (rankingMode === 'central') {
        explanationParts.push(
          `Centered within ~${distanceToCentroidKm} km of the team centroid, balancing latency for all ${peerCount} peers.`
        );
      } else if (rankingMode === 'minimize_max') {
        explanationParts.push(`Limits the worst-case peer latency to ${worstPing} ms.`);
      } else {
        explanationParts.push(`Lowest overall mean ping (${averagePing} ms) across all players.`);
      }

      if (candidate.connectionType === 'wired') explanationParts.push('Stable wired LAN connection.');
      else explanationParts.push('Wi-Fi connection adds packet jitter.');

      if (candidate.uploadMbps >= minRequiredUpload) {
        explanationParts.push(`Strong upload (${candidate.uploadMbps} Mbps) handles ${peerCount} concurrent streams.`);
      }
      if (candidate.pcStrength === 'high') explanationParts.push('High-end host PC prevents server tick dips.');

      return {
        player: candidate,
        worstPing,
        worstTargetPlayer: worstTarget,
        averagePing,
        distanceToCentroidKm,
        uploadScore: candidate.uploadMbps,
        stabilityScore: candidate.jitterMs,
        hardwareScore: candidate.pcStrength === 'high' ? 95 : candidate.pcStrength === 'medium' ? 75 : 45,
        overallScore,
        uploadWarning,
        breakdown: {
          baseLatency: baseMetric,
          centralityPenalty,
          uploadPenalty: Math.round(uploadPenalty),
          wifiPenalty,
          jitterPenalty: Math.round(jitterPenalty),
          pcBonus
        },
        explanation: explanationParts.join(' ')
      };
    });

    results.sort((a, b) => a.overallScore - b.overallScore);
    return results;
  }, [playersList, rankingMode, geographicCentroid]);

  const recommendedHost = candidateRankings[0] || null;

  const confidenceScore = useMemo(() => {
    if (playersList.length < 2) return 'Low';
    let measuredCount = 0;
    let totalPairs = 0;
    for (let i = 0; i < playersList.length; i++) {
      for (let j = i + 1; j < playersList.length; j++) {
        totalPairs++;
        const p1 = playersList[i];
        const p2 = playersList[j];
        if (
          (p1.radminPings && p1.radminPings[p2.id] !== undefined) ||
          (p2.radminPings && p2.radminPings[p1.id] !== undefined)
        ) {
          measuredCount++;
        }
      }
    }
    if (totalPairs === 0) return 'Low (Distance Approximations)';
    const ratio = measuredCount / totalPairs;
    if (ratio >= 0.5) return 'High (Measured Radmin Tests)';
    if (ratio >= 0.2) return 'Medium (Partial Measured)';
    return 'Low (Distance Approximations)';
  }, [playersList]);

  useEffect(() => {
    if (recommendedHost && !selectedHostId) {
      setSelectedHostId(recommendedHost.player.id);
    }
  }, [recommendedHost, selectedHostId]);

  const activeHost = useMemo(() => {
    if (selectedHostId && players[selectedHostId]) {
      return players[selectedHostId];
    }
    return recommendedHost?.player || null;
  }, [selectedHostId, players, recommendedHost]);

  const getPingForGlobe = useCallback((p1: { id: string; lat: number; lng: number }, p2: { id: string; lat: number; lng: number }) => {
    const fullP1 = players[p1.id];
    const fullP2 = players[p2.id];
    if (!fullP1 || !fullP2) return 50;
    return calculateEstimatedPing(fullP1, fullP2).ping;
  }, [players]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none">
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Radio className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg text-white tracking-tight">Host Finder</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800">
                Radmin VPN
              </span>
            </div>
            <p className="text-xs text-slate-400">PC Game Host Ping & Geographic Centroid Optimizer</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {sessionId && !sessionNotFound && (
            <div className="flex items-center gap-2 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs">
              <span className="text-slate-400">Session:</span>
              <span className="font-mono text-cyan-300 font-semibold">{sessionId}</span>
              <button
                onClick={copyMagicLink}
                className="ml-1 hover:text-white transition flex items-center gap-1 text-slate-300"
                title="Copy shareable link"
              >
                {isCopied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          <button
            onClick={() => setShowSecurityModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 transition"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Zero-IP Privacy Shield</span>
          </button>
        </div>
      </header>

      {authError && (
        <div className="bg-rose-950/90 border-b border-rose-800 px-4 py-2.5 text-xs text-rose-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span>Firebase Connection Error: {authError}</span>
        </div>
      )}

      {sessionExpired && (
        <div className="bg-amber-950/80 border-b border-amber-800 px-4 py-2.5 text-xs text-amber-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>This session has reached its 24-hour expiration limit and is no longer active.</span>
          </div>
          <button
            onClick={createNewSession}
            className="px-3 py-1 rounded bg-amber-500 text-slate-950 font-semibold hover:bg-amber-400 text-xs"
          >
            New Session
          </button>
        </div>
      )}

      {sessionNotFound && (
        <div className="bg-rose-950/80 border-b border-rose-800 px-4 py-3 text-xs text-rose-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400" />
            <span>Session not found. The link may be invalid or expired.</span>
          </div>
          <button
            onClick={createNewSession}
            className="px-3 py-1 rounded bg-cyan-600 text-white font-semibold hover:bg-cyan-500 text-xs"
          >
            Create New Session
          </button>
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 relative overflow-hidden">
        <div className="lg:col-span-7 xl:col-span-8 relative h-[440px] lg:h-auto min-h-[420px] bg-slate-950 flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-800">
          <div className="absolute top-4 left-4 z-20 flex flex-wrap items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 backdrop-blur-sm text-xs flex items-center gap-2">
              <Globe2 className="w-4 h-4 text-cyan-400 animate-spin" style={{ animationDuration: '30s' }} />
              <span className="text-slate-300">{playersList.length} Connected Players</span>
            </div>

            {hasAnalyzed && activeHost && (
              <div className="px-3 py-1.5 rounded-lg bg-amber-950/80 border border-amber-800/80 backdrop-blur-sm text-xs flex items-center gap-2 text-amber-300 font-medium">
                <Trophy className="w-4 h-4 text-amber-400" />
                <span>Host: {activeHost.name}</span>
              </div>
            )}

            {playersList.length >= 10 && (
              <div className="px-3 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-800 backdrop-blur-sm text-xs flex items-center gap-1.5 text-cyan-300">
                <Layers className="w-3.5 h-3.5" />
                <span>Large Group Mode ({playersList.length} Peers)</span>
              </div>
            )}
          </div>

          <div className="absolute bottom-4 left-4 z-20 flex flex-wrap items-center gap-2 text-[11px] text-slate-400 bg-slate-900/70 backdrop-blur-sm p-2 rounded-lg border border-slate-800">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 inline-block"></span>
              <span>Player</span>
            </div>
            <div className="flex items-center gap-1.5 ml-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span>
              <span>Optimal Host</span>
            </div>
            {hasAnalyzed && (
              <>
                <div className="flex items-center gap-1 ml-3 border-l border-slate-700 pl-3">
                  <span className="w-3 h-0.5 bg-green-500 inline-block"></span>
                  <span>&lt;60ms</span>
                </div>
                <div className="flex items-center gap-1 ml-1.5">
                  <span className="w-3 h-0.5 bg-yellow-400 inline-block"></span>
                  <span>60-120ms</span>
                </div>
                <div className="flex items-center gap-1 ml-1.5">
                  <span className="w-3 h-0.5 bg-red-500 inline-block"></span>
                  <span>&gt;120ms</span>
                </div>
              </>
            )}
            <span className="ml-3 text-slate-500 hidden sm:inline">• Earth Map • Drag to rotate, scroll to zoom</span>
          </div>

          <Suspense fallback={<div className="text-slate-500 text-xs">Loading 3D Globe...</div>}>
            <GlobeView
              playersList={playersList}
              activeHost={activeHost}
              hasAnalyzed={hasAnalyzed}
              getPing={getPingForGlobe}
            />
          </Suspense>
        </div>

        <div className="lg:col-span-5 xl:col-span-4 flex flex-col bg-slate-900/40 divide-y divide-slate-800 overflow-y-auto max-h-screen">
          {!sessionId || sessionNotFound ? (
            <div className="p-6 flex flex-col items-center text-center justify-center flex-1">
              <div className="w-16 h-16 rounded-2xl bg-cyan-950/70 border border-cyan-800 flex items-center justify-center mb-4 text-cyan-400 shadow-xl shadow-cyan-950/50">
                <Globe2 className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Host Finder for Radmin VPN</h2>
              <p className="text-sm text-slate-400 mb-6 max-w-sm">
                Playing peer-to-peer or LAN games with 2 to 20+ friends? Find out who is positioned in the middle with the best upload line to host everyone smoothly.
              </p>
              <button
                onClick={createNewSession}
                className="w-full max-w-xs py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 font-semibold text-white shadow-lg shadow-cyan-600/25 flex items-center justify-center gap-2 transition"
              >
                <Sparkles className="w-4 h-4" />
                <span>Create New Session</span>
              </button>
            </div>
          ) : sessionLoading ? (
            <div className="p-8 text-center text-slate-400 text-xs">Loading session data...</div>
          ) : (
            <>
              <div className="p-5 bg-slate-900/80">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-cyan-400" />
                    <h2 className="font-semibold text-sm text-white">
                      {currentPlayer ? 'Edit Your Setup' : 'Join This Session'}
                    </h2>
                  </div>
                  {currentPlayer && (
                    <button
                      onClick={handleRemoveMyData}
                      className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove My Data</span>
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Display Name</label>
                    <input
                      type="text"
                      maxLength={24}
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="e.g. Alex"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-300">Your Location</label>
                      <button
                        type="button"
                        onClick={detectCurrentLocation}
                        disabled={isLocating}
                        className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                      >
                        <Compass className="w-3 h-3" />
                        <span>{isLocating ? 'Locating...' : 'Use My GPS'}</span>
                      </button>
                    </div>

                    <div className="relative">
                      <div className="relative">
                        <input
                          type="text"
                          value={cityName}
                          onChange={e => handleCitySearch(e.target.value)}
                          placeholder="Search your city or region..."
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 pl-8 text-sm text-white focus:outline-none focus:border-cyan-500"
                        />
                        <Search className="w-4 h-4 text-slate-500 absolute left-2.5 top-2.5" />
                      </div>

                      {geoResults.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-slate-950 border border-slate-700 rounded-lg shadow-xl z-30 max-h-48 overflow-y-auto">
                          {geoResults.map((r, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => selectCity(r)}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-slate-800 text-slate-200 border-b border-slate-800/60 flex items-center justify-between"
                            >
                              <span>
                                {r.name}
                                {r.admin1 ? `, ${r.admin1}` : ''}
                                {r.country ? `, ${r.country}` : ''}
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                {roundCoord(r.latitude)}°, {roundCoord(r.longitude)}°
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {locatingError && <p className="text-[11px] text-rose-400 mt-1">{locatingError}</p>}
                    {geoError && <p className="text-[11px] text-amber-400 mt-1">{geoError}</p>}

                    <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400/90">
                      <Lock className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      <span>City-level rounding (~11 km). Exact coordinates are not stored.</span>
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                        <span className="text-xs font-medium text-slate-200">Network Quality Benchmark</span>
                      </div>
                      <button
                        type="button"
                        onClick={runNetworkBenchmark}
                        disabled={isTestingNet}
                        className="text-[11px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition flex items-center gap-1"
                      >
                        <RotateCw className={`w-3 h-3 ${isTestingNet ? 'animate-spin' : ''}`} />
                        <span>{isTestingNet ? 'Testing...' : latencyMs !== null ? 'Retest' : 'Auto-Test'}</span>
                      </button>
                    </div>

                    {netTestError && (
                      <p className="text-[11px] text-rose-400">{netTestError}</p>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-400 text-[11px]">Upload (Mbps, self-reported)</span>
                        <input
                          type="number"
                          min={1}
                          max={2000}
                          value={uploadMbps}
                          onChange={e => setUploadMbps(Number(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
                      </div>
                      <div>
                        <span className="text-slate-400 text-[11px]">Download (Mbps, self-reported)</span>
                        <input
                          type="number"
                          min={1}
                          max={2000}
                          value={downloadMbps}
                          onChange={e => setDownloadMbps(Number(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-400 text-[11px]">Ping to Internet (measured)</span>
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          value={latencyMs !== null ? latencyMs : ''}
                          placeholder="Run Auto-Test"
                          onChange={e => setLatencyMs(e.target.value ? Number(e.target.value) : null)}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
                      </div>
                      <div>
                        <span className="text-slate-400 text-[11px]">Jitter (ms, measured)</span>
                        <input
                          type="number"
                          min={0}
                          max={500}
                          value={jitterMs !== null ? jitterMs : ''}
                          placeholder="Run Auto-Test"
                          onChange={e => setJitterMs(e.target.value ? Number(e.target.value) : null)}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
                      </div>
                    </div>

                    <div>
                      <span className="text-slate-400 text-[11px]">Connection Type</span>
                      <div className="grid grid-cols-2 gap-1 mt-0.5">
                        <button
                          type="button"
                          onClick={() => setConnectionType('wired')}
                          className={`py-1 rounded text-[11px] flex items-center justify-center gap-1 border ${
                            connectionType === 'wired'
                              ? 'bg-cyan-950 text-cyan-300 border-cyan-700'
                              : 'bg-slate-900 text-slate-400 border-slate-800'
                          }`}
                        >
                          <Cable className="w-3 h-3" />
                          <span>Wired</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setConnectionType('wifi')}
                          className={`py-1 rounded text-[11px] flex items-center justify-center gap-1 border ${
                            connectionType === 'wifi'
                              ? 'bg-cyan-950 text-cyan-300 border-cyan-700'
                              : 'bg-slate-900 text-slate-400 border-slate-800'
                          }`}
                        >
                          <Wifi className="w-3 h-3" />
                          <span>Wi-Fi</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="block text-slate-300 mb-1 text-[11px]">PC Hardware Strength</label>
                      <select
                        value={pcStrength}
                        onChange={e => setPcStrength(e.target.value as any)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        <option value="high">High (Fast CPU/GPU)</option>
                        <option value="medium">Medium (Standard)</option>
                        <option value="low">Low (Budget / Laptop)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-300 mb-1 text-[11px]">Can you host?</label>
                      <select
                        value={canHost}
                        onChange={e => setCanHost(e.target.value as any)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        <option value="yes">Yes, happy to host</option>
                        <option value="only_if_needed">Only if needed</option>
                        <option value="no">No, cannot host</option>
                      </select>
                    </div>
                  </div>

                  {currentUser && playersList.filter(p => p.id !== currentUser.uid).length > 0 && (
                    <div className="p-2.5 bg-slate-950/60 border border-slate-800 rounded-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-medium text-slate-300">
                          Radmin Ping Overrides (Optional)
                        </span>
                        <span className="text-[10px] text-slate-500">Overrides location estimates</span>
                      </div>
                      <div className="space-y-1.5 max-h-24 overflow-y-auto pr-1">
                        {playersList
                          .filter(p => p.id !== currentUser.uid)
                          .map(other => (
                            <div key={other.id} className="flex items-center justify-between text-xs">
                              <span className="text-slate-300 truncate max-w-[120px]">{other.name}</span>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  placeholder="est."
                                  value={customPings[other.id] !== undefined ? customPings[other.id] : ''}
                                  onChange={e => {
                                    const val = e.target.value === '' ? undefined : Number(e.target.value);
                                    setCustomPings(prev => {
                                      const next = { ...prev };
                                      if (val === undefined) delete next[other.id];
                                      else next[other.id] = val;
                                      return next;
                                    });
                                  }}
                                  className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-right font-mono text-xs"
                                />
                                <span className="text-slate-500 text-[10px]">ms</span>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleJoinOrUpdate}
                    disabled={!name.trim() || lat === null || lng === null}
                    className="w-full py-2.5 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:pointer-events-none font-semibold text-xs text-white shadow-md shadow-cyan-900/30 transition flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{currentPlayer ? 'Update My Player Info' : 'Join Game Group'}</span>
                  </button>
                </div>
              </div>

              <div className="p-4 bg-slate-900/50">
                <div className="flex flex-col gap-2 mb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-amber-400" />
                      <h3 className="font-semibold text-sm text-white">Host Analysis & Ranking</h3>
                    </div>

                    <span className="text-[11px] text-slate-400 font-mono">
                      {playersList.length} Players ({Math.max(0, playersList.length - 1)} Peers)
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-[10px]">
                    <button
                      onClick={() => setRankingMode('central')}
                      className={`py-1 px-1 rounded transition text-center font-medium ${
                        rankingMode === 'central'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                      title="Best for large groups: picks candidate in the middle of all peers"
                    >
                      Middle of All Peers
                    </button>
                    <button
                      onClick={() => setRankingMode('minimize_max')}
                      className={`py-1 px-1 rounded transition text-center font-medium ${
                        rankingMode === 'minimize_max'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                      title="Minimize the worst ping experienced by any single player"
                    >
                      Best Worst-off
                    </button>
                    <button
                      onClick={() => setRankingMode('best_avg')}
                      className={`py-1 px-1 rounded transition text-center font-medium ${
                        rankingMode === 'best_avg'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                      title="Minimize the average latency across the whole team"
                    >
                      Best Average
                    </button>
                  </div>
                </div>

                {playersList.length < 2 ? (
                  <div className="p-6 rounded-xl border border-dashed border-slate-800 text-center flex flex-col items-center justify-center bg-slate-950/40">
                    <Users className="w-8 h-8 text-slate-600 mb-2" />
                    <p className="text-xs font-medium text-slate-300 mb-1">Waiting for more players</p>
                    <p className="text-[11px] text-slate-500 max-w-xs mb-3">
                      At least 2 players must join this session to calculate group centroid and network matrix.
                    </p>
                    <button
                      onClick={copyMagicLink}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs border border-slate-700 flex items-center gap-1.5 transition"
                    >
                      {isCopied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Share Session Link</span>
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button
                      onClick={() => setHasAnalyzed(true)}
                      className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-xs shadow-lg shadow-amber-600/20 transition flex items-center justify-center gap-2"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>{hasAnalyzed ? 'Recalculate Best Host' : 'Analyze Optimal Game Host'}</span>
                    </button>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
                      <span>
                        Confidence: <strong className="text-cyan-400">{confidenceScore}</strong>
                      </span>
                      <span>
                        Algorithm:{' '}
                        {rankingMode === 'central'
                          ? 'Group Centroid'
                          : rankingMode === 'minimize_max'
                          ? 'Minimax Latency'
                          : 'Mean Latency'}
                      </span>
                    </div>

                    {candidateRankings.length > 0 && (
                      <div className="space-y-2">
                        {candidateRankings.slice(0, 3).map((item, idx) => {
                          const isWinner = idx === 0;
                          const isSelected = activeHost?.id === item.player.id;
                          return (
                            <div
                              key={item.player.id}
                              onClick={() => {
                                setSelectedHostId(item.player.id);
                                setHasAnalyzed(true);
                              }}
                              className={`p-3 rounded-xl border transition cursor-pointer ${
                                isSelected
                                  ? 'bg-amber-950/30 border-amber-500/80 ring-1 ring-amber-500/50'
                                  : isWinner
                                  ? 'bg-slate-900/90 border-amber-800/60'
                                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center justify-between mb-1.5">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                                      isWinner
                                        ? 'bg-amber-400 text-slate-950'
                                        : 'bg-slate-800 text-slate-400'
                                    }`}
                                  >
                                    {idx + 1}
                                  </span>
                                  <span className="font-semibold text-sm text-white">
                                    {item.player.name}
                                  </span>
                                  {isWinner && (
                                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-500/40">
                                      Optimal Host
                                    </span>
                                  )}
                                </div>
                                <div className="text-right">
                                  <span className="text-xs font-mono font-bold text-cyan-300">
                                    Worst: {item.worstPing} ms
                                  </span>
                                  <span className="text-[10px] text-slate-500 block font-mono">
                                    Avg: {item.averagePing} ms
                                  </span>
                                </div>
                              </div>

                              <p className="text-[11px] text-slate-400 mb-2 leading-relaxed">
                                {item.explanation}
                              </p>

                              {item.uploadWarning && (
                                <div className="mb-2 p-1.5 bg-rose-950/70 border border-rose-800/80 rounded text-[10px] text-rose-300 flex items-center gap-1.5">
                                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 flex-shrink-0" />
                                  <span>{item.uploadWarning}</span>
                                </div>
                              )}

                              <div className="grid grid-cols-4 gap-1 text-[10px] pt-1.5 border-t border-slate-800/80 text-slate-400">
                                <div>
                                  <span className="block text-slate-500">Center Dist</span>
                                  <span className="font-mono text-slate-200">
                                    ~{item.distanceToCentroidKm} km
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-slate-500">Upload</span>
                                  <span className="font-mono text-slate-200">
                                    {item.player.uploadMbps} Mbps
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-slate-500">Line</span>
                                  <span className="capitalize text-slate-200">
                                    {item.player.connectionType}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-slate-500">PC Strength</span>
                                  <span className="capitalize text-slate-200">
                                    {item.player.pcStrength}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2">
                      <Info className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                      <span>
                        Note: Numbers are calculated via great-circle network approximations and reported indicators. Run a live Radmin VPN ping test between the recommended host and all peers for final verification.
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 bg-slate-900/30">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-slate-300">
                    Group Roster ({playersList.length})
                  </h4>
                  <span className="text-[10px] text-slate-500">Click a candidate to view network arcs</span>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {playersList.map(p => {
                    const isCandidate = p.canHost !== 'no';
                    const isHost = activeHost?.id === p.id;
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          if (isCandidate) {
                            setSelectedHostId(p.id);
                            setHasAnalyzed(true);
                          }
                        }}
                        className={`p-2 rounded-lg border text-xs flex items-center justify-between transition cursor-pointer ${
                          isHost
                            ? 'bg-amber-950/30 border-amber-700/60'
                            : 'bg-slate-950/40 border-slate-800/80 hover:bg-slate-850'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              isHost ? 'bg-amber-400 animate-pulse' : 'bg-cyan-400'
                            }`}
                          ></span>
                          <span className="font-medium text-white">{p.name}</span>
                          <span className="text-[10px] text-slate-500">({p.cityName})</span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                          <span>{p.uploadMbps} Mbps</span>
                          <span className="capitalize">{p.connectionType}</span>
                          {!isCandidate && (
                            <span className="text-rose-400 text-[10px]">No Host</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {showSecurityModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-emerald-700/60 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400">
                <ShieldCheck className="w-5 h-5" />
                <h3 className="font-bold text-base text-white">Privacy & Security Information</h3>
              </div>
              <button
                onClick={() => setShowSecurityModal(false)}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded bg-slate-800"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-800/50 flex items-start gap-2.5">
                <Lock className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-emerald-300 mb-0.5">How Your Information is Handled</h4>
                  <p className="text-[11px] text-slate-300">
                    Host Finder does not collect or store your IP address in Firestore. Only your chosen display name, self-reported connection details, and approximate coordinates are stored.
                  </p>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <h4 className="font-semibold text-slate-200">Security Architecture:</h4>
                <ul className="list-disc list-inside space-y-1 text-slate-400 text-[11px]">
                  <li>
                    <strong className="text-slate-300">City-Level Location Obfuscation:</strong> Coordinates are rounded to ~1 decimal place (~11 km radius). Exact residential addresses are not accepted or stored.
                  </li>
                  <li>
                    <strong className="text-slate-300">Firebase Anonymous Authentication:</strong> Each player is assigned an anonymous UID. Firestore Security Rules enforce that you can only edit or delete your own player document.
                  </li>
                  <li>
                    <strong className="text-slate-300">Automatic 24-Hour Expiration:</strong> Sessions are timestamped with a 24-hour expiration window.
                  </li>
                  <li>
                    <strong className="text-slate-300">Network Transparency:</strong> Standard web requests (fetching Firestore, Open-Meteo geocoding, Cloudflare latency probes) connect your browser directly to those service providers over TLS.
                  </li>
                  <li>
                    <strong className="text-slate-300">Data Deletion:</strong> Clicking &quot;Remove My Data&quot; deletes your document from the session subcollection immediately.
                  </li>
                </ul>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={() => setShowSecurityModal(false)}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs"
                >
                  Understood
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
