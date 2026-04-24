import { QPointF } from './types';
import simplify from 'simplify-js';

export const calculateArea = (pts: QPointF[]): number => {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
};

export const calculatePerimeter = (pts: QPointF[]): number => {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.sqrt(Math.pow(pts[i].x - pts[j].x, 2) + Math.pow(pts[i].y - pts[j].y, 2));
  }
  return p;
};

export const calculateCircularity = (area: number, perimeter: number): number => {
  if (perimeter === 0) return 0;
  return (4 * Math.PI * area) / (perimeter * perimeter);
};

export const calculateAsymmetry = (pts: QPointF[]): number => {
  if (pts.length < 3) return 0;
  const xMin = Math.min(...pts.map(p => p.x));
  const xMax = Math.max(...pts.map(p => p.x));
  const yMin = Math.min(...pts.map(p => p.y));
  const yMax = Math.max(...pts.map(p => p.y));
  
  const midX = (xMin + xMax) / 2;
  const midY = (yMin + yMax) / 2;
  
  // Simple centroid deviation as a proxy for asymmetry
  let sumX = 0, sumY = 0;
  pts.forEach(p => { sumX += p.x; sumY += p.y; });
  const centroidX = sumX / pts.length;
  const centroidY = sumY / pts.length;
  
  const deviation = Math.sqrt(Math.pow(centroidX - midX, 2) + Math.pow(centroidY - midY, 2));
  const maxDim = Math.max(xMax - xMin, yMax - yMin);
  
  return Math.min(1.0, (deviation * 2) / (maxDim || 1));
};

export const extractContoursFromMask = async (file: File, morphology?: { mode: 'dilation' | 'erosion' | 'none', kernel: number }): Promise<QPointF[][]> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject('No context');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const w = canvas.width;
      const h = canvas.height;
      
      // Basic Morphology Implementation
      if (morphology && morphology.mode !== 'none') {
        const temp = new Uint8ClampedArray(data.length);
        temp.set(data);
        const radius = Math.floor(morphology.kernel / 2);
        
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            if (data[idx+3] === 0) continue; // Skip alpha 0
            
            let found = morphology.mode === 'dilation' ? false : true;
            
            for (let ky = -radius; ky <= radius; ky++) {
              for (let kx = -radius; kx <= radius; kx++) {
                const nx = x + kx;
                const ny = y + ky;
                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                  const nIdx = (ny * w + nx) * 4;
                  const isObject = data[nIdx] > 120 || data[nIdx+1] > 120 || data[nIdx+2] > 120;
                  
                  if (morphology.mode === 'dilation') {
                    if (isObject) { found = true; break; }
                  } else { // erosion
                    if (!isObject) { found = false; break; }
                  }
                }
              }
              if (morphology.mode === 'dilation' && found) break;
              if (morphology.mode === 'erosion' && !found) break;
            }
            
            if (found) {
              temp[idx] = temp[idx+1] = temp[idx+2] = 255;
              temp[idx+3] = 255;
            } else {
              temp[idx] = temp[idx+1] = temp[idx+2] = 0;
              temp[idx+3] = 255;
            }
          }
        }
        data.set(temp);
      }

      const visited = new Uint8Array(w * h);
      const contours: QPointF[][] = [];

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const isObject = data[idx] > 120 || data[idx+1] > 120 || data[idx+2] > 120;
          
          if (data[idx+3] > 128 && isObject && !visited[y * w + x]) {
            const contour = traceBoundary(x, y, w, h, data, visited);
            if (contour.length > 30 && calculateArea(contour) > 100) { 
              contours.push(contour);
            }
          }
        }
      }
      URL.revokeObjectURL(url);
      resolve(contours);
    };
    img.onerror = () => reject('Load error');
    img.src = url;
  });
};

