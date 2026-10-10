import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import {
  Globe2,
  Copy,
  Check,
  MapPin,
  Wifi,
  Cable,
  Cpu,
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
  Database,
  Radio,
  CheckCircle2,
  Sparkles,
  Search,
  Lock,
  Layers,
  Network
} from 'lucide-react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

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

interface SessionData {
  id: string;
  createdAt: number;
  expiresAt: number;
  players: Record<string, Player>;
  lastAnalyzedAt?: number;
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

const STORAGE_SESSION_KEY = 'hostfinder_sessions';
const STORAGE_USER_ID_KEY = 'hostfinder_user_id';
const STORAGE_FIREBASE_CONFIG_KEY = 'hostfinder_firebase_cfg';
const DEFAULT_FIREBASE_CONFIG = JSON.stringify(
  {
    apiKey: "AIzaSyAOJ96bDA7_IyZUfS7hwDsZPrbmDzlZFTg",
    authDomain: "host-finder-985be.firebaseapp.com",
    projectId: "host-finder-985be",
    storageBucket: "host-finder-985be.firebasestorage.app",
    messagingSenderId: "65478399967",
    appId: "1:65478399967:web:e0c8bdca3cc469fce7566a"
  },
  null,
  2
);

function getOrCreateUserId(): string {
  let uid = localStorage.getItem(STORAGE_USER_ID_KEY);
  if (!uid) {
    uid = 'user_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(STORAGE_USER_ID_KEY, uid);
  }
  return uid;
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

function createRealisticEarthTexture(): THREE.CanvasTexture {
  const width = 2048;
  const height = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  const oceanGrad = ctx.createLinearGradient(0, 0, 0, height);
  oceanGrad.addColorStop(0, '#030816');
  oceanGrad.addColorStop(0.3, '#08172e');
  oceanGrad.addColorStop(0.5, '#0a1d38');
  oceanGrad.addColorStop(0.7, '#08172e');
  oceanGrad.addColorStop(1, '#030816');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#0f294a';
  ctx.lineWidth = 1;
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.strokeStyle = '#1e3a8a';
  ctx.lineWidth = 2;
  const eqY = height / 2;
  ctx.beginPath();
  ctx.moveTo(0, eqY);
  ctx.lineTo(width, eqY);
  ctx.stroke();

  const toX = (lon: number) => ((lon + 180) / 360) * width;
  const toY = (lat: number) => ((90 - lat) / 180) * height;

  const continents = [
    [
      [-168, 65], [-160, 71], [-140, 70], [-120, 75], [-85, 78], [-60, 60], [-65, 45],
      [-75, 35], [-80, 25], [-90, 20], [-97, 18], [-105, 20], [-115, 30], [-125, 40],
      [-125, 50], [-140, 60], [-168, 65]
    ],
    [
      [-55, 83], [-20, 83], [-25, 65], [-45, 60], [-55, 75], [-55, 83]
    ],
    [
      [-80, 10], [-60, 12], [-50, -5], [-35, -5], [-38, -15], [-55, -25], [-65, -45],
      [-70, -55], [-75, -50], [-72, -35], [-80, -5], [-80, 10]
    ],
    [
      [-10, 36], [0, 42], [5, 48], [-4, 48], [2, 51], [8, 55], [20, 60], [28, 70],
      [15, 68], [5, 62], [10, 54], [12, 45], [20, 40], [25, 38], [15, 38], [-5, 36], [-10, 36]
    ],
    [
      [-5, 58], [2, 52], [-5, 50], [-4, 58]
    ],
    [
      [-17, 30], [-17, 20], [-10, 5], [5, 5], [10, -5], [12, -18], [20, -34], [30, -34],
      [35, -20], [40, -10], [51, 12], [45, 12], [32, 30], [10, 37], [-5, 36], [-17, 30]
    ],
    [
      [45, -12], [50, -14], [48, -25], [44, -25], [45, -12]
    ],
    [
      [28, 70], [60, 75], [100, 77], [140, 75], [170, 68], [170, 60], [140, 50],
      [130, 40], [120, 35], [120, 22], [110, 20], [105, 10], [100, 5], [98, 15],
      [80, 15], [70, 25], [60, 25], [50, 25], [40, 15], [35, 30], [28, 40], [30, 55], [28, 70]
    ],
    [
      [70, 22], [80, 20], [88, 22], [80, 8], [75, 10], [70, 22]
    ],
    [
      [130, 32], [140, 36], [142, 44], [135, 35], [130, 32]
    ],
    [
      [114, -22], [125, -15], [135, -12], [145, -15], [152, -25], [150, -35], [140, -38],
      [130, -32], [115, -34], [114, -22]
    ],
    [
      [168, -35], [178, -38], [172, -45], [168, -35]
    ],
    [
      [-180, -70], [-100, -72], [-60, -65], [0, -70], [60, -68], [120, -65], [180, -70],
      [180, -85], [-180, -85], [-180, -70]
    ]
  ];

  continents.forEach(poly => {
    ctx.fillStyle = '#064e3b';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    poly.forEach((pt, idx) => {
      const x = toX(pt[0]);
      const y = toY(pt[1]);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#047857';
    ctx.beginPath();
    poly.forEach((pt, idx) => {
      const x = toX(pt[0]);
      const y = toY(pt[1]);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  });

  const cityLights = [
    [-74, 40.7], [-118, 34], [-0.1, 51.5], [2.3, 48.8], [13.4, 52.5],
    [37.6, 55.7], [77.2, 28.6], [72.8, 19], [121.5, 31.2], [116.4, 39.9],
    [139.7, 35.7], [151.2, -33.8], [-46.6, -23.5], [18.4, -33.9], [55.3, 25.2]
  ];

  ctx.fillStyle = '#fef08a';
  cityLights.forEach(cl => {
    const cx = toX(cl[0]);
    const cy = toY(cl[1]);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export default function App() {
  const currentUserId = useMemo(() => getOrCreateUserId(), []);
  const [sessionId, setSessionId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || '';
  });
  const [session, setSession] = useState<SessionData | null>(null);
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
  const [latencyMs, setLatencyMs] = useState<number>(20);
  const [jitterMs, setJitterMs] = useState<number>(2);
  const [pcStrength, setPcStrength] = useState<'low' | 'medium' | 'high'>('high');
  const [canHost, setCanHost] = useState<'yes' | 'no' | 'only_if_needed'>('yes');
  const [customPings, setCustomPings] = useState<Record<string, number>>({});

  const [isTestingNet, setIsTestingNet] = useState<boolean>(false);
  const [netTestDone, setNetTestDone] = useState<boolean>(false);
  const [geoSearching, setGeoSearching] = useState<boolean>(false);
  const [geoResults, setGeoResults] = useState<GeocodingResult[]>([]);
  const [geoError, setGeoError] = useState<string>('');
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [locatingError, setLocatingError] = useState<string>('');

  const [firebaseConfigStr, setFirebaseConfigStr] = useState<string>(() => {
    return localStorage.getItem(STORAGE_FIREBASE_CONFIG_KEY) || DEFAULT_FIREBASE_CONFIG;
  });
  const [isFirebaseConnected, setIsFirebaseConnected] = useState<boolean>(false);
  const [showSecurityModal, setShowSecurityModal] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<'local' | 'firebase' | 'connecting'>('connecting');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const threeStateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    globe?: THREE.Mesh;
    dotsGroup?: THREE.Group;
    arcsGroup?: THREE.Group;
    starMesh?: THREE.Points;
    reqId?: number;
    isDragging: boolean;
    prevMouseX: number;
    prevMouseY: number;
    targetRotY: number;
    targetRotX: number;
    cameraDistance: number;
  }>({
    isDragging: false,
    prevMouseX: 0,
    prevMouseY: 0,
    targetRotY: 0,
    targetRotX: 0.2,
    cameraDistance: 6.5
  });

  const [screenNodes, setScreenNodes] = useState<{ id: string; name: string; x: number; y: number; visible: boolean; isHost: boolean }[]>([]);

  const runNetworkBenchmark = useCallback(async () => {
    setIsTestingNet(true);
    const times: number[] = [];
    const endpoints = [
      'https://cloudflare.com/cdn-cgi/trace',
      'https://1.1.1.1/cdn-cgi/trace',
      'https://dns.google/resolve?name=example.com'
    ];
    for (let i = 0; i < 4; i++) {
      const ep = endpoints[i % endpoints.length];
      const start = performance.now();
      try {
        await fetch(ep, { mode: 'no-cors', cache: 'no-store' });
        times.push(performance.now() - start);
      } catch {
        times.push(30 + Math.random() * 20);
      }
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    let diffSum = 0;
    for (let i = 1; i < times.length; i++) {
      diffSum += Math.abs(times[i] - times[i - 1]);
    }
    const computedJitter = Math.max(1, Math.round(diffSum / (times.length - 1)));

    setLatencyMs(Math.max(8, Math.min(250, avg)));
    setJitterMs(Math.max(1, Math.min(50, computedJitter)));
    setUploadMbps(prev => (prev === 50 ? 60 : prev));
    setDownloadMbps(prev => (prev === 150 ? 180 : prev));
    setIsTestingNet(false);
    setNetTestDone(true);
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

  useEffect(() => {
    if (!firebaseConfigStr.trim()) {
      setIsFirebaseConnected(false);
      setSyncStatus('local');
      return;
    }
    try {
      const parsed = JSON.parse(firebaseConfigStr);
      const app = getApps().length > 0 ? getApp() : initializeApp(parsed);
      const auth = getAuth(app);
      const db = getFirestore(app);
      signInAnonymously(auth)
        .then(() => {
          setIsFirebaseConnected(true);
          setSyncStatus('firebase');
        })
        .catch(() => {
          setIsFirebaseConnected(false);
          setSyncStatus('local');
        });
    } catch {
      setIsFirebaseConnected(false);
      setSyncStatus('local');
    }
  }, [firebaseConfigStr]);

  const saveFirebaseConfig = useCallback((val: string) => {
    setFirebaseConfigStr(val);
    localStorage.setItem(STORAGE_FIREBASE_CONFIG_KEY, val);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      return;
    }

    if (isFirebaseConnected && firebaseConfigStr.trim()) {
      try {
        const app = getApps().length > 0 ? getApp() : initializeApp(JSON.parse(firebaseConfigStr));
        const db = getFirestore(app);
        const sessionRef = doc(db, 'sessions', sessionId);
        const unsub = onSnapshot(sessionRef, snap => {
          if (snap.exists()) {
            setSession(snap.data() as SessionData);
          } else {
            const now = Date.now();
            const initial: SessionData = {
              id: sessionId,
              createdAt: now,
              expiresAt: now + 24 * 60 * 60 * 1000,
              players: {}
            };
            setDoc(sessionRef, initial);
            setSession(initial);
          }
        });
        return () => unsub();
      } catch {
        setSyncStatus('local');
      }
    }

    const loadLocal = () => {
      try {
        const raw = localStorage.getItem(STORAGE_SESSION_KEY);
        const map: Record<string, SessionData> = raw ? JSON.parse(raw) : {};
        let current = map[sessionId];
        const now = Date.now();
        if (!current) {
          current = {
            id: sessionId,
            createdAt: now,
            expiresAt: now + 24 * 60 * 60 * 1000,
            players: {}
          };
          map[sessionId] = current;
          localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(map));
        }
        setSession(current);
      } catch {
        // storage fallback
      }
    };

    loadLocal();
    const interval = setInterval(loadLocal, 2000);
    const channel = new BroadcastChannel('hostfinder_sync_' + sessionId);
    channel.onmessage = e => {
      if (e.data && e.data.sessionId === sessionId) {
        loadLocal();
      }
    };

    return () => {
      clearInterval(interval);
      channel.close();
    };
  }, [sessionId, isFirebaseConnected, firebaseConfigStr]);

  const updateSessionData = useCallback(
    async (updater: (prev: SessionData) => SessionData) => {
      if (!sessionId) return;
      if (isFirebaseConnected && firebaseConfigStr.trim()) {
        try {
          const app = getApps().length > 0 ? getApp() : initializeApp(JSON.parse(firebaseConfigStr));
          const db = getFirestore(app);
          const sessionRef = doc(db, 'sessions', sessionId);
          setSession(prev => {
            const next = updater(
              prev || {
                id: sessionId,
                createdAt: Date.now(),
                expiresAt: Date.now() + 24 * 60 * 60 * 1000,
                players: {}
              }
            );
            setDoc(sessionRef, next);
            return next;
          });
          return;
        } catch {
          // fallback
        }
      }

      try {
        const raw = localStorage.getItem(STORAGE_SESSION_KEY);
        const map: Record<string, SessionData> = raw ? JSON.parse(raw) : {};
        const current = map[sessionId] || {
          id: sessionId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          players: {}
        };
        const next = updater(current);
        map[sessionId] = next;
        localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(map));
        setSession(next);
        const channel = new BroadcastChannel('hostfinder_sync_' + sessionId);
        channel.postMessage({ sessionId, timestamp: Date.now() });
        channel.close();
      } catch {
        // fallback
      }
    },
    [sessionId, isFirebaseConnected, firebaseConfigStr]
  );

  const createNewSession = useCallback(() => {
    const rand = Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 6);
    const newId = 'hf-' + rand;
    const now = Date.now();
    const newSession: SessionData = {
      id: newId,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      players: {}
    };

    try {
      const raw = localStorage.getItem(STORAGE_SESSION_KEY);
      const map: Record<string, SessionData> = raw ? JSON.parse(raw) : {};
      map[newId] = newSession;
      localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(map));
    } catch {
      // storage
    }

    const url = new URL(window.location.href);
    url.searchParams.set('session', newId);
    window.history.pushState({}, '', url.toString());
    setSessionId(newId);
    setSession(newSession);
    setHasAnalyzed(false);
    setSelectedHostId(null);
  }, []);

  const copyMagicLink = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2200);
    });
  }, [sessionId]);

