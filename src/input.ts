import { activeTouchPointers, drawingPointerId, setDrawingPointerId, isDrawing, setIsDrawing, viewScale, viewOffsetX, viewOffsetY, viewRotation, setViewScale, setViewOffsetX, setViewOffsetY, setViewRotation, initialPinchDistance, initialPinchAngle, initialViewScale, initialViewRotation, initialPinchCenter, initialViewOffset, setInitialPinchDistance, setInitialPinchAngle, setInitialViewScale, setInitialViewRotation, setInitialPinchCenter, setInitialViewOffset, tapRecords, setTapRecords, TAP_MAX_DURATION, TAP_MAX_DISTANCE } from './state';
import { container } from './dom';
import { getCanvasPoint, smootherReset, smootherProcessPoint } from './drawing';
import { saveUndoState, performUndo, performRedo } from './undo';
import { updateViewTransform } from './canvas';
import { getActiveLayer } from './layers';

// ===================================================================
// Tap Detection (2-finger undo, 3-finger redo)
// ===================================================================
function addTapRecord(e: PointerEvent) {
  if (drawingPointerId !== null) return;
  tapRecords.push({
    pointerId: e.pointerId,
    startTime: performance.now(),
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  });
}

function updateTapRecord(e: PointerEvent) {
  const rec = tapRecords.find(r => r.pointerId === e.pointerId);
  if (!rec) return;
  const dx = e.clientX - rec.startX;
  const dy = e.clientY - rec.startY;
  if (dx * dx + dy * dy > TAP_MAX_DISTANCE * TAP_MAX_DISTANCE) {
    rec.moved = true;
  }
}

function checkTapOnAllUp(): number | null {
  const now = performance.now();
  const count = tapRecords.length;
  if (count < 2) { setTapRecords([]); return null; }

  const allQuick = tapRecords.every(r => (now - r.startTime) < TAP_MAX_DURATION);
  const noneMoved = tapRecords.every(r => !r.moved);

  setTapRecords([]);

  if (allQuick && noneMoved) {
    return count;
  }
  return null;
}

// ===================================================================
// Gestures (Pan / Zoom)
// ===================================================================
function getPointers() {
  return Array.from(activeTouchPointers.values());
}

function initGesture() {
  const pts = getPointers();
  if (pts.length < 2) return;

  const p1 = pts[0];
  const p2 = pts[1];

  const dx = p2.clientX - p1.clientX;
  const dy = p2.clientY - p1.clientY;
  setInitialPinchDistance(Math.hypot(dx, dy));
  setInitialPinchAngle(Math.atan2(dy, dx));
  setInitialViewScale(viewScale);
  setInitialViewRotation(viewRotation);

  const rect = container.getBoundingClientRect();
  setInitialPinchCenter({
    x: (p1.clientX + p2.clientX) / 2 - rect.left,
    y: (p1.clientY + p2.clientY) / 2 - rect.top,
  });

  setInitialViewOffset({ x: viewOffsetX, y: viewOffsetY });
}

function handleGesture() {
  const pts = getPointers();
  if (pts.length < 2 || !initialPinchDistance || !initialPinchCenter || !initialViewOffset || initialPinchAngle === null) return;

  const p1 = pts[0];
  const p2 = pts[1];

  const dx = p2.clientX - p1.clientX;
  const dy = p2.clientY - p1.clientY;
  const currentDistance = Math.hypot(dx, dy);
  const currentAngle = Math.atan2(dy, dx);

  let newScale = initialViewScale * (currentDistance / initialPinchDistance);
  newScale = Math.max(0.1, Math.min(newScale, 10));

  let newRotation = initialViewRotation + (currentAngle - initialPinchAngle);

  const rect = container.getBoundingClientRect();
  const currentCenter = {
    x: (p1.clientX + p2.clientX) / 2 - rect.left,
    y: (p1.clientY + p2.clientY) / 2 - rect.top,
  };

  const vX = initialPinchCenter.x - initialViewOffset.x;
  const vY = initialPinchCenter.y - initialViewOffset.y;

  const deltaAngle = newRotation - initialViewRotation;
  const cos = Math.cos(deltaAngle);
  const sin = Math.sin(deltaAngle);

  const rotatedVX = vX * cos - vY * sin;
  const rotatedVY = vX * sin + vY * cos;

  const scaleRatio = newScale / initialViewScale;
  const scaledVX = rotatedVX * scaleRatio;
  const scaledVY = rotatedVY * scaleRatio;

  setViewOffsetX(currentCenter.x - scaledVX);
  setViewOffsetY(currentCenter.y - scaledVY);
  setViewScale(newScale);
  setViewRotation(newRotation);

  updateViewTransform();
}

function handlePointerUp(e: PointerEvent) {
  if (e.pointerType === 'touch') {
    activeTouchPointers.delete(e.pointerId);
    try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }

    if (drawingPointerId === null && activeTouchPointers.size === 0) {
      const fingerCount = checkTapOnAllUp();
      if (fingerCount === 2) {
        performUndo();
      } else if (fingerCount !== null && fingerCount >= 3) {
        performRedo();
      }
    }
  } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    if (drawingPointerId === e.pointerId) {
      try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      setDrawingPointerId(null);
      setTapRecords([]);
      if (isDrawing) {
        setIsDrawing(false);
        smootherReset();
      }
    }
  }
}

export function initInputListeners() {
  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      activeTouchPointers.set(e.pointerId, e);
      addTapRecord(e);

      if (drawingPointerId === null) {
        if (activeTouchPointers.size === 2) {
          initGesture();
        }
      }
    } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      if (drawingPointerId === null) {
        setDrawingPointerId(e.pointerId);
        container.setPointerCapture(e.pointerId);

        setTapRecords([]);

        const layer = getActiveLayer();
        if (layer) saveUndoState(layer.id);
        setIsDrawing(true);
        smootherReset();
        smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
      }
    }
  });

  container.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (activeTouchPointers.has(e.pointerId)) {
        activeTouchPointers.set(e.pointerId, e);
      }
      updateTapRecord(e);

      if (drawingPointerId === null) {
        if (activeTouchPointers.size >= 2) {
          handleGesture();
        }
      }
    } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      if (drawingPointerId === e.pointerId && isDrawing) {
        smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
      }
    }
  });

  container.addEventListener('pointerup', handlePointerUp);
  container.addEventListener('pointercancel', handlePointerUp);

  // Wheel support for desktop
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const zoomSpeed = 0.01;
      const oldScale = viewScale;
      setViewScale(Math.max(0.1, Math.min(viewScale - e.deltaY * zoomSpeed, 10)));

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      setViewOffsetX(mouseX - (mouseX - viewOffsetX) * (viewScale / oldScale));
      setViewOffsetY(mouseY - (mouseY - viewOffsetY) * (viewScale / oldScale));
    } else {
      setViewOffsetX(viewOffsetX - e.deltaX);
      setViewOffsetY(viewOffsetY - e.deltaY);
    }
    updateViewTransform();
  }, { passive: false });

  // Keyboard undo/redo for desktop
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        performRedo();
      } else {
        performUndo();
      }
    }
  });
}
