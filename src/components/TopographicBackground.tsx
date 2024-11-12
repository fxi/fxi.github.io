import React, { useEffect, useRef } from 'react';

class PerlinNoise {
  private permutation: number[];
  private p: number[];

  constructor() {
    this.permutation = new Array(256).fill(0).map((_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.permutation[i], this.permutation[j]] = [this.permutation[j], this.permutation[i]];
    }
    this.p = [...this.permutation, ...this.permutation];
  }

  fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  grad(hash: number, x: number, y: number): number {
    const h = hash & 15;
    const gradX = h < 8 ? x : y;
    const gradY = h < 4 ? y : x;
    return ((h & 1) ? -gradX : gradX) + ((h & 2) ? -gradY : gradY);
  }

  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    x -= Math.floor(x);
    y -= Math.floor(y);

    const u = this.fade(x);
    const v = this.fade(y);

    const A = this.p[X] + Y;
    const B = this.p[X + 1] + Y;

    return this.lerp(v,
                     this.lerp(u,
                               this.grad(this.p[A], x, y),
                               this.grad(this.p[B], x - 1, y)
                              ),
                              this.lerp(u,
                                        this.grad(this.p[A + 1], x, y - 1),
                                        this.grad(this.p[B + 1], x - 1, y - 1)
                                       )
                    );
  }
}

interface Props {
  className?: string;
}