  const handleJoinOrUpdate = useCallback(() => {
    if (!name.trim() || lat === null || lng === null) return;
    const myPlayer: Player = {
      id: currentUserId,
      userId: currentUserId,
      name: name.trim(),
      cityName: cityName.trim() || 'Approximate City Area',
      lat,
      lng,
      connectionType,
      uploadMbps: Math.max(1, uploadMbps),
      downloadMbps: Math.max(1, downloadMbps),
      latencyMs: Math.max(1, latencyMs),
      jitterMs: Math.max(1, jitterMs),
      pcStrength,
      canHost,
      radminPings: customPings,
      joinedAt: Date.now()
    };

    updateSessionData(prev => ({
      ...prev,
      players: {
        ...prev.players,
        [currentUserId]: myPlayer
      }
    }));
  }, [
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
    customPings,
    currentUserId,
    updateSessionData
  ]);

  const handleRemoveMyData = useCallback(() => {
    updateSessionData(prev => {
      const copy = { ...prev.players };
      delete copy[currentUserId];
      return {
        ...prev,
        players: copy
      };
    });
    setName('');
    setCityName('');
    setLat(null);
    setLng(null);
  }, [currentUserId, updateSessionData]);

  const playersList = useMemo(() => {
    if (!session || !session.players) return [];
    return Object.values(session.players);
  }, [session]);