const traceBoundary = (startX: number, startY: number, w: number, h: number, data: Uint8ClampedArray, visited: Uint8Array): QPointF[] => {
  const points: QPointF[] = [];
  let currX = startX;
  let currY = startY;
  const dx = [0, 1, 1, 1, 0, -1, -1, -1];
  const dy = [-1, -1, 0, 1, 1, 1, 0, -1];
  let backtrackDir = 4; 
  points.push({ x: currX, y: currY });
  visited[currY * w + currX] = 1;
  for (let step = 0; step < 50000; step++) {
    let found = false;
    for (let i = 0; i < 8; i++) {
      const dir = (backtrackDir + i) % 8;
      const nx = currX + dx[dir];
      const ny = currY + dy[dir];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const nIdx = (ny * w + nx) * 4;
        if (data[nIdx+3] > 128 && (data[nIdx] > 120 || data[nIdx+1] > 120 || data[nIdx+2] > 120)) {
          currX = nx;
          currY = ny;
          points.push({ x: currX, y: currY });
          visited[currY * w + currX] = 1;
          backtrackDir = (dir + 5) % 8;
          found = true;
          break;
        }
      }
    }
    if (!found || (currX === startX && currY === startY)) break;
  }
  
  if (points.length > 0) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x !== last.x || first.y !== last.y) {
      points.push({ ...first });
    }
  }
  
  return points;
};

export const simplifyContour = (points: QPointF[], tolerance: number = 2): QPointF[] => {
  return simplify(points as any, tolerance, true) as any;
};

export const getBSplinePoints = (controlPoints: QPointF[], degree: number = 3, samples: number = 100): QPointF[] => {
  if (controlPoints.length <= degree) return controlPoints;
  
  // To make it closed, we wrap the control points
  const n = controlPoints.length;
  // Repeat first 'degree' points at the end to close the spline smoothly
  const wrappedCP = [...controlPoints, ...controlPoints.slice(0, degree)];
  const m = wrappedCP.length;
  
  const knots: number[] = [];
  // Uniform non-clamped knots for periodic spline
  for (let i = 0; i < m + degree + 1; i++) {
    knots.push(i);
  }
  
  const points: QPointF[] = [];
  const startT = degree;
  const endT = m;
  
  for (let s = 0; s < samples; s++) {
    const t = startT + (s / (samples - 1)) * (endT - startT);
    points.push(evaluateBSpline(degree, knots, wrappedCP, t));
  }
  
  // Force absolute closure at the end
  if (points.length > 0) {
    points[points.length - 1] = { ...points[0] };
  }
  
  return points;
};

const evaluateBSpline = (degree: number, knots: number[], cp: QPointF[], t: number): QPointF => {
  const n = cp.length;
  let k = degree;
  while (k < n && knots[k+1] <= t) k++;
  const points = [];
  for (let j = 0; j <= degree; j++) points.push({ ...cp[k - degree + j] });
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const alpha = (t - knots[k - degree + j]) / (knots[k + j + 1 - r] - knots[k - degree + j]);
      points[j].x = (1.0 - alpha) * points[j-1].x + alpha * points[j].x;
      points[j].y = (1.0 - alpha) * points[j-1].y + alpha * points[j].y;
    }
  }
  return points[degree];
};

const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max !== min) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else if (max === b) h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 179, s * 255, v * 255]; 
};

const PARAM_SETS = [
  { name: "Value1", h_min: 47, h_max: 122, s_min: 7, s_max: 88, v_min: 148, v_max: 255 },
  { name: "Value2", h_min: 0, h_max: 179, s_min: 0, s_max: 50, v_min: 180, v_max: 255 },
  { name: "Value3", h_min: 40, h_max: 122, s_min: 5, s_max: 88, v_min: 148, v_max: 255 },
  { name: "Value4", h_min: 38, h_max: 110, s_min: 0, s_max: 115, v_min: 169, v_max: 255 }
];

export interface CalibrationResult {
  scale: number | null;
  error?: string;
  score?: number;
}

