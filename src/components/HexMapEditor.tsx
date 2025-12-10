'use client';
// Hex Map Editor – pan & zoom, mirroring, stagger, rect/rhombus, pointy/flat, live shading

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
}
export interface SpawnPoint {
  q: number;
  r: number;
}

export interface MapData {
  hexSize: number;
  orientation: Orientation;
  map: Hex[];
  spawnPoints?: SpawnPoint[];
  worldTree?: { q: number; r: number };
}

const TERRAIN_COLOURS: Record<string, string> = {
  grass: '#52c41a',
  water: '#1890ff',
  sand: '#fadb14',
  mountain: '#8c8c8c',
  forest: '#237804',
  swamp: '#08979c',
  road: '#b37f4c',
};
const SQRT3 = Math.sqrt(3);

// --------------------------------------------------------------------------
// GEOMETRY HELPERS
// --------------------------------------------------------------------------
function axialToPixel(
  q: number,
  r: number,
  size: number,
  orientation: Orientation,
  rect: boolean,
  stagger: boolean,
  mirror: boolean,
  maxR: number,
) {
  const rr = mirror ? maxR - r : r;
  if (orientation === 'pointy') {
    const baseX = size * SQRT3 * (rect ? q : q + rr / 2);
    const y = size * 1.5 * rr;
    // Use original r for stagger to maintain row alignment when mirroring
    const x = stagger ? baseX + ((r % 2) * SQRT3 * size) / 2 : baseX;
    return { x, y };
  }
  const baseY = size * SQRT3 * (rect ? rr : rr + q / 2);
  const x = size * 1.5 * q;
  const y = stagger ? baseY + ((q % 2) * SQRT3 * size) / 2 : baseY;
  return { x, y };
}

function hexPoints(cx: number, cy: number, size: number, orientation: Orientation) {
  const offsetDeg = orientation === 'pointy' ? 30 : 0;
  return Array.from({ length: 6 }, (_, i) => {
    const ang = ((offsetDeg + 60 * i) * Math.PI) / 180;
    return `${cx + size * Math.cos(ang)},${cy + size * Math.sin(ang)}`;
  }).join(' ');
}

