import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Trophy } from 'lucide-react';

export interface GlobePlayer {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface GlobeViewProps {
  playersList: GlobePlayer[];
  activeHost: GlobePlayer | null;
  hasAnalyzed: boolean;
  getPing: (p1: GlobePlayer, p2: GlobePlayer) => number;
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

export default function GlobeView({ playersList, activeHost, hasAnalyzed, getPing }: GlobeViewProps) {
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

  const latLngToVector3 = useCallback((latitude: number, longitude: number, radius = 2.0) => {
    const phi = ((90 - latitude) * Math.PI) / 180;
    const theta = ((longitude + 180) * Math.PI) / 180;
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    return new THREE.Vector3(x, y, z);
  }, []);

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

        const ping = getPing(activeHost, player);

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
  }, [playersList, activeHost, hasAnalyzed, latLngToVector3, getPing]);

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
    <div className="w-full h-full relative">
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
  );
}
