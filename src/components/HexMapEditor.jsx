// Hex Map Editor – pan & zoom, mirroring, stagger, rect/rhombus, pointy/flat, live shading, stamp/paint mode

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';

// --------------------------------------------------------------------------
// CONSTANTS
// --------------------------------------------------------------------------
const TERRAIN_COLOURS = {
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
  q,
  r,
  size,
  orientation,
  rect,
  stagger,
  mirror,
  maxR,
) {
  const rr = mirror ? maxR - r : r;
  if (orientation === 'pointy') {
    const baseX = size * SQRT3 * (rect ? q : q + rr / 2);
    const y = size * 1.5 * rr;
    const x = stagger ? baseX + ((rr % 2) * SQRT3 * size) / 2 : baseX;
    return { x, y };
  }
  const baseY = size * SQRT3 * (rect ? rr : rr + q / 2);
  const x = size * 1.5 * q;
  const y = stagger ? baseY + ((q % 2) * SQRT3 * size) / 2 : baseY;
  return { x, y };
}

function hexPoints(cx, cy, size, orientation) {
  const offsetDeg = orientation === 'pointy' ? 30 : 0;
  return Array.from({ length: 6 }, (_, i) => {
    const ang = ((offsetDeg + 60 * i) * Math.PI) / 180;
    return `${cx + size * Math.cos(ang)},${cy + size * Math.sin(ang)}`;
  }).join(' ');
}

