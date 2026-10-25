const handle = document.getElementById('handle');
let openTimer = null;
let dragging = false;
let last = null;
let queuedPoint = null;
let moveFrame = 0;

function desktopPoint(event) {
  return { x: event.screenX, y: event.screenY, scaleFactor: window.devicePixelRatio || 1 };
}

function setEdge(edge) {
  handle.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');
  handle.classList.add(`edge-${edge}`);
}

function scheduleOpen() {
  if (dragging) return;
  clearTimeout(openTimer);
  handle.classList.add('near');
  openTimer = setTimeout(() => window.nooknote.openPanel(), 150);
}

handle.addEventListener('pointerenter', scheduleOpen);
handle.addEventListener('pointerleave', () => {
  clearTimeout(openTimer);
  handle.classList.remove('near');
  window.nooknote.triggerLeft();
});

handle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  clearTimeout(openTimer);
  handle.classList.remove('near');
  dragging = true;
  last = { x: event.screenX, y: event.screenY, time: performance.now(), angle: null };
  handle.classList.add('dragging');
  handle.setPointerCapture(event.pointerId);
  window.nooknote.startDrag();
});

handle.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const now = performance.now();
  const dx = event.screenX - last.x;
  const dy = event.screenY - last.y;
  const distance = Math.hypot(dx, dy);
  const angle = distance > 1.25 ? Math.atan2(dy, dx) * 180 / Math.PI : last.angle;
  if (angle !== null) {
    const turn = last.angle === null ? 0 : ((angle - last.angle + 540) % 360) - 180;
    const speed = Math.min(1, Math.max(0, (distance / Math.max(1, now - last.time)) / 1.1));
    handle.style.setProperty('--drag-rotation', `${angle + 45 + Math.min(11, Math.max(-11, turn * .2))}deg`);
    handle.style.setProperty('--blob-scale-x', `${1 - speed * .08}`);
    handle.style.setProperty('--blob-scale-y', `${1 + speed * .2}`);
  }
  last = { x: event.screenX, y: event.screenY, time: now, angle: angle === null ? last.angle : angle };
  queuedPoint = desktopPoint(event);
  if (!moveFrame) {
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      if (queuedPoint) window.nooknote.dragTo(queuedPoint);
    });
  }
});

handle.addEventListener('pointerup', async (event) => {
  if (!dragging) return;
  dragging = false;
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  const finalPosition = await window.nooknote.finishDrag(desktopPoint(event));
  handle.classList.remove('dragging');
  handle.style.removeProperty('--drag-rotation');
  handle.style.removeProperty('--blob-scale-x');
  handle.style.removeProperty('--blob-scale-y');
  setEdge(finalPosition.edge);
  last = null;
});

window.nooknote.getPosition().then((position) => setEdge(position.edge));
window.nooknote.onPositionChanged((position) => setEdge(position.edge));