function shadeColour(hex: Hex, minH: number, maxH: number) {
  const base = TERRAIN_COLOURS[hex.terrain] ?? '#cccccc';
  const t = (hex.tier - minH) / Math.max(1, maxH - minH);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  const rB = parseInt(base.slice(1, 3), 16);
  const gB = parseInt(base.slice(3, 5), 16);
  const bB = parseInt(base.slice(5, 7), 16);
  return `#${[mix(rB), mix(gB), mix(bB)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// --------------------------------------------------------------------------
// MAIN COMPONENT
// --------------------------------------------------------------------------
type EditMode = 'terrain' | 'spawn' | 'goal';

export default function HexMapEditor() {
  const [data, setData] = useState<MapData | null>(null);
  const [selected, setSelected] = useState<Hex | null>(null);
  const [selectedMultiple, setSelectedMultiple] = useState<Set<string>>(new Set());
  const [rect] = useState(true);
  const [stagger] = useState(true);
  const [mirror] = useState(true);

  // Edit mode, spawn points, and world tree
  const [editMode, setEditMode] = useState<EditMode>('terrain');
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([]);
  const [worldTree, setWorldTree] = useState<{ q: number; r: number } | null>(null);

  // Brush tool
  const [brushEnabled, setBrushEnabled] = useState(false);
  const [brushTerrain, setBrushTerrain] = useState<string>('grass');
  const [brushTier, setBrushTier] = useState<number>(0);
  const isBrushPainting = useRef(false);
  const paintedInStroke = useRef<Set<string>>(new Set());

  // pan & zoom
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const isDragSelecting = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  const fileRef = useRef<HTMLInputElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const lastFileHandle = useRef<FileSystemFileHandle | null>(null);
  const lastFileName = useRef<string>('map.json');

  // Load default map on mount
  useEffect(() => {
    fetch(`${process.env.NODE_ENV === 'production' ? '/hex-map-editor' : ''}/bordered_map.json`)
      .then(res => res.json())
      .then((parsed: MapData) => {
        setData(parsed);
        setSpawnPoints(parsed.spawnPoints ?? []);
        setWorldTree(parsed.worldTree ?? null);
      })
      .catch(err => console.error('Failed to load default map:', err));
  }, []);

  // File IO - use File System Access API for import to get file handle
  const handleImportClick = useCallback(async () => {
    // Try File System Access API first to get file handle
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as Window & { showOpenFilePicker: (options?: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
          types: [
            {
              description: 'JSON Files',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });

        // Store file handle and name for export
        lastFileHandle.current = fileHandle;
        lastFileName.current = fileHandle.name;

        const file = await fileHandle.getFile();
        const text = await file.text();
        const parsed = JSON.parse(text) as MapData;
        setData(parsed);
        setSpawnPoints(parsed.spawnPoints ?? []);
        setWorldTree(parsed.worldTree ?? null);
        setSelected(null);
        setEditMode('terrain');
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        // Fall through to file input
      }
    }

    // Fallback to file input
    fileRef.current?.click();
  }, []);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Store filename for export (clear file handle since we used fallback)
    lastFileName.current = file.name;
    lastFileHandle.current = null;

    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as MapData;
        setData(parsed);
        setSpawnPoints(parsed.spawnPoints ?? []);
        setWorldTree(parsed.worldTree ?? null);
        setSelected(null);
        setEditMode('terrain');
      } catch {
        alert('Invalid JSON');
      }
    };
    reader.readAsText(file);
  }, []);

  // Helper to get export data
  const getExportData = () => {
    if (!data) return null;
    return {
      ...data,
      spawnPoints: spawnPoints.length > 0 ? spawnPoints : undefined,
      worldTree: worldTree ?? undefined,
    } as MapData;
  };

  // Save directly to original file (if we have handle)
  const handleSave = async () => {
    const exportData = getExportData();
    if (!exportData) return;

    const jsonContent = JSON.stringify(exportData, null, 2);

    // If we have a file handle from import, use it
    if (lastFileHandle.current) {
      try {
        const writable = await lastFileHandle.current.createWritable();
        await writable.write(jsonContent);
        await writable.close();
        return;
      } catch (err) {
        // Permission denied or other error - fall through to Save As
        console.log('Could not save to original file, using Save As...', err);
      }
    }

    // No file handle, fall through to Save As behavior
    await handleExport();
  };

  // Save As - always shows file picker
  const handleExport = async () => {
    const exportData = getExportData();
    if (!exportData) return;

    const jsonContent = JSON.stringify(exportData, null, 2);

    // Try to use File System Access API for save dialog
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as Window & { showSaveFilePicker: (options?: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: lastFileName.current,
          types: [
            {
              description: 'JSON Files',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(jsonContent);
        await writable.close();

        // Update file handle and filename for future saves
        lastFileHandle.current = handle;
        lastFileName.current = handle.name;
        return;
      } catch (err) {
        // User cancelled or API not supported - fall back to download
        if ((err as Error).name === 'AbortError') return;
      }
    }

    // Fallback to download approach for unsupported browsers
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastFileName.current;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Update helper - supports both single and multi-select
  const updateHex = <K extends keyof Hex>(k: K, v: Hex[K]) => {
    if (!data) return;

    // If we have multiple selections, update all of them
    if (selectedMultiple.size > 0) {
      setData({
        ...data,
        map: data.map.map(mapHex =>
          selectedMultiple.has(mapHex.id) ? { ...mapHex, [k]: v } : mapHex
        )
      });
      // Also update the primary selected if it's in the multi-selection
      if (selected && selectedMultiple.has(selected.id)) {
        setSelected(prev => (prev ? { ...prev, [k]: v } : prev));
      }
    } else if (selected) {
      // Single selection mode
      setData({ ...data, map: data.map.map(mapHex => (mapHex.id === selected.id ? { ...mapHex, [k]: v } : mapHex)) });
      setSelected(prev => (prev ? { ...prev, [k]: v } : prev));
    }
  };

  // Store updateHex in a ref so the wheel handler can access it
  const updateHexRef = useRef(updateHex);
  updateHexRef.current = updateHex;

  // Store selected, selectedMultiple, and editMode in refs for wheel handler
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedMultipleRef = useRef(selectedMultiple);
  selectedMultipleRef.current = selectedMultiple;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  // Non-passive wheel event listener to block page scroll
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const currentSelected = selectedRef.current;
      const currentSelectedMultiple = selectedMultipleRef.current;
      const currentEditMode = editModeRef.current;

      // Allow scroll to change tier if we have selection(s) in terrain mode
      const hasSelection = currentSelected || currentSelectedMultiple.size > 0;
      if (hasSelection && currentEditMode === 'terrain') {
        const delta = e.deltaY > 0 ? -1 : 1;
        // Use the primary selected hex tier as base for calculation
        const baseTier = currentSelected?.tier ?? 0;
        const newTier = Math.max(0, Math.min(3, baseTier + delta));
        updateHexRef.current('tier', newTier);
      }
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [data]); // Re-run when data changes (SVG mounts/unmounts)

  // Spawn point helpers
  const isSpawnPoint = (q: number, r: number) => {
    return spawnPoints.some(sp => sp.q === q && sp.r === r);
  };

  const toggleSpawnPoint = (q: number, r: number) => {
    setSpawnPoints(prev => {
      const exists = prev.find(sp => sp.q === q && sp.r === r);
      if (exists) {
        return prev.filter(sp => !(sp.q === q && sp.r === r));
      } else {
        return [...prev, { q, r }];
      }
    });
  };

  // World tree helpers
  const isWorldTree = (q: number, r: number) => {
    return worldTree?.q === q && worldTree?.r === r;
  };

  const setWorldTreeAt = (q: number, r: number) => {
    // Toggle: if clicking same tile, remove; otherwise set new location
    if (worldTree?.q === q && worldTree?.r === r) {
      setWorldTree(null);
    } else {
      setWorldTree({ q, r });
    }
  };

  // Hex click handler - supports Ctrl+click for multi-select
  const handleHexClick = (hex: Hex, e: React.MouseEvent) => {
    if (editMode === 'spawn') {
      toggleSpawnPoint(hex.q, hex.r);
    } else if (editMode === 'goal') {
      setWorldTreeAt(hex.q, hex.r);
    } else {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+click: toggle this hex in multi-selection
        setSelectedMultiple(prev => {
          const newSet = new Set(prev);

          // If starting multi-select and we have a single selection, add it first
          if (newSet.size === 0 && selected && selected.id !== hex.id) {
            newSet.add(selected.id);
          }

          if (newSet.has(hex.id)) {
            newSet.delete(hex.id);
          } else {
            newSet.add(hex.id);
          }
          return newSet;
        });
        // Set as primary selected for the sidebar display
        setSelected(hex);
      } else {
        // Normal click: clear multi-selection and select single
        setSelectedMultiple(new Set());
        setSelected(hex);
      }
    }
  };

  // Derived
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

  const [minH, maxH] = useMemo(() => {
    if (!data) return [0, 1];
    const hs = data.map.map(h => h.tier);
    return [Math.min(...hs), Math.max(...hs)];
  }, [data]);

  // Find hex at SVG coordinates
  const findHexAtPoint = useCallback((svgX: number, svgY: number): Hex | null => {
    if (!data) return null;
    // Check each hex and find the closest one within range
    let closest: Hex | null = null;
    let closestDist = Infinity;
    const threshold = sizePx * 0.9; // Slightly smaller than hex size for better accuracy

    for (const hex of data.map) {
      const { x, y } = axialToPixel(hex.q, hex.r, sizePx, data.orientation, rect, stagger, mirror, maxR);
      const dist = Math.sqrt((svgX - x) ** 2 + (svgY - y) ** 2);
      if (dist < threshold && dist < closestDist) {
        closest = hex;
        closestDist = dist;
      }
    }
    return closest;
  }, [data, sizePx, rect, stagger, mirror, maxR]);

  // Convert mouse event to SVG coordinates
  const mouseToSvg = useCallback((e: React.MouseEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const scaleX = viewBox.width / svgRect.width;
    const scaleY = viewBox.height / svgRect.height;
    return {
      x: (e.clientX - svgRect.left) * scaleX,
      y: (e.clientY - svgRect.top) * scaleY,
    };
  }, []);

  // Paint hex with brush (skips already painted in this stroke)
  const paintHexWithBrush = useCallback((hex: Hex) => {
    if (!data) return;
    // Skip if already painted in this stroke
    if (paintedInStroke.current.has(hex.id)) return;
    // Skip if hex already has same terrain and tier
    if (hex.terrain === brushTerrain && hex.tier === brushTier) return;

    paintedInStroke.current.add(hex.id);
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        map: prev.map.map(h =>
          h.id === hex.id ? { ...h, terrain: brushTerrain, tier: brushTier } : h
        ),
      };
    });
  }, [data, brushTerrain, brushTier]);

  // Handlers -------------------------------------------------------------
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;

    if (brushEnabled && editMode === 'terrain') {
      // Start brush painting
      isBrushPainting.current = true;
      isPanning.current = false;
      isDragSelecting.current = false;
      paintedInStroke.current.clear(); // Reset for new stroke
      // Paint the hex under cursor immediately
      const svgPoint = mouseToSvg(e);
      if (svgPoint) {
        const hex = findHexAtPoint(svgPoint.x, svgPoint.y);
        if (hex) paintHexWithBrush(hex);
      }
    } else if ((e.ctrlKey || e.metaKey) && editMode === 'terrain') {
      // Start drag-select mode
      isDragSelecting.current = true;
      isPanning.current = false;
      isBrushPainting.current = false;
    } else {
      // Normal pan
      isPanning.current = true;
      isDragSelecting.current = false;
      isBrushPainting.current = false;
      start.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    }
  };

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // Brush painting
    if (isBrushPainting.current && brushEnabled) {
      const svgPoint = mouseToSvg(e);
      if (svgPoint) {
        const hex = findHexAtPoint(svgPoint.x, svgPoint.y);
        if (hex) paintHexWithBrush(hex);
      }
      return;
    }

    // Drag select
    if (isDragSelecting.current && (e.ctrlKey || e.metaKey)) {
      const svgPoint = mouseToSvg(e);
      if (svgPoint) {
        const hex = findHexAtPoint(svgPoint.x, svgPoint.y);
        if (hex) {
          setSelectedMultiple(prev => {
            if (prev.has(hex.id)) return prev;
            const newSet = new Set(prev);
            newSet.add(hex.id);
            return newSet;
          });
          setSelected(hex);
        }
      }
      return;
    }

    if (!isPanning.current) return;
    setOffset({
      x: e.clientX - start.current.x,
      y: e.clientY - start.current.y,
    });
  };

  const onMouseUp = () => {
    isPanning.current = false;
    isDragSelecting.current = false;
    isBrushPainting.current = false;
    paintedInStroke.current.clear();
  };

  // JSX
  return (
    <div className="grid grid-cols-1 md:grid-cols-[4fr_2fr] gap-4 p-4 font-sans">
      {/* Canvas */}
      <Card className="overflow-auto shadow-xl min-h-[60vh]">
        <CardContent className="relative">
          {data ? (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${bounds.w} ${bounds.h}`}
              width="100%"
              height="100%"
              className="select-none cursor-grab"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            >
              <g transform={`translate(${offset.x + bounds.w / 2 * (1 - scale)} ${offset.y + bounds.h / 2 * (1 - scale)}) scale(${scale})`}>
                {data.map.map(hex => {
                  const { x, y } = axialToPixel(
                    hex.q,
                    hex.r,
                    sizePx,
                    data.orientation,
                    rect,
                    stagger,
                    mirror,
                    maxR,
                  );
                  const isSpawn = isSpawnPoint(hex.q, hex.r);
                  const isTree = isWorldTree(hex.q, hex.r);
                  const isSelected = selected?.id === hex.id;
                  const isMultiSelected = selectedMultiple.has(hex.id);
                  return (
                    <g key={hex.id} onClick={(e) => handleHexClick(hex, e)} className="cursor-pointer">
                      <motion.polygon
                        points={hexPoints(x, y, sizePx, data.orientation)}
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 120 }}
                        stroke={isTree ? '#22c55e' : isSpawn ? '#ff4444' : isMultiSelected ? '#3b82f6' : '#333'}
                        strokeWidth={isTree ? 4 : isSpawn ? 4 : isMultiSelected ? 3 : 1.2}
                        fill={shadeColour(hex, minH, maxH)}
                        opacity={isSelected || isMultiSelected ? 0.7 : 1}
                      />
                      {/* World tree marker */}
                      {isTree && (
                        <g>
                          <circle
                            cx={x}
                            cy={y}
                            r={sizePx * 0.35}
                            fill="#22c55e"
                            opacity={0.9}
                          />
                          <text
                            x={x}
                            y={y}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="white"
                            fontSize={sizePx * 0.4}
                            fontWeight="bold"
                          >
                            T
                          </text>
                        </g>
                      )}
                      {/* Spawn point marker */}
                      {isSpawn && (
                        <g>
                          <circle
                            cx={x}
                            cy={y}
                            r={sizePx * 0.35}
                            fill="#ff4444"
                            opacity={0.8}
                          />
                          <text
                            x={x}
                            y={y}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="white"
                            fontSize={sizePx * 0.4}
                            fontWeight="bold"
                          >
                            S
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <div className="flex h-[60vh] items-center justify-center text-gray-400">
              Import a map to get started
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sidebar */}
      <div className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-lg">
        <h2 className="text-xl font-semibold">Hex Map Editor</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleImportClick}>Import</Button>
          <Button variant="secondary" disabled={!data} onClick={handleSave}>
            Save
          </Button>
          <Button variant="outline" disabled={!data} onClick={handleExport}>
            Save As
          </Button>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setScale(s => Math.max(0.3, s * 0.8))}
            disabled={!data}
          >
            -
          </Button>
          <span className="text-sm min-w-[60px] text-center">{Math.round(scale * 100)}%</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setScale(s => Math.min(4, s * 1.25))}
            disabled={!data}
          >
            +
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
            disabled={!data}
          >
            Reset View
          </Button>
        </div>

        {/* Edit Mode Toggle */}
        {data && (
          <div className="flex gap-2 mt-2 flex-wrap">
            <Button
              variant={editMode === 'terrain' ? 'default' : 'outline'}
              onClick={() => setEditMode('terrain')}
              className="flex-1"
            >
              🎨 Terrain
            </Button>
            <Button
              variant={editMode === 'spawn' ? 'default' : 'outline'}
              onClick={() => setEditMode('spawn')}
              className="flex-1"
              style={editMode === 'spawn' ? { backgroundColor: '#ff4444' } : {}}
            >
              📍 Spawn ({spawnPoints.length})
            </Button>
            <Button
              variant={editMode === 'goal' ? 'default' : 'outline'}
              onClick={() => setEditMode('goal')}
              className="flex-1"
              style={editMode === 'goal' ? { backgroundColor: '#22c55e' } : {}}
            >
              🌳 Goal {worldTree ? '✓' : ''}
            </Button>
          </div>
        )}

        {/* Brush Tool */}
        {data && editMode === 'terrain' && (
          <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-blue-700">Brush Tool</h3>
              <Button
                size="sm"
                variant={brushEnabled ? 'default' : 'outline'}
                onClick={() => setBrushEnabled(!brushEnabled)}
                className={brushEnabled ? 'bg-blue-600 hover:bg-blue-700' : ''}
              >
                {brushEnabled ? '🖌️ On' : '🖌️ Off'}
              </Button>
            </div>
            {brushEnabled && (
              <div className="space-y-2">
                <div>
                  <Label className="text-xs text-blue-600">Terrain</Label>
                  <Select value={brushTerrain} onValueChange={setBrushTerrain}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(TERRAIN_COLOURS).map(t => (
                        <SelectItem key={t} value={t}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded"
                              style={{ backgroundColor: TERRAIN_COLOURS[t] }}
                            />
                            {t}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-blue-600">Tier</Label>
                  <div className="flex items-center gap-2">
                    {[0, 1, 2, 3].map(t => (
                      <Button
                        key={t}
                        size="sm"
                        variant={brushTier === t ? 'default' : 'outline'}
                        onClick={() => setBrushTier(t)}
                        className={`flex-1 ${brushTier === t ? 'bg-blue-600' : ''}`}
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-blue-400 italic">Click and drag to paint</p>
              </div>
            )}
          </div>
        )}

        <Input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={handleImport} />

        {/* Legend */}
        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Terrain</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(TERRAIN_COLOURS).map(([name, color]) => (
              <div key={name} className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded border border-gray-300"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs text-gray-600 capitalize">{name}</span>
              </div>
            ))}
          </div>

          <h3 className="text-sm font-medium text-gray-700 mt-3 mb-2">Markers</h3>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-red-500 border-2 border-red-700" />
              <span className="text-xs text-gray-600">Spawn</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-green-500 border-2 border-green-700" />
              <span className="text-xs text-gray-600">Goal</span>
            </div>
          </div>

          <h3 className="text-sm font-medium text-gray-700 mt-3 mb-2">Tiers</h3>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center text-xs font-bold bg-white border border-gray-300 rounded">0</span>
              <span className="text-xs text-gray-600">Walkable / Road (not buildable)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center text-xs font-bold bg-white border border-gray-300 rounded">1</span>
              <span className="text-xs text-gray-600">Normal wall</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center text-xs font-bold bg-white border border-gray-300 rounded">2</span>
              <span className="text-xs text-gray-600">Unmodifiable wall</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center text-xs font-bold bg-white border border-gray-300 rounded">3</span>
              <span className="text-xs text-gray-600">Out of bounds</span>
            </div>
          </div>

          <p className="text-xs text-gray-400 mt-3 italic">Ctrl+click or Ctrl+drag to multi-select</p>
        </div>

        {/* Spawn mode info panel */}
        {editMode === 'spawn' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <h3 className="text-lg font-medium text-red-700">Spawn Point Mode</h3>
            <p className="text-sm text-red-600 mt-1">Click hexes to add/remove spawn points</p>
            {spawnPoints.length > 0 && (
              <div className="mt-2">
                <p className="text-sm font-medium text-red-700">Current spawn points:</p>
                <ul className="text-xs text-red-600 mt-1 max-h-32 overflow-y-auto">
                  {spawnPoints.map((sp, i) => (
                    <li key={i} className="flex justify-between items-center py-0.5">
                      <span>({sp.q}, {sp.r})</span>
                      <button
                        onClick={() => toggleSpawnPoint(sp.q, sp.r)}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {spawnPoints.length === 0 && (
              <p className="text-xs text-red-400 mt-2 italic">No spawn points yet</p>
            )}
          </div>
        )}

        {/* Goal mode info panel */}
        {editMode === 'goal' && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <h3 className="text-lg font-medium text-green-700">Goal/Tree Mode</h3>
            <p className="text-sm text-green-600 mt-1">Click a hex to set the World Tree location (goal)</p>
            {worldTree ? (
              <div className="mt-2">
                <p className="text-sm font-medium text-green-700">Current location:</p>
                <div className="flex justify-between items-center mt-1">
                  <span className="text-sm text-green-600">({worldTree.q}, {worldTree.r})</span>
                  <button
                    onClick={() => setWorldTree(null)}
                    className="text-green-400 hover:text-green-600 text-xs"
                  >
                    ✕ Remove
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-green-400 mt-2 italic">No goal set yet</p>
            )}
          </div>
        )}

        {selected && editMode === 'terrain' ? (
          <>
            <h3 className="text-lg font-medium mt-4">Selected Hex: {selected.id}</h3>
            <div className="space-y-3">
              <div>
                <Label>Terrain</Label>
                <Select value={selected.terrain} onValueChange={v => updateHex('terrain', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Terrain" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(TERRAIN_COLOURS).map(t => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tier</Label>
                <div
                  className="flex items-center gap-2 p-2 border rounded-md cursor-ns-resize select-none"
                  onWheel={e => {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? -1 : 1;
                    const newTier = Math.max(0, Math.min(3, selected.tier + delta));
                    updateHex('tier', newTier);
                  }}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => updateHex('tier', Math.max(0, selected.tier - 1))}
                  >
                    -
                  </Button>
                  <span className="text-lg font-medium min-w-[40px] text-center">{selected.tier}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => updateHex('tier', Math.min(3, selected.tier + 1))}
                  >
                    +
                  </Button>
                </div>
              </div>
              <div>
                <Label>Asset</Label>
                <Input value={selected.asset} onChange={e => updateHex('asset', e.target.value)} />
              </div>
            </div>
          </>
        ) : editMode === 'terrain' ? (
          <p className="text-gray-500 mt-4">Click a hex to edit its properties.</p>
        ) : null}
      </div>
    </div>
  );
}
