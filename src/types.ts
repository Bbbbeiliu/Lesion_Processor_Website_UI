export interface QPointF {
  x: number;
  y: number;
}

export interface QRectF {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Contour {
  id: number;
  label: number;
  sourceImage: string;
  originalPoints: QPointF[];
  nurbsPoints: QPointF[];
  controlPoints: QPointF[]; // Points used for NURBS control
  position: QPointF;
  scaleX: number;
  scaleY: number;
  color: string;
  actualWidthMm: number;
  actualHeightMm: number;
  originalWidthPx: number;
  originalHeightPx: number;
  pixelScale: number; // mm/px
  isVisible: boolean;
  pageIndex: number;
  patientName?: string;
  roundness?: number;
  asymmetry?: number;
  areaMm2?: number;
  perimeterMm?: number;
}

export const PIXELS_PER_CM = 75.59; // User's calibrated value
export const CANVAS_SIZE_CM = 15;
export const CANVAS_SIZE_PX = CANVAS_SIZE_CM * PIXELS_PER_CM;
export const CONTAINER_RADIUS_CM = 7.5; // Working circle domain