export const detectMarkerScale = async (file: File | null): Promise<CalibrationResult> => {
  if (!file) return { scale: null, error: '未找到配套的原图文件 (_overlay)' };

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // For performance, we can process a smaller version, but for accuracy we want full res
      // But browser may struggle with very large images. Let's use a reasonable max size.
      const MAX_CALIB_DIM = 2048;
      let scaleDown = 1;
      if (img.width > MAX_CALIB_DIM || img.height > MAX_CALIB_DIM) {
        scaleDown = MAX_CALIB_DIM / Math.max(img.width, img.height);
      }
      
      canvas.width = img.width * scaleDown;
      canvas.height = img.height * scaleDown;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve({ scale: null, error: 'Canvas 初始化失败' }); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      let bestCandidate: { scale: number, score: number, circularity: number, ellipseScore: number } | null = null;
      const MIN_SCORE_THRESHOLD = 0.7;

      for (const params of PARAM_SETS) {
        const binary = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          const [h, s, v] = rgbToHsv(data[i], data[i+1], data[i+2]);
          if (h >= params.h_min && h <= params.h_max && 
              s >= params.s_min && s <= params.s_max && 
              v >= params.v_min && v <= params.v_max) {
            binary[i/4] = 255;
          }
        }

        const blobs = findMarkerBlobs(binary, canvas.width, canvas.height);
        for (const blob of blobs) {
          const circularity = 4 * Math.PI * blob.area / (blob.perimeter * blob.perimeter);
          const ellipseScore = 1 / (1 + Math.abs(blob.aspectRatio - 1));
          
          // Python-like scoring (weighted features: circularity + ellipse ratio)
          const score = circularity * 0.5 + ellipseScore * 0.5;

          // Scaled min area: Python used 5000 on full res. 
          // We adjust based on scaleDown and a minimum of 150 for noise removal.
          const pythonMinArea = 5000 * (scaleDown ** 2);
          const effectiveMinArea = Math.max(150, pythonMinArea * 0.2); // Be more lenient than Python for initial detection

          if (circularity > 0.55 && blob.area > effectiveMinArea) {
            const pixelDiameter = Math.sqrt(blob.area / Math.PI) * 2 / scaleDown;
            const currentScale = 10 / pixelDiameter;

            if (!bestCandidate || score > bestCandidate.score) {
              bestCandidate = { scale: currentScale, score, circularity, ellipseScore };
            }
          }
        }
        // Very high confidence threshold to stop early
        if (bestCandidate && bestCandidate.score > 0.95) break; 
      }
      
      URL.revokeObjectURL(url);
      if (bestCandidate) {
        if (bestCandidate.score >= MIN_SCORE_THRESHOLD) {
          resolve({ scale: bestCandidate.scale, score: bestCandidate.score });
        } else {
          resolve({ 
            scale: null, 
            error: `识别评分不足: ${bestCandidate.score.toFixed(3)} (要求 >= ${MIN_SCORE_THRESHOLD})。圆度=${bestCandidate.circularity.toFixed(3)}, 椭圆度=${bestCandidate.ellipseScore.toFixed(3)}。`,
            score: bestCandidate.score
          });
        }
      } else {
        resolve({ scale: null, error: 'HSV算法未在图中检索到符合条件的圆形物体，请检查标志物是否被遮挡或光照异常。' });
      }
    };
    img.onerror = () => resolve({ scale: null, error: '原图资源加载失败或跨域限制' });
    img.src = url;
  });
};

