export type CursorEvent = {
  frame: number;
  x: number;
  y: number;
  travel?: number;
  click?: boolean;
};

export type Mark = {
  frame: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type ShotMeta = {
  width: number;
  height: number;
  fps: number;
  frames: number;
  cursor: CursorEvent[];
  marks: Record<string, Mark>;
};

export type ZoomKey = {
  frame: number;
  cx: number;
  cy: number;
  scale: number;
};

export type Ring = {
  mark: string;
  from: number;
  to: number;
};

const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const zoomAt = (frame: number, keys: ZoomKey[]) => {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (frame <= first.frame) {
    return first;
  }
  if (frame >= last.frame) {
    return last;
  }
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1].frame < frame) {
    index++;
  }
  const from = keys[index];
  const to = keys[index + 1];
  const t = ease((frame - from.frame) / (to.frame - from.frame));
  return {
    frame,
    cx: from.cx + (to.cx - from.cx) * t,
    cy: from.cy + (to.cy - from.cy) * t,
    scale: from.scale + (to.scale - from.scale) * t,
  };
};

// Keeps the camera inside the footage, so no grey band shows past its edge.
export const clampView = (view: ZoomKey, meta: ShotMeta): ZoomKey => {
  const halfWidth = meta.width / 2 / view.scale;
  const halfHeight = meta.height / 2 / view.scale;
  return {
    ...view,
    cx: Math.min(Math.max(view.cx, halfWidth), meta.width - halfWidth),
    cy: Math.min(Math.max(view.cy, halfHeight), meta.height - halfHeight),
  };
};

// The top-right corner of a job: the Actions button, its menu, and the Print
// step field the menu changes, all in one picture above the caption.
export const actionsView = (frame: number): ZoomKey => ({
  frame,
  cx: 1140,
  cy: 259,
  scale: 1.74,
});

export const focus = (mark: Mark, scale: number, frame: number): ZoomKey => ({
  frame,
  cx: (mark.x ?? 0) + (mark.width ?? 0) / 2,
  cy: (mark.y ?? 0) + (mark.height ?? 0) / 2,
  scale,
});

export const cursorAt = (meta: ShotMeta, sourceFrame: number) => {
  const events = meta.cursor;
  if (events.length === 0 || sourceFrame < events[0].frame) {
    return null;
  }
  let x = meta.width - 48;
  let y = meta.height - 48;
  let clickAge = -1;
  for (const event of events) {
    if (event.travel) {
      const end = event.frame + event.travel;
      if (sourceFrame >= end) {
        x = event.x;
        y = event.y;
        continue;
      }
      if (sourceFrame >= event.frame) {
        const t = ease((sourceFrame - event.frame) / event.travel);
        return {
          x: x + (event.x - x) * t,
          y: y + (event.y - y) * t,
          clickAge,
        };
      }
      return { x, y, clickAge };
    }
    if (event.click && sourceFrame >= event.frame) {
      x = event.x;
      y = event.y;
      clickAge = sourceFrame - event.frame;
    }
  }
  return { x, y, clickAge };
};