const TopographicBackground: React.FC<Props> = ({ className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    class TopographicMap {
      constructor(container) {
        this.container = container;
        this.baseResolution = 500;  // Base resolution for reference
        this.desiredCellSize = 10; // Desired size of each cell in pixels
        this.perlin = new PerlinNoise();
        this.mouseX = -1;
        this.mouseY = -1;
        this.influence = 200;
        this.levels = 40;
        this.animationFrameId = null;
        this.pendingUpdate = false;

        this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        container.appendChild(this.svg);

        this.updateDimensions();
        this.heightMap = this.generateHeightMap();
        this.bindEvents();
        this.draw();
      }

      updateDimensions() {
        const rect = this.container.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

        // Calculate resolution based on container size and desired cell size
        this.resolutionX = Math.ceil(this.width / this.desiredCellSize);
        this.resolutionY = Math.ceil(this.height / this.desiredCellSize);

        // Update actual cell size to maintain even distribution
        this.cellSizeX = this.width / this.resolutionX;
        this.cellSizeY = this.height / this.resolutionY;

        this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
      }

      generateHeightMap() {
        const map = new Array(this.resolutionY + 1).fill(0)
        .map(() => new Array(this.resolutionX + 1).fill(0));

        let minVal = Infinity;
        let maxVal = -Infinity;

        // Generate initial height values
        for (let y = 0; y <= this.resolutionY; y++) {
          for (let x = 0; x <= this.resolutionX; x++) {
            let value = 0;
            let amplitude = 1;
            let frequency = 1;

            // Scale coordinates to maintain consistent feature size
            const scaleX = (x / this.resolutionX) * (this.resolutionX / this.baseResolution);
            const scaleY = (y / this.resolutionY) * (this.resolutionY / this.baseResolution);

            for (let i = 0; i < 4; i++) {
              const nx = scaleX * 4 * frequency;
              const ny = scaleY * 4 * frequency;
              value += this.perlin.noise(nx, ny) * amplitude;
              amplitude *= 0.5;
              frequency *= 2;
            }

            map[y][x] = value;
            minVal = Math.min(minVal, value);
            maxVal = Math.max(maxVal, value);
          }
        }

        // Normalize values
        for (let y = 0; y <= this.resolutionY; y++) {
          for (let x = 0; x <= this.resolutionX; x++) {
            map[y][x] = (map[y][x] - minVal) / (maxVal - minVal);
          }
        }

        return map;
      }

      getModifiedHeight(x, y) {
        let height = this.heightMap[y][x];

        if (this.mouseX >= 0 && this.mouseY >= 0) {
          const dx = (x * this.cellSizeX - this.mouseX);
          const dy = (y * this.cellSizeY - this.mouseY);
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < this.influence) {
            const factor = Math.pow(1 - (distance / this.influence), 2);
            height *= (1 - factor * 2);
          }
        }

        return height;
      }

      generateContours() {
        const contours = [];

        for (let level = 0; level <= this.levels; level++) {
          const threshold = level / this.levels;
          let contour = "";

          for (let y = 0; y < this.resolutionY; y++) {
            for (let x = 0; x < this.resolutionX; x++) {
              const corners = [
                this.getModifiedHeight(x, y) >= threshold ? 1 : 0,
                  this.getModifiedHeight(x + 1, y) >= threshold ? 1 : 0,
                  this.getModifiedHeight(x + 1, y + 1) >= threshold ? 1 : 0,
                  this.getModifiedHeight(x, y + 1) >= threshold ? 1 : 0
              ];

              const sum = corners.reduce((a, b) => a + b);
              if (sum > 0 && sum < 4) {
                const points = this.getContourPoints(x, y, corners, threshold);
                contour += points;
              }
            }
          }

          if (contour) {
            contours.push({
              path: contour,
              level: level
            });
          }
        }

        return contours;
      }

      getContourPoints(x, y, corners, threshold) {
        const points = [];
        const px = x * this.cellSizeX;
        const py = y * this.cellSizeY;

        if ((corners[0] ^ corners[1]) === 1) {
          points.push([px + this.cellSizeX * this.getIntersection(
            this.getModifiedHeight(x, y),
            this.getModifiedHeight(x + 1, y),
            threshold
          ), py]);
        }
        if ((corners[1] ^ corners[2]) === 1) {
          points.push([px + this.cellSizeX, py + this.cellSizeY * this.getIntersection(
            this.getModifiedHeight(x + 1, y),
            this.getModifiedHeight(x + 1, y + 1),
            threshold
          )]);
        }
        if ((corners[2] ^ corners[3]) === 1) {
          points.push([px + this.cellSizeX * this.getIntersection(
            this.getModifiedHeight(x, y + 1),
            this.getModifiedHeight(x + 1, y + 1),
            threshold
          ), py + this.cellSizeY]);
        }
        if ((corners[3] ^ corners[0]) === 1) {
          points.push([px, py + this.cellSizeY * this.getIntersection(
            this.getModifiedHeight(x, y),
            this.getModifiedHeight(x, y + 1),
            threshold
          )]);
        }

        if (points.length >= 2) {
          return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]} `;
        }
        return "";
      }

      getIntersection(a, b, threshold) {
        return (threshold - a) / (b - a);
      }

      requestDraw() {
        if (!this.pendingUpdate) {
          this.pendingUpdate = true;
          this.animationFrameId = requestAnimationFrame(() => this.draw());
        }
      }

      draw() {
        this.pendingUpdate = false;
        this.svg.innerHTML = "";
        const contours = this.generateContours();

        contours.forEach(({path, level}) => {
          const contour = document.createElementNS("http://www.w3.org/2000/svg", "path");
          contour.setAttribute("d", path);
          contour.setAttribute("class", `contour ${level % 5 === 0 ? 'major-contour' : 'minor-contour'}`);
          this.svg.appendChild(contour);
        });
      }

      bindEvents() {
        const updateMousePosition = (e) => {
          const rect = this.svg.getBoundingClientRect();
          const scaleX = this.width / rect.width;
          const scaleY = this.height / rect.height;

          this.mouseX = (e.clientX - rect.left) * scaleX;
          this.mouseY = (e.clientY - rect.top) * scaleY;
          this.requestDraw();
        };

        window.addEventListener('mousemove', updateMousePosition);
        this.svg.addEventListener('touchmove', (e) => {
          e.preventDefault();
          const touch = e.touches[0];
          updateMousePosition(touch);
        });

        window.addEventListener('mouseleave', () => {
          this.mouseX = -1;
          this.mouseY = -1;
          this.requestDraw();
        });

        let resizeTimeout;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            this.updateDimensions();
            this.heightMap = this.generateHeightMap();
            this.requestDraw();
          }, 100);
        });
      }

      cleanup() {
        if (this.animationFrameId) {
          cancelAnimationFrame(this.animationFrameId);
        }
      }

    }

    mapInstanceRef.current = new TopographicMap(containerRef.current);

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.cleanup();
      }
    };
  }, []);

  return (
    <div 
    ref={containerRef} 
    className={`fixed inset-0 -z-10 ${className}`}
    style={{
      opacity: 0.5
    }}
    />
  );
};

export default TopographicBackground;