const findMarkerBlobs = (binary: Uint8Array, w: number, h: number) => {
  const visited = new Uint8Array(w * h);
  const blobs = [];
  
  // Finer scan for better precision on small markers
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (binary[y * w + x] === 255 && !visited[y * w + x]) {
        let area = 0;
        let boundaryPoints = 0;
        let minX = x, maxX = x, minY = y, maxY = y;
        const stack: [number, number][] = [[x, y]];
        
        while (stack.length > 0) {
          const [cx, cy] = stack.pop()!;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h || visited[cy * w + cx] || binary[cy * w + cx] === 0) continue;
          
          visited[cy * w + cx] = 1;
          area++;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          
          let isBoundary = false;
          const neighbors = [[cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]];
          for(const [nx, ny] of neighbors) {
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) { isBoundary = true; break; }
            if (binary[ny * w + nx] === 0) { isBoundary = true; break; }
          }
          if (isBoundary) boundaryPoints++;
          
          stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        
        if (area > 100) {
          const width = maxX - minX + 1;
          const height = maxY - minY + 1;
          // Perimeter approximation: boundaryPoints is a common proxy for pixel-based perimeter
          const perimeter = boundaryPoints; 
          blobs.push({ area, perimeter, aspectRatio: width / height });
        }
      }
    }
  }
  return blobs;
};

export const findBestLabelPosition = (pts: QPointF[], fontSizePx: number): { pos: QPointF, scaleHint: number } | null => {
  if (pts.length < 3) return null;
  const xMin = Math.min(...pts.map(p => p.x));
  const xMax = Math.max(...pts.map(p => p.x));
  const yMin = Math.min(...pts.map(p => p.y));
  const yMax = Math.max(...pts.map(p => p.y));
  
  // Use a relative threshold for "small" contours based on bounding box
  const bboxWidth = xMax - xMin;
  const bboxHeight = yMax - yMin;
  if (bboxWidth < fontSizePx * 0.8 || bboxHeight < fontSizePx * 0.8) return null;

  const step = Math.max(1, fontSizePx * 0.3); // Finer step for accuracy
  
  let bestPoint = null;
  let bestScore = -1;
  let bestVDist = 0;
  
  for (let x = xMin; x <= xMax; x += step) {
    const vIntersections: number[] = [];
    for (let j = 0; j < pts.length; j++) {
      const p1 = pts[j];
      const p2 = pts[(j + 1) % pts.length];
      if ((p1.x <= x && x <= p2.x) || (p2.x <= x && x <= p1.x)) {
        if (Math.abs(p1.x - p2.x) < 0.0001) continue;
        const t = (x - p1.x) / (p2.x - p1.x);
        vIntersections.push(p1.y + t * (p2.y - p1.y));
      }
    }
    
    vIntersections.sort((a, b) => a - b);
    
    for (let k = 0; k < vIntersections.length - 1; k += 2) {
      const y1 = vIntersections[k];
      const y2 = vIntersections[k + 1];
      const distY = y2 - y1;
      
      if (distY >= fontSizePx) {
        const yMid = (y1 + y2) / 2;
        
        // Horizontal check at yMid
        const hIntersections: number[] = [];
        for (let j = 0; j < pts.length; j++) {
          const p1 = pts[j];
          const p2 = pts[(j + 1) % pts.length];
          if ((p1.y <= yMid && yMid <= p2.y) || (p2.y <= yMid && yMid <= p1.y)) {
            if (Math.abs(p1.y - p2.y) < 0.0001) continue;
            const t = (yMid - p1.y) / (p2.y - p1.y);
            hIntersections.push(p1.x + t * (p2.x - p1.x));
          }
        }
        
        hIntersections.sort((a, b) => a - b);
        
        for (let m = 0; m < hIntersections.length - 1; m += 2) {
          const x1 = hIntersections[m];
          const x2 = hIntersections[m + 1];
          
          if (x >= x1 && x <= x2) {
            const distX = x2 - x1;
            if (distX >= fontSizePx) {
              // Priority: score based on the smaller dimension available at this point
              // This favors points where we have most room horizontally AND vertically
              const score = Math.min(distY, distX);
              if (score > bestScore) {
                bestScore = score;
                bestPoint = { x, y: yMid };
                bestVDist = distY;
              }
            }
            break;
          }
        }
      }
    }
  }
  
  return bestPoint ? { pos: bestPoint, scaleHint: bestVDist } : null;
};
