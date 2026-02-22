import { useEffect, useRef } from "react";

interface Props {
  imageSrc: string;
}

/**
 * RGB split parallax hero.
 *
 * Layer structure (per channel):
 *   .rgb-layer          — mix-blend-mode: screen  (toward siblings)
 *     .img-wrap         — background-image (the photo)
 *     .mask             — mix-blend-mode: multiply (tints to one channel)
 *
 * isolation: isolate on .rgb-layer keeps the mask's multiply LOCAL
 * (composites against .img-wrap only), then the whole layer is
 * screen-blended outward.
 *
 * Mouse/tilt shifts R opposite to cursor, B follows cursor, G is anchor.
 */
export default function RGBSplit({ imageSrc }: Props) {
  const rRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const rafId = useRef<number>(0);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      target.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 28,
        y: (e.clientY / window.innerHeight - 0.5) * 28,
      };
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      target.current = {
        x: ((e.gamma ?? 0) / 45) * 14,
        y: (((e.beta ?? 45) - 45) / 45) * 14,
      };
    };

    const tick = () => {
      const c = current.current;
      const t = target.current;
      c.x += (t.x - c.x) * 0.07;
      c.y += (t.y - c.y) * 0.07;

      if (rRef.current) {
        rRef.current.style.transform = `translate(${-c.x}px, ${-c.y}px)`;
      }
      if (bRef.current) {
        bRef.current.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }

      rafId.current = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMouse);
    window.addEventListener("deviceorientation", onOrientation);
    rafId.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("deviceorientation", onOrientation);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  const bg = { backgroundImage: `url(${imageSrc})` };

  return (
    <div className="rgb-hero">
      {/* R — moves opposite to cursor */}
      <div className="rgb-layer" ref={rRef}>
        <div className="img-wrap" style={bg} />
        <div className="mask" style={{ background: "#f00" }} />
      </div>

      {/* G — anchor, no movement */}
      <div className="rgb-layer">
        <div className="img-wrap" style={bg} />
        <div className="mask" style={{ background: "#0f0" }} />
      </div>

      {/* B — follows cursor */}
      <div className="rgb-layer" ref={bRef}>
        <div className="img-wrap" style={bg} />
        <div className="mask" style={{ background: "#00f" }} />
      </div>
    </div>
  );
}
