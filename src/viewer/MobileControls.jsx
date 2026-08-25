import { useCallback, useEffect, useRef, useState } from 'react';
import './MobileControls.css';

const LOOK_SENSITIVITY = 0.0042;
const JOYSTICK_RADIUS = 56;
const DEADZONE = 0.12;

export function useTouchLayout() {
  const [active, setActive] = useState(false);
  const [orientation, setOrientation] = useState('landscape');

  useEffect(() => {
    const update = () => {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const noHover = window.matchMedia('(hover: none)').matches;
      const narrow = window.matchMedia('(max-width: 1024px)').matches;
      const touch = navigator.maxTouchPoints > 0;
      setActive((coarse && noHover) || (touch && narrow));

      const landscape = window.matchMedia('(orientation: landscape)').matches
        || window.innerWidth > window.innerHeight;
      setOrientation(landscape ? 'landscape' : 'portrait');
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return { isTouch: active, orientation };
}

async function enterImmersive() {
  const root = document.documentElement;
  try {
    if (!document.fullscreenElement && root.requestFullscreen) {
      await root.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    // Fullscreen can be denied; CSS still covers the viewport.
  }
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Orientation lock is optional (Safari / insecure contexts).
  }
}

/**
 * Minecraft Pocket Edition–style HUD:
 * left analog stick (floating origin), right-side look drag, jump / sneak / sprint.
 */
export function MobileControls({ spectatorRef, visible, orientation, onOpenMenu }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [stickActive, setStickActive] = useState(false);
  const [stickAnchor, setStickAnchor] = useState(null);
  const [showRotateHint, setShowRotateHint] = useState(true);
  const lookId = useRef(null);
  const lookLast = useRef({ x: 0, y: 0 });
  const stickId = useRef(null);
  const stickOrigin = useRef({ x: 0, y: 0 });

  const controls = () => spectatorRef?.current;

  const setAnalog = useCallback((x, y) => {
    controls()?.setAnalogMove?.(x, y);
  }, [spectatorRef]);

  useEffect(() => {
    return () => {
      controls()?.setAnalogMove?.(0, 0);
      controls()?.setAction?.('up', false);
      controls()?.setAction?.('down', false);
      controls()?.setAction?.('sprint', false);
    };
  }, [spectatorRef]);

  const updateStick = (clientX, clientY) => {
    let dx = clientX - stickOrigin.current.x;
    let dy = clientY - stickOrigin.current.y;
    const mag = Math.hypot(dx, dy);
    if (mag > JOYSTICK_RADIUS) {
      dx = (dx / mag) * JOYSTICK_RADIUS;
      dy = (dy / mag) * JOYSTICK_RADIUS;
    }
    setKnob({ x: dx, y: dy });
    const ax = dx / JOYSTICK_RADIUS;
    const ay = -dy / JOYSTICK_RADIUS;
    const len = Math.hypot(ax, ay);
    if (len < DEADZONE) {
      setAnalog(0, 0);
    } else {
      setAnalog(ax, ay);
    }
  };

  const onStickDown = (event) => {
    if (stickId.current !== null) return;
    if (event.target.closest('.mobile-hud-button, .mobile-hud-top')) return;
    event.preventDefault();
    event.stopPropagation();
    enterImmersive();
    stickId.current = event.pointerId;
    const zone = event.currentTarget.getBoundingClientRect();
    const pad = 64;
    const originX = Math.min(Math.max(event.clientX, zone.left + pad), zone.right - pad);
    const originY = Math.min(Math.max(event.clientY, zone.top + pad), zone.bottom - pad);
    stickOrigin.current = { x: originX, y: originY };
    setStickAnchor({ x: originX, y: originY });
    setStickActive(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic / already captured */ }
    updateStick(event.clientX, event.clientY);
  };

  const onStickMove = (event) => {
    if (event.pointerId !== stickId.current) return;
    event.preventDefault();
    updateStick(event.clientX, event.clientY);
  };

  const onStickUp = (event) => {
    if (event.pointerId !== stickId.current) return;
    stickId.current = null;
    setStickActive(false);
    setStickAnchor(null);
    setKnob({ x: 0, y: 0 });
    setAnalog(0, 0);
  };

  const onLookDown = (event) => {
    if (lookId.current !== null) return;
    if (event.target.closest('.mobile-hud-button, .mobile-hud-top, .mobile-rotate-hint')) return;
    event.preventDefault();
    enterImmersive();
    lookId.current = event.pointerId;
    lookLast.current = { x: event.clientX, y: event.clientY };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic / already captured */ }
  };

  const onLookMove = (event) => {
    if (event.pointerId !== lookId.current) return;
    event.preventDefault();
    const dx = event.clientX - lookLast.current.x;
    const dy = event.clientY - lookLast.current.y;
    lookLast.current = { x: event.clientX, y: event.clientY };
    controls()?.look?.(dx, dy, LOOK_SENSITIVITY);
  };

  const onLookUp = (event) => {
    if (event.pointerId !== lookId.current) return;
    lookId.current = null;
  };

  const hold = (action) => ({
    onPointerDown: (event) => {
      event.preventDefault();
      event.stopPropagation();
      controls()?.setAction?.(action, true);
      enterImmersive();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic / already captured */ }
    },
    onPointerUp: () => controls()?.setAction?.(action, false),
    onPointerCancel: () => controls()?.setAction?.(action, false),
  });

  if (!visible) return null;

  return (
    <div className={`mobile-hud ${orientation}`}>
      <div className="mobile-crosshair" aria-hidden="true" />

      <div className="mobile-hud-top">
        <button
          type="button"
          className="mobile-hud-button mobile-hud-button--small"
          onPointerDown={(e) => {
            e.stopPropagation();
            enterImmersive();
          }}
          onClick={(e) => {
            e.stopPropagation();
            enterImmersive();
          }}
          aria-label="Fullscreen"
        >
          ⛶
        </button>
        <button
          type="button"
          className="mobile-hud-button mobile-hud-button--small"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu?.();
          }}
          aria-label="Menu"
        >
          ☰
        </button>
      </div>

      {orientation === 'portrait' && showRotateHint && (
        <div className="mobile-rotate-hint">
          <p>Rotate your device for a fullscreen Pocket Edition view</p>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setShowRotateHint(false);
              enterImmersive();
            }}
          >
            Continue in portrait
          </button>
        </div>
      )}

      <div
        className="mobile-move-zone"
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      />

      <div
        className="mobile-look-zone"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      <div
        className={`mobile-joystick ${stickActive ? 'active' : ''}`}
        style={stickAnchor ? {
          left: stickAnchor.x,
          top: stickAnchor.y,
          bottom: 'auto',
          transform: 'translate(-50%, -50%)',
        } : undefined}
        aria-hidden="true"
      >
        <div className="mobile-joystick-base">
          <div
            className="mobile-joystick-knob"
            style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
          />
        </div>
      </div>

      <div className="mobile-actions">
        <button type="button" className="mobile-hud-button mobile-sprint" {...hold('sprint')}>
          Sprint
        </button>
        <div className="mobile-actions-row">
          <button type="button" className="mobile-hud-button mobile-sneak" {...hold('down')}>
            Sneak
          </button>
          <button type="button" className="mobile-hud-button mobile-jump" {...hold('up')}>
            Jump
          </button>
        </div>
      </div>
    </div>
  );
}
