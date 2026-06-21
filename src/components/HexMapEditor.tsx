'use client';
// Hex Map Editor – World Tree Defender styling, canvas-rendered.
// pan & zoom, mirroring, stagger, rect/rhombus, pointy/flat, painterly fills,
// brush tool, undo, spawn & goal markers, tier elevation view.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Hexagon, Upload, Undo2, Save, CopyPlus, Brush, MapPin, MousePointer2,
  Palette, List, ChevronUp, ChevronDown, Minus, Plus, Maximize, TreePine, Box, Send, X, LayoutGrid,
} from 'lucide-react';

// wtd-analytics map-submission endpoint (override if the deployed domain differs)
// wtd-analytics base URL — override at build time with NEXT_PUBLIC_WTD_ANALYTICS_BASE.
const ANALYTICS_BASE = process.env.NEXT_PUBLIC_WTD_ANALYTICS_BASE || 'https://wtd-analytics.vercel.app';
// Low-value, map-submit-only token (rate-limited server-side). Embedded so any
// editor user can submit without entering anything. Override at build time with
// NEXT_PUBLIC_WTD_SUBMIT_TOKEN; must match MAP_SUBMIT_TOKEN on wtd-analytics.
const SUBMIT_TOKEN = process.env.NEXT_PUBLIC_WTD_SUBMIT_TOKEN || 'wtdmap_e8370e8e965fef19b5748ed2104c57ee3ba1f633';
const BIOMES = ['Cinderheart', 'Verdant Veil', 'Miremaw', 'Other'];

// --------------------------------------------------------------------------
// TYPES & CONSTANTS
// --------------------------------------------------------------------------
export type Orientation = 'pointy' | 'flat';
export interface Hex {
  q: number;
  r: number;
  id: string;
  asset: string;
  terrain: string;
  tier: number;
  rotation: number; // -1 = no rotation, 0-5 = hex edge rotation
}
export interface SpawnPoint { q: number; r: number }
export interface WorldTree { q: number; r: number; treeId: number }

export interface MapData {
  hexSize: number;
  orientation: Orientation;
  map: Hex[];
  spawnPoints?: SpawnPoint[];
  worldTree?: { q: number; r: number }; // Legacy single tree (backward compatibility)
  worldTrees?: WorldTree[]; // Multiple trees for multi-lane mode
}

// Painterly terrain palette (top / fill / bottom for vertical gradient)
interface TerrainDef { fill: string; top: string; bot: string }
const TERRAIN: Record<string, TerrainDef> = {
  grass: { fill: '#6ea93f', top: '#86c456', bot: '#4f7e2c' },
  water: { fill: '#3f7fa6', top: '#5aa0c4', bot: '#2c5d7e' },
  sand: { fill: '#d8c074', top: '#ecd690', bot: '#b89c52' },
  mountain: { fill: '#6b7280', top: '#8c93a0', bot: '#4d5462' },
  forest: { fill: '#3f7a2a', top: '#52923a', bot: '#295417' },
  swamp: { fill: '#2f7a6a', top: '#3f9684', bot: '#1f594c' },
  road: { fill: '#8a6a44', top: '#a3855c', bot: '#5b4128' },
  lava: { fill: '#d3491b', top: '#ff7a1f', bot: '#7a2510' },
};
const TERRAIN_ORDER = ['grass', 'water', 'sand', 'mountain', 'forest', 'swamp', 'road', 'lava'];
const SQRT3 = Math.sqrt(3);
const terrainFill = (t: string) => (TERRAIN[t] ?? TERRAIN.grass).fill;

// --------------------------------------------------------------------------
// GEOMETRY HELPERS
// --------------------------------------------------------------------------
function axialToPixel(
  q: number, r: number, size: number, orientation: Orientation,
  rect: boolean, stagger: boolean, mirror: boolean, maxR: number,
) {
  const rr = mirror ? maxR - r : r;
  if (orientation === 'pointy') {
    const baseX = size * SQRT3 * (rect ? q : q + rr / 2);
    const y = size * 1.5 * rr;
    const x = stagger ? baseX + ((r % 2) * SQRT3 * size) / 2 : baseX;
    return { x, y };
  }
  const baseY = size * SQRT3 * (rect ? rr : rr + q / 2);
  const x = size * 1.5 * q;
  const y = stagger ? baseY + ((q % 2) * SQRT3 * size) / 2 : baseY;
  return { x, y };
}

// Hexagon corner offsets (unit circle) for a given orientation
function hexCorners(cx: number, cy: number, s: number, orientation: Orientation): [number, number][] {
  const offsetDeg = orientation === 'pointy' ? 30 : 0;
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = ((offsetDeg + 60 * i) * Math.PI) / 180;
    pts.push([cx + s * Math.cos(a), cy + s * Math.sin(a)]);
  }
  return pts;
}