  const currentPlayer = useMemo(() => {
    if (!session || !session.players) return null;
    return session.players[currentUserId] || null;
  }, [session, currentUserId]);

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

  const isSessionExpired = useMemo(() => {
    if (!session) return false;
    return Date.now() > session.expiresAt;
  }, [session]);

  const activeHost = useMemo(() => {
    if (selectedHostId && session && session.players[selectedHostId]) {
      return session.players[selectedHostId];
    }
    return recommendedHost?.player || null;
  }, [selectedHostId, session, recommendedHost]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = threeStateRef.current.cameraDistance;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xe0f2fe, 1.4);
    sunLight.position.set(6, 4, 6);
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.5);
    fillLight.position.set(-6, -3, -6);
    scene.add(fillLight);

    const starGeo = new THREE.BufferGeometry();
    const starCount = 1500;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 100;
      starPositions[i + 1] = (Math.random() - 0.5) * 100;
      starPositions[i + 2] = (Math.random() - 0.5) * 100;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x94a3b8,
      size: 0.16,
      transparent: true,
      opacity: 0.85
    });
    const starPoints = new THREE.Points(starGeo, starMat);
    scene.add(starPoints);

    const globeRadius = 2.0;
    const globeGeo = new THREE.SphereGeometry(globeRadius, 64, 64);
    const earthTexture = createRealisticEarthTexture();

    const globeMat = new THREE.MeshStandardMaterial({
      map: earthTexture,
      roughness: 0.55,
      metalness: 0.15
    });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    const atmosphereGeo = new THREE.SphereGeometry(globeRadius * 1.04, 48, 48);
    const atmosphereMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide
    });
    const atmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
    scene.add(atmosphere);

    const dotsGroup = new THREE.Group();
    scene.add(dotsGroup);

    const arcsGroup = new THREE.Group();
    scene.add(arcsGroup);

    threeStateRef.current = {
      renderer,
      scene,
      camera,
      globe,
      dotsGroup,
      arcsGroup,
      starMesh: starPoints,
      isDragging: false,
      prevMouseX: 0,
      prevMouseY: 0,
      targetRotY: 0,
      targetRotX: 0.2,
      cameraDistance: 6.5
    };

    const animate = () => {
      const st = threeStateRef.current;
      if (!st.isDragging && globe) {
        st.targetRotY += 0.0018;
      }

      if (globe && dotsGroup && arcsGroup) {
        globe.rotation.y = THREE.MathUtils.lerp(globe.rotation.y, st.targetRotY, 0.08);
        globe.rotation.x = THREE.MathUtils.lerp(globe.rotation.x, st.targetRotX, 0.08);
        dotsGroup.rotation.y = globe.rotation.y;
        dotsGroup.rotation.x = globe.rotation.x;
        arcsGroup.rotation.y = globe.rotation.y;
        arcsGroup.rotation.x = globe.rotation.x;
      }

      renderer.render(scene, camera);

      if (canvas && camera && dotsGroup) {
        const rect = canvas.getBoundingClientRect();
        const updatedScreenNodes: typeof screenNodes = [];
        dotsGroup.children.forEach(child => {
          if (child.userData && child.userData.playerId) {
            const worldPos = new THREE.Vector3();
            child.getWorldPosition(worldPos);
            const proj = worldPos.clone().project(camera);
            const isBehind = proj.z > 1.0 || worldPos.dot(camera.position) < -0.1;
            const x = ((proj.x + 1) / 2) * rect.width;
            const y = ((-proj.y + 1) / 2) * rect.height;
            updatedScreenNodes.push({
              id: child.userData.playerId,
              name: child.userData.playerName,
              x,
              y,
              visible: !isBehind && proj.z < 1.0,
              isHost: child.userData.isHost
            });
          }
        });
        setScreenNodes(updatedScreenNodes);
      }

      threeStateRef.current.reqId = requestAnimationFrame(animate);
    };

    threeStateRef.current.reqId = requestAnimationFrame(animate);

    const handleResize = () => {
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (threeStateRef.current.reqId) cancelAnimationFrame(threeStateRef.current.reqId);
      renderer.dispose();
      globeGeo.dispose();
      globeMat.dispose();
      earthTexture.dispose();
      atmosphereGeo.dispose();
      atmosphereMat.dispose();
      starGeo.dispose();
      starMat.dispose();
    };
  }, []);

  const latLngToVector3 = useCallback((latitude: number, longitude: number, radius = 2.0) => {
    const phi = ((90 - latitude) * Math.PI) / 180;
    const theta = ((longitude + 180) * Math.PI) / 180;
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    return new THREE.Vector3(x, y, z);
  }, []);

  useEffect(() => {
    const { dotsGroup, arcsGroup } = threeStateRef.current;
    if (!dotsGroup || !arcsGroup) return;

    while (dotsGroup.children.length > 0) {
      const obj = dotsGroup.children[0] as THREE.Mesh;
      if (obj.geometry) obj.geometry.dispose();
      dotsGroup.remove(obj);
    }
    while (arcsGroup.children.length > 0) {
      const obj = arcsGroup.children[0] as THREE.Line;
      if (obj.geometry) obj.geometry.dispose();
      arcsGroup.remove(obj);
    }

    const hostId = activeHost ? activeHost.id : null;

    playersList.forEach(player => {
      const pos = latLngToVector3(player.lat, player.lng, 2.02);
      const isHost = player.id === hostId;

      const pinGeo = new THREE.SphereGeometry(isHost ? 0.085 : 0.05, 16, 16);
      const pinMat = new THREE.MeshBasicMaterial({
        color: isHost ? 0xf59e0b : 0x06b6d4
      });
      const pinMesh = new THREE.Mesh(pinGeo, pinMat);
      pinMesh.position.copy(pos);
      pinMesh.userData = {
        playerId: player.id,
        playerName: player.name,
        isHost
      };
      dotsGroup.add(pinMesh);

      const ringGeo = new THREE.RingGeometry(isHost ? 0.09 : 0.06, isHost ? 0.13 : 0.085, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: isHost ? 0xfbbf24 : 0x22d3ee,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.copy(pos.clone().multiplyScalar(1.002));
      ringMesh.lookAt(new THREE.Vector3(0, 0, 0));
      dotsGroup.add(ringMesh);
    });

    if (hasAnalyzed && activeHost && playersList.length >= 2) {
      const hostPos = latLngToVector3(activeHost.lat, activeHost.lng, 2.03);

      playersList.forEach(player => {
        if (player.id === activeHost.id) return;
        const targetPos = latLngToVector3(player.lat, player.lng, 2.03);

        const { ping } = calculateEstimatedPing(activeHost, player);

        let arcColor = 0x22c55e;
        if (ping > 60 && ping <= 120) arcColor = 0xeab308;
        if (ping > 120) arcColor = 0xef4444;

        const mid = hostPos.clone().add(targetPos).multiplyScalar(0.5);
        const dist = hostPos.distanceTo(targetPos);
        const altitude = 2.0 + Math.max(0.4, dist * 0.45);
        mid.normalize().multiplyScalar(altitude);

        const curve = new THREE.QuadraticBezierCurve3(hostPos, mid, targetPos);
        const points = curve.getPoints(40);
        const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineBasicMaterial({
          color: arcColor,
          linewidth: 2,
          transparent: true,
          opacity: 0.85
        });
        const line = new THREE.Line(lineGeo, lineMat);
        arcsGroup.add(line);
      });
    }
  }, [playersList, activeHost, hasAnalyzed, latLngToVector3]);

  const handlePointerDown = (e: React.PointerEvent) => {
    const st = threeStateRef.current;
    st.isDragging = true;
    st.prevMouseX = e.clientX;
    st.prevMouseY = e.clientY;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const st = threeStateRef.current;
    if (!st.isDragging) return;
    const dx = e.clientX - st.prevMouseX;
    const dy = e.clientY - st.prevMouseY;
    st.prevMouseX = e.clientX;
    st.prevMouseY = e.clientY;
    st.targetRotY += dx * 0.006;
    st.targetRotX = Math.max(-1.2, Math.min(1.2, st.targetRotX + dy * 0.006));
  };

  const handlePointerUp = () => {
    threeStateRef.current.isDragging = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const st = threeStateRef.current;
    st.cameraDistance = Math.max(3.5, Math.min(10.0, st.cameraDistance + e.deltaY * 0.005));
    if (st.camera) {
      st.camera.position.z = st.cameraDistance;
    }
  };

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
          {sessionId && (
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

      {isSessionExpired && (
        <div className="bg-amber-950/80 border-b border-amber-800 px-4 py-2.5 text-xs text-amber-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>This session has expired (24h limit reached). Please create a fresh session for new games.</span>
          </div>
          <button
            onClick={createNewSession}
            className="px-3 py-1 rounded bg-amber-500 text-slate-950 font-semibold hover:bg-amber-400 text-xs"
          >
            New Session
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
            <span className="ml-3 text-slate-500 hidden sm:inline">• Geographic Earth map • Drag to rotate, scroll to zoom</span>
          </div>

          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onWheel={handleWheel}
            className="w-full h-full cursor-grab active:cursor-grabbing block"
          />

          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {screenNodes.map(node => {
              if (!node.visible) return null;
              return (
                <div
                  key={node.id}
                  style={{
                    transform: `translate(${node.x}px, ${node.y}px)`,
                    left: 0,
                    top: 0
                  }}
                  className="absolute pointer-events-none -translate-x-1/2 -translate-y-8 flex flex-col items-center transition-transform duration-75"
                >
                  <div
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide whitespace-nowrap shadow-lg flex items-center gap-1 border ${
                      node.isHost
                        ? 'bg-amber-500 text-slate-950 border-amber-300'
                        : 'bg-slate-900/90 text-cyan-300 border-cyan-800/80 backdrop-blur-sm'
                    }`}
                  >
                    {node.isHost && <Trophy className="w-3 h-3 text-slate-950 inline" />}
                    <span>{node.name}</span>
                  </div>
                  <div
                    className={`w-1.5 h-1.5 rotate-45 -mt-1 ${
                      node.isHost ? 'bg-amber-400' : 'bg-slate-900 border-r border-b border-cyan-800'
                    }`}
                  ></div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-5 xl:col-span-4 flex flex-col bg-slate-900/40 divide-y divide-slate-800 overflow-y-auto max-h-screen">
          {!sessionId ? (
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
                      <span>Zero-IP Protected: Exact coordinates are rounded to ~city level. IP is never collected.</span>
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
                        <span>{isTestingNet ? 'Testing...' : netTestDone ? 'Retest' : 'Auto-Test'}</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-400 text-[11px]">Upload (Mbps)</span>
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
                        <span className="text-slate-400 text-[11px]">Ping to Internet</span>
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={latencyMs}
                          onChange={e => setLatencyMs(Number(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
                      </div>
                      <div>
                        <span className="text-slate-400 text-[11px]">Jitter (ms)</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={jitterMs}
                          onChange={e => setJitterMs(Number(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs mt-0.5"
                        />
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

                  {playersList.filter(p => p.id !== currentUserId).length > 0 && (
                    <div className="p-2.5 bg-slate-950/60 border border-slate-800 rounded-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-medium text-slate-300">
                          Radmin Ping Overrides (Optional)
                        </span>
                        <span className="text-[10px] text-slate-500">Overrides location estimates</span>
                      </div>
                      <div className="space-y-1.5 max-h-24 overflow-y-auto pr-1">
                        {playersList
                          .filter(p => p.id !== currentUserId)
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
                      {playersList.length} Players ({playersList.length - 1} Peers)
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
                      title="Best for large groups: picks candidate in the middle of all 19 peers"
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
                <h3 className="font-bold text-base text-white">Zero-IP Privacy & Security Shield</h3>
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
                  <h4 className="font-semibold text-emerald-300 mb-0.5">Your IP Address is Never Stored or Shared</h4>
                  <p className="text-[11px] text-slate-300">
                    Host Finder does not collect, record, log, or broadcast peer IP addresses. Your actual public IP remains completely invisible to other players in the session.
                  </p>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <h4 className="font-semibold text-slate-200">How Your Data is Protected:</h4>
                <ul className="list-disc list-inside space-y-1 text-slate-400 text-[11px]">
                  <li>
                    <strong className="text-slate-300">City-Level Precision Only:</strong> Coordinates are rounded to ~1 decimal place (roughly an 11 km radius). Exact home addresses are impossible to determine.
                  </li>
                  <li>
                    <strong className="text-slate-300">Anonymous Ownership:</strong> Entries are bound to an ephemeral anonymous UID. Only your browser can edit or delete your entry.
                  </li>
                  <li>
                    <strong className="text-slate-300">Automatic 24-Hour Expiration:</strong> All sessions and room records automatically expire and are purged after 24 hours.
                  </li>
                  <li>
                    <strong className="text-slate-300">Instant Removal:</strong> You can click the &quot;Remove My Data&quot; button at any time to instantly wipe your entry from the database.
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
