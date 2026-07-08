import type { Layer, Point, UndoEntry, TapRecord } from './types';

// Tool state
export let currentTool: 'pen' | 'eraser' = 'pen';
export let currentSize = 5;
export let currentColor = '#000000';
export let currentCanvasId: string | null = null;

export function setCurrentTool(t: 'pen' | 'eraser') { currentTool = t; }
export function setCurrentSize(s: number) { currentSize = s; }
export function setCurrentColor(c: string) { currentColor = c; }
export function setCurrentCanvasId(id: string | null) { currentCanvasId = id; }

// StrokeSmoother parameters
export const positionSmoothing = 0.07;
export let lazyRadius = 30;
export function setLazyRadius(r: number) { lazyRadius = r; }

// View state
export let viewScale = 1;
export let viewOffsetX = 0;
export let viewOffsetY = 0;
export let viewRotation = 0;
export function setViewScale(s: number) { viewScale = s; }
export function setViewOffsetX(x: number) { viewOffsetX = x; }
export function setViewOffsetY(y: number) { viewOffsetY = y; }
export function setViewRotation(r: number) { viewRotation = r; }

// Canvas dimensions
export let canvasLogicalW = 1024;
export let canvasLogicalH = 768;
export function setCanvasLogicalW(w: number) { canvasLogicalW = w; }
export function setCanvasLogicalH(h: number) { canvasLogicalH = h; }

// Drawing state
export let isDrawing = false;
export const activeTouchPointers: Map<number, PointerEvent> = new Map();
export let drawingPointerId: number | null = null;
export function setIsDrawing(d: boolean) { isDrawing = d; }
export function setDrawingPointerId(id: number | null) { drawingPointerId = id; }

// StrokeSmoother state
export let anchorPoint: Point | null = null;
export let lastInputPoint: Point | null = null;
export let lastRenderPos: Point | null = null;
export let lastInputTime = 0;
export function setAnchorPoint(p: Point | null) { anchorPoint = p; }
export function setLastInputPoint(p: Point | null) { lastInputPoint = p; }
export function setLastRenderPos(p: Point | null) { lastRenderPos = p; }
export function setLastInputTime(t: number) { lastInputTime = t; }

// Gesture state
export let initialPinchDistance: number | null = null;
export let initialPinchAngle: number | null = null;
export let initialViewScale = 1;
export let initialViewRotation = 0;
export let initialPinchCenter: Point | null = null;
export let initialViewOffset: Point | null = null;
export function setInitialPinchDistance(d: number | null) { initialPinchDistance = d; }
export function setInitialPinchAngle(a: number | null) { initialPinchAngle = a; }
export function setInitialViewScale(s: number) { initialViewScale = s; }
export function setInitialViewRotation(r: number) { initialViewRotation = r; }
export function setInitialPinchCenter(p: Point | null) { initialPinchCenter = p; }
export function setInitialViewOffset(p: Point | null) { initialViewOffset = p; }

// Tap detection state
export let tapRecords: TapRecord[] = [];
export const TAP_MAX_DURATION = 300;
export const TAP_MAX_DISTANCE = 15;
export function setTapRecords(r: TapRecord[]) { tapRecords = r; }

// Layer state
export let layers: Layer[] = [];
export let activeLayerId = -1;
export let nextLayerId = 0;
export function setLayers(l: Layer[]) { layers = l; }
export function setActiveLayerId(id: number) { activeLayerId = id; }
export function setNextLayerId(id: number) { nextLayerId = id; }

// Undo/Redo stacks
export const undoStack: UndoEntry[] = [];
export const redoStack: UndoEntry[] = [];
export const MAX_UNDO = 50;

// Group canvas for clipping compositing
export let groupCanvas: HTMLCanvasElement | null = null;
export let groupCtx: CanvasRenderingContext2D | null = null;
export function setGroupCanvas(c: HTMLCanvasElement | null) { groupCanvas = c; }
export function setGroupCtx(ctx: CanvasRenderingContext2D | null) { groupCtx = ctx; }
