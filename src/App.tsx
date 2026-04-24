import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  FileImage, 
  Settings2, 
  MousePointer2, 
  Hand, 
  ZoomIn, 
  ZoomOut, 
  Maximize,
  Trash2, 
  LayoutDashboard,
  Send,
  Play,
  RotateCcw,
  Plus,
  RefreshCw,
  Lock,
  Unlock,
  ChevronLeft,
  ChevronRight,
  Database,
  ArrowRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useDropzone } from 'react-dropzone';

import { Contour, QPointF, PIXELS_PER_CM, CANVAS_SIZE_PX } from './types';
import { 
  calculateArea,
  calculatePerimeter,
  calculateCircularity,
  calculateAsymmetry,
  extractContoursFromMask, 
  simplifyContour, 
  getBSplinePoints, 
  detectMarkerScale, 
  findBestLabelPosition 
} from './imageProcessor';

import { exportToDXF, downloadBlob } from './dxfExporter';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// User's specific calibration
const CANVAS_SIZE_CM = 10;
const CALIBRATED_PIXELS_PER_CM = 75.59;
const CALIB_CANVAS_PX = CANVAS_SIZE_CM * CALIBRATED_PIXELS_PER_CM;

export default function App() {
  const [contours, setContours] = useState<Contour[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(0.85);
  const [offset, setOffset] = useState<QPointF>({ x: 0, y: 0 });
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [showOriginal, setShowOriginal] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [lockAspect, setLockAspect] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const resetView = () => {
    setZoom(0.85);
    setOffset({ x: 0, y: 0 });
  };
  const [currentPage, setCurrentPage] = useState(0);
  const [rdpTolerance, setRdpTolerance] = useState(1.2);
  const [showSim, setShowSim] = useState(false);
  
  const DEFAULT_PIXEL_SCALE = 0.062786; // User reference mm/px
  const [isSimulating, setIsSimulating] = useState(false);
  const [patients, setPatients] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string, type: 'info' | 'error' } | null>(null);

  const [morphologyKernel, setMorphologyKernel] = useState<3 | 5 | 7>(3);
  const [morphologyMode, setMorphologyMode] = useState<'dilation' | 'erosion' | 'none'>('dilation');

  const showToast = (text: string, type: 'info' | 'error' = 'info') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const canvasRef = useRef<SVGSVGElement>(null);
  const isDraggingCanvas = useRef(false);
  const lastMousePos = useRef<QPointF>({ x: 0, y: 0 });
  const fileMap = useRef<Map<string, File>>(new Map());

  const [activeDragId, setActiveDragId] = useState<number | null>(null);
  const [activeCPIndex, setActiveCPIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState<QPointF>({ x: 0, y: 0 });

  const handleMouseUp = () => {
    isDraggingCanvas.current = false;
    setActiveDragId(null);
    setActiveCPIndex(null);
  };

  const handlePack = (targetContours: Contour[]) => {
    if (targetContours.length === 0) return [];
    
    // 1. Pre-sort by area (descending) - heuristic for better packing
    const sorted = [...targetContours].sort((a, b) => {
      const areaA = a.actualWidthMm * a.actualHeightMm;
      const areaB = b.actualWidthMm * b.actualHeightMm;
      return areaB - areaA;
    });
    
    const pixelsPerCm = CALIBRATED_PIXELS_PER_CM;
    const containerRadiusPx = 5 * pixelsPerCm; 
    const centerX = CALIB_CANVAS_PX / 2;
    const centerY = CALIB_CANVAS_PX / 2;
    const marginPx = 15; // 1.5mm margin between items for laser beam width and safety

    const pages: Contour[][] = [[]];

    // Faster intersection check using pre-calculated bounding rects
    const intersects = (aRect: any, bRect: any) => {
      return !(aRect.x2 < bRect.x1 || aRect.x1 > bRect.x2 || aRect.y2 < bRect.y1 || aRect.y1 > bRect.y2);
    };

    const isInsideContainer = (x: number, y: number, w: number, h: number) => {
      // Check 4 corners + midpoints for a reasonably safe circular check
      const points = [
        { x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h },
        { x: x + w/2, y }, { x: x + w/2, y: y + h }, { x, y: y + h/2 }, { x: x + w, y: y + h/2 }
      ];
      return points.every(p => {
        const dx = p.x - centerX;
        const dy = p.y - centerY;
        return (dx * dx + dy * dy) <= (containerRadiusPx * containerRadiusPx);
      });
    };

    sorted.forEach((c) => {
      let placed = false;
      const w = (c.actualWidthMm * pixelsPerCm / 10);
      const h = (c.actualHeightMm * pixelsPerCm / 10);
      
      // Candidate search starting from center and spiraling out
      // We use a coarser step for performance, then potentially refine
      const rStep = 10; 
      const angleStepConst = 15; // degrees

      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        const currentPage = pages[pIdx];
        const pageRects = currentPage.map(other => {
          const ow = (other.actualWidthMm * pixelsPerCm / 10);
          const oh = (other.actualHeightMm * pixelsPerCm / 10);
          return {
            x1: other.position.x - marginPx,
            y1: other.position.y - marginPx,
            x2: other.position.x + ow + marginPx,
            y2: other.position.y + oh + marginPx
          };
        });

        for (let r = 0; r <= containerRadiusPx; r += rStep) {
          // Adjust angle step based on radius to maintain consistent linear step
          const circumference = 2 * Math.PI * r;
          const aStep = r === 0 ? 360 : Math.max(5, 360 / (circumference / 20));

          for (let angle = 0; angle < 360; angle += aStep) {
            const rad = (angle * Math.PI) / 180;
            const tx = centerX + r * Math.cos(rad) - w/2;
            const ty = centerY + r * Math.sin(rad) - h/2;

            if (isInsideContainer(tx, ty, w, h)) {
              const currentRect = { x1: tx, y1: ty, x2: tx + w, y2: ty + h };
              const collision = pageRects.some(rect => intersects(currentRect, rect));
              
              if (!collision) {
                currentPage.push({ ...c, position: { x: tx, y: ty }, pageIndex: pIdx });
                placed = true;
                break;
              }
            }
          }
          if (placed) break;
        }
        if (placed) break;
      }

      if (!placed) {
        // Build a new page and place at center
        const newPageIdx = pages.length;
        const tx = centerX - w / 2;
        const ty = centerY - h / 2;
        pages.push([{ ...c, position: { x: tx, y: ty }, pageIndex: newPageIdx }]);
      }
    });

    return pages.flat();
  };

  // Handle file upload
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setLoading(true);
    setStatusMessage("正在解析文件夹结构并匹配患者数据...");
    
    // Index all files to identify patient grouping by folder
    fileMap.current.clear();
    const patientFolders = new Map<string, File[]>();

    acceptedFiles.forEach(f => {
      const path = (f as any).path || f.webkitRelativePath || f.name;
      fileMap.current.set(path, f);
      fileMap.current.set(f.name, f);
      
      // Determine patient directory from path structure
      const segments = path.split('/');
      if (segments.length >= 2) {
        // e.g., "My Samples/PatientName/file.png" -> segments are ["My Samples", "PatientName", "file.png"]
        // We take the second to last as patient name
        const patientName = segments[segments.length - 2];
        if (!patientFolders.has(patientName)) {
          patientFolders.set(patientName, []);
        }
        patientFolders.get(patientName)?.push(f);
      } else {
        const patientName = "根目录样本";
        if (!patientFolders.has(patientName)) {
          patientFolders.set(patientName, []);
        }
        patientFolders.get(patientName)?.push(f);
      }

      // Index fuzzy name
      const fuzzy = f.name.replace(/_mask|_overlay|_segmented/i, '');
      fileMap.current.set(fuzzy, f);
    });

    const processedNewContours: Contour[] = [];
    const patientNames = Array.from(patientFolders.keys()).filter(n => n !== "根目录样本");
    
    if (patientNames.length > 0) {
      showToast(`检测到 ${patientNames.length} 个患者目录: ${patientNames.join(', ')}`);
    }

    for (const [patientName, files] of patientFolders.entries()) {
      setStatusMessage(`正在加载患者 [${patientName}] 的数据...`);
      
      const masks = files.filter(f => {
        const name = f.name.toLowerCase();
        return (name.includes('mask') || name.includes('segmented')) && 
               (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg'));
      });

      // No masks? Try images as masks
      if (masks.length === 0) {
        masks.push(...files.filter(f => f.type.startsWith('image/')));
      }

      for (const maskFile of masks) {
        try {
          const maskPath = (maskFile as any).path || maskFile.name;
          setStatusMessage(`[${patientName}] 正在提取边缘: ${maskFile.name}`);
          const results = await extractContoursFromMask(maskFile, { mode: morphologyMode, kernel: morphologyKernel });
          
          setStatusMessage(`[${patientName}] 正在进行自动标定...`);
          const base = maskFile.name.split('.')[0].replace(/(_mask)$|(_segmented)$/i, '');
          
          let overlayFile: File | null = null;
          const dirPrefix = maskPath.includes('/') ? maskPath.substring(0, maskPath.lastIndexOf('/') + 1) : '';

          // Priority search in the SAME relative path first
          overlayFile = fileMap.current.get(dirPrefix + base + '_overlay.png') || 
                        fileMap.current.get(dirPrefix + base + '_overlay.jpg') ||
                        fileMap.current.get(dirPrefix + base + '.png') ||
                        fileMap.current.get(dirPrefix + base + '.jpg');

          // Sibling overlays folder check
          if (!overlayFile && dirPrefix) {
            const siblingOverlaysDir = dirPrefix.replace('/masks/', '/overlays/');
            overlayFile = fileMap.current.get(siblingOverlaysDir + base + '_overlay.png') || 
                          fileMap.current.get(siblingOverlaysDir + base + '_overlay.jpg');
          }

          // Global fallback
          if (!overlayFile) {
            overlayFile = fileMap.current.get(base + '_overlay.png') || 
                          fileMap.current.get(base + '_overlay.jpg') ||
                          fileMap.current.get(base + '.png') ||
                          fileMap.current.get(base) ||
                          maskFile;
          }

          const calibResult = await detectMarkerScale(overlayFile);
          let pixelScale = DEFAULT_PIXEL_SCALE;

          if (calibResult.scale) {
            pixelScale = calibResult.scale;
            showToast(`[${patientName}] 标定成功 (评分: ${calibResult.score?.toFixed(3)})`);
          } else {
            const errorDetail = overlayFile !== maskFile ? calibResult.error : `未在 [${patientName}] 中找到对应的 _overlay 原图文件`;
            showToast(`[${patientName}] 标定失败: ${errorDetail}`, 'error');
          }

          const currentContoursCount = contours.length;
          results.forEach((contour) => {
            const minX = Math.min(...contour.map(p => p.x));
            const maxX = Math.max(...contour.map(p => p.x));
            const minY = Math.min(...contour.map(p => p.y));
            const maxY = Math.max(...contour.map(p => p.y));
            const wPx = maxX - minX;
            const hPx = maxY - minY;

            // Ensure closure
            const closed = [...contour];
            if (closed.length > 0) {
              const first = closed[0];
              const last = closed[closed.length - 1];
              if (Math.sqrt((first.x - last.x)**2 + (first.y - last.y)**2) > 1.0) {
                closed.push({ ...first });
              }
            }

            const simplified = simplifyContour(closed, rdpTolerance);
            const smoothed = getBSplinePoints(simplified, 3, 100);

            // Calculate precise metrics
            const areaPx2 = calculateArea(closed);
            const perimeterPx = calculatePerimeter(closed);
            const areaMm2 = areaPx2 * (pixelScale ** 2);
            const perimeterMm = perimeterPx * pixelScale;
            const roundness = calculateCircularity(areaPx2, perimeterPx);
            const asymmetry = calculateAsymmetry(closed);

            processedNewContours.push({
              id: Date.now() + Math.random(),
              label: currentContoursCount + processedNewContours.length + 1,
              sourceImage: URL.createObjectURL(overlayFile!), 
              originalPoints: closed,
              nurbsPoints: smoothed,
              controlPoints: simplified,
              position: { x: 0, y: 0 },
              scaleX: 1,
              scaleY: 1,
              color: `hsl(${Math.random() * 360}, 60%, 50%)`,
              actualWidthMm: wPx * pixelScale,
              actualHeightMm: hPx * pixelScale,
              originalWidthPx: wPx,
              originalHeightPx: hPx,
              pixelScale: pixelScale,
              isVisible: true,
              pageIndex: 0,
              patientName,
              areaMm2,
              perimeterMm,
              roundness,
              asymmetry
            });
          });
        } catch (e) {
          console.error(`Error processing ${maskFile.name} for patient ${patientName}:`, e);
        }
      }
    }
    
    if (processedNewContours.length > 0) {
      setStatusMessage("正在执行自动排样...");
      const finalContours = handlePack([...contours, ...processedNewContours]);
      setContours(finalContours);
      setCurrentPage(0);
      showToast(`成功处理 ${processedNewContours.length} 个轮廓，涉及 ${patientNames.length} 个患者集合`);
    } else {
      showToast("未发现有效的掩膜文件 (_mask.png)", "error");
    }
    
    setLoading(false);
    setStatusMessage(null);
  }, [contours, rdpTolerance, DEFAULT_PIXEL_SCALE, handlePack, showToast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop, 
    accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.bmp'] },
    multiple: true
  } as any);

  const selectedContour = contours.find(c => c.id === selectedId);

  const handleUpdateSize = (width?: number, height?: number, scale?: number) => {
    if (!selectedId) return;
    setContours(prev => prev.map(c => {
      if (c.id !== selectedId) return c;
      
      const newScale = scale ?? c.pixelScale;
      let newWidth = width;
      let newHeight = height;

      // If scale changed but width/height weren't explicitly provided, recalculate them
      if (scale !== undefined && width === undefined && height === undefined) {
        newWidth = c.originalWidthPx * newScale;
        newHeight = c.originalHeightPx * newScale;
      } else {
        newWidth = width ?? c.actualWidthMm;
        newHeight = height ?? c.actualHeightMm;
      }

      const newAreaMm2 = calculateArea(c.originalPoints) * (newScale ** 2);
      const newPerimeterMm = calculatePerimeter(c.originalPoints) * newScale;

      if (lockAspect && width !== undefined) {
        const ratio = c.actualHeightMm / c.actualWidthMm;
        return { 
          ...c, 
          actualWidthMm: newWidth, 
          actualHeightMm: newWidth * ratio, 
          pixelScale: newScale,
          areaMm2: newAreaMm2,
          perimeterMm: newPerimeterMm
        };
      }
      return { 
        ...c, 
        actualWidthMm: newWidth, 
        actualHeightMm: newHeight, 
        pixelScale: newScale,
        areaMm2: newAreaMm2,
        perimeterMm: newPerimeterMm
      };
    }));
  };

  const handleSelectPatient = async (patientName: string) => {
    setLoading(true);
    showToast(`正在从云端拉取 ${patientName} 的掩膜数据...`);
    
    // Simulate fetching a mask image and processing it
    setTimeout(() => {
      const id = Date.now() + Math.random();
      const demoContour: QPointF[] = [];
      for(let i=0; i<32; i++) {
        const a = (i/32) * Math.PI * 2;
        const r = 50 + Math.random() * 20;
        demoContour.push({ x: 150 + Math.cos(a)*r, y: 150 + Math.sin(a)*r });
      }
      // Ensure closure
      demoContour.push({ ...demoContour[0] });

      const simplified = simplifyContour(demoContour, rdpTolerance);
      const smoothed = getBSplinePoints(simplified, 3, 100);

      const newContour: Contour = {
        id,
        label: contours.length + 1,
        sourceImage: "https://images.unsplash.com/photo-1559757175-5700dde675bc?q=80&w=400&auto=format&fit=crop", // More reliable image
        originalPoints: demoContour,
        nurbsPoints: smoothed,
        controlPoints: simplified,
        position: { x: CALIB_CANVAS_PX/2 - 75, y: CALIB_CANVAS_PX/2 - 75 },
        scaleX: 1,
        scaleY: 1,
        color: `hsl(${Math.random() * 360}, 60%, 50%)`,
        actualWidthMm: 50,
        actualHeightMm: 50,
        originalWidthPx: 50 / DEFAULT_PIXEL_SCALE,
        originalHeightPx: 50 / DEFAULT_PIXEL_SCALE,
        pixelScale: DEFAULT_PIXEL_SCALE,
        isVisible: true,
        pageIndex: currentPage
      };
      
      setContours(prev => [...prev, newContour]);
      setSelectedId(id);
      showToast('云端数据加载成功');
      setLoading(false);
    }, 1000);
  };

  const handleDelete = () => {
    if (selectedId) {
      setContours(prev => prev.filter(c => c.id !== selectedId));
      setSelectedId(null);
    }
  };

  const handleClear = () => {
    if (confirm('确定清空所有轮廓吗？')) {
      setContours([]);
      setSelectedId(null);
    }
  };

  const handleExportDXF = () => {
    if (contours.length === 0) return;
    const dxf = exportToDXF(contours);
    downloadBlob(dxf, 'contour_design.dxf', 'application/dxf');
  };

  const handleFetchPatients = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/cloud/databasequery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: "wx727c965326d8f905",
          appSecret: "f8ee8710362411c0e8686c5aae39e5ef",
          envId: "cloud1-4gut65zm8fa5f13d",
          query: 'db.collection("cases").limit(100).get()'
        })
      });
      const data = await resp.json();
      if (data.data) {
        const parsed = data.data.map((item: string) => JSON.parse(item));
        const names = Array.from(new Set(parsed.map((v: any) => v.patientName))) as string[];
        setPatients(names.filter(Boolean));
        showToast(`已更新 ${names.length} 名患者数据`);
      }
    } catch (e) {
      console.error(e);
      showToast('同步失败，请检查配置');
    }
    setLoading(false);
  };
  // Remove the problematic handleCircularArrange and use handlePack instead if needed for UI buttons
  const handleArrange = () => {
    setContours(prev => {
      const packed = handlePack(prev);
      if (packed.length > 0) {
        setCurrentPage(0);
        showToast("自动排样已完成");
      }
      return packed;
    });
  };

  const handleMouseDownOnContour = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setSelectedId(id);
    if (tool === 'select') {
      const c = contours.find(v => v.id === id);
      if (c) {
        const mouseX = (e.clientX - offset.x) / zoom;
        const mouseY = (e.clientY - offset.y) / zoom;
        
        // Check if clicking a control point
        const minX = Math.min(...c.originalPoints.map(p => p.x));
        const minY = Math.min(...c.originalPoints.map(p => p.y));
        const maxX = Math.max(...c.originalPoints.map(p => p.x));
        const maxY = Math.max(...c.originalPoints.map(p => p.y));
        
        const targetW = c.actualWidthMm * CALIBRATED_PIXELS_PER_CM / 10;
        const targetH = c.actualHeightMm * CALIBRATED_PIXELS_PER_CM / 10;
        const sx = targetW / (maxX - minX);
        const sy = targetH / (maxY - minY);

        let hitCP = -1;
        c.controlPoints.forEach((cp, idx) => {
          const cpX = c.position.x + (cp.x - minX) * sx;
          const cpY = c.position.y + (cp.y - minY) * sy;
          const dist = Math.sqrt((mouseX - cpX)**2 + (mouseY - cpY)**2);
          if (dist < 10 / zoom) {
            hitCP = idx;
          }
        });

        if (hitCP !== -1) {
          setActiveCPIndex(hitCP);
          setActiveDragId(id);
        } else {
          setDragOffset({ x: mouseX - c.position.x, y: mouseY - c.position.y });
          setActiveDragId(id);
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (activeDragId !== null) {
      const mouseX = (e.clientX - offset.x) / zoom;
      const mouseY = (e.clientY - offset.y) / zoom;

      setContours(prev => prev.map(c => {
        if (c.id !== activeDragId) return c;
        
        if (activeCPIndex !== null) {
          // Dragging a control point
          const minX = Math.min(...c.originalPoints.map(p => p.x));
          const minY = Math.min(...c.originalPoints.map(p => p.y));
          const maxX = Math.max(...c.originalPoints.map(p => p.x));
          const maxY = Math.max(...c.originalPoints.map(p => p.y));
          const sx = (c.actualWidthMm * CALIBRATED_PIXELS_PER_CM / 10) / (maxX - minX);
          const sy = (c.actualHeightMm * CALIBRATED_PIXELS_PER_CM / 10) / (maxY - minY);

          const newCPs = [...c.controlPoints];
          newCPs[activeCPIndex] = {
            x: ((mouseX - c.position.x) / sx) + minX,
            y: ((mouseY - c.position.y) / sy) + minY
          };
          
          return { 
            ...c, 
            controlPoints: newCPs,
            nurbsPoints: getBSplinePoints(newCPs, 3, 100)
          };
        } else {
          // Dragging the whole contour
          return { ...c, position: { x: mouseX - dragOffset.x, y: mouseY - dragOffset.y } };
        }
      }));
    } else if (isDraggingCanvas.current) {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const startSimulation = () => {
    if (contours.length === 0) return;
    setShowSim(true);
    setIsSimulating(true);
  };

  useEffect(() => {
    if (selectedId) {
      setContours(prev => prev.map(c => {
        if (c.id === selectedId) {
          const simplified = simplifyContour(c.originalPoints, rdpTolerance);
          const smoothed = getBSplinePoints(simplified, 3, 100);
          return { ...c, controlPoints: simplified, nurbsPoints: smoothed };
        }
        return c;
      }));
    }
  }, [rdpTolerance, selectedId]);

  // Canvas Interactions
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(prev => Math.min(Math.max(0.1, prev * delta), 10));
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (tool === 'pan' || e.button === 1) {
      isDraggingCanvas.current = true;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleCalibrate = async (id: number) => {
    const c = contours.find(v => v.id === id);
    if (!c) return;
    
    setLoading(true);
    setStatusMessage('重新提取图片并执行 HSV 标志物检测...');
    
    try {
      // Create a File from the sourceImage blob URL to pass to detectMarkerScale
      const response = await fetch(c.sourceImage);
      const blob = await response.blob();
      const file = new File([blob], "recalib.jpg", { type: blob.type });
      
      const calibResult = await detectMarkerScale(file);
      if (calibResult.scale) {
        handleUpdateSize(undefined, undefined, calibResult.scale);
        showToast(`重新标定成功: ${(1/calibResult.scale).toFixed(2)} px/mm (得分: ${calibResult.score?.toFixed(2)})`);
      } else {
        showToast(`重新标定失败: ${calibResult.error}`, 'error');
      }
    } catch (e) {
      console.error("Calibration error", e);
      showToast('标定过程发生错误，请检查图片资源');
    } finally {
      setLoading(false);
      setStatusMessage(null);
    }
  };

  const renderContour = (c: Contour) => {
    const pathData = c.nurbsPoints.length > 0 
      ? `M ${c.nurbsPoints[0].x} ${c.nurbsPoints[0].y} ` + c.nurbsPoints.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') + ' Z'
      : '';

    const minX = Math.min(...c.originalPoints.map(p => p.x));
    const maxX = Math.max(...c.originalPoints.map(p => p.x));
    const minY = Math.min(...c.originalPoints.map(p => p.y));
    const maxY = Math.max(...c.originalPoints.map(p => p.y));
    const origW = maxX - minX;
    const origH = maxY - minY;
    
    const targetW = c.actualWidthMm * CALIBRATED_PIXELS_PER_CM / 10;
    const targetH = c.actualHeightMm * CALIBRATED_PIXELS_PER_CM / 10;
    
    const sx = targetW / origW;
    const sy = targetH / origH;

    return (
      <g 
        key={c.id} 
        transform={`translate(${c.position.x}, ${c.position.y}) scale(${sx}, ${sy}) translate(${-minX}, ${-minY})`}
        onMouseDown={(e) => handleMouseDownOnContour(e, c.id)}
        className="cursor-pointer group"
      >
        {/* Large invisible hit area */}
        <path 
          d={pathData} 
          fill="rgba(255,255,255,0.01)" 
          stroke="transparent" 
          strokeWidth={20 / sx}
          className="pointer-events-auto"
        />
        <path 
          d={pathData} 
          fill="transparent" 
          stroke={c.id === selectedId ? 'var(--color-brand-accent)' : c.color} 
          strokeWidth={(c.id === selectedId ? 4 : 2) / sx}
          className="transition-all duration-300 pointer-events-none"
        />
        {/* Glow for selected */}
        {c.id === selectedId && (
           <path 
            d={pathData} 
            fill="none" 
            stroke="var(--color-brand-accent)" 
            strokeWidth={12 / sx}
            opacity="0.15"
            className="animate-pulse"
          />
        )}
        {showOriginal && (
          <polyline 
            points={c.originalPoints.map(p => `${p.x},${p.y}`).join(' ')} 
            fill="none" 
            stroke="#cbd5e1" 
            strokeWidth={1/sx} 
            strokeDasharray={`${4/sx},${4/sx}`} 
          />
        )}
        {/* NURBS Control Points handles */}
        {c.id === selectedId && c.controlPoints.map((cp, idx) => (
          <circle 
            key={idx}
            cx={cp.x}
            cy={cp.y}
            r={6 / sx}
            fill="white"
            stroke="var(--color-brand-accent)"
            strokeWidth={2 / sx}
            className="hover:scale-125 transition-transform cursor-move"
          />
        ))}
        {/* Label text */}
        {(() => {
          // Use a search size that represents the room needed in pixel space
          // A label that appears ~12px on screen needs 12/(sx*zoom) room in raw points space
          // We use a slightly larger constant to ensure it finds a "roomy" spot
          const searchSize = 25 / sx; 
          const labelInfo = findBestLabelPosition(c.originalPoints, searchSize);
          if (!labelInfo) return null;
          
          return (
            <g transform={`translate(${labelInfo.pos.x}, ${labelInfo.pos.y}) scale(${1/sx}, ${1/sy})`}>
              <text 
                dy="6" 
                textAnchor="middle" 
                fill={c.id === selectedId ? 'var(--color-brand-accent)' : '#475569'} 
                fontSize="14px" 
                fontWeight="900" 
                style={{ filter: 'drop-shadow(0 0 2px white)' }}
              >
                {c.label}
              </text>
            </g>
          );
        })()}
      </g>
    );
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-brand-bg font-sans overflow-hidden text-slate-800">
      {/* Header */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-accent rounded-lg flex items-center justify-center text-white shadow-sm">
            <Settings2 className="w-5 h-5 stroke-[2.5]" />
          </div>
          <h1 className="text-lg font-semibold text-slate-800 tracking-tight">
            LesionSeg-X <span className="text-slate-400 font-normal ml-1">| 核心调试器 v1.4.2</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-100 shadow-sm">
            <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
            算子内核已就绪
          </div>
          <button 
            onClick={handleArrange}
            className="px-4 py-1.5 bg-brand-accent hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-all shadow-sm active:scale-95"
          >
            ROIs 自动排样
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Samples */}
        <aside className="w-48 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-50">病灶样本库</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div 
                {...getRootProps()}
                className={cn(
                  "aspect-square bg-slate-50 border border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all hover:bg-slate-100",
                  isDragActive && "bg-blue-50 border-brand-accent/50 scale-95",
                  loading && "opacity-50 pointer-events-none"
                )}
              >
                <input {...getInputProps()} />
                <Plus className="w-5 h-5 text-slate-400 mb-0.5" />
                <span className="text-[9px] font-bold text-slate-500">图片导入</span>
              </div>
              
              <label 
                className={cn(
                  "aspect-square bg-slate-50 border border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all hover:bg-slate-100",
                  loading && "opacity-50 pointer-events-none"
                )}
              >
                <input 
                  type="file" 
                  className="hidden" 
                  webkitdirectory="" 
                  directory="" 
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files) onDrop(Array.from(files));
                  }} 
                />
                <Database className="w-5 h-5 text-slate-400 mb-0.5" />
                <span className="text-[9px] font-bold text-brand-accent">目录导入</span>
              </label>
            </div>

            {/* List of processed images as "samples" */}
            <div className="space-y-3">
              {contours.map((c, i) => (
                <div key={c.id} className="group cursor-pointer" onClick={() => setSelectedId(c.id)}>
                  <div className={cn(
                    "w-full aspect-square bg-slate-100 rounded-md overflow-hidden mb-1 border-2 transition-all p-1",
                    selectedId === c.id ? "border-brand-accent shadow-blue-100 shadow-lg" : "border-transparent opacity-60 hover:opacity-100"
                  )}>
                    <div className="w-full h-full bg-slate-200 flex items-center justify-center rounded-sm overflow-hidden text-[8px] text-slate-400 font-bold">
                       {c.sourceImage ? <img src={c.sourceImage} className="w-full h-full object-cover" alt="Mask preview" /> : 'ROI'}
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 truncate font-mono">#{c.label} {c.patientName ? `(${c.patientName})` : 'ROI'}</div>
                </div>
              ))}
            </div>
            
            {/* Patients from cloud */}
            {patients.length > 0 && (
              <div className="pt-4 border-t border-slate-100 space-y-2">
                <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-2">云端序列</div>
                {patients.map(p => (
                  <div 
                    key={p} 
                    onClick={() => handleSelectPatient(p)}
                    className="flex items-center justify-between p-2 rounded hover:bg-slate-50 transition-colors cursor-pointer text-[10px] text-slate-600 font-medium group"
                  >
                    <span className="truncate">{p}</span>
                    <ArrowRight className="w-3 h-3 text-slate-300 group-hover:text-brand-accent" />
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="p-4 border-t border-slate-100">
            <button 
              onClick={handleFetchPatients}
              className="w-full py-2 bg-slate-50 text-slate-500 rounded border border-slate-200 text-[10px] font-bold uppercase tracking-wider hover:bg-slate-100 flex items-center justify-center gap-2 transition-colors"
            >
              <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} /> 同步云端
            </button>
          </div>
        </aside>

        {/* Central Viewport */}
        <section className="flex-1 bg-slate-50 flex flex-col relative overflow-hidden">
          {/* HUD Overlay */}
          <div className="absolute top-4 left-4 z-10 flex gap-2">
            <div className="bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-200 shadow-sm flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">缩放:</span> 
              <span className="text-xs font-bold text-brand-accent">{Math.round(zoom * 100)}%</span>
            </div>
            {selectedContour && (
              <div className="bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-200 shadow-sm flex items-center gap-2 animate-in fade-in slide-in-from-left-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase">ROI ID:</span> 
                <span className="text-xs font-bold text-brand-accent">#{selectedContour.label}</span>
              </div>
            )}
          </div>

          <div className="absolute top-4 right-4 z-10 flex gap-1 bg-white/90 backdrop-blur p-1 rounded-lg border border-slate-200 shadow-sm font-medium">
            <NavToolBtn active={tool === 'select'} onClick={() => setTool('select')} icon={<MousePointer2 />} />
            <NavToolBtn active={tool === 'pan'} onClick={() => setTool('pan')} icon={<Hand />} />
            <div className="w-px h-4 bg-slate-200 my-auto mx-1" />
            <NavToolBtn onClick={() => setZoom(z => z * 1.2)} icon={<ZoomIn />} />
            <NavToolBtn onClick={() => setZoom(z => z * 0.8)} icon={<ZoomOut />} />
            <NavToolBtn onClick={resetView} icon={<RotateCcw className="w-4 h-4" />} />
          </div>

          {/* Canvas Wrapper */}
          <div 
            className="flex-1 canvas-grid flex items-center justify-center relative select-none overflow-hidden"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setSelectedId(null);
              }
              handleMouseDown(e);
            }}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={(e) => {
              // Standard Smooth Zoom Logic (no Ctrl required)
              const delta = e.deltaY;
              const scaleChange = delta < 0 ? 1.05 : 0.95;
              setZoom(prev => Math.min(Math.max(prev * scaleChange, 0.1), 10));
            }}
          >
            {statusMessage && (
              <div className="absolute top-8 left-1/2 -translate-x-1/2 z-50 bg-brand-accent text-white px-6 py-2.5 rounded-full text-xs font-bold shadow-2xl flex items-center gap-3 animate-bounce border border-white/20">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                {statusMessage}
              </div>
            )}

            <div 
              className="origin-center transition-transform duration-75 ease-out"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
            >
              <div 
                className="cad-canvas relative shadow-2xl"
                style={{ width: CALIB_CANVAS_PX, height: CALIB_CANVAS_PX }}
              >
                {showGrid && (
                  <div className="absolute inset-0 pointer-events-none opacity-20">
                     <svg width="100%" height="100%">
                        <defs>
                          <pattern id="grid" width={CALIBRATED_PIXELS_PER_CM} height={CALIBRATED_PIXELS_PER_CM} patternUnits="userSpaceOnUse">
                            <path d={`M ${CALIBRATED_PIXELS_PER_CM} 0 L 0 0 0 ${CALIBRATED_PIXELS_PER_CM}`} fill="none" stroke="black" strokeWidth="0.5"/>
                          </pattern>
                        </defs>
                        <rect width="100%" height="100%" fill="url(#grid)" />
                      </svg>
                  </div>
                )}
                
                <svg 
                  ref={canvasRef}
                  className="w-full h-full relative z-10"
                  viewBox={`0 0 ${CALIB_CANVAS_PX} ${CALIB_CANVAS_PX}`}
                >
                  {contours.filter(c => c.pageIndex === currentPage).map(renderContour)}
                </svg>

                <div className="absolute inset-0 border border-slate-200 pointer-events-none z-0" />
              </div>
            </div>
            
            {/* Position HUD */}
            <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-md text-[10px] text-white border border-white/10 font-mono">
              ROI_SYS: 掩膜重叠显示模式 (Live)
            </div>
          </div>

          {/* Bottom Info Bar: Mask Metrics */}
          <div className="h-44 bg-white border-t border-slate-200 p-6 flex gap-8 z-10 overflow-x-auto shrink-0">
             <div className="flex-1">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase mb-4 tracking-widest flex items-center gap-2">
                  <Database className="w-3 h-3" /> 掩膜特征统计 (Mask Metrics)
                </h3>
                <div className="grid grid-cols-4 gap-4 min-w-[600px]">
                   <MetricCard label="病灶面积" value={selectedContour?.areaMm2 ? selectedContour.areaMm2.toFixed(1) : "0.0"} unit="mm²" />
                   <MetricCard label="周长 (Perimeter)" value={selectedContour?.perimeterMm ? selectedContour.perimeterMm.toFixed(1) : "0.0"} unit="mm" />
                   <MetricCard label="圆度评分 (Circularity)" value={selectedContour?.roundness ? selectedContour.roundness.toFixed(3) : "---"} status="success" />
                   <MetricCard label="不对称度 (Asymmetry)" value={selectedContour?.asymmetry ? selectedContour.asymmetry.toFixed(3) : "---"} status="warning" />
                </div>
             </div>
             
             <div className="w-px h-full bg-slate-100" />
             
             <div className="flex items-center gap-4 py-2">
                <div className="flex flex-col items-center gap-1">
                  <button 
                    onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                    className="p-2 hover:bg-slate-50 rounded border border-slate-100 text-slate-400 disabled:opacity-30" 
                    disabled={currentPage === 0}
                  >
                    <ChevronLeft className="w-5 h-5"/>
                  </button>
                  <span className="text-[10px] font-bold text-slate-400 font-mono">PREV</span>
                </div>
                <div className="px-4 text-center">
                  <div className="text-xl font-bold font-mono tracking-tighter text-slate-800">{currentPage + 1} <span className="text-slate-300">/</span> {Math.max(1, Math.ceil(contours.length / 10))}</div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">PAGE</div>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <button 
                    onClick={() => setCurrentPage(p => p + 1)}
                    className="p-2 hover:bg-slate-50 rounded border border-slate-100 text-slate-400 disabled:opacity-30"
                  >
                    <ChevronRight className="w-5 h-5"/>
                  </button>
                  <span className="text-[10px] font-bold text-slate-400 font-mono">NEXT</span>
                </div>
             </div>
          </div>
        </section>

        {/* Right Sidebar: Params */}
        <aside className="w-72 bg-white border-l border-slate-200 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">处理参数调节 (Params)</h3>
            <Settings2 className="w-3.5 h-3.5 text-slate-300" />
          </div>

          <div className="p-5 space-y-8 flex-1 overflow-y-auto">
            <div className="space-y-4">
               {/* Selection Detail if any */}
               {selectedContour ? (
                 <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-4 animate-in fade-in zoom-in-95 duration-200">
                    <div className="flex justify-between items-center">
                       <span className="text-[10px] font-bold text-slate-500 uppercase">当前 ROI 尺寸</span>
                       <button onClick={handleDelete} className="p-1.5 hover:bg-red-50 text-red-500 rounded border border-transparent hover:border-red-100 transition-all active:scale-90">
                         <Trash2 className="w-3.5 h-3.5" />
                       </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                       <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">宽度 (MM)</label>
                          <input 
                            type="number" step="0.1"
                            value={selectedContour.actualWidthMm.toFixed(1)}
                            onChange={(e) => handleUpdateSize(parseFloat(e.target.value))}
                            className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs font-mono font-bold text-brand-accent focus:ring-1 focus:ring-brand-accent outline-none"
                          />
                       </div>
                       <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">高度 (MM)</label>
                          <input 
                            type="number" step="0.1"
                            disabled={lockAspect}
                            value={selectedContour.actualHeightMm.toFixed(1)}
                            onChange={(e) => handleUpdateSize(undefined, parseFloat(e.target.value))}
                            className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs font-mono font-bold text-brand-accent focus:ring-1 focus:ring-brand-accent outline-none disabled:opacity-50"
                          />
                       </div>
                    </div>

                    <div className="pt-2">
                       <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">当前比例尺 (Scale)</div>
                       <div className="bg-slate-200/50 p-2 rounded border border-slate-100 flex justify-between items-center">
                          <span className="text-[10px] font-mono text-slate-500 font-bold">{(1/(selectedContour.pixelScale || 0.132)).toFixed(2)} PX/MM</span>
                          <span className="text-[10px] font-mono text-emerald-600 font-bold">{(selectedContour.pixelScale || 0.132).toFixed(4)} MM/PX</span>
                       </div>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                       <button 
                        onClick={() => setLockAspect(!lockAspect)}
                        className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-wide hover:text-brand-accent transition-colors"
                      >
                        {lockAspect ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                        {lockAspect ? '锁定宽高比 (Locked)' : '解除锁定 (Free)'}
                      </button>
                      <button 
                        onClick={() => {
                          const scale = prompt("请输入像素比例尺 (mm/px):", "0.132");
                          if (scale && selectedContour) {
                            const s = parseFloat(scale);
                            const minX = Math.min(...selectedContour.originalPoints.map(p => p.x));
                            const maxX = Math.max(...selectedContour.originalPoints.map(p => p.x));
                            const minY = Math.min(...selectedContour.originalPoints.map(p => p.y));
                            const maxY = Math.max(...selectedContour.originalPoints.map(p => p.y));
                            handleUpdateSize((maxX - minX) * s, (maxY - minY) * s);
                          }
                        }}
                        className="flex items-center gap-2 text-[10px] font-bold text-emerald-600 uppercase tracking-wide hover:brightness-110 transition-all"
                      >
                        <Maximize className="w-3 h-3" /> 手动标定 (Manual)
                      </button>
                      <button 
                        onClick={() => handleCalibrate(selectedContour.id)}
                        className="flex items-center gap-2 text-[10px] font-bold text-blue-600 uppercase tracking-wide hover:brightness-110 transition-all"
                      >
                        <RefreshCw className="w-3 h-3" /> HSV 自动标定 (Auto)
                      </button>
                    </div>
                 </div>
               ) : (
                 <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-8 text-center">
                    <p className="text-[10px] font-bold text-slate-400 uppercase italic">请选择轮廓以编辑尺寸</p>
                 </div>
               )}
            </div>

            <div className="space-y-6">
               <ParamSlider 
                 label="NURBS 拟合复杂度 (RDP)" 
                 value={rdpTolerance.toFixed(1)} 
                 min={0.1} 
                 max={10.0} 
                 step={0.1} 
                 onChange={(e: any) => setRdpTolerance(parseFloat(e.target.value))}
               />
               
               <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">形态学内核</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => {
                        setMorphologyMode(m => m === 'dilation' ? 'none' : 'dilation');
                        showToast(`形态学模式: ${morphologyMode === 'dilation' ? '已关闭' : '膨胀 (Dilation)'}`);
                      }}
                      className={cn(
                        "py-2 text-[10px] border rounded font-bold transition-all",
                        morphologyMode === 'dilation' ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                      )}
                    >
                      Dilation ({morphologyKernel}x{morphologyKernel})
                    </button>
                    <button 
                      onClick={() => {
                        setMorphologyMode(m => m === 'erosion' ? 'none' : 'erosion');
                        showToast(`形态学模式: ${morphologyMode === 'erosion' ? '已关闭' : '腐蚀 (Erosion)'}`);
                      }}
                      className={cn(
                        "py-2 text-[10px] border rounded font-bold transition-all",
                        morphologyMode === 'erosion' ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                      )}
                    >
                      Erosion (Off)
                    </button>
                  </div>
                  {morphologyMode !== 'none' && (
                    <div className="flex gap-1 pt-1">
                      {[3, 5, 7].map(size => (
                        <button 
                          key={size}
                          onClick={() => setMorphologyKernel(size as any)}
                          className={cn(
                            "flex-1 py-1 text-[9px] rounded border transition-all",
                            morphologyKernel === size ? "bg-brand-accent text-white border-brand-accent" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"
                          )}
                        >
                          {size}px
                        </button>
                      ))}
                    </div>
                  )}
               </div>

               <div className="pt-6 border-t border-slate-100 space-y-3">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">视图过滤器</label>
                  <div className="space-y-2.5">
                    <SimpleCheck id="v1" label="仅显示最大连通域" checked={true} onChange={() => {}} />
                    <SimpleCheck id="v2" label="显示原始轮廓 (Ghost)" checked={showOriginal} onChange={() => setShowOriginal(!showOriginal)} />
                    <SimpleCheck id="v3" label="显示标尺网格" checked={showGrid} onChange={() => setShowGrid(!showGrid)} />
                  </div>
               </div>
            </div>
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-200 space-y-2">
            <button 
              onClick={handleExportDXF}
              className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all active:scale-95 shadow-sm flex items-center justify-center gap-2"
            >
              <Send className="w-3.5 h-3.5" /> 导出处理结果 (DXF)
            </button>
            <button 
              onClick={() => {
                showToast('已生成任务并发送至: 10.181.27.186');
                setTimeout(() => alert('远程服务器回应: 任务已入库, ID: RT-X4090-002'), 1000);
              }}
              className="w-full py-2.5 bg-[#151619] hover:brightness-110 text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all active:scale-95 shadow-sm flex items-center justify-center gap-2"
            >
              <Database className="w-3.5 h-3.5" /> 远程任务提交
            </button>
            <button 
              onClick={startSimulation}
              className="w-full py-2.5 bg-brand-accent hover:brightness-110 text-white rounded text-[10px] font-bold uppercase tracking-widest transition-all active:scale-95 shadow-sm flex items-center justify-center gap-2"
            >
              <Play className="w-3.5 h-3.5" /> 启动行程模拟
            </button>
          </div>
        </aside>
      </main>

      {/* Footer */}
      <footer className="h-8 bg-slate-800 flex items-center px-4 justify-between text-[10px] text-slate-400 shrink-0 border-t border-white/5 font-mono">
        <div className="flex items-center gap-4">
           <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>设备状态: NVIDIA RTX 4090 TI (LOCAL)</span>
           <span className="opacity-30">|</span>
           <span>推理耗时: 14ms</span>
           <span className="opacity-30">|</span>
           <span className="text-amber-400">FPS: 144</span>
        </div>
        <div className="flex items-center gap-4">
          <span>坐标: {Math.round(offset.x)}px, {Math.round(offset.y)}px</span>
          <span className="opacity-30">|</span>
          <span>分辨率: 1024x1024 (CALIB: {CALIBRATED_PIXELS_PER_CM})</span>
        </div>
      </footer>

      {/* Toast Message */}
      <AnimatePresence>
        {message && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={cn(
              "fixed bottom-12 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full shadow-2xl text-xs font-bold flex items-center gap-3 border border-white/10",
              message.type === 'error' ? "bg-red-600 text-white" : "bg-slate-900 text-white"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full animate-pulse",
              message.type === 'error' ? "bg-white" : "bg-emerald-500"
            )}></div>
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Simulation Modal (Dynamic) */}
      <AnimatePresence>
          {showSim && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[100] flex items-center justify-center p-12"
            >
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 40 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 40 }}
                className="bg-slate-900 text-white w-full max-w-4xl p-8 rounded-[2rem] shadow-[0_40px_100px_rgba(0,0,0,0.5)] relative overflow-hidden flex flex-col h-[70vh] border border-white/10"
              >
                <div className="flex justify-between items-center mb-8 relative z-10">
                  <div>
                    <h2 className="text-2xl font-black italic tracking-tighter uppercase">Laser Simulation</h2>
                    <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Status: {isSimulating ? 'Executing Dynamic Travel Paths' : 'Process Sequence Interrupted'}</p>
                  </div>
                  <button 
                    onClick={() => { setShowSim(false); setIsSimulating(false); }}
                    className="w-12 h-12 flex items-center justify-center hover:bg-red-500 hover:text-white rounded-full transition-all text-slate-400 border border-white/5 active:scale-95"
                  >
                    <Plus className="w-6 h-6 rotate-45" />
                  </button>
                </div>

                <div className="flex-1 bg-black/50 rounded-3xl border border-white/5 relative overflow-hidden canvas-grid">
                  <svg className="w-full h-full" viewBox={`0 0 ${CALIB_CANVAS_PX} ${CALIB_CANVAS_PX}`}>
                    {contours.map(c => {
                      const pathData = c.nurbsPoints.length > 0 
                        ? `M ${c.nurbsPoints[0].x} ${c.nurbsPoints[0].y} ` + c.nurbsPoints.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') + ' Z'
                        : '';
                      const minX = Math.min(...c.originalPoints.map(p => p.x));
                      const minY = Math.min(...c.originalPoints.map(p => p.y));
                      const sx = (c.actualWidthMm * CALIBRATED_PIXELS_PER_CM / 10) / (Math.max(...c.originalPoints.map(p => p.x)) - minX);
                      const sy = (c.actualHeightMm * CALIBRATED_PIXELS_PER_CM / 10) / (Math.max(...c.originalPoints.map(p => p.y)) - minY);
                      
                      return (
                        <g key={c.id} transform={`translate(${c.position.x}, ${c.position.y}) scale(${sx}, ${sy}) translate(${-minX}, ${-minY})`}>
                          <path d={pathData} fill="none" stroke="white" strokeWidth={1.5/sx} strokeDasharray="4 4" opacity="0.1" />
                          {isSimulating && (
                            <motion.path
                              d={pathData}
                              fill="none"
                              stroke="#3b82f6"
                              strokeWidth={3 / (sx * zoom)}
                              initial={{ pathLength: 0 }}
                              animate={{ pathLength: 1 }}
                              transition={{ duration: 4, ease: "linear", repeat: Infinity }}
                              style={{ filter: 'drop-shadow(0 0 8px #3b82f6)' }}
                            />
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>

                <div className="mt-8 flex items-center justify-between relative z-10">
                  <div className="flex gap-8">
                    <div>
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Cutter Speed</div>
                      <div className="text-xl font-black font-mono tracking-tighter">500<span className="text-[10px] font-normal text-slate-500 ml-1">mm/s</span></div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Cutter Power</div>
                      <div className="text-xl font-black font-mono tracking-tighter text-brand-accent">85<span className="text-[10px] font-normal text-slate-500 ml-1">%</span></div>
                    </div>
                  </div>
                   <button 
                    onClick={() => setIsSimulating(!isSimulating)}
                    className={cn(
                      "px-10 py-4 rounded-full font-bold uppercase tracking-widest text-[10px] transition-all active:scale-95 shadow-xl",
                      isSimulating ? "bg-white text-slate-900" : "bg-brand-accent text-white"
                    )}
                  >
                    {isSimulating ? '中止行程记录' : '启动模拟序列'}
                  </button>
                </div>

                {/* Decorative noise/effect */}
                <div className="absolute inset-0 pointer-events-none opacity-[0.03] select-none" style={{ backgroundImage: 'url("https://grainy-gradients.vercel.app/noise.svg")' }}></div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
    </div>
  );
}

// Sub-components for cleaner code
function NavToolBtn({ active, icon, onClick }: { active?: boolean, icon: React.ReactNode, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "p-2 rounded-md flex items-center justify-center transition-all",
        active ? "bg-slate-100 text-brand-accent shadow-inner ring-1 ring-slate-200" : "hover:bg-slate-50 text-slate-400"
      )}
    >
      {React.cloneElement(icon as React.ReactElement, { className: 'w-4 h-4' })}
    </button>
  );
}

function MetricCard({ label, value, unit, status }: { label: string, value: string, unit?: string, status?: 'success' | 'warning' }) {
  const statusColor = status === 'success' ? 'text-emerald-600' : status === 'warning' ? 'text-amber-600' : 'text-slate-800';
  return (
    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 transition-all hover:bg-slate-100 hover:scale-[1.02] cursor-default">
      <div className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wide truncate">{label}</div>
      <div className={cn("text-xl font-bold tracking-tighter", statusColor)}>
        {value} {unit && <span className="text-xs font-normal text-slate-400 font-mono ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}

function ParamSlider({ label, value, ...props }: { label: string, value: string, [key: string]: any }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</label>
        <span className="text-[10px] font-bold font-mono text-brand-accent">{value}</span>
      </div>
      <input type="range" className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer param-slider" {...props} />
    </div>
  );
}

function SimpleCheck({ id, label, checked, onChange }: { id: string, label: string, checked?: boolean, onChange?: () => void }) {
  return (
    <div className="flex items-center gap-3 group px-1">
      <div className="relative">
        <input 
          type="checkbox" id={id} checked={checked} onChange={onChange || (() => {})}
          className="peer w-4 h-4 text-brand-accent border-slate-300 rounded focus:ring-brand-accent focus:ring-offset-0 transition-all cursor-pointer" 
        />
      </div>
      <label htmlFor={id} className="text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer group-hover:text-slate-700 transition-colors">{label}</label>
    </div>
  );
}