function darkenColor(color: string, amount: number): string {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const d = (c: number) => Math.round(c * (1 - amount));
  return `#${[d(r), d(g), d(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Odd-r offset neighbour deltas (the map staggers odd rows right, so the six
// neighbours depend on row parity). Returns the 6 adjacent (q,r) coordinates.
const ODDR_DIRS: [number, number][][] = [
  [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]],   // even rows
  [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]],     // odd rows
];
function offsetNeighbors(q: number, r: number): [number, number][] {
  const parity = ((r % 2) + 2) % 2;
  return ODDR_DIRS[parity].map(([dq, dr]) => [q + dq, r + dr] as [number, number]);
}

// --------------------------------------------------------------------------
// MAIN COMPONENT
// --------------------------------------------------------------------------
type EditMode = 'select' | 'brush' | 'spawn' | 'goal';

interface Snapshot { map: Hex[]; spawnPoints: SpawnPoint[]; worldTrees: WorldTree[] }

interface GalleryItem {
  name: string;
  biome: string;
  submittedBy: string;
  notes?: string;
  ts: number;
  url: string;
  stats?: { hexes: number; spawns: number; goals: number; biomes: number };
}

// Draw a small flat-shaded thumbnail of a map document onto a canvas.
function drawThumb(canvas: HTMLCanvasElement, data: MapData) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 260, H = canvas.clientHeight || 150;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const hexes = data.map || [];
  if (!hexes.length) return;
  const orientation: Orientation = data.orientation === 'flat' ? 'flat' : 'pointy';
  const maxR = Math.max(...hexes.map(h => h.r));
  const size = 10;
  const coords = hexes.map(h => axialToPixel(h.q, h.r, size, orientation, true, true, true, maxR));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of coords) { if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x; if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y; }
  const bw = (maxX - minX) + size * 2, bh = (maxY - minY) + size * 2;
  const scale = Math.min(W / bw, H / bh) * 0.96;
  const ox = (W - bw * scale) / 2 - (minX - size) * scale;
  const oy = (H - bh * scale) / 2 - (minY - size) * scale;
  const s = size * scale;
  const spawn = new Set((data.spawnPoints || []).map(p => `${p.q},${p.r}`));
  const trees = new Set<string>();
  if (Array.isArray(data.worldTrees)) data.worldTrees.forEach(t => trees.add(`${t.q},${t.r}`));
  else if (data.worldTree) trees.add(`${data.worldTree.q},${data.worldTree.r}`);
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i], c = coords[i];
    const cx = c.x * scale + ox, cy = c.y * scale + oy;
    const corners = hexCorners(cx, cy, s, orientation);
    ctx.beginPath(); corners.forEach((pt, j) => (j ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]))); ctx.closePath();
    ctx.fillStyle = terrainFill(h.terrain); ctx.fill();
    if (h.tier >= 2) { ctx.fillStyle = 'rgba(12,15,21,0.42)'; ctx.fill(); }
    else if (h.tier === 1) { ctx.fillStyle = 'rgba(12,15,21,0.22)'; ctx.fill(); }
  }
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i], key = `${h.q},${h.r}`, c = coords[i];
    const cx = c.x * scale + ox, cy = c.y * scale + oy;
    if (trees.has(key)) { ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, s * 0.7), 0, 7); ctx.fillStyle = '#ecc846'; ctx.fill(); ctx.lineWidth = Math.max(1, s * 0.25); ctx.strokeStyle = '#14181f'; ctx.stroke(); }
    else if (spawn.has(key)) { ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.3, s * 0.6), 0, 7); ctx.fillStyle = '#d3491b'; ctx.fill(); ctx.lineWidth = Math.max(1, s * 0.22); ctx.strokeStyle = '#fff'; ctx.stroke(); }
  }
}

function GalleryThumb({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: MapData) => { if (!cancelled && ref.current) drawThumb(ref.current, data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);
  return failed ? <div className="gthumb-fail">No preview</div> : <canvas ref={ref} className="gthumb" />;
}

export default function HexMapEditor() {
  const [data, setData] = useState<MapData | null>(null);
  const [selected, setSelected] = useState<Hex | null>(null);
  const [selectedMultiple, setSelectedMultiple] = useState<Set<string>>(new Set());
  const [rect] = useState(true);
  const [stagger] = useState(true);
  const [mirror] = useState(true);
  const [fileName, setFileName] = useState('cinderheart_v2.json');

  const [editMode, setEditMode] = useState<EditMode>('select');
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([]);
  const [worldTrees, setWorldTrees] = useState<WorldTree[]>([]);

  const [brushTerrain, setBrushTerrain] = useState<string>('grass');
  const [brushTier, setBrushTier] = useState<number>(0);
  const isBrushPainting = useRef(false);
  const paintedInStroke = useRef<Set<string>>(new Set());

  const [selCollapsed, setSelCollapsed] = useState(false);
  const [isometric, setIsometric] = useState(false);

  // Map gallery modal
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryMaps, setGalleryMaps] = useState<GalleryItem[]>([]);
  const [galleryState, setGalleryState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [galleryErr, setGalleryErr] = useState('');

  // Submit-to-analytics modal
  const [submitOpen, setSubmitOpen] = useState(false);
  const [subName, setSubName] = useState('');
  const [subBiome, setSubBiome] = useState(BIOMES[0]);
  const [subBy, setSubBy] = useState('');
  const [subNotes, setSubNotes] = useState('');
  const [subStatus, setSubStatus] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');
  const [subMsg, setSubMsg] = useState('');

  // camera
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const isPanning = useRef(false);
  const isDragSelecting = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  // undo
  const historyRef = useRef<Snapshot[]>([]);
  const [, setHistoryVersion] = useState(0);
  const canUndo = historyRef.current.length > 0;

  const fileRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<(() => void) | null>(null); // latest draw(), for imperative redraws
  const lastFileHandle = useRef<FileSystemFileHandle | null>(null);
  const lastFileName = useRef<string>('map.json');

  const dataRef = useRef(data); dataRef.current = data;
  const spawnPointsRef = useRef(spawnPoints); spawnPointsRef.current = spawnPoints;
  const worldTreesRef = useRef(worldTrees); worldTreesRef.current = worldTrees;

  // ---- load -----------------------------------------------------------------
  const loadWorldTrees = (parsed: MapData): WorldTree[] => {
    if (parsed.worldTrees && parsed.worldTrees.length > 0) return parsed.worldTrees;
    if (parsed.worldTree) return [{ q: parsed.worldTree.q, r: parsed.worldTree.r, treeId: 0 }];
    return [];
  };

  const applyLoadedMap = useCallback((parsed: MapData, name?: string) => {
    parsed.map = parsed.map.map(h => ({ ...h, rotation: h.rotation ?? -1 }));
    setData(parsed);
    setSpawnPoints(parsed.spawnPoints ?? []);
    setWorldTrees(loadWorldTrees(parsed));
    setSelected(null);
    setSelectedMultiple(new Set());
    setEditMode('select');
    setScale(1);
    setOffset({ x: 0, y: 0 });
    historyRef.current = [];
    setHistoryVersion(v => v + 1);
    if (name) setFileName(name);
  }, []);

  useEffect(() => {
    const loadDefault = () => fetch('/hex-map-editor/cinderheart_v2.json')
      .then(res => res.json())
      .then((parsed: MapData) => applyLoadedMap(parsed, 'cinderheart_v2.json'))
      .catch(err => console.error('Failed to load default map:', err));

    // ?load=<url> — open a specific map (e.g. a submitted map's Blob URL).
    const loadUrl = new URLSearchParams(window.location.search).get('load');
    if (loadUrl) {
      fetch(loadUrl)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then((parsed: MapData) => {
          const name = decodeURIComponent((loadUrl.split('/').pop() || 'map.json').split('?')[0]) || 'map.json';
          applyLoadedMap(parsed, name);
        })
        .catch(err => { console.error('Failed to load map from ?load=', err); loadDefault(); });
      return;
    }
    loadDefault();
  }, [applyLoadedMap]);

  // ---- undo -----------------------------------------------------------------
  const pushHistory = useCallback(() => {
    const cur = dataRef.current;
    if (!cur) return;
    historyRef.current.push({
      map: cur.map.map(h => ({ ...h })),
      spawnPoints: spawnPointsRef.current.map(s => ({ ...s })),
      worldTrees: worldTreesRef.current.map(t => ({ ...t })),
    });
    if (historyRef.current.length > 100) historyRef.current.shift();
    setHistoryVersion(v => v + 1);
  }, []);

  const undo = useCallback(() => {
    const snap = historyRef.current.pop();
    if (!snap) return;
    setData(prev => (prev ? { ...prev, map: snap.map } : prev));
    setSpawnPoints(snap.spawnPoints);
    setWorldTrees(snap.worldTrees);
    setSelected(prev => (prev ? snap.map.find(h => h.id === prev.id) ?? null : null));
    setHistoryVersion(v => v + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ---- file IO --------------------------------------------------------------
  const handleImportClick = useCallback(async () => {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as Window & { showOpenFilePicker: (o?: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
          types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
        });
        lastFileHandle.current = fileHandle;
        lastFileName.current = fileHandle.name;
        const file = await fileHandle.getFile();
        applyLoadedMap(JSON.parse(await file.text()) as MapData, fileHandle.name);
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    fileRef.current?.click();
  }, [applyLoadedMap]);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    lastFileName.current = file.name;
    lastFileHandle.current = null;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        applyLoadedMap(JSON.parse(ev.target?.result as string) as MapData, file.name);
      } catch { alert('Invalid JSON'); }
    };
    reader.readAsText(file);
  }, [applyLoadedMap]);

  const getExportData = () => {
    if (!data) return null;
    const exportData: MapData = { ...data, spawnPoints: spawnPoints.length > 0 ? spawnPoints : undefined };
    if (worldTrees.length === 0) { delete exportData.worldTree; delete exportData.worldTrees; }
    else if (worldTrees.length === 1) { exportData.worldTree = { q: worldTrees[0].q, r: worldTrees[0].r }; delete exportData.worldTrees; }
    else { exportData.worldTrees = worldTrees; delete exportData.worldTree; }
    return exportData;
  };

  const handleSave = async () => {
    const exportData = getExportData();
    if (!exportData) return;
    const jsonContent = JSON.stringify(exportData, null, 2);
    if (lastFileHandle.current) {
      try {
        const writable = await lastFileHandle.current.createWritable();
        await writable.write(jsonContent);
        await writable.close();
        return;
      } catch (err) { console.log('Could not save to original file, using Save As...', err); }
    }
    await handleExport();
  };

  const handleExport = async () => {
    const exportData = getExportData();
    if (!exportData) return;
    const jsonContent = JSON.stringify(exportData, null, 2);
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as Window & { showSaveFilePicker: (o?: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: lastFileName.current,
          types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(jsonContent);
        await writable.close();
        lastFileHandle.current = handle;
        lastFileName.current = handle.name;
        setFileName(handle.name);
        return;
      } catch (err) { if ((err as Error).name === 'AbortError') return; }
    }
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = lastFileName.current; a.click();
    URL.revokeObjectURL(url);
  };

  // ---- mutations ------------------------------------------------------------
  const updateHex = <K extends keyof Hex>(k: K, v: Hex[K]) => {
    if (!data) return;
    pushHistory();
    if (selectedMultiple.size > 0) {
      setData({ ...data, map: data.map.map(h => (selectedMultiple.has(h.id) ? { ...h, [k]: v } : h)) });
      if (selected && selectedMultiple.has(selected.id)) setSelected(prev => (prev ? { ...prev, [k]: v } : prev));
    } else if (selected) {
      setData({ ...data, map: data.map.map(h => (h.id === selected.id ? { ...h, [k]: v } : h)) });
      setSelected(prev => (prev ? { ...prev, [k]: v } : prev));
    }
  };

  const updateHexRef = useRef(updateHex); updateHexRef.current = updateHex;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const selectedMultipleRef = useRef(selectedMultiple); selectedMultipleRef.current = selectedMultiple;
  const editModeRef = useRef(editMode); editModeRef.current = editMode;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const wheelRafRef = useRef(0);
  const pendingScaleRef = useRef<number | null>(null);

  const toggleSpawnPoint = useCallback((q: number, r: number) => {
    pushHistory();
    setSpawnPoints(prev => {
      const exists = prev.find(sp => sp.q === q && sp.r === r);
      return exists ? prev.filter(sp => !(sp.q === q && sp.r === r)) : [...prev, { q, r }];
    });
  }, [pushHistory]);

  const toggleWorldTreeAt = useCallback((q: number, r: number) => {
    pushHistory();
    setWorldTrees(prev => {
      const existingIndex = prev.findIndex(t => t.q === q && t.r === r);
      if (existingIndex >= 0) return prev.filter((_, i) => i !== existingIndex);
      const maxId = prev.length > 0 ? Math.max(...prev.map(t => t.treeId)) : -1;
      return [...prev, { q, r, treeId: maxId + 1 }];
    });
  }, [pushHistory]);

  const onHexClick = useCallback((hex: Hex, e: { ctrlKey: boolean; metaKey: boolean }) => {
    const mode = editModeRef.current;
    if (mode === 'spawn') { toggleSpawnPoint(hex.q, hex.r); return; }
    if (mode === 'goal') { toggleWorldTreeAt(hex.q, hex.r); return; }
    if (e.ctrlKey || e.metaKey) {
      const cur = selectedRef.current;
      setSelectedMultiple(prev => {
        const newSet = new Set(prev);
        if (newSet.size === 0 && cur && cur.id !== hex.id) newSet.add(cur.id);
        if (newSet.has(hex.id)) newSet.delete(hex.id); else newSet.add(hex.id);
        return newSet;
      });
      setSelected(hex);
    } else {
      setSelectedMultiple(new Set());
      setSelected(hex);
    }
  }, [toggleSpawnPoint, toggleWorldTreeAt]);

  // ---- derived --------------------------------------------------------------
  const sizePx = (data?.hexSize ?? 1) * 100;
  const maxR = useMemo(() => (data ? Math.max(...data.map.map(h => h.r)) : 0), [data]);
  const bounds = useMemo(() => {
    if (!data) return { w: 800, h: 600 };
    const coords = data.map.map(h => axialToPixel(h.q, h.r, sizePx, data.orientation, rect, stagger, mirror, maxR));
    return {
      w: Math.max(...coords.map(c => c.x)) + sizePx * 2,
      h: Math.max(...coords.map(c => c.y)) + sizePx * 2,
    };
  }, [data, sizePx, rect, stagger, mirror, maxR]);

  const spawnSet = useMemo(() => new Set(spawnPoints.map(sp => `${sp.q},${sp.r}`)), [spawnPoints]);
  const treeMap = useMemo(() => {
    const m = new Map<string, number>();
    worldTrees.forEach(t => m.set(`${t.q},${t.r}`, t.treeId));
    return m;
  }, [worldTrees]);

  // Highlighted footprint around markers: spawns mark their 1st ring (6 hexes),
  // world trees mark their 1st + 2nd ring (6 + 12 hexes).
  type Aura = 'spawn' | 'tree2' | 'tree1';
  const auraMap = useMemo(() => {
    const m = new Map<string, Aura>();
    for (const sp of spawnPoints) {
      for (const [q, r] of offsetNeighbors(sp.q, sp.r)) m.set(`${q},${r}`, 'spawn');
    }
    for (const t of worldTrees) {
      const center = `${t.q},${t.r}`;
      const ring1 = offsetNeighbors(t.q, t.r);
      const ring1Keys = new Set(ring1.map(([q, r]) => `${q},${r}`));
      const ring2 = new Set<string>();
      for (const [q, r] of ring1) {
        for (const [nq, nr] of offsetNeighbors(q, r)) {
          const k = `${nq},${nr}`;
          if (k === center || ring1Keys.has(k)) continue;
          ring2.add(k);
        }
      }
      for (const k of ring2) m.set(k, 'tree2');
      for (const k of ring1Keys) m.set(k, 'tree1'); // ring1 wins over ring2 overlaps
    }
    return m;
  }, [spawnPoints, worldTrees]);

  // Base scale that fits the whole map in the viewport => "100%" shows everything.
  // The user-facing `scale` (100% = 1) multiplies on top of this.
  const fitScale = useMemo(() => {
    if (!viewSize.w || !viewSize.h) return 1;
    return Math.min(viewSize.w / bounds.w, viewSize.h / bounds.h) * 0.92;
  }, [viewSize, bounds]);

  // Cached world-pixel centre per hex (positions never change while editing, so
  // computing them every frame / every mousemove was pure waste).
  const hexCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (data) for (const h of data.map) m.set(h.id, axialToPixel(h.q, h.r, sizePx, data.orientation, rect, stagger, mirror, maxR));
    return m;
  }, [data, sizePx, rect, stagger, mirror, maxR]);

  // Spatial hash of hex centres so hit-testing is O(1) instead of scanning all hexes.
  const cellSize = sizePx * 1.5;
  const hexIndex = useMemo(() => {
    const grid = new Map<string, Hex[]>();
    if (data) for (const h of data.map) {
      const c = hexCenters.get(h.id)!;
      const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(h);
    }
    return grid;
  }, [data, hexCenters, cellSize]);

  const findHexAtPoint = useCallback((wx: number, wy: number): Hex | null => {
    if (!data) return null;
    const threshold = sizePx * 0.9;
    const cx = Math.floor(wx / cellSize), cy = Math.floor(wy / cellSize);
    let closest: Hex | null = null;
    let closestDist = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = hexIndex.get(`${gx},${gy}`);
        if (!cell) continue;
        for (const hex of cell) {
          const c = hexCenters.get(hex.id)!;
          const dist = Math.sqrt((wx - c.x) ** 2 + (wy - c.y) ** 2);
          if (dist < threshold && dist < closestDist) { closest = hex; closestDist = dist; }
        }
      }
    }
    return closest;
  }, [data, sizePx, cellSize, hexIndex, hexCenters]);

  // mouse(client) -> world, the exact inverse of worldToScreen
  const eventToWorld = useCallback((clientX: number, clientY: number) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const eff = fitScale * scale;
    return {
      x: (sx - r.width / 2 - offset.x) / eff + bounds.w / 2,
      y: (sy - r.height / 2 - offset.y) / eff + bounds.h / 2,
    };
  }, [offset, fitScale, scale, bounds]);

  // ---- painting -------------------------------------------------------------
  // Hot path: mutate the hex in place and redraw imperatively (no React state
  // churn). The stroke is committed to state once on mouse-up.
  const paintHexWithBrush = useCallback((hex: Hex) => {
    if (paintedInStroke.current.has(hex.id)) return;
    const terrain = brushTerrain;
    const tier = brushTier;
    if (hex.terrain === terrain && hex.tier === tier) return;
    paintedInStroke.current.add(hex.id);
    hex.terrain = terrain;
    hex.tier = tier;
    drawRef.current?.();
  }, [brushTerrain, brushTier]);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const paintMode = editMode === 'brush';
    const world = eventToWorld(e.clientX, e.clientY);
    if (paintMode) {
      isBrushPainting.current = true; isPanning.current = false; isDragSelecting.current = false;
      paintedInStroke.current.clear();
      pushHistory();
      if (world) {
        const hex = findHexAtPoint(world.x, world.y);
        if (hex) { paintHexWithBrush(hex); setSelected(hex); }
      }
    } else if ((e.ctrlKey || e.metaKey) && editMode === 'select') {
      isDragSelecting.current = true; isPanning.current = false; isBrushPainting.current = false;
      if (world) { const hex = findHexAtPoint(world.x, world.y); if (hex) onHexClick(hex, e); }
    } else if (editMode === 'spawn' || editMode === 'goal') {
      // single click toggles a marker; still allow pan if dragged
      isPanning.current = true; isDragSelecting.current = false; isBrushPainting.current = false;
      start.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
      if (world) { const hex = findHexAtPoint(world.x, world.y); if (hex) onHexClick(hex, e); }
    } else {
      // select mode -> select hex + pan on drag
      if (world) { const hex = findHexAtPoint(world.x, world.y); if (hex) onHexClick(hex, e); }
      isPanning.current = true; isDragSelecting.current = false; isBrushPainting.current = false;
      start.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isBrushPainting.current) {
      const world = eventToWorld(e.clientX, e.clientY);
      if (world) { const hex = findHexAtPoint(world.x, world.y); if (hex) paintHexWithBrush(hex); }
      return;
    }
    if (isDragSelecting.current && (e.ctrlKey || e.metaKey)) {
      const world = eventToWorld(e.clientX, e.clientY);
      if (world) {
        const hex = findHexAtPoint(world.x, world.y);
        if (hex) {
          setSelectedMultiple(prev => { if (prev.has(hex.id)) return prev; const s = new Set(prev); s.add(hex.id); return s; });
          setSelected(hex);
        }
      }
      return;
    }
    if (!isPanning.current) return;
    setOffset({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
  };

  const onMouseUp = () => {
    if (isBrushPainting.current) {
      if (paintedInStroke.current.size === 0) {
        historyRef.current.pop(); // nothing changed -> drop the undo entry
        setHistoryVersion(v => v + 1);
      } else {
        // commit the in-place stroke to React state (inspector / export / draw deps)
        setData(prev => (prev ? { ...prev, map: [...prev.map] } : prev));
        setSelected(prev => {
          if (!prev) return prev;
          const h = dataRef.current?.map.find(m => m.id === prev.id);
          return h ? { ...h } : prev;
        });
      }
    }
    isPanning.current = false; isDragSelecting.current = false; isBrushPainting.current = false;
    paintedInStroke.current.clear();
  };

  // wheel: tier on selection (select mode), otherwise zoom.
  // Zoom is coalesced to one state update per animation frame so fast wheel
  // streams don't trigger a redraw per event.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const hasSelection = selectedRef.current || selectedMultipleRef.current.size > 0;
      if (hasSelection && editModeRef.current === 'select') {
        const delta = e.deltaY > 0 ? -1 : 1;
        const base = selectedRef.current?.tier ?? 0;
        updateHexRef.current('tier', Math.max(0, Math.min(3, base + delta)));
        return;
      }
      const baseScale = pendingScaleRef.current ?? scaleRef.current;
      pendingScaleRef.current = Math.max(0.3, Math.min(5, baseScale * (e.deltaY < 0 ? 1.1 : 0.9)));
      if (!wheelRafRef.current) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          const v = pendingScaleRef.current;
          pendingScaleRef.current = null;
          if (v != null) setScale(v);
        });
      }
    };
    c.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      c.removeEventListener('wheel', handleWheel);
      if (wheelRafRef.current) cancelAnimationFrame(wheelRafRef.current);
    };
  }, []);

  // ---- canvas size ----------------------------------------------------------
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const measure = () => { const r = c.getBoundingClientRect(); setViewSize({ w: r.width, h: r.height }); };
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    measure();
    return () => ro.disconnect();
  }, []);

  // ---- render loop ----------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || viewSize.w === 0 || viewSize.h === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = viewSize.w, H = viewSize.h;
    if (canvas.width !== Math.round(W * dpr)) canvas.width = Math.round(W * dpr);
    if (canvas.height !== Math.round(H * dpr)) canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const eff = fitScale * scale;
    const s = sizePx * eff;                    // hex radius on screen
    const tierH = sizePx * 0.5 * eff;          // elevation per tier on screen
    const orientation = data.orientation;
    const halfW = bounds.w / 2, halfH = bounds.h / 2;
    const baseX = W / 2 + offset.x, baseY = H / 2 + offset.y;

    // Precompute the 6 corner unit vectors once (constant per orientation) so we
    // don't call cos/sin for every hex every frame.
    const offDeg = orientation === 'pointy' ? 30 : 0;
    const ux: number[] = [], uy: number[] = [];
    for (let i = 0; i < 6; i++) { const a = ((offDeg + 60 * i) * Math.PI) / 180; ux.push(Math.cos(a)); uy.push(Math.sin(a)); }
    const tracePath = (cx: number, cy: number, rad: number) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const X = cx + rad * ux[i], Y = cy + rad * uy[i]; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
      ctx.closePath();
    };

    const order = isometric
      ? [...data.map].sort((a, b) => (a.r - a.tier * 0.5) - (b.r - b.tier * 0.5))
      : data.map;

    // glow pass (lava + goal)
    for (const hex of data.map) {
      const tree = treeMap.has(`${hex.q},${hex.r}`);
      if (hex.terrain !== 'lava' && !tree) continue;
      const p = hexCenters.get(hex.id); if (!p) continue;
      const scx = (p.x - halfW) * eff + baseX;
      const cy = (p.y - halfH) * eff + baseY - (isometric ? hex.tier * tierH : 0);
      if (scx < -s * 2 || scx > W + s * 2 || cy < -s * 2 || cy > H + s * 2) continue;
      const g = ctx.createRadialGradient(scx, cy, 0, scx, cy, s * 1.6);
      g.addColorStop(0, tree ? 'rgba(110,169,63,0.5)' : 'rgba(255,110,30,0.42)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(scx, cy, s * 1.6, 0, Math.PI * 2); ctx.fill();
    }

    const selId = selected?.id;
    const multi = selectedMultiple;

    for (const hex of order) {
      const p = hexCenters.get(hex.id); if (!p) continue;
      const scx = (p.x - halfW) * eff + baseX;
      const scyBase = (p.y - halfH) * eff + baseY;
      const cy = scyBase - (isometric ? hex.tier * tierH : 0);
      if (scx < -s * 2 || scx > W + s * 2 || cy < -s * 2 || cy > H + s * 2) continue;

      const T = TERRAIN[hex.terrain] ?? TERRAIN.grass;

      // elevation walls
      if (isometric && hex.tier > 0) {
        const edges = [2, 3, 4];
        const shades = [0.5, 0.4, 0.45];
        for (let e = 0; e < 3; e++) {
          const idx = edges[e], n = (idx + 1) % 6;
          ctx.beginPath();
          ctx.moveTo(scx + s * ux[idx], cy + s * uy[idx]);
          ctx.lineTo(scx + s * ux[n], cy + s * uy[n]);
          ctx.lineTo(scx + s * ux[n], scyBase + s * uy[n]);
          ctx.lineTo(scx + s * ux[idx], scyBase + s * uy[idx]);
          ctx.closePath();
          ctx.fillStyle = darkenColor(T.fill, shades[e]);
          ctx.fill();
          ctx.lineWidth = Math.max(0.5, s * 0.02);
          ctx.strokeStyle = 'rgba(12,15,21,0.55)';
          ctx.stroke();
        }
      }

      // top face — flat terrain colour, faint edge (calm + cheap)
      tracePath(scx, cy, s);
      ctx.fillStyle = T.fill; ctx.fill();
      ctx.lineWidth = Math.max(0.4, s * 0.03);
      ctx.strokeStyle = 'rgba(12,15,21,0.14)';
      ctx.stroke();

      // tier darkening
      if (hex.tier >= 1) {
        tracePath(scx, cy, s);
        ctx.save(); ctx.clip();
        ctx.fillStyle = hex.tier >= 2 ? 'rgba(20,24,31,0.40)' : 'rgba(20,24,31,0.22)';
        ctx.fillRect(scx - s, cy - s, 2 * s, 2 * s);
        ctx.restore();
      }

      const key = `${hex.q},${hex.r}`;
      const isSpawn = spawnSet.has(key);
      const isTree = treeMap.has(key);

      // marker footprint aura (rings around spawns / world trees)
      const aura = auraMap.get(key);
      if (aura && !isSpawn && !isTree) {
        tracePath(scx, cy, s);
        // Tree rings use a bright lime (distinct from grass, which is the same
        // canopy green) so the footprint reads on grass and every other terrain.
        ctx.fillStyle = aura === 'spawn' ? 'rgba(211,73,27,0.30)'
          : aura === 'tree1' ? 'rgba(190,255,120,0.45)' : 'rgba(190,255,120,0.26)';
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, s * 0.08);
        ctx.strokeStyle = aura === 'spawn' ? 'rgba(255,120,60,0.85)'
          : aura === 'tree1' ? 'rgba(224,255,150,1)' : 'rgba(200,255,130,0.9)';
        ctx.stroke();
      }

      // markers
      if (isTree) {
        tracePath(scx, cy, s * 0.5);
        ctx.fillStyle = '#ecc846'; ctx.fill();
        ctx.lineWidth = Math.max(1, s * 0.05); ctx.strokeStyle = '#14181f'; ctx.stroke();
        if (worldTrees.length > 1) {
          ctx.fillStyle = '#14181f'; ctx.font = `bold ${Math.round(s * 0.5)}px var(--font-ui, sans-serif)`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(treeMap.get(key)), scx, cy);
        }
      } else if (isSpawn) {
        ctx.beginPath(); ctx.arc(scx, cy, s * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = '#d3491b'; ctx.fill();
        ctx.lineWidth = Math.max(1.5, s * 0.07); ctx.strokeStyle = '#fff'; ctx.stroke();
      }

      // selection / multi-select outline
      const isSel = hex.id === selId;
      const isMulti = multi.has(hex.id);
      if (isSel || isMulti) {
        ctx.save();
        tracePath(scx, cy, s);
        if (isSel) { ctx.shadowColor = 'rgba(246,217,112,0.85)'; ctx.shadowBlur = 14; ctx.strokeStyle = '#f6d970'; ctx.lineWidth = Math.max(2, s * 0.1); }
        else { ctx.strokeStyle = '#ecc846'; ctx.lineWidth = Math.max(1.5, s * 0.06); }
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [data, viewSize, sizePx, scale, fitScale, offset, bounds, isometric, hexCenters,
    spawnSet, treeMap, auraMap, worldTrees, selected, selectedMultiple]);

  drawRef.current = draw;

  // redraw whenever anything visual changes
  useEffect(() => { draw(); }, [draw]);

  // ---- inspector helpers ----------------------------------------------------
  const choosePaletteTerrain = (t: string) => setBrushTerrain(t);

  // ---- map gallery (browse + load submitted maps) ----
  const openGallery = async () => {
    setGalleryOpen(true);
    setGalleryState('loading');
    setGalleryErr('');
    try {
      const res = await fetch(`${ANALYTICS_BASE}/api/maps`, { headers: { 'X-Submit-Token': SUBMIT_TOKEN } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGalleryMaps(Array.isArray(data.maps) ? data.maps : []);
      setGalleryState('idle');
    } catch {
      setGalleryState('error');
      setGalleryErr('Could not load the gallery.');
    }
  };

  const loadFromGallery = async (item: GalleryItem) => {
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = (await res.json()) as MapData;
      lastFileHandle.current = null; // loaded from gallery -> Save becomes Save As
      applyLoadedMap(parsed, item.name ? `${item.name}.json` : 'map.json');
      setGalleryOpen(false);
    } catch {
      setGalleryErr('Failed to load that map.');
    }
  };

  // ---- submit to wtd-analytics ----
  const submitStats = useMemo(() => ({
    hexes: data?.map.length ?? 0,
    spawns: spawnPoints.length,
    goals: worldTrees.length,
    biomes: data ? new Set(data.map.map(h => h.terrain)).size : 0,
  }), [data, spawnPoints, worldTrees]);

  const openSubmit = () => {
    if (!data) return;
    setSubName(fileName.replace(/\.[^.]+$/, '').toUpperCase());
    setSubStatus('idle');
    setSubMsg('');
    setSubmitOpen(true);
  };

  const handleSubmit = async () => {
    const exportData = getExportData();
    if (!exportData) return;
    setSubStatus('sending');
    setSubMsg('Sending…');
    try {
      const res = await fetch(`${ANALYTICS_BASE}/api/maps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Submit-Token': SUBMIT_TOKEN },
        body: JSON.stringify({ name: subName, biome: subBiome, submittedBy: subBy, notes: subNotes, map: exportData }),
      });
      if (res.status === 401) {
        setSubStatus('error');
        setSubMsg('Submit rejected (token not configured on server).');
        return;
      }
      if (res.status === 429) {
        setSubStatus('error');
        setSubMsg('Daily submit limit reached. Try again tomorrow.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubStatus('error');
        setSubMsg(body?.error ? `Failed: ${body.error}` : `Failed (HTTP ${res.status})`);
        return;
      }
      setSubStatus('ok');
      setSubMsg('Submitted ✓');
      setTimeout(() => { setSubmitOpen(false); setSubStatus('idle'); setSubMsg(''); }, 1300);
    } catch {
      setSubStatus('error');
      setSubMsg('Could not reach server (network/CORS).');
    }
  };
  const cycleSelectedTerrain = () => {
    if (!selected) return;
    const i = TERRAIN_ORDER.indexOf(selected.terrain);
    updateHex('terrain', TERRAIN_ORDER[(i + 1) % TERRAIN_ORDER.length]);
  };

  const zoomPct = Math.round(scale * 100);
  const crumbName = fileName.replace(/\.[^.]+$/, '').toUpperCase();
  const showSelected = !!selected && editMode === 'select';
  const paintCursor = editMode === 'brush';

  // ==========================================================================
  return (
    <div className="hme">
      {/* ============ TOP BAR ============ */}
      <header className="topbar">
        <div className="brandmark">
          <div className="hex"><Hexagon /></div>
          <div className="brand-text">
            <span className="kicker">WORLD TREE DEFENDER</span>
            <span className="title">Hex Map Editor</span>
          </div>
        </div>
        <div className="mapcrumb"><span className="dot" /> MAP <b>{crumbName || '—'}</b></div>
        <div className="spacer" />
        <button className="btn ghost" onClick={handleImportClick}><Upload /> Import</button>
        <button className="btn ghost" onClick={openGallery}><LayoutGrid /> Gallery</button>
        <button className={`btn${canUndo ? '' : ' disabled'}`} onClick={undo}><Undo2 /> Undo</button>
        <button className={`btn${data ? '' : ' disabled'}`} onClick={handleSave}><Save /> Save</button>
        <button className={`btn${data ? '' : ' disabled'}`} onClick={handleExport}><CopyPlus /> Save As</button>
        <button className={`btn primary${data ? '' : ' disabled'}`} onClick={openSubmit}><Send /> Submit</button>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImport} />
      </header>

      <div className="hme-body">
        {/* ============ LEFT TOOL RAIL ============ */}
        <nav className="rail">
          <button className={`tool${editMode === 'select' ? ' active' : ''}`} title="Select" onClick={() => setEditMode('select')}><MousePointer2 /></button>
          <button className={`tool${editMode === 'brush' ? ' active' : ''}`} title="Brush / paint terrain" onClick={() => setEditMode('brush')}><Brush /></button>
          <div className="tool-wrap">
            <button className={`tool${editMode === 'spawn' ? ' active' : ''}`} title="Spawn markers" onClick={() => setEditMode('spawn')}><MapPin /></button>
            {spawnPoints.length > 0 && <span className="badge">{spawnPoints.length}</span>}
          </div>
          <div className="tool-wrap">
            <button className={`tool${editMode === 'goal' ? ' active' : ''}`} title="Goal / World Trees" onClick={() => setEditMode('goal')}><TreePine /></button>
            {worldTrees.length > 0 && <span className="badge canopy">{worldTrees.length}</span>}
          </div>
        </nav>

        {/* ============ CANVAS STAGE ============ */}
        <div className="stage">
          <canvas
            ref={canvasRef}
            className="map"
            style={{ cursor: paintCursor ? 'crosshair' : 'grab' }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
          {!data && <div className="empty">Import a map to get started</div>}

          {/* floating view controls */}
          <div className="float viewbar">
            <button className="icon-btn" title="Zoom out" onClick={() => setScale(s => Math.max(0.3, s * 0.85))}><Minus /></button>
            <div className="zoomval">{zoomPct}%</div>
            <button className="icon-btn" title="Zoom in" onClick={() => setScale(s => Math.min(5, s * 1.18))}><Plus /></button>
            <div className="vsep" />
            <button className="icon-btn" title="Reset view" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><Maximize /></button>
            <div className="vsep" />
            <div className="seg">
              <button className={isometric ? '' : 'on'} onClick={() => setIsometric(false)}>2D</button>
              <button className={isometric ? 'on' : ''} onClick={() => setIsometric(true)}><Box style={{ width: 13, height: 13, verticalAlign: '-2px', marginRight: 4 }} />3D</button>
            </div>
          </div>
        </div>

        {/* ============ RIGHT INSPECTOR ============ */}
        <aside className="inspector">
          {/* BRUSH + TERRAIN PALETTE — only while the Brush tool is active */}
          {editMode === 'brush' && (
            <>
              <section className="panel hero">
                <div className="phead">
                  <div className="ico"><Brush /></div>
                  <h3>Brush Tool</h3>
                </div>
                <div className="pbody">
                  <span className="label">Tier</span>
                  <div className="tierseg">
                    {[0, 1, 2, 3].map(t => (
                      <div key={t} className={`tier${brushTier === t ? ' on' : ''}`} onClick={() => setBrushTier(t)}>{t}</div>
                    ))}
                  </div>
                  <div className="hint sun">Click &amp; drag on the map to paint</div>
                </div>
              </section>

              <section className="panel">
                <div className="phead"><div className="ico"><Palette /></div><h3>Terrain Palette</h3></div>
                <div className="pbody">
                  <div className="swgrid">
                    {TERRAIN_ORDER.map(t => (
                      <div key={t} className={`sw-item${brushTerrain === t ? ' sel' : ''}`} onClick={() => choosePaletteTerrain(t)}>
                        <span className="chip" style={{ background: TERRAIN[t].fill }} />
                        <span className="nm">{t}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}

          {/* SPAWN / GOAL LIST */}
          {(editMode === 'spawn' || editMode === 'goal') && (
            <section className="panel">
              <div className="phead">
                <div className="ico">{editMode === 'spawn' ? <MapPin /> : <TreePine />}</div>
                <h3>{editMode === 'spawn' ? 'Spawn Points' : 'World Trees'}</h3>
              </div>
              <div className="pbody">
                <div className="hint" style={{ marginTop: 0 }}>
                  {editMode === 'spawn' ? 'Click hexes to add / remove spawn points.' : 'Click hexes to add / remove goals. Multiple = multi-lane.'}
                </div>
                {editMode === 'spawn' ? (
                  spawnPoints.length ? (
                    <div className="mlist">
                      {spawnPoints.map((sp, i) => (
                        <div key={i} className="mitem"><span>({sp.q}, {sp.r})</span><button onClick={() => toggleSpawnPoint(sp.q, sp.r)} title="Remove">✕</button></div>
                      ))}
                    </div>
                  ) : <div className="hint">No spawn points yet.</div>
                ) : (
                  worldTrees.length ? (
                    <div className="mlist">
                      {worldTrees.map(tree => (
                        <div key={tree.treeId} className="mitem"><span>Tree {tree.treeId}: ({tree.q}, {tree.r})</span><button onClick={() => toggleWorldTreeAt(tree.q, tree.r)} title="Remove">✕</button></div>
                      ))}
                    </div>
                  ) : <div className="hint">No trees set yet.</div>
                )}
              </div>
            </section>
          )}

          {/* LEGEND */}
          <section className="panel">
            <div className="phead"><div className="ico"><List /></div><h3>Legend</h3></div>
            <div className="pbody">
              <div className="subhead">Markers</div>
              <div className="legend">
                <div className="lrow"><span className="dotm" style={{ background: '#d3491b' }} /> Spawn</div>
                <div className="lrow"><span className="dotm" style={{ background: '#6ea93f' }} /> Goal</div>
              </div>
              <div className="subhead">Tiers</div>
              <div className="legend">
                <div className="lrow"><span className="tnum">0</span> Walkable / road</div>
                <div className="lrow"><span className="tnum">1</span> Normal wall</div>
                <div className="lrow"><span className="tnum">2</span> Unmodifiable</div>
                <div className="lrow"><span className="tnum">3</span> Out of bounds</div>
              </div>
              <div className="hint">Ctrl+click or Ctrl+drag to multi-select.</div>
            </div>
          </section>

          {/* SELECTED HEX */}
          {showSelected && (
            <section className={`panel${selCollapsed ? ' collapsed' : ''}`}>
              <div className="phead">
                <div className="ico"><Hexagon /></div>
                <h3>Selected Hex</h3>
                <div className="right selhead">
                  <span className="id">{selectedMultiple.size > 1 ? `×${selectedMultiple.size}` : selected!.id}</span>
                  <button className="collapse-btn" title="Hide details" onClick={() => setSelCollapsed(v => !v)}><ChevronUp /></button>
                </div>
              </div>
              <div className="pbody">
                <span className="label">Terrain</span>
                <div className="field" onClick={cycleSelectedTerrain} title="Click to cycle, or pick from the palette">
                  <span className="sw" style={{ background: terrainFill(selected!.terrain) }} />
                  <span className="nm">{selected!.terrain}</span>
                  <span className="chev"><ChevronDown /></span>
                </div>

                <div className="gap" />
                <span className="label">Tier</span>
                <div className="stepper">
                  <button onClick={() => updateHex('tier', Math.max(0, selected!.tier - 1))}>−</button>
                  <div className="val">{selected!.tier}</div>
                  <button onClick={() => updateHex('tier', Math.min(3, selected!.tier + 1))}>+</button>
                </div>

                <div className="gap" />
                <span className="label">Rotation</span>
                <div className="rotrow">
                  <div className={`rot none${selected!.rotation === -1 ? ' on' : ''}`} onClick={() => updateHex('rotation', -1)}>None</div>
                  {[0, 1, 2, 3, 4, 5].map(r => (
                    <div key={r} className={`rot${selected!.rotation === r ? ' on' : ''}`} onClick={() => updateHex('rotation', r)}>{r}</div>
                  ))}
                </div>

                <div className="gap" />
                <span className="label">Asset</span>
                <input className="asset-input" value={selected!.asset} placeholder="asset id…" onChange={e => updateHex('asset', e.target.value)} />
              </div>
            </section>
          )}
        </aside>
      </div>

      {/* ============ GALLERY MODAL ============ */}
      {galleryOpen && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setGalleryOpen(false); }}>
          <div className="modal wide" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="m-ico"><LayoutGrid /></div>
              <div>
                <h2>Map Gallery</h2>
                <div className="m-sub">{galleryState === 'idle' ? `${galleryMaps.length} submitted maps` : 'Submitted maps'}</div>
              </div>
              <button className="icon-btn" onClick={() => setGalleryOpen(false)}><X /></button>
            </div>
            <div className="modal-body">
              {galleryState === 'loading' && <div className="g-empty">Loading…</div>}
              {galleryState === 'error' && <div className="g-empty">{galleryErr}</div>}
              {galleryState === 'idle' && galleryMaps.length === 0 && <div className="g-empty">No maps submitted yet.</div>}
              {galleryState === 'idle' && galleryMaps.length > 0 && (
                <>
                  {galleryErr && <div className="g-empty" style={{ padding: '0 0 8px' }}>{galleryErr}</div>}
                  <div className="gallery-grid">
                    {galleryMaps.map((m, i) => (
                      <div key={i} className="gcard" onClick={() => loadFromGallery(m)} title="Click to load">
                        <div className="gthumb-wrap"><GalleryThumb url={m.url} /></div>
                        <div className="gcard-body">
                          <div className="gcard-top">
                            <span className="gnm">{m.name || 'untitled'}</span>
                            <span className="gbiome">{m.biome || '—'}</span>
                          </div>
                          <div className="gmeta">by {m.submittedBy || 'anonymous'} · {m.stats?.hexes ?? '—'} hexes</div>
                        </div>
                        <div className="gload"><Upload /> Load</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ SUBMIT MODAL ============ */}
      {submitOpen && data && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setSubmitOpen(false); }}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="m-ico"><Send /></div>
              <div>
                <h2>Submit Map</h2>
                <div className="m-sub">Send {subName || '—'} to wtd-analytics</div>
              </div>
              <button className="icon-btn" onClick={() => setSubmitOpen(false)}><X /></button>
            </div>
            <div className="modal-body">
              <div className="valrow">
                <span><b>{submitStats.hexes}</b> Hexes</span>
                <span><b>{submitStats.spawns}</b> Spawns</span>
                <span><b>{submitStats.goals}</b> Goals</span>
                <span><b>{submitStats.biomes}</b> Biomes</span>
              </div>
              <div>
                <span className="label">Map Name</span>
                <input className="m-input" value={subName} onChange={e => setSubName(e.target.value)} />
              </div>
              <div>
                <span className="label">Biome</span>
                <div className="m-select">
                  <select value={subBiome} onChange={e => setSubBiome(e.target.value)}>
                    {BIOMES.map(b => <option key={b}>{b}</option>)}
                  </select>
                  <ChevronDown />
                </div>
              </div>
              <div>
                <span className="label">Submitted By</span>
                <input className="m-input" value={subBy} placeholder="Your nickname" onChange={e => setSubBy(e.target.value)} />
              </div>
              <div>
                <span className="label">Patch Notes</span>
                <textarea className="m-input m-area" value={subNotes} placeholder="What changed in this revision…" onChange={e => setSubNotes(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot">
              {subMsg && <span className={`m-msg${subStatus === 'ok' ? ' ok' : subStatus === 'error' ? ' err' : ''}`}>{subMsg}</span>}
              <button className="btn ghost" onClick={() => setSubmitOpen(false)}>Cancel</button>
              <button className={`btn primary${subStatus === 'ok' ? ' ok' : ''}`} onClick={handleSubmit} disabled={subStatus === 'sending'}>
                <Send /> {subStatus === 'sending' ? 'Sending…' : subStatus === 'ok' ? 'Submitted' : 'Submit Map'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
