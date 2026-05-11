'use client';

import { useEffect, useRef } from 'react';

interface Props {
  width?: number;
  height?: number;
  cellSize?: number;
  className?: string;
  /** Disable radial mask (full sharp edges) */
  noMask?: boolean;
  /** ms between generations. Default 200 (slower for spot use) */
  tickMs?: number;
}

/**
 * Точечная версия cellular automaton — Conway's Game of Life
 * в компактном canvas-блоке. Для декораций, empty states, bento cards.
 *
 * Использует тот же ритм/стиль что hero, но с маленьким размером
 * и radial-mask на края, чтобы выглядел как "островок жизни".
 */
export function CellsSpot({
  width = 320,
  height = 200,
  cellSize = 8,
  className = '',
  noMask = false,
  tickMs = 200,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cols = Math.floor(width / cellSize);
    const rows = Math.floor(height / cellSize);

    // Init grid with ~30% density
    let grid: number[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() < 0.3 ? 1 : 0))
    );

    let last = 0;
    const draw = (t: number) => {
      if (t - last >= tickMs) {
        last = t;

        // Render
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.7)'; // accent amber

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (grid[r][c]) {
              ctx.fillRect(
                c * cellSize + 1,
                r * cellSize + 1,
                cellSize - 2,
                cellSize - 2
              );
            }
          }
        }

        // Step
        const next: number[][] = grid.map((row) => [...row]);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            let n = 0;
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = (r + dr + rows) % rows;
                const nc = (c + dc + cols) % cols;
                n += grid[nr][nc];
              }
            }
            const alive = grid[r][c];
            next[r][c] = alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
          }
        }
        grid = next;
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [width, height, cellSize, tickMs]);

  return (
    <div
      className={`aiag-cells-spot ${noMask ? 'no-mask' : ''} aiag-grid-bg-sm ${className}`}
      style={{ width, height }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ display: 'block' }}
      />
    </div>
  );
}

export default CellsSpot;