function shadeColour(hex, minH, maxH) {
  const base = TERRAIN_COLOURS[hex.terrain] ?? '#cccccc';
  const t = (hex.height - minH) / Math.max(1, maxH - minH);
  const mix = (c) => Math.round(c + (255 - c) * t);
  const rB = parseInt(base.slice(1, 3), 16);
  const gB = parseInt(base.slice(3, 5), 16);
  const bB = parseInt(base.slice(5, 7), 16);
  return `#${[mix(rB), mix(gB), mix(bB)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// --------------------------------------------------------------------------
// MAIN COMPONENT
// --------------------------------------------------------------------------
// Default sample data for testing
const DEFAULT_DATA = {
  "hexSize": 0.8,
  "orientation": "pointy",
  "map": [
    {
      "q": 0,
      "r": 0,
      "id": "hex_0_0",
      "asset": "",
      "terrain": "grass",
      "height": 1,
      "texture": ""
    },
    {
      "q": 1,
      "r": 0,
      "id": "hex_1_0",
      "asset": "",
      "terrain": "water",
      "height": 0,
      "texture": ""
    },
    {
      "q": -1,
      "r": 0,
      "id": "hex_-1_0",
      "asset": "",
      "terrain": "sand",
      "height": 1,
      "texture": ""
    },
    {
      "q": 0,
      "r": 1,
      "id": "hex_0_1",
      "asset": "",
      "terrain": "forest",
      "height": 2,
      "texture": ""
    },
    {
      "q": 1,
      "r": -1,
      "id": "hex_1_-1",
      "asset": "",
      "terrain": "mountain",
      "height": 3,
      "texture": ""
    },
    {
      "q": -1,
      "r": 1,
      "id": "hex_-1_1",
      "asset": "",
      "terrain": "swamp",
      "height": 0,
      "texture": ""
    },
    {
      "q": 0,
      "r": -1,
      "id": "hex_0_-1",
      "asset": "",
      "terrain": "road",
      "height": 1,
      "texture": ""
    }
  ]
};

export default function HexMapEditor() {
  const [data, setData] = useState(DEFAULT_DATA);
  const [selected, setSelected] = useState(null);
  const [rect, setRect] = useState(true);
  const [stagger, setStagger] = useState(true);
  const [mirror, setMirror] = useState(true);

  // Paint mode state
  const [paintMode, setPaintMode] = useState(false);
  const [paintBrush, setPaintBrush] = useState({
    terrain: 'grass',
    height: 1,
    texture: '',
    asset: '',
    applyTerrain: true,
    applyHeight: true,
    applyTexture: false,
    applyAsset: false,
  });

  // pan & zoom
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const start = useRef({ x: 0, y: 0 });

  const fileRef = useRef(null);

  // File IO
  const handleImport = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result);
        setData(parsed);
        setSelected(null);
      } catch {
        alert('Invalid JSON');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleExport = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'map.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Update helper for selected hex
  const updateHex = (k, v) => {
    if (!selected || !data) return;
    setData({ ...data, map: data.map.map(mapHex => (mapHex.id === selected.id ? { ...mapHex, [k]: v } : mapHex)) });
    setSelected(prev => (prev ? { ...prev, [k]: v } : prev));
  };

  // Paint brush helper
  const applyPaintBrush = (targetHex) => {
    if (!data) return;
    
    const updatedHex = { ...targetHex };
    if (paintBrush.applyTerrain) updatedHex.terrain = paintBrush.terrain;
    if (paintBrush.applyHeight) updatedHex.height = paintBrush.height;
    if (paintBrush.applyTexture) updatedHex.texture = paintBrush.texture;
    if (paintBrush.applyAsset) updatedHex.asset = paintBrush.asset;

    setData({ 
      ...data, 
      map: data.map.map(mapHex => (mapHex.id === targetHex.id ? updatedHex : mapHex)) 
    });
  };

  // Update paint brush helper
  const updatePaintBrush = (k, v) => {
    setPaintBrush(prev => ({ ...prev, [k]: v }));
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
    const hs = data.map.map(h => h.height);
    return [Math.min(...hs), Math.max(...hs)];
  }, [data]);

  // Handlers -------------------------------------------------------------
  const handleWheel = (e) => {
    if (!data) return;
    e.preventDefault();
    const zoom = e.deltaY > 0 ? 0.9 : 1.1;
    setScale(s => {
      const next = Math.min(4, Math.max(0.3, s * zoom));
      return next;
    });
  };

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    isPanning.current = true;
    start.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  };
  const onMouseMove = (e) => {
    if (!isPanning.current) return;
    setOffset({
      x: e.clientX - start.current.x,
      y: e.clientY - start.current.y,
    });
  };
  const onMouseUp = () => {
    isPanning.current = false;
  };

  // Handle hex click - either select or paint
  const handleHexClick = (hex, e) => {
    e.stopPropagation();
    if (paintMode) {
      applyPaintBrush(hex);
    } else {
      setSelected(hex);
    }
  };

  // JSX
  return (
    <div className="grid grid-cols-1 md:grid-cols-[4fr_2fr] gap-4 p-4 font-sans">
      {/* Canvas */}
      <Card className="overflow-auto shadow-xl min-h-[60vh]">
        <CardContent className="relative">
          {data ? (
            <svg
              viewBox={`0 0 ${bounds.w} ${bounds.h}`}
              width="100%"
              height="100%"
              className={`select-none ${paintMode ? 'cursor-crosshair' : 'cursor-grab'}`}
              onWheel={handleWheel}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            >
              <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
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
                  return (
                    <g key={hex.id} onClick={(e) => handleHexClick(hex, e)} className="cursor-pointer">
                      <motion.polygon
                        points={hexPoints(x, y, sizePx, data.orientation)}
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 120 }}
                        stroke="#333"
                        strokeWidth={1.2}
                        fill={shadeColour(hex, minH, maxH)}
                        opacity={selected?.id === hex.id && !paintMode ? 0.7 : 1}
                      />
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
        
        {/* Mode Toggle */}
        <div className="flex gap-2">
          <Button 
            variant={!paintMode ? "default" : "outline"} 
            onClick={() => setPaintMode(false)}
            className="flex-1"
          >
            Select Mode
          </Button>
          <Button 
            variant={paintMode ? "default" : "outline"} 
            onClick={() => setPaintMode(true)}
            className="flex-1"
          >
            🎨 Paint Mode
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => fileRef.current?.click()}>Import JSON</Button>
          <Button variant="secondary" disabled={!data} onClick={handleExport}>
            Export JSON
          </Button>
          <Button variant="outline" onClick={() => setRect(p => !p)}>
            {rect ? 'Rhombus ➜ Rect' : 'Rect ➜ Rhombus'}
          </Button>
          <Button variant="outline" onClick={() => setStagger(p => !p)}>
            {stagger ? 'Un-stagger' : 'Stagger'}
          </Button>
          <Button variant="outline" onClick={() => setMirror(p => !p)}>
            {mirror ? 'Un-mirror' : 'Mirror Y'}
          </Button>
          {data && (
            <Button
              variant="outline"
              onClick={() =>
                setData({ ...data, orientation: data.orientation === 'pointy' ? 'flat' : 'pointy' })
              }
            >
              {data.orientation === 'pointy' ? 'Flat-top' : 'Pointy-top'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            Reset View
          </Button>
        </div>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={handleImport} />

        {paintMode ? (
          <>
            <h3 className="text-lg font-medium mt-4">🎨 Paint Brush</h3>
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="apply-terrain"
                  checked={paintBrush.applyTerrain}
                  onChange={(e) => updatePaintBrush('applyTerrain', e.target.checked)}
                />
                <Label htmlFor="apply-terrain" className="flex-1">Terrain</Label>
                <Select 
                  value={paintBrush.terrain} 
                  onValueChange={v => updatePaintBrush('terrain', v)}
                  disabled={!paintBrush.applyTerrain}
                >
                  <SelectTrigger className="w-32">
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
              
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="apply-height"
                  checked={paintBrush.applyHeight}
                  onChange={(e) => updatePaintBrush('applyHeight', e.target.checked)}
                />
                <Label htmlFor="apply-height" className="flex-1">Height</Label>
                <Input
                  type="number"
                  value={paintBrush.height}
                  onChange={e => updatePaintBrush('height', Number(e.target.value))}
                  disabled={!paintBrush.applyHeight}
                  className="w-20"
                />
              </div>
              
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="apply-texture"
                  checked={paintBrush.applyTexture}
                  onChange={(e) => updatePaintBrush('applyTexture', e.target.checked)}
                />
                <Label htmlFor="apply-texture" className="flex-1">Texture</Label>
                <Input 
                  value={paintBrush.texture} 
                  onChange={e => updatePaintBrush('texture', e.target.value)}
                  disabled={!paintBrush.applyTexture}
                  className="w-32"
                />
              </div>
              
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="apply-asset"
                  checked={paintBrush.applyAsset}
                  onChange={(e) => updatePaintBrush('applyAsset', e.target.checked)}
                />
                <Label htmlFor="apply-asset" className="flex-1">Asset</Label>
                <Input 
                  value={paintBrush.asset} 
                  onChange={e => updatePaintBrush('asset', e.target.value)}
                  disabled={!paintBrush.applyAsset}
                  className="w-32"
                />
              </div>
            </div>
            
            <div className="mt-4 p-3 bg-blue-50 rounded-lg">
              <p className="text-sm text-blue-700">
                🎨 <strong>Paint Mode Active:</strong> Click any hex to apply the brush settings. 
                Check/uncheck properties to control what gets painted.
              </p>
            </div>
          </>
        ) : selected ? (
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
                <Label>Height</Label>
                <Input
                  type="number"
                  value={selected.height}
                  onChange={e => updateHex('height', Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Texture</Label>
                <Input value={selected.texture} onChange={e => updateHex('texture', e.target.value)} />
              </div>
              <div>
                <Label>Asset</Label>
                <Input value={selected.asset} onChange={e => updateHex('asset', e.target.value)} />
              </div>
            </div>
            
            <div className="mt-4">
              <Button 
                onClick={() => {
                  setPaintBrush({
                    terrain: selected.terrain,
                    height: selected.height,
                    texture: selected.texture,
                    asset: selected.asset,
                    applyTerrain: true,
                    applyHeight: true,
                    applyTexture: !!selected.texture,
                    applyAsset: !!selected.asset,
                  });
                  setPaintMode(true);
                }}
                variant="outline"
                className="w-full"
              >
                📋 Copy to Paint Brush
              </Button>
            </div>
          </>
        ) : (
          <p className="text-gray-500 mt-4">
            {paintMode 
              ? "🎨 Paint mode: Configure your brush above, then click hexes to paint them."
              : "Click a hex to edit its properties, or switch to Paint Mode for faster editing."
            }
          </p>
        )}
      </div>
    </div>
  );
}

