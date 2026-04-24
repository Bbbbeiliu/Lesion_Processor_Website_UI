import Drawing from 'dxf-writer';
import { Contour, PIXELS_PER_CM } from './types';

export const exportToDXF = (contours: Contour[]): string => {
  const d = new Drawing();
  
  // Overall scale factor requested in Python code: 1/2.3
  const SCALE_FACTOR = 1.0 / 2.3;
  
  contours.forEach(c => {
    // Convert canvas points to mm
    // Canvas is in pixels. 
    // pixels_per_cm = 75.59 (user's setting)
    // 1 cm = 10 mm
    
    const points = c.nurbsPoints.map(p => {
      // Relative to original bounding box minX/minY
      const minX = Math.min(...c.originalPoints.map(p => p.x));
      const minY = Math.min(...c.originalPoints.map(p => p.y));
      const maxX = Math.max(...c.originalPoints.map(p => p.x));
      const maxY = Math.max(...c.originalPoints.map(p => p.y));
      const origW = maxX - minX;
      const origH = maxY - minY;

      const targetW = c.actualWidthMm * PIXELS_PER_CM / 10;
      const targetH = c.actualHeightMm * PIXELS_PER_CM / 10;
      
      const sx = targetW / origW;
      const sy = targetH / origH;

      // Position in canvas pixels
      const xPx = c.position.x + (p.x - minX) * sx;
      const yPx = c.position.y + (p.y - minY) * sy;
      
      // Convert to mm
      const xMm = (xPx * 10 / PIXELS_PER_CM) * SCALE_FACTOR;
      const yMm = (yPx * 10 / PIXELS_PER_CM) * SCALE_FACTOR;
      
      // Invert Y as done in Python (150 is the canvas size in mm)
      const flipYM = (150 * SCALE_FACTOR) - yMm;
      
      return [xMm, flipYM] as [number, number];
    });

    if (points.length > 1) {
      d.drawPolyline(points, true);
    }
    
    // Add label text
    // (Simplified placement logic)
    const centerX = points[0][0];
    const centerY = points[0][1];
    d.drawText(centerX, centerY, 3 * SCALE_FACTOR, 0, c.label.toString());
  });

  return d.toDxfString();
};

export const downloadBlob = (content: string, filename: string, contentType: string) => {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
